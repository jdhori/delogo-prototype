"""Region-removal processors.

Two backends share one entry point, `process(...)`:

  * "delogo"     — ffmpeg's delogo filter. No PyTorch, no weights. Weak quality
                   (edge interpolation) but exercises the full job contract so
                   the browser wiring can be verified before the GPU model is in.
  * "propainter" — deep video inpainting on the GPU. Marked integration point;
                   left as a stub so the dependency-heavy install is opt-in.

Geometry note: region coordinates in the spec are PERCENT of frame (0..100),
matching the editor's model. We convert to pixels here using spec.width/height.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Callable, Optional

OnProgress = Callable[[str, int, str], None]


def active_processor() -> str:
    return os.environ.get("DELOGO_PROCESSOR", "delogo").strip().lower()


def process(
    input_path: Path,
    spec: dict,
    output_path: Path,
    on_progress: OnProgress,
) -> None:
    # Audio-description jobs carry notes instead of (or besides) regions and
    # produce an MKV with a second, user-selectable "described" audio track.
    if spec.get("task") == "describe":
        _process_describe(input_path, spec, output_path, on_progress)
        return
    if spec.get("task") == "upscale":
        _process_upscale(input_path, spec, output_path, on_progress)
        return
    name = active_processor()
    if name == "delogo":
        _process_delogo(input_path, spec, output_path, on_progress)
    elif name == "propainter":
        _process_propainter(input_path, spec, output_path, on_progress)
    else:
        raise ValueError(f"unknown DELOGO_PROCESSOR: {name!r}")


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _region_bbox_px(region: dict, width: int, height: int) -> tuple[int, int, int, int]:
    """Bounding box (x, y, w, h) in pixels covering the region across all keyframes.

    The delogo filter takes one static rectangle, so for keyframed regions we use
    the union of every keyframe box — a superset that fully covers the moving
    region. (ProPainter gets the true per-frame mask instead.)
    """
    frames = region.get("keyframes") or [region]
    xs0, ys0, xs1, ys1 = [], [], [], []
    for f in frames:
        x = float(f.get("x", region.get("x", 0)))
        y = float(f.get("y", region.get("y", 0)))
        w = float(f.get("w", region.get("w", 0)))
        h = float(f.get("h", region.get("h", 0)))
        xs0.append(x)
        ys0.append(y)
        xs1.append(x + w)
        ys1.append(y + h)
    x0 = min(xs0) / 100.0 * width
    y0 = min(ys0) / 100.0 * height
    x1 = max(xs1) / 100.0 * width
    y1 = max(ys1) / 100.0 * height
    # delogo interpolates inward from the pixels *surrounding* the rectangle,
    # so ffmpeg rejects any box that touches a frame edge. Keep the box
    # strictly inside: x,y >= 1 and x+w <= width-1 / y+h <= height-1.
    px = min(max(1, int(round(x0))), width - 3)
    py = min(max(1, int(round(y0))), height - 3)
    pw = max(1, min(int(round(x1 - x0)), width - px - 1))
    ph = max(1, min(int(round(y1 - y0)), height - py - 1))
    return px, py, pw, ph


def _region_time_bounds(region: dict, spec: dict) -> tuple[Optional[float], Optional[float]]:
    """Active window (startSec, endSec) for one region.

    Per-region bounds win; the job-level timeRange is the fallback so older
    specs keep working. (None, None) means "active for the whole clip".
    """
    time_range = spec.get("timeRange") or {}
    start = region.get("startSec", time_range.get("startSec"))
    end = region.get("endSec", time_range.get("endSec"))
    if start is None or end is None:
        return None, None
    start_f, end_f = float(start), float(end)
    if end_f <= start_f:
        return None, None
    return start_f, end_f


# ---------------------------------------------------------------------------
# ffmpeg delogo stub
# ---------------------------------------------------------------------------


def _process_delogo(
    input_path: Path,
    spec: dict,
    output_path: Path,
    on_progress: OnProgress,
) -> None:
    width = int(spec["width"])
    height = int(spec["height"])
    regions = spec["regions"]

    on_progress("rendering-mask", 5, f"Mapping {len(regions)} region(s)")

    # One delogo filter per region, each gated to its active time window with
    # a timeline `enable` expression. The output is the FULL-LENGTH video —
    # captions are erased (background interpolated over them) only while their
    # window is active. We deliberately do NOT -ss/-to trim: trimming returned
    # a chopped clip instead of a cleaned one.
    filters = []
    for r in regions:
        x, y, w, h = _region_bbox_px(r, width, height)
        f = f"delogo=x={x}:y={y}:w={w}:h={h}"
        start, end = _region_time_bounds(r, spec)
        if start is not None:
            # Quotes keep the commas inside between() out of the filter-chain
            # parser's hands (args go straight to ffmpeg, no shell involved).
            f += f":enable='between(t,{start:.3f},{end:.3f})'"
        filters.append(f)
    vf = ",".join(filters)

    cmd = ["ffmpeg", "-y", "-i", str(input_path)]

    # Replacement closed captions: when the spec carries an SRT (built from
    # the editor's cue list — e.g. OCR-extracted from the burned-in text
    # being erased), mux it as a soft, toggleable subtitle track. The open
    # captions come OFF the pixels; the same text rides along as real CC.
    srt_text = (spec.get("subtitlesSrt") or "").strip()
    srt_path = None
    if srt_text:
        srt_path = output_path.parent / "subs.srt"
        srt_path.write_text(srt_text + "\n", encoding="utf-8")
        cmd += ["-i", str(srt_path)]

    cmd += [
        "-vf", vf,
        "-map", "0:v", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "copy",
    ]
    if srt_path:
        cmd += [
            "-map", "1:s",
            "-c:s", "mov_text",
            "-metadata:s:s:0", "language=eng",
            # mp4 names tracks via handler_name (title works for mkv)
            "-metadata:s:s:0", "handler_name=Replacement captions",
            "-metadata:s:s:0", "title=Replacement captions",
        ]
    cmd += [str(output_path)]

    on_progress("inpainting", 30, "Running ffmpeg delogo")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{proc.stderr[-2000:]}")
    on_progress("encoding", 95, "Finalising output")


# ---------------------------------------------------------------------------
# Upscaling — Real-ESRGAN when installed, Lanczos resample fallback
# ---------------------------------------------------------------------------


def _upscale_engine() -> str:
    """Pick the upscaler: realesrgan (super-resolution) > lanczos (resample).

    Override with DELOGO_UPSCALER=realesrgan|lanczos. Real-ESRGAN needs the
    ncnn-vulkan binary on PATH (or REALESRGAN_BIN pointing at it).
    """
    forced = os.environ.get("DELOGO_UPSCALER", "").strip().lower()
    if forced:
        return forced
    import shutil as _shutil

    if _shutil.which(os.environ.get("REALESRGAN_BIN", "realesrgan-ncnn-vulkan")):
        return "realesrgan"
    return "lanczos"


def _probe_video(input_path: Path) -> tuple[int, int, str]:
    """(width, height, avg_frame_rate) of the first video stream."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate", "-of", "csv=p=0",
         str(input_path)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed:\n{proc.stderr[-500:]}")
    width, height, fps = proc.stdout.strip().split("\n")[0].split(",")[:3]
    return int(width), int(height), fps


def _process_upscale(
    input_path: Path,
    spec: dict,
    output_path: Path,
    on_progress: OnProgress,
) -> None:
    """Upscale the whole clip. spec: { task: "upscale", scale? , targetHeight?, sharpen? }.

    scale (2/3/4) multiplies the resolution; targetHeight fits to a height
    (e.g. 1080, 2160) preserving aspect. Real-ESRGAN reconstructs detail
    (slow, per-frame, GPU); the Lanczos fallback is a high-quality resample
    that works everywhere ffmpeg does.
    """
    scale = float(spec.get("scale") or 0)
    target_h = int(spec.get("targetHeight") or 0)
    if not scale and not target_h:
        raise ValueError("upscale needs 'scale' (2/3/4) or 'targetHeight' (e.g. 1080)")

    src_w, src_h, fps = _probe_video(input_path)
    if target_h and not scale:
        scale = target_h / src_h
    if scale <= 1.0:
        raise ValueError(
            f"target resolution is not larger than the source ({src_w}x{src_h}); "
            "nothing to upscale"
        )
    out_h = target_h or int(round(src_h * scale))
    out_h -= out_h % 2  # encoder needs even dimensions

    engine = _upscale_engine()
    if engine == "realesrgan":
        _upscale_realesrgan(input_path, output_path, scale, out_h, fps, on_progress)
    elif engine == "lanczos":
        on_progress("upscaling", 20, f"Lanczos resample {src_w}x{src_h} → height {out_h}")
        vf = f"scale=-2:{out_h}:flags=lanczos"
        if spec.get("sharpen"):
            vf += ",unsharp=5:5:0.4:5:5:0.0"
        cmd = [
            "ffmpeg", "-y", "-i", str(input_path),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            str(output_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg upscale failed:\n{proc.stderr[-2000:]}")
        on_progress("encoding", 95, "Finalising upscaled video")
    else:
        raise ValueError(f"unknown DELOGO_UPSCALER: {engine!r}")


def _upscale_realesrgan(
    input_path: Path,
    output_path: Path,
    scale: float,
    out_h: int,
    fps: str,
    on_progress: OnProgress,
) -> None:
    """Frame-wise Real-ESRGAN super-resolution.

    Disk-hungry: extracts every frame as PNG (roughly 2-6 MB per 1080p frame),
    so budget several GB of scratch for long clips.
    """
    import shutil as _shutil
    import tempfile

    binary = os.environ.get("REALESRGAN_BIN", "realesrgan-ncnn-vulkan")
    model = os.environ.get("REALESRGAN_MODEL", "realesrgan-x4plus")
    # ncnn build accepts integer 2/3/4; round up then downscale to target.
    ncnn_scale = max(2, min(4, int(-(-scale // 1))))

    with tempfile.TemporaryDirectory(dir=output_path.parent) as tmp:
        frames_in = Path(tmp) / "in"
        frames_out = Path(tmp) / "out"
        frames_in.mkdir()
        frames_out.mkdir()

        on_progress("extracting", 10, "Extracting frames")
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", str(input_path), str(frames_in / "%06d.png")],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"frame extraction failed:\n{proc.stderr[-1000:]}")

        on_progress("upscaling", 30, f"Real-ESRGAN x{ncnn_scale} ({model})")
        proc = subprocess.run(
            [binary, "-i", str(frames_in), "-o", str(frames_out),
             "-s", str(ncnn_scale), "-n", model],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"realesrgan failed:\n{(proc.stderr or proc.stdout)[-1000:]}")

        on_progress("encoding", 75, "Re-encoding upscaled frames")
        proc = subprocess.run(
            ["ffmpeg", "-y",
             "-framerate", fps, "-i", str(frames_out / "%06d.png"),
             "-i", str(input_path),
             "-map", "0:v", "-map", "1:a?",
             "-vf", f"scale=-2:{out_h}:flags=lanczos",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
             "-pix_fmt", "yuv420p",
             "-c:a", "copy",
             str(output_path)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"re-encode failed:\n{proc.stderr[-1000:]}")
    on_progress("encoding", 95, "Finalising upscaled video")


# ---------------------------------------------------------------------------
# Audio descriptions — TTS synthesis + described-track mux
# ---------------------------------------------------------------------------


def _tts_backend() -> str:
    """Pick the TTS engine: piper > espeak-ng > tone (testing placeholder).

    Override with DELOGO_TTS=piper|espeak|tone. Piper needs PIPER_VOICE set to
    a .onnx voice model path (see server/README.md).
    """
    forced = os.environ.get("DELOGO_TTS", "").strip().lower()
    if forced:
        return forced
    import shutil as _shutil

    if _shutil.which(os.environ.get("PIPER_BIN", "piper")) and os.environ.get("PIPER_VOICE"):
        return "piper"
    if _shutil.which("espeak-ng"):
        return "espeak"
    return "tone"


def _synthesize_note(text: str, wav_path: Path, backend: str) -> None:
    """Render one description to a WAV file with the chosen engine."""
    if backend == "piper":
        proc = subprocess.run(
            [
                os.environ.get("PIPER_BIN", "piper"),
                "--model", os.environ["PIPER_VOICE"],
                "--output_file", str(wav_path),
            ],
            input=text, text=True, capture_output=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"piper failed: {proc.stderr[-500:]}")
    elif backend == "espeak":
        proc = subprocess.run(
            ["espeak-ng", "-w", str(wav_path), text],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"espeak-ng failed: {proc.stderr[-500:]}")
    elif backend == "tone":
        # Placeholder so the mux pipeline is testable before a TTS engine is
        # installed: a soft beep sized roughly to the reading time of the text.
        dur = max(1.5, min(12.0, len(text) * 0.06))
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi",
                # sine generates at a fixed 1/8 amplitude (~-21 dB); lift it
                # to speech-like level so the placeholder is clearly audible.
                "-i", f"sine=frequency=660:duration={dur:.2f}",
                "-af", "volume=10dB", str(wav_path),
            ],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"tone synth failed: {proc.stderr[-500:]}")
    else:
        raise ValueError(f"unknown DELOGO_TTS backend: {backend!r}")


def _process_describe(
    input_path: Path,
    spec: dict,
    output_path: Path,
    on_progress: OnProgress,
) -> None:
    """Mux an audio-description track into an MKV.

    Output track layout (the user's "trigger" is the player's audio-track menu):
      0: video               — stream-copied
      1: original audio      — stream-copied, default
      2: "Audio Description" — original ducked to 25% under each description,
                               flagged visual_impaired+descriptions so players
                               list it as an AD track.

    Notes with mode "pause" cannot pause a linear file; they are mixed like
    overlay notes. (True extended AD would insert freeze-frames — future work.)
    """
    notes = [n for n in spec.get("notes", []) if (n.get("text") or "").strip()]
    if not notes:
        raise ValueError("describe task needs spec.notes with at least one text note")
    notes.sort(key=lambda n: float(n.get("startSec", 0)))

    backend = _tts_backend()
    on_progress("tts", 5, f"Synthesizing {len(notes)} description(s) via {backend}")

    work = output_path.parent
    wavs: list[tuple[float, Path]] = []
    for i, note in enumerate(notes):
        wav = work / f"note_{i}.wav"
        _synthesize_note(note["text"].strip(), wav, backend)
        wavs.append((max(0.0, float(note.get("startSec", 0))), wav))
        on_progress("tts", 5 + int(40 * (i + 1) / len(notes)), f"Synthesized note {i + 1}/{len(notes)}")

    # Duck the original under each description window (window length = the
    # synthesized WAV's real duration, probed via ffprobe).
    windows = []
    for start, wav in wavs:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(wav)],
            capture_output=True, text=True,
        )
        dur = float(probe.stdout.strip() or "2")
        windows.append((start, start + dur))
    duck_expr = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in windows)

    parts = [f"[0:a]volume=0.25:enable='{duck_expr}'[ducked]"]
    for i, (start, _wav) in enumerate(wavs):
        ms = int(round(start * 1000))
        parts.append(
            f"[{i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
            f"adelay={ms}|{ms}[n{i}]"
        )
    mix_inputs = "[ducked]" + "".join(f"[n{i}]" for i in range(len(wavs)))
    parts.append(f"{mix_inputs}amix=inputs={len(wavs) + 1}:duration=first:normalize=0[admix]")
    filter_complex = ";".join(parts)

    cmd = ["ffmpeg", "-y", "-i", str(input_path)]
    for _start, wav in wavs:
        cmd += ["-i", str(wav)]
    cmd += [
        "-filter_complex", filter_complex,
        "-map", "0:v", "-c:v", "copy",
        "-map", "0:a", "-c:a:0", "copy",
        "-map", "[admix]", "-c:a:1", "aac", "-b:a:1", "192k",
        "-metadata:s:a:0", "title=Original audio",
        "-metadata:s:a:1", "title=Audio Description",
        "-metadata:s:a:1", "language=eng",
        "-disposition:a:0", "default",
        "-disposition:a:1", "visual_impaired+descriptions",
        "-f", "matroska",
        str(output_path),
    ]

    on_progress("muxing", 60, "Muxing described MKV (video stream-copied)")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg describe mux failed:\n{proc.stderr[-2000:]}")
    for _start, wav in wavs:
        wav.unlink(missing_ok=True)
    on_progress("encoding", 95, "Finalising described MKV")


# ---------------------------------------------------------------------------
# ProPainter (deep video inpainting) — integration point
# ---------------------------------------------------------------------------


def _process_propainter(
    input_path: Path,
    spec: dict,
    output_path: Path,
    on_progress: OnProgress,
) -> None:
    """Real high-quality path. Wire this once weights + torch are installed.

    Plan (matching ProPainter's CLI / inference_propainter.py):
      1. Decode the (already trimmed) upload to RGB frames.
      2. Render a per-frame binary mask by interpolating each region's keyframes
         to every frame timestamp and rasterising the rectangles (with feather).
         Reuse _region_bbox_px's percent->pixel mapping but PER FRAME, not union.
      3. Optionally crop to the union bbox (+ margin) so the model only sees the
         affected sub-rectangle — the single biggest VRAM/speed win on a 12 GB
         card. Composite the cleaned crop back into the original frames.
      4. Call ProPainter with VRAM-fitting args (see README): resize_ratio,
         subvideo_length, neighbor_length, fp16. Emit on_progress per chunk.
      5. Re-encode frames -> output_path (libx264, copy audio from input).

    Until implemented, fail loudly so it's obvious the model isn't wired yet.
    """
    propainter_dir = Path(os.environ.get("PROPAINTER_DIR", "../ProPainter"))
    raise NotImplementedError(
        "ProPainter processor is not wired yet. "
        f"Clone it to {propainter_dir} (or set PROPAINTER_DIR), install torch + "
        "the commented deps in requirements.txt, then implement _process_propainter "
        "at the integration point in processor.py. Run with DELOGO_PROCESSOR=delogo "
        "to use the ffmpeg stub in the meantime."
    )
