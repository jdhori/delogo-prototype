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
