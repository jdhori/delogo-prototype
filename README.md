# Delogo — burned-in caption + logo + watermark removal prototype

Browser-only video editor for removing burned-in captions, network logos, watermarks, and adding audio descriptions. Works fully client-side (no upload to a server).

## Quick start

```bash
./setup.sh                       # downloads FFmpeg-WASM (~32 MB)
python3 -m http.server 8090      # any static server works
# open http://localhost:8090/Delogo.html
```

To load a video directly via URL param:

```
http://localhost:8090/Delogo.html?video=/path/to/local.mp4
```

Drag-and-drop on the upload zone also works.

## What's wired

| Feature | Status |
|---|---|
| Real video playback synced with editor playhead and timeline scrubbing | Working |
| Heuristic auto-detect: burned-in captions (1- vs 2-line), network logos (corner-anchored), static watermarks (off-corner persistent low-contrast) | Working |
| Audio description opportunity detector (finds pauses ≥1.6s via Web Audio RMS) | Working |
| Pre-detect modal — user picks which categories to scan for before any detection runs | Working |
| Per-region "Re-fit to active range" — re-runs caption detection scoped to one region's IN/OUT window | Working |
| Rectangle and **polygon** regions, with vertex drag/right-click-delete | Working |
| Time-gated rendering — regions only show on the video stage during their `[IN, OUT]` window | Working |
| Live `backdrop-filter: blur(14px)` preview clipped to the region shape (rect or polygon) | Working |
| Audio notes editable in the side panel: jump, edit, delete, add at playhead | Working |
| FFmpeg-WASM export — burns blur into a downloadable MP4. Polygons exported via per-region PNG mask + `alphamerge` so blur respects polygon shape, not bounding rect | Working |
| Timeline ↔ stage sync — clip glows when playhead enters it, "selected" highlight ties inspector to track | Working |

## AI & browser automation

Delogo can be driven by an AI chat client through **two complementary paths**. They
listen on different ports (8772 / 8765 vs. 61822) so both can run at once.

| | Built-in `unlogo` MCP | Kapture (vendored) |
|---|---|---|
| Scope | **In-page, project-aware** — operates on Delogo's own model (regions, timecodes, detection, ffmpeg processing) | **Out-of-page, browser-generic** — drives the actual Chrome tab (navigate/click/fill/hover/evaluate/screenshot/DOM) on any page |
| Lives in | this repo — `server/mcp_server.py` + in-page bridge `bridge.js` (`ws://127.0.0.1:8772`) | separate MIT project cloned to `../kapture` (upstream: [williamkapke/kapture](https://github.com/williamkapke/kapture)) |
| Runtime | Python / FastAPI backend | Node 18+ MCP server + Chrome DevTools extension |
| Best for | letting AI add/refine regions, detect captions, run removal/AD exports — every action shows live in the editor | E2E-driving or observing the Delogo web UI itself (or pulling in web sources) from outside the page |

### Built-in `unlogo` MCP

`server/mcp_server.py` exposes the editor over MCP; the web page auto-connects via
`bridge.js`. Every AI action (regions, seeks, detections, processing) appears live in
the editor for the human to review. Tools: `editor_status`, `get_project_state`,
`get_frame`, `seek`, `add_region` / `update_region` / `delete_region`,
`detect_captions`, `add_audio_note`, `remove_regions`, `mux_audio_descriptions`,
`import_url`, `upscale_video`, `extract_captions`.

```bash
claude mcp add unlogo -- /path/to/delogo/server/.venv/bin/python /path/to/delogo/server/mcp_server.py
```

Ports: bridge `UNLOGO_BRIDGE_PORT` (default 8772), HTTP transport `UNLOGO_HTTP_PORT`
(default 8765). Everything binds to `127.0.0.1`. Full contract in
[`server/README.md`](server/README.md).

### Kapture (browser-automation companion)

[Kapture](https://github.com/williamkapke/kapture) is a Chromium DevTools extension +
MCP server + WebSocket bridge that lets an AI client drive **the real Brave/Chrome tab
you're watching** — unlike generic automation MCPs (`playwright`, `chrome-devtools`)
that spin up a *separate* browser with a clean profile. It's kept as a **local checkout
at `../kapture`** (sibling of this repo; `git pull` off the `upstream` remote for
updates), already built (`server/dist/`), and mirrored into SecondBrain (Obsidian)
under `AI Tools/kapture`.

To wire it into Claude Code, copy [`.mcp.json.example`](.mcp.json.example) to `.mcp.json`
(gitignored) — it registers `kapture` (project scope) via `npx`. The remaining setup is
browser-side: load the unpacked extension from `../kapture/extension` and attach a tab via
its DevTools panel. Full walkthrough: [`../kapture/KAPTURE_SETUP.md`](../kapture/KAPTURE_SETUP.md).

Tools: `navigate`, `back`, `forward`, `click`, `hover`, `fill`, `select`, `evaluate`,
`elements`. Resources: `kapture://tabs`, `.../console`, `.../screenshot`, `.../dom`.
Server binds `127.0.0.1:61822`. See also [`../kapture/server/README.md`](../kapture/server/README.md).

## Known limitations

- **CORS-locked sources** (Kaltura/YuJa signed URLs without CORS) can't be ingested or exported. A small proxy server is the fix; not built yet.
- **Audio descriptions aren't mixed into exports.** Notes are text-only in this prototype; mixing TTS or recorded audio into the output MP4 is a separate pass.
- **Moving watermarks** need optical-flow tracking — the existing "track" mode handles them manually but auto-detection covers static watermarks only.
- **Heuristic detectors** produce false positives on busy footage. Defaults to opt-in for watermarks for that reason.

## File layout

| File | Purpose |
|---|---|
| `Delogo.html` | Shell + CSS + script loader (cache-busted) |
| `app.jsx` | Top-level project/screen routing, Export screen, mock scenes |
| `editor.jsx` | Editor surface — regions, timeline, inspector, modals, detection wiring |
| `audio-notes.jsx` | Audio note timeline track, recorder modal, default note seeds |
| `detect.js` | Heuristic detectors: captions, logos, watermarks, audio pauses |
| `export.js` | FFmpeg-WASM export pipeline + polygon PNG mask generation |
| `scenes.jsx`, `tweaks-panel.jsx`, `icons.jsx`, `image-slot.js` | Original prototype scaffolding |
| `ffmpeg/` | Self-hosted FFmpeg-WASM bundle (gitignored — `setup.sh` recreates) |
