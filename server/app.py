"""delogo local inpainting backend — FastAPI control surface.

Implements the v1 job contract documented in README.md:
  POST   /api/jobs            submit (multipart: video + spec JSON)
  GET    /api/jobs/{id}       poll status
  GET    /api/jobs/{id}/events  SSE progress stream
  GET    /api/jobs/{id}/result  download cleaned video
  DELETE /api/jobs/{id}       drop job + scratch files

Single-worker queue: a 12 GB GPU runs one inpaint job at a time, so we serialise
on one background thread. Job state lives in memory; scratch files live under
DELOGO_WORK_DIR. Nothing is persisted across restarts — this is a local tool.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue
from typing import Optional

from fastapi import Body, FastAPI, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

import fetcher
import processor

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

WORK_DIR = Path(os.environ.get("DELOGO_WORK_DIR", "./_jobs")).resolve()
WORK_DIR.mkdir(parents=True, exist_ok=True)

ALLOW_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "DELOGO_ALLOW_ORIGINS",
        "http://localhost:8090,http://127.0.0.1:8090",
    ).split(",")
    if o.strip()
]

MAX_UPLOAD_BYTES = int(os.environ.get("DELOGO_MAX_UPLOAD_MB", "512")) * 1024 * 1024

# ---------------------------------------------------------------------------
# Job model
# ---------------------------------------------------------------------------


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error
    stage: str = "queued"
    pct: int = 0
    message: str = "Waiting for a free worker"
    error: Optional[str] = None
    dir: Path = field(default=None)  # type: ignore[assignment]
    kind: str = "process"  # process | fetch
    source_url: Optional[str] = None  # for kind == "fetch"
    # async fan-out: each SSE subscriber gets its own queue of snapshots
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    loop: Optional[asyncio.AbstractEventLoop] = None

    def snapshot(self) -> dict:
        return {
            "jobId": self.id,
            "status": self.status,
            "stage": self.stage,
            "pct": self.pct,
            "message": self.message,
            "error": self.error,
        }

    @property
    def input_path(self) -> Path:
        return self.dir / "input"

    @property
    def spec_path(self) -> Path:
        return self.dir / "spec.json"

    @property
    def result_path(self) -> Path:
        # Describe jobs produce an MKV (multi-audio-track container); region
        # jobs produce MP4. Whichever the processor wrote wins.
        mkv = self.dir / "result.mkv"
        return mkv if mkv.exists() else self.dir / "result.mp4"


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
WORK_QUEUE: "Queue[str]" = Queue()


# ---------------------------------------------------------------------------
# Progress fan-out: worker thread -> async SSE subscribers
# ---------------------------------------------------------------------------


def _publish(job: Job) -> None:
    """Push the current snapshot to every SSE subscriber (thread-safe)."""
    snap = job.snapshot()
    loop = job.loop
    if loop is None:
        return
    for q in list(job.subscribers):
        # subscribers' queues live on the event loop; hand off across threads
        loop.call_soon_threadsafe(q.put_nowait, snap)


def _update(job: Job, **fields) -> None:
    for k, v in fields.items():
        setattr(job, k, v)
    _publish(job)


# ---------------------------------------------------------------------------
# Worker thread — drains the queue one job at a time
# ---------------------------------------------------------------------------


def _worker_loop() -> None:
    while True:
        job_id = WORK_QUEUE.get()
        job = JOBS.get(job_id)
        if job is None:  # deleted before it ran
            WORK_QUEUE.task_done()
            continue
        try:
            _run_job(job)
        except Exception as exc:  # noqa: BLE001 — surface any failure to the client
            _update(
                job,
                status="error",
                stage="error",
                error=str(exc),
                message="Processing failed",
            )
        finally:
            WORK_QUEUE.task_done()


def _run_job(job: Job) -> None:
    _update(job, status="running", stage="starting", pct=1, message="Loading job")

    def on_progress(stage: str, pct: int, message: str) -> None:
        _update(job, stage=stage, pct=max(1, min(99, int(pct))), message=message)

    if job.kind == "fetch":
        out = fetcher.fetch(job.source_url, job.dir, on_progress)
        # Serve the download under the result path the client polls for.
        out.rename(job.dir / "result.mp4")
        if not job.result_path.exists():
            raise RuntimeError("fetch finished but no file was produced")
        _update(job, status="done", stage="done", pct=100, message="Video fetched")
        return

    spec = json.loads(job.spec_path.read_text())
    out_name = "result.mkv" if spec.get("task") == "describe" else "result.mp4"
    processor.process(
        input_path=job.input_path,
        spec=spec,
        output_path=job.dir / out_name,
        on_progress=on_progress,
    )

    if not job.result_path.exists():
        raise RuntimeError("processor finished without writing a result")

    _update(
        job,
        status="done",
        stage="done",
        pct=100,
        message="Cleaned video ready",
    )


threading.Thread(target=_worker_loop, daemon=True, name="delogo-worker").start()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="delogo local inpainting backend", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "processor": processor.active_processor()}


# ---------------------------------------------------------------------------
# Service status + start controls
# ---------------------------------------------------------------------------

MCP_BRIDGE_PORT = int(os.environ.get("UNLOGO_BRIDGE_PORT", "8772"))


def _port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.4) -> bool:
    """True if something is listening on host:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


@app.get("/api/services")
def services() -> dict:
    """Status of the local services the editor depends on. The processing
    backend is trivially 'running' (it's answering this request); the MCP
    bridge is detected by probing its WebSocket port."""
    return {
        "backend": {"name": "Processing backend", "running": True, "port": 8770},
        "mcp": {"name": "AI chat bridge (MCP)", "running": _port_open(MCP_BRIDGE_PORT), "port": MCP_BRIDGE_PORT},
    }


@app.post("/api/services/mcp/start", status_code=202)
def start_mcp() -> dict:
    """Start the MCP server (which hosts the WebSocket bridge) if it isn't
    already up. Spawns a FIXED command — the sibling mcp_server.py under the
    same interpreter — so there is no arbitrary-command surface."""
    if _port_open(MCP_BRIDGE_PORT):
        return {"started": False, "running": True, "message": "MCP bridge already running"}
    script = Path(__file__).with_name("mcp_server.py")
    if not script.exists():
        raise HTTPException(500, f"mcp_server.py not found next to app.py ({script})")
    try:
        # --http, NOT stdio: a background-launched MCP server has no stdio
        # client, so stdio mode would read EOF on stdin and exit immediately
        # (tearing down the WebSocket bridge). --http runs a persistent server
        # that keeps the bridge (its lifespan) alive; the browser connects to
        # the bridge and chat clients connect over HTTP.
        subprocess.Popen(
            [sys.executable, str(script), "--http"],
            cwd=str(script.parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,  # detach so it survives this request
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"could not start MCP server: {exc}") from exc

    # Give the WebSocket host a moment to bind.
    import time
    for _ in range(20):
        if _port_open(MCP_BRIDGE_PORT):
            return {"started": True, "running": True, "message": "MCP bridge started"}
        time.sleep(0.25)
    return {"started": True, "running": False, "message": "MCP server launched; bridge not up yet — check again shortly"}


@app.post("/api/jobs", status_code=202)
async def submit_job(video: UploadFile, spec: str = Form(...)) -> JSONResponse:
    # Validate the spec before we spend disk on the upload.
    try:
        parsed = json.loads(spec)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"spec is not valid JSON: {exc}") from exc
    is_describe = parsed.get("task") == "describe" and parsed.get("notes")
    is_upscale = parsed.get("task") == "upscale" and (
        parsed.get("scale") or parsed.get("targetHeight")
    )
    if not parsed.get("regions") and not is_describe and not is_upscale:
        raise HTTPException(
            400,
            "spec needs regions (removal), task='describe' + notes (audio description), "
            "or task='upscale' + scale/targetHeight (upscaling)",
        )

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    input_path = job_dir / "input"

    # Stream the upload to disk with a hard size cap.
    written = 0
    with input_path.open("wb") as fh:
        while chunk := await video.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                shutil.rmtree(job_dir, ignore_errors=True)
                raise HTTPException(413, "upload exceeds DELOGO_MAX_UPLOAD_MB")
            fh.write(chunk)

    job = Job(id=job_id, dir=job_dir, loop=asyncio.get_running_loop())
    job.spec_path.write_text(json.dumps(parsed))
    with JOBS_LOCK:
        JOBS[job_id] = job
    WORK_QUEUE.put(job_id)

    return JSONResponse({"jobId": job_id, "status": "queued"}, status_code=202)


@app.post("/api/fetch", status_code=202)
async def submit_fetch(url: str = Body(..., embed=True)) -> JSONResponse:
    """Download a remote video (YouTube/Vimeo/YuJa/Kaltura/direct URL) via
    yt-dlp so the editor can open it as a real file. Progress/result/delete
    reuse the same /api/jobs/{id}/... endpoints."""
    url = (url or "").strip()
    if not url:
        raise HTTPException(400, "missing url")
    ok, why = fetcher._is_safe_url(url)
    if not ok:
        raise HTTPException(400, f"URL rejected: {why}")

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    job = Job(id=job_id, dir=job_dir, kind="fetch", source_url=url,
              loop=asyncio.get_running_loop())
    with JOBS_LOCK:
        JOBS[job_id] = job
    WORK_QUEUE.put(job_id)
    return JSONResponse({"jobId": job_id, "status": "queued"}, status_code=202)


def _require_job(job_id: str) -> Job:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return _require_job(job_id).snapshot()


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    job = _require_job(job_id)
    queue: asyncio.Queue = asyncio.Queue()
    job.subscribers.append(queue)
    # Make sure the worker (on another thread) can reach this event loop.
    job.loop = asyncio.get_running_loop()

    async def stream():
        try:
            # Emit the current state immediately so late subscribers catch up.
            yield f"data: {json.dumps(job.snapshot())}\n\n"
            if job.status in ("done", "error"):
                return
            while True:
                snap = await queue.get()
                yield f"data: {json.dumps(snap)}\n\n"
                if snap["status"] in ("done", "error"):
                    return
        finally:
            if queue in job.subscribers:
                job.subscribers.remove(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str) -> FileResponse:
    job = _require_job(job_id)
    if job.status != "done" or not job.result_path.exists():
        raise HTTPException(409, "result not ready")
    suffix = job.result_path.suffix
    return FileResponse(
        job.result_path,
        media_type="video/x-matroska" if suffix == ".mkv" else "video/mp4",
        filename=f"delogo-{job_id}{suffix}",
    )


@app.delete("/api/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    job = JOBS.pop(job_id, None)
    if job is None:
        raise HTTPException(404, "no such job")
    shutil.rmtree(job.dir, ignore_errors=True)
    return Response(status_code=204)
