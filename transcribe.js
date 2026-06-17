/* transcribe.js — Whisper-in-browser caption generator.
 *
 * Wraps @xenova/transformers (a.k.a. transformers.js) to run Whisper-tiny
 * entirely in the browser via WASM. First-run downloads the model
 * (~75 MB for whisper-tiny.en quantized) into IndexedDB; subsequent runs
 * pull straight from cache.
 *
 * Exposes: window.runWhisperCaption(videoSrc, opts) → Promise<Cue[]>
 *   Cue = { startSeconds, endSeconds, text }
 *
 *   opts.model        default "Xenova/whisper-tiny.en"
 *                       — use "Xenova/whisper-base.en" for higher quality
 *                         (≈ 145 MB) or "Xenova/whisper-small.en" (≈ 480 MB).
 *   opts.onProgress   ({ stage, message, pct }) callback
 *
 * Why an ESM CDN import inside a dynamically-loaded script:
 *   The rest of the app is plain UMD scripts (no bundler). transformers.js
 *   only ships as ESM. We can't use a top-level <script type="module"> for
 *   the whole app, so this file does a dynamic ESM `import()` from the
 *   classic-script global scope, which browsers DO support.
 *
 * CORS rules: same as the rest of the editor. Audio is decoded via fetch
 * + AudioContext, which means cross-origin video sources need CORS
 * headers. Uploaded files (blob: URLs) and same-origin files always work.
 */

(function (global) {
  "use strict";

  // M:SS formatter — keeps progress messages readable.
  function fmt(sec) {
    if (!isFinite(sec)) return "?";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Decode the video's audio track to a mono 16 kHz Float32Array
  // (Whisper's native sample rate). Web Audio resampling handles the
  // conversion from whatever the source's sample rate happens to be.
  //
  // Optional startSeconds/endSeconds clip the output to just a time
  // window so a user can transcribe one section of a long video without
  // re-running Whisper over the whole thing.
  async function decodeAudioForWhisper(src, startSec, endSec) {
    const Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!Ctx) throw new Error("OfflineAudioContext unavailable in this browser");

    const arrayBuf = await (await fetch(src)).arrayBuffer();
    // Decode at the source's native rate first, then resample to 16 kHz.
    const tempCtx = new (global.AudioContext || global.webkitAudioContext)();
    let decoded;
    try {
      decoded = await tempCtx.decodeAudioData(arrayBuf);
    } finally {
      try { tempCtx.close(); } catch (_) {}
    }

    const targetRate = 16000;
    const fullDur = decoded.duration;
    const t0 = Math.max(0, startSec ?? 0);
    const t1 = Math.min(fullDur, endSec ?? fullDur);
    if (t1 <= t0) throw new Error("Empty time window for transcription");
    const clipDur = t1 - t0;

    const offCtx = new Ctx(1, Math.ceil(clipDur * targetRate), targetRate);
    const src1 = offCtx.createBufferSource();
    src1.buffer = decoded;
    src1.connect(offCtx.destination);
    // start(when, offset, duration) — read from t0 for clipDur seconds.
    src1.start(0, t0, clipDur);
    const rendered = await offCtx.startRendering();
    return { audio: rendered.getChannelData(0), offsetSeconds: t0 };
  }

  let pipelinePromise = null;
  async function loadPipeline(modelName, onProgress) {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (async () => {
      // Dynamic ESM import from CDN. Pinned to a known-good version.
      const { pipeline, env } = await import(
        "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js"
      );
      // Force WASM backend even if WebGPU exists — broadest support
      // across the kinds of browsers customers might run on.
      env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
      const transcriber = await pipeline("automatic-speech-recognition", modelName, {
        progress_callback: (p) => {
          if (!onProgress) return;
          // p.status: "download" | "progress" | "done" etc.
          if (p.status === "progress" && typeof p.progress === "number") {
            onProgress({
              stage: "downloading",
              message: `Downloading model · ${(p.progress).toFixed(0)}%`,
              pct: p.progress,
            });
          } else if (p.status === "ready") {
            onProgress({ stage: "ready", message: "Model loaded", pct: 100 });
          }
        },
      });
      return transcriber;
    })();
    return pipelinePromise;
  }

  async function runWhisperCaption(videoSrc, opts) {
    opts = opts || {};
    const modelName = opts.model || "Xenova/whisper-tiny.en";
    const onProgress = opts.onProgress || function () {};
    const startSeconds = opts.startSeconds;
    const endSeconds   = opts.endSeconds;

    if (!videoSrc) throw new Error("No video source supplied");

    const rangeLabel = (startSeconds != null || endSeconds != null)
      ? ` (range ${fmt(startSeconds || 0)}–${endSeconds != null ? fmt(endSeconds) : "end"})`
      : "";
    onProgress({ stage: "decoding", message: `Decoding audio${rangeLabel}…`, pct: 0 });
    let audio, offsetSeconds = 0;
    try {
      const decoded = await decodeAudioForWhisper(videoSrc, startSeconds, endSeconds);
      audio = decoded.audio;
      offsetSeconds = decoded.offsetSeconds;
    } catch (e) {
      throw new Error(
        "Could not decode audio. Cross-origin videos without CORS headers " +
        "can't be processed in the browser — upload the file, or proxy it. " +
        "(" + (e.message || e) + ")"
      );
    }

    onProgress({ stage: "loading", message: "Loading speech model (cached after first run)…", pct: 0 });
    const transcriber = await loadPipeline(modelName, onProgress);

    onProgress({ stage: "transcribing", message: "Transcribing… (1-2× real-time)", pct: 0 });
    // return_timestamps:true gives us per-segment start/end seconds, which
    // is the difference between "subtitles" and "one big paragraph".
    const result = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });

    onProgress({ stage: "post", message: "Splitting into cues…", pct: 95 });
    // result.chunks: [{ timestamp: [start, end], text }, ...]
    // Whisper's timestamps are relative to the clipped audio buffer; shift
    // by offsetSeconds so cue times match the ORIGINAL video timeline.
    const cues = (result.chunks || [])
      .filter((c) => c.text && c.text.trim().length > 0)
      .map((c) => ({
        startSeconds: (c.timestamp?.[0] ?? 0) + offsetSeconds,
        endSeconds:   (c.timestamp?.[1] ?? ((c.timestamp?.[0] ?? 0) + 2)) + offsetSeconds,
        text: c.text.trim(),
      }))
      // Sanity: end > start, drop zero-duration or NaN entries.
      .filter((c) => isFinite(c.startSeconds) && isFinite(c.endSeconds) && c.endSeconds > c.startSeconds);

    onProgress({ stage: "done", message: `Generated ${cues.length} cue${cues.length === 1 ? "" : "s"}`, pct: 100 });
    return cues;
  }

  global.runWhisperCaption = runWhisperCaption;
})(typeof window !== "undefined" ? window : globalThis);
