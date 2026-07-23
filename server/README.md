# delogo local inpainting backend

A small, **self-hosted** FastAPI service that does high-quality region removal
(burned-in captions, logos, watermarks) with a real video-inpainting model
(ProPainter) on your own GPU. The browser app stays the control plane: it
selects regions, builds masks, uploads only the cropped region + mask + time
window, then streams progress and pulls the cleaned clip back.

Nothing leaves your machine. The server binds to `127.0.0.1` by default.

```
browser (Delogo.html)                 local backend (this server)
  pick regions / masks  ──POST /api/jobs──▶  queue job, render mask
  show progress         ◀──SSE  /events───   emit stage/pct events
  pull result           ◀──GET  /result───   cleaned video blob
```

---

## Run

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
ffmpeg -version   # must be on PATH (the stub processor shells out to it)
uvicorn app:app --host 127.0.0.1 --port 8770
```

The stub processor (`DELOGO_PROCESSOR=delogo`, the default) uses only ffmpeg's
`delogo` filter so you can exercise the whole contract end-to-end before
installing PyTorch. Swap in ProPainter once the wiring works (see below).

Environment knobs:

| Var | Default | Meaning |
|-----|---------|---------|
| `DELOGO_PROCESSOR` | `delogo` | `delogo` (ffmpeg stub) or `propainter` |
| `DELOGO_WORK_DIR` | `./_jobs` | scratch dir for uploads/results (auto-created) |
| `DELOGO_ALLOW_ORIGINS` | `http://localhost:8090,http://127.0.0.1:8090` | CORS allowlist for the editor |
| `PROPAINTER_DIR` | `../ProPainter` | clone path, only for the propainter processor |
| `DELOGO_TTS` | auto | TTS for describe jobs: `piper` \| `espeak` \| `tone`. Auto picks piper → espeak-ng → tone |
| `PIPER_BIN` | `piper` | piper executable (only for `piper` TTS) |
| `PIPER_VOICE` | — | path to a piper `.onnx` voice model (required for `piper` TTS) |
| `DELOGO_UPSCALER` | auto | `realesrgan` \| `lanczos`. Auto picks Real-ESRGAN when its binary is on PATH |
| `REALESRGAN_BIN` | `realesrgan-ncnn-vulkan` | Real-ESRGAN ncnn-vulkan executable |
| `REALESRGAN_MODEL` | `realesrgan-x4plus` | Real-ESRGAN model name |
| `DELOGO_MAX_FETCH_MB` | `4096` | size cap for URL imports (yt-dlp) |
| `DELOGO_ALLOW_PRIVATE_FETCH` | `0` | allow importing from private/LAN hosts (some institutional Kaltura/YuJa). Off = SSRF-safe |

---

## Audio-description jobs (`task: "describe"`)

Same `POST /api/jobs` flow, but the spec carries notes instead of regions:

```jsonc
{
  "task": "describe",
  "notes": [
    { "startSec": 18.0, "text": "Network logo appears in the top-right.", "mode": "overlay" },
    { "startSec": 95.0, "text": "A lower third introduces the speaker.",  "mode": "pause" }
  ]
}
```

Each note is synthesized to speech (Piper if configured, else espeak-ng, else
an audible placeholder tone so the pipeline is testable), the original audio is
ducked to 25% under each description, and the result is an **MKV** with:

| Track | Content | Flags |
|-------|---------|-------|
| 0 | video (stream-copied, fast) | — |
| 1 | original audio | `default` |
| 2 | ducked original + descriptions | `visual_impaired+descriptions`, title "Audio Description" |

Players (VLC, mpv, most TVs) list track 2 as a selectable audio-description
track — that's the user trigger. `mode: "pause"` notes are mixed like overlay
notes for now; true extended AD (freeze-frame insertion) is future work.

Piper setup:

```bash
pip install piper-tts
# grab a voice, e.g. en_US-lessac-medium, from https://github.com/rhasspy/piper/blob/master/VOICES.md
PIPER_VOICE=/path/to/en_US-lessac-medium.onnx uvicorn app:app --port 8770
```

Browser side: `window.runServerDescribe(videoSrc, notes, opts)` in `inpaint.js`
uploads the clip + notes and resolves with the described MKV.

---

## Job contract (v1)

All endpoints are under `/api`. IDs are opaque UUID strings.

### `POST /api/jobs` — submit a job

`multipart/form-data`:

- `video`: the source clip (a Blob). Send the **trimmed** clip when you can —
  the smaller the upload, the faster everything is.
- `spec`: a JSON string (the `JobSpec` below).

`JobSpec`:

```jsonc
{
  "fps": 24,                      // source fps, used to map frames<->seconds
  "width": 1280,                  // source pixel dimensions (for % -> px)
  "height": 720,
  "timeRange": {                  // optional FALLBACK window for regions that
    "startSec": 12.0,             // don't carry their own startSec/endSec.
    "endSec": 19.5                // NOTE: the output is always the FULL-LENGTH
  },                              // video — regions are only erased while
                                  // their window is active (never trimmed).
  "regions": [                    // one or more areas to remove
    {
      "id": "r2",
      "type": "caption",          // caption | logo | watermark (informational)
      // Geometry is in PERCENT of frame (0..100), matching the editor's model.
      // A region is either static (x/y/w/h) or keyframed (keyframes[]).
      "x": 8, "y": 78, "w": 84, "h": 13,
      "startSec": 12.0,           // optional active window (seconds); the
      "endSec": 19.5,             // region is untouched outside it
      "keyframes": [              // optional; overrides x/y/w/h when present
        { "t": 12.0, "x": 8,  "y": 78, "w": 84, "h": 13 },
        { "t": 19.5, "x": 10, "y": 76, "w": 80, "h": 15 }
      ],
      "feather": 2               // optional mask edge softening, in px
    }
  ]
}
```

Response `202`:

```json
{ "jobId": "f0c1...", "status": "queued" }
```

### `GET /api/jobs/{id}` — poll status

```json
{
  "jobId": "f0c1...",
  "status": "queued | running | done | error",
  "stage": "rendering-mask",
  "pct": 42,
  "message": "Inpainting frames 120/300",
  "error": null
}
```

### `GET /api/jobs/{id}/events` — progress stream (SSE)

`text/event-stream`. One JSON object per `data:` line, same shape as the poll
body. The stream closes after a terminal (`done` / `error`) event. Poll is the
fallback when SSE isn't available.

### `GET /api/jobs/{id}/result` — download cleaned video

`200 video/mp4` once `status == done`, else `409`.

### `DELETE /api/jobs/{id}` — drop a job and its scratch files

---

## Upscaling jobs (`task: "upscale"`)

```jsonc
{ "task": "upscale", "scale": 2 }            // 2x/3x/4x, or:
{ "task": "upscale", "targetHeight": 2160 }  // fit to a height (aspect kept)
```

Real-ESRGAN super-resolution when `realesrgan-ncnn-vulkan` is installed
(grab a release from https://github.com/xinntao/Real-ESRGAN/releases — no
Python deps, runs on Vulkan); otherwise a high-quality Lanczos resample
(`"sharpen": true` adds a light unsharp pass). Real-ESRGAN extracts every
frame as PNG — budget several GB of scratch for long clips. Browser side:
`window.runServerUpscale(videoSrc, { scale | targetHeight, sharpen })`;
chat side: the `upscale_video` MCP tool.

---

## URL import (`POST /api/fetch`)

The browser can't load a YouTube/Vimeo/YuJa/Kaltura *watch page* into a
`<video>` element. This endpoint runs [yt-dlp](https://github.com/yt-dlp/yt-dlp)
server-side to resolve + download the real stream to a local MP4, which the
editor then opens like any other file.

```jsonc
POST /api/fetch   { "url": "https://…" }   → { "jobId": "…" }
```

Progress, result, and delete reuse the `/api/jobs/{id}/...` endpoints. Browser
side: `window.fetchRemoteVideo(url, { onProgress })`; the Upload screen's URL
tab uses it; chat side: the `import_url` MCP tool.

**Rights:** only import content you have the right to download and modify
(your own uploads, institutional lecture recordings, accessibility
remediation of licensed material). yt-dlp is a general resolver — you are
responsible for how you use it.

**Security:** URLs are restricted to `http`/`https`, and hosts resolving to
private/loopback/link-local addresses are refused (SSRF hardening). Set
`DELOGO_ALLOW_PRIVATE_FETCH=1` only for a trusted internal media server.

---

## AI chat integration (MCP)

`mcp_server.py` exposes the editor to any MCP-capable chat client. The web
page stays the user's visual surface — every AI action (regions, seeks,
detections, processing) appears live in the editor for the human to review
and refine. The page connects to the MCP server automatically (`bridge.js`,
`ws://127.0.0.1:8772`); start things in any order.

**Claude Code** (one command):

```bash
claude mcp add unlogo -- /path/to/delogo/server/.venv/bin/python /path/to/delogo/server/mcp_server.py
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "unlogo": {
      "command": "/path/to/delogo/server/.venv/bin/python",
      "args": ["/path/to/delogo/server/mcp_server.py"]
    }
  }
}
```

**Any other chat client** — run it as a local streamable-HTTP server:

```bash
python mcp_server.py --http     # MCP endpoint at http://127.0.0.1:8765/mcp
```

Tools: `editor_status`, `get_project_state`, `get_frame` (the AI can *see*
frames), `seek`, `add_region` / `update_region` / `delete_region`
(frame-accurate `MM:SS:FF` timecodes), `detect_captions`, `add_audio_note`,
`remove_regions` (full ffmpeg clean via this backend), and
`mux_audio_descriptions` (Piper AD track).

Example prompt once connected: *"Look at the frame at 05:45:16 — that's a
burned-in caption. Remove captions from 5:44 to 6:48."*

Ports: bridge `UNLOGO_BRIDGE_PORT` (default 8772), HTTP transport
`UNLOGO_HTTP_PORT` (default 8765). Everything binds to 127.0.0.1.

---

## Switching to ProPainter

1. Clone next to this repo and grab the weights:
   ```bash
   git clone https://github.com/sczhou/ProPainter
   # follow its README to download the pretrained weights into ProPainter/weights
   ```
2. `pip install torch torchvision` (CUDA build matching your driver) plus the
   commented deps in `requirements.txt`.
3. Implement the `propainter` branch in `processor.py` (there's a marked
   integration point). Feed it the cropped frames + per-frame mask the stub
   already renders.
4. Run with `DELOGO_PROCESSOR=propainter PROPAINTER_DIR=../ProPainter uvicorn ...`.

### Fitting a 12 GB card

ProPainter is memory-hungry on long/large clips. The crop-only upload already
helps (you inpaint a sub-rectangle, not the full frame). Tune these on the
ProPainter call to stay under 12 GB:

| Flag | Effect | Suggested start |
|------|--------|-----------------|
| `--resize_ratio` | downscale before inpaint, upscale after | `1.0`, drop to `0.5` if OOM |
| `--subvideo_length` | frames processed per chunk | `80` -> `40` if OOM |
| `--neighbor_length` | temporal window size | `10` -> `6` if OOM |
| `--raft_iter` | optical-flow refine iterations | `20` -> `10` to save time |
| `--fp16` | half precision | enable it |

Process **only the trimmed time range and the cropped region** — that is the
single biggest VRAM and speed win, and it's exactly what the contract uploads.
