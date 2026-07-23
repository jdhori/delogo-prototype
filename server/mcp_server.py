"""unlogo MCP server — chat-AI control surface for the Delogo video editor.

The web editor stays the user's visual surface: every tool call here shows up
live in the page (regions appear on the timeline, the playhead moves, the
cleaned clip lands in the normal UI), so the human can watch, refine, and
approve everything the AI does.

Architecture:

    chat client ──MCP (stdio / streamable-http)──▶ this process
                                                     │ WebSocket 127.0.0.1:8772
                                                     ▼
                                            Delogo editor page (bridge.js)

Run it:
    python mcp_server.py            # stdio — for `claude mcp add` etc.
    python mcp_server.py --http     # streamable HTTP on :8765 for other chats

The heavy processing (ffmpeg removal, Piper audio descriptions) is executed by
the page against the existing local backend (server/app.py) — this server
never touches video bytes except thumbnail frames.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import threading
import uuid
from typing import Any, Optional

import websockets
from mcp.server.fastmcp import FastMCP, Image

# ---------------------------------------------------------------------------
# Editor bridge (WebSocket host)
# ---------------------------------------------------------------------------

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = int(os.environ.get("UNLOGO_BRIDGE_PORT", "8772"))
CALL_TIMEOUT_SEC = float(os.environ.get("UNLOGO_BRIDGE_TIMEOUT", "60"))
HTTP_PORT = int(os.environ.get("UNLOGO_HTTP_PORT", "8765"))

NO_EDITOR_MSG = (
    "No Delogo editor is connected. Ask the user to open the editor page "
    "(e.g. http://localhost:8090/Delogo.html) and load a video — the page "
    "connects to this server automatically within a few seconds."
)

# The WebSocket bridge runs on its OWN event loop on a daemon thread, NOT on
# the FastMCP lifespan — the lifespan doesn't run in every transport (notably
# streamable-http), which used to leave the bridge unbound. Decoupling it means
# the bridge is up for stdio AND http, and survives a background launch.
_editor_ws: Optional[Any] = None
_pending: dict[str, asyncio.Future] = {}
_bridge_loop: Optional[asyncio.AbstractEventLoop] = None


async def _handle_editor(ws) -> None:
    """One editor page at a time; a newer connection replaces the older."""
    global _editor_ws
    _editor_ws = ws
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                continue
            fut = _pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                fut.set_result(msg)
    except websockets.ConnectionClosed:
        pass
    finally:
        if _editor_ws is ws:
            _editor_ws = None


async def _bridge_call(cmd: str, args: dict | None, timeout: float) -> Any:
    """Runs ON the bridge loop: send one command to the page, await its reply."""
    if _editor_ws is None:
        raise RuntimeError(NO_EDITOR_MSG)
    call_id = uuid.uuid4().hex
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _pending[call_id] = fut
    try:
        await _editor_ws.send(json.dumps({"id": call_id, "cmd": cmd, "args": args or {}}))
        msg = await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError as exc:
        raise RuntimeError(
            f"The editor did not answer '{cmd}' within {timeout:.0f}s. "
            "The page may be busy (a scan or export in progress) — try again shortly."
        ) from exc
    finally:
        _pending.pop(call_id, None)
    if not msg.get("ok"):
        raise RuntimeError(msg.get("error") or f"editor command '{cmd}' failed")
    return msg.get("result")


async def _call_editor(cmd: str, args: dict | None = None, timeout: float = CALL_TIMEOUT_SEC) -> Any:
    """Called from the MCP server loop; hops to the bridge loop and awaits."""
    if _bridge_loop is None:
        raise RuntimeError("editor bridge is not running")
    cfut = asyncio.run_coroutine_threadsafe(_bridge_call(cmd, args, timeout), _bridge_loop)
    return await asyncio.wrap_future(cfut)


def _start_bridge() -> None:
    """Bind the WebSocket bridge on a dedicated daemon-thread event loop.
    Idempotent-ish: safe to call once at process start (both transports)."""
    ready = threading.Event()
    err: dict[str, Exception] = {}

    def run() -> None:
        global _bridge_loop
        loop = asyncio.new_event_loop()
        _bridge_loop = loop
        asyncio.set_event_loop(loop)
        # Local pages only. `None` origin admits non-browser clients (tests).
        origins = [None] + [
            f"{scheme}://{host}{port}"
            for scheme in ("http", "https")
            for host in ("localhost", "127.0.0.1")
            for port in ("", ":8090", ":8080", ":3000", ":5173", ":8000")
        ]

        async def boot() -> None:
            await websockets.serve(_handle_editor, BRIDGE_HOST, BRIDGE_PORT, origins=origins)

        try:
            loop.run_until_complete(boot())
        except Exception as exc:  # noqa: BLE001 — surface bind failures to the caller
            err["e"] = exc
            ready.set()
            return
        ready.set()
        loop.run_forever()

    threading.Thread(target=run, daemon=True, name="unlogo-bridge").start()
    ready.wait(timeout=5)
    if "e" in err:
        raise err["e"]


# ---------------------------------------------------------------------------
# MCP server + tools
# ---------------------------------------------------------------------------

TC_DOC = 'Timecode: "MM:SS:FF" (FF = frames, e.g. "05:45:16"), "MM:SS", or plain seconds like "345.5".'

mcp = FastMCP(
    "unlogo",
    instructions=(
        "Control surface for the Delogo browser video editor (removes burned-in "
        "captions/logos/watermarks and authors audio descriptions). The human is "
        "watching the editor page: every change you make appears there live, and "
        "they can refine your regions by hand. Workflow: check editor_status, read "
        "get_project_state, look at frames with get_frame before and after acting, "
        "add or adjust regions with frame-accurate timecodes, then remove_regions "
        "to produce the cleaned video. " + TC_DOC
    ),
)


@mcp.tool(annotations={"readOnlyHint": True})
async def editor_status() -> dict:
    """Check whether a Delogo editor page is connected and ready.

    Call this first. If not connected, ask the user to open the editor page —
    it links up automatically.
    """
    if _editor_ws is None:
        return {"connected": False, "hint": NO_EDITOR_MSG}
    state = await _call_editor("getState")
    return {"connected": True, "project": state.get("project"), "hasRealVideo": state.get("hasRealVideo")}


@mcp.tool()
async def import_url(url: str) -> dict:
    """Import a remote video (YouTube/Vimeo/YuJa/Kaltura or a direct media URL)
    into the editor. The local backend downloads it with yt-dlp and opens it
    as a real video for editing. Only import content the user has the right to
    download and modify. Slow for long videos.
    """
    if not (url or "").strip():
        raise ValueError("url is required")
    return await _call_editor("importUrl", {"url": url.strip()}, timeout=3600)


@mcp.tool(annotations={"readOnlyHint": True})
async def get_project_state() -> dict:
    """Full editor state: project info, fps, duration, playhead, and every
    region / audio note / caption cue (times in both frames and seconds)."""
    return await _call_editor("getState")


@mcp.tool(annotations={"readOnlyHint": True})
async def get_frame(timecode: str, max_width: int = 640) -> Image:
    """Grab the video frame at a timecode so you can SEE what is on screen
    (captions, logos, slide text). Also moves the user's playhead there.

    Timecode: "MM:SS:FF", "MM:SS", or seconds.
    """
    result = await _call_editor("getFrame", {"tc": timecode, "maxWidth": max_width})
    data_url = result["dataUrl"]
    b64 = data_url.split(",", 1)[1]
    return Image(data=base64.b64decode(b64), format="jpeg")


@mcp.tool()
async def seek(timecode: str) -> dict:
    """Move the editor playhead (and the user's view) to a timecode."""
    return await _call_editor("seek", {"tc": timecode})


@mcp.tool()
async def add_region(
    x_pct: float,
    y_pct: float,
    w_pct: float,
    h_pct: float,
    start_tc: str,
    end_tc: str,
    method: str = "inpaint",
    region_type: str = "caption",
    name: str = "",
) -> dict:
    """Add a removal region. Geometry is percent of frame (0-100); the region
    is only removed between start_tc and end_tc. method: "inpaint"/"delogo"
    (erase — background blended over the content) or "blur".

    The region appears on the user's timeline immediately for review.
    """
    return await _call_editor("addRegion", {
        "x": x_pct, "y": y_pct, "w": w_pct, "h": h_pct,
        "startTc": start_tc, "endTc": end_tc,
        "method": method, "type": region_type, "name": name,
    })


@mcp.tool()
async def update_region(
    region_id: str,
    x_pct: Optional[float] = None,
    y_pct: Optional[float] = None,
    w_pct: Optional[float] = None,
    h_pct: Optional[float] = None,
    start_tc: Optional[str] = None,
    end_tc: Optional[str] = None,
    method: Optional[str] = None,
    visible: Optional[bool] = None,
) -> dict:
    """Update any subset of a region's geometry, active window, method, or
    visibility. Omitted fields keep their current values."""
    patch: dict[str, Any] = {}
    for key, val in (("x", x_pct), ("y", y_pct), ("w", w_pct), ("h", h_pct),
                     ("startTc", start_tc), ("endTc", end_tc),
                     ("method", method), ("visible", visible)):
        if val is not None:
            patch[key] = val
    return await _call_editor("updateRegion", {"id": region_id, "patch": patch})


@mcp.tool(annotations={"destructiveHint": True})
async def delete_region(region_id: str) -> dict:
    """Delete a region from the editor."""
    return await _call_editor("deleteRegion", {"id": region_id})


@mcp.tool()
async def detect_captions(start_tc: str, end_tc: str) -> dict:
    """Run the editor's caption detector on a time window (give the tightest
    window you can — it avoids flagging slide/lecture text). Returns the
    resulting region list; detected regions land on the user's timeline.
    Slow: expect roughly the window's own duration."""
    await _call_editor("detectCaptions", {"startTc": start_tc, "endTc": end_tc}, timeout=600)
    state = await _call_editor("getState")
    return {"regions": state.get("regions", [])}


@mcp.tool()
async def extract_captions(start_tc: Optional[str] = None, end_tc: Optional[str] = None) -> dict:
    """Read the burned-in (open) captions with OCR and convert them to real
    subtitles. Pass 1 samples frames and builds DEDUPLICATED cues (a caption
    on screen for 3s becomes one cue); pass 2 cuts removal shapes (tight
    rectangles, staircase polygons for uneven multi-line captions) from the
    exact text geometry. Cues land in the editor's caption track; shapes on
    the timeline. remove_regions afterwards muxes the cues back into the
    cleaned video as a toggleable soft subtitle track.

    Scope with start_tc/end_tc when you can — OCR is ~1-2s per sampled
    frame (samples every 0.75s of the window).
    """
    args: dict = {}
    if start_tc is not None:
        args["startTc"] = start_tc
    if end_tc is not None:
        args["endTc"] = end_tc
    return await _call_editor("extractCaptions", args, timeout=3600)


@mcp.tool()
async def add_audio_note(timecode: str, text: str, mode: str = "overlay") -> dict:
    """Add an audio-description note at a timecode. mode: "overlay" (rides on
    top of program audio) or "pause". Notes become spoken descriptions when
    mux_audio_descriptions runs (Piper TTS on the local backend)."""
    return await _call_editor("addNote", {"tc": timecode, "text": text, "mode": mode})


@mcp.tool(annotations={"destructiveHint": False, "openWorldHint": False})
async def remove_regions(region_ids: Optional[list[str]] = None) -> dict:
    """Process the video: erase every listed region (default: all visible
    regions) during its active window via the local ffmpeg backend, returning
    a full-length cleaned video into the editor UI for the user to download.

    Requires the local backend (cd server && uvicorn app:app --port 8770).
    Slow for long videos — several minutes is normal.
    """
    return await _call_editor("removeRegions", {"ids": region_ids or []}, timeout=1800)


@mcp.tool()
async def upscale_video(
    scale: Optional[float] = None,
    target_height: Optional[int] = None,
    sharpen: bool = False,
) -> dict:
    """Upscale the loaded video via the local backend. Give scale (2/3/4) OR
    target_height (e.g. 1080, 2160). Uses Real-ESRGAN super-resolution when
    installed on the backend, otherwise a high-quality Lanczos resample
    (sharpen adds a light unsharp pass to the resample).

    Slow — minutes for real videos; Real-ESRGAN can take much longer and
    needs several GB of scratch disk for frame extraction.
    """
    if not scale and not target_height:
        raise ValueError("Provide scale (2/3/4) or target_height (e.g. 1080).")
    return await _call_editor(
        "upscale",
        {"scale": scale, "targetHeight": target_height, "sharpen": sharpen},
        timeout=3600,
    )


@mcp.tool()
async def mux_audio_descriptions() -> dict:
    """Synthesize every audio note to speech (Piper → espeak → tone fallback)
    and mux an MKV with a user-selectable Audio Description track, via the
    local backend. Returns when the described video is ready in the page."""
    return await _call_editor("muxDescriptions", {}, timeout=1800)


if __name__ == "__main__":
    # Bind the editor bridge first, independent of the chat transport below.
    _start_bridge()
    if "--http" in sys.argv:
        # Streamable HTTP for chat clients that speak MCP over HTTP.
        mcp.settings.host = "127.0.0.1"
        mcp.settings.port = HTTP_PORT
        mcp.run(transport="streamable-http")
    else:
        mcp.run()
