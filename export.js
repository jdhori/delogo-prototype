/* export.js — burn regions into a downloadable MP4 using FFmpeg-WASM.
 *
 * One public function:
 *   window.runExport({ videoSrc, regions, fps, onProgress, onLog, signal })
 *     → Promise<{ blob, filename, log }>
 *
 * Pipeline:
 *   1. Lazy-load @ffmpeg/ffmpeg (ESM) + @ffmpeg/core (ST) from unpkg on first call.
 *      Result cached on window.__ffmpegReady so subsequent exports skip loading.
 *   2. Fetch videoSrc as a Blob. Works for blob: URLs (uploads) and any
 *      same-origin or CORS-friendly HTTP(S) URL. Throws clearly on CORS failure.
 *   3. Build a filter_complex graph. Regions with an erase method (delogo /
 *      inpaint) run ffmpeg's delogo filter — background interpolated over the
 *      text. Blur-method and polygon regions get split → crop → boxblur →
 *      overlay. Every filter is gated with enable='between(t,start,end)' so
 *      it only applies during the region's [startFrame, endFrame] window.
 *   4. Run ffmpeg with libx264 + audio copy. Stream progress via onProgress.
 *   5. Read the output as Uint8Array → wrap in Blob → return.
 *
 * Limitations:
 *   - Audio descriptions (text-only notes) are NOT mixed in. Notes don't carry
 *     audio data in this prototype, and synthesizing TTS to a mixable audio
 *     track in the browser is unreliable. The modal in editor.jsx surfaces this
 *     to the user; we just don't touch the audio stream here beyond copying.
 *   - Single-thread FFmpeg core (no cross-origin isolation required). A 10-min
 *     1080p clip will take roughly 8–15 min on a typical laptop. Multi-thread
 *     core needs COOP/COEP headers which the dev server doesn't set.
 *   - libx264 only. No HEVC / AV1 in the WASM core.
 */

(function (global) {
  "use strict";

  // Self-hosted FFmpeg-WASM bundle. Files were copied from unpkg into
  // /ffmpeg so the browser sees everything (including the spawned Worker
  // and the core .wasm) as same-origin. Cross-origin Workers + WASM through
  // dynamic ESM imports were initializing inconsistently in some browsers,
  // even with toBlobURL re-hosting — colocating fixes it deterministically.
  const FFMPEG_ESM = `/ffmpeg/ffmpeg.js`;
  const UTIL_ESM   = `/ffmpeg/util/index.js`;
  const CORE_BASE  = `/ffmpeg`;
  const WORKER_URL = `/ffmpeg/worker.js`;

  async function ensureFFmpeg(onProgress, onLog) {
    if (global.__ffmpegReady) return global.__ffmpegReady;
    onProgress && onProgress({ phase: "loading", message: "Downloading FFmpeg core (~31 MB)…", pct: 0 });

    // Dynamic import keeps the rest of the app non-module while still loading
    // the ESM-only ffmpeg packages. Module specifier must be an absolute URL.
    const ffmpegMod = await import(/* @vite-ignore */ FFMPEG_ESM);
    const utilMod   = await import(/* @vite-ignore */ UTIL_ESM);
    const { FFmpeg } = ffmpegMod;
    const { fetchFile, toBlobURL } = utilMod;

    const ffmpeg = new FFmpeg();
    if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));

    onProgress && onProgress({ phase: "loading", message: "Initializing FFmpeg…", pct: 50 });

    // toBlobURL re-hosts the .js + .wasm + worker.js so the browser treats
    // them as same-origin (required for spawning a Worker and instantiating
    // WASM from a cross-origin CDN). classWorkerURL points at the @ffmpeg/ffmpeg
    // package's internal worker that hosts the WASM instance — without this
    // override the constructor tries to load it from unpkg, which the browser
    // refuses ("Script at ... cannot be accessed from origin ...").
    // Same-origin URLs: no toBlobURL gymnastics needed. The Worker
    // constructor accepts a same-origin module URL directly.
    await ffmpeg.load({
      coreURL:        `${CORE_BASE}/ffmpeg-core.js`,
      wasmURL:        `${CORE_BASE}/ffmpeg-core.wasm`,
      classWorkerURL: WORKER_URL,
    });

    const ready = { ffmpeg, fetchFile };
    global.__ffmpegReady = ready;
    onProgress && onProgress({ phase: "loading", message: "FFmpeg ready.", pct: 100 });
    return ready;
  }

  // Escape commas / colons inside enable= expressions for FFmpeg filter parsing.
  function esc(n) { return Number(n).toFixed(3); }

  // Compute the polygon's bounding box in percent space.
  function polyBBox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // Build a PNG mask the size of the polygon's bounding box: white inside
  // the polygon, black outside. Used as a luminance source for alphamerge so
  // boxblur stays confined to the actual polygon shape, not its bbox rect.
  async function makePolygonMaskPNG(points, bbox, bboxPx) {
    if (typeof OffscreenCanvas === "undefined") {
      // Older browsers: fall back to a regular canvas. Slightly slower; same result.
      const c = document.createElement("canvas");
      c.width = bboxPx.w; c.height = bboxPx.h;
      const ctx = c.getContext("2d");
      drawMask(ctx, points, bbox, bboxPx);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      return new Uint8Array(await blob.arrayBuffer());
    }
    const canvas = new OffscreenCanvas(bboxPx.w, bboxPx.h);
    const ctx = canvas.getContext("2d");
    drawMask(ctx, points, bbox, bboxPx);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }

  function drawMask(ctx, points, bbox, bboxPx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, bboxPx.w, bboxPx.h);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = ((p.x - bbox.x) / bbox.w) * bboxPx.w;
      const py = ((p.y - bbox.y) / bbox.h) * bboxPx.h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  }

  // Pre-compute per-region geometry so the rest of the pipeline doesn't
  // recompute it three times. Returns an array of
  // { r, isPoly, erase, bbox, bboxPx, delogoPx, t0, t1, radius }.
  function planRegions(regions, vw, vh, fps, totalSeconds) {
    return regions
      .filter((r) => r.visible !== false && r.method !== "none")
      .map((r) => {
        const isPoly = r.shape === "polygon" && Array.isArray(r.points) && r.points.length >= 3;
        const bbox = isPoly ? polyBBox(r.points) : { x: r.x, y: r.y, w: r.w, h: r.h };
        const w = Math.max(2, Math.min(vw, Math.round((bbox.w / 100) * vw)));
        const h = Math.max(2, Math.min(vh, Math.round((bbox.h / 100) * vh)));
        const x = Math.max(0, Math.min(vw - w, Math.round((bbox.x / 100) * vw)));
        const y = Math.max(0, Math.min(vh - h, Math.round((bbox.y / 100) * vh)));
        const radius = Math.max(5, Math.min(20, Math.round(Math.min(w, h) / 12)));
        const t0 = esc(Math.max(0, (r.startFrame ?? 0) / fps));
        const t1 = esc(Math.min(totalSeconds, (r.endFrame ?? Number.MAX_SAFE_INTEGER) / fps));
        // Rect regions whose method asks for removal (not blurring) go
        // through ffmpeg's delogo filter — background interpolated over the
        // text. delogo needs its rect strictly INSIDE the frame (it reads
        // the pixels surrounding the box), so clamp to x,y >= 1 and
        // x+w <= vw-1 / y+h <= vh-1 or ffmpeg rejects the filter.
        const dx = Math.min(Math.max(1, x), vw - 3);
        const dy = Math.min(Math.max(1, y), vh - 3);
        const dw = Math.max(1, Math.min(w, vw - dx - 1));
        const dh = Math.max(1, Math.min(h, vh - dy - 1));
        const erase = !isPoly && (r.method === "delogo" || r.method === "inpaint");
        return {
          r, isPoly, erase, bbox,
          bboxPx: { x, y, w, h },
          delogoPx: { x: dx, y: dy, w: dw, h: dh },
          radius, t0, t1,
        };
      });
  }

  // Build a filter_complex graph. For polygon regions, expects PNG masks
  // pre-written as mask_0.png, mask_1.png, ... matching `polyIndex` order
  // and present as ffmpeg inputs 1..N (input 0 is the video).
  function buildFilterGraph(plans) {
    if (plans.length === 0) return null;
    const erasePlans = plans.filter((p) => p.erase);
    const blurPlans = plans.filter((p) => !p.erase);
    const parts = [];

    // Step 0: erase-method regions (delogo / inpaint) run ffmpeg's delogo
    // directly on the main stream, each gated to its time window. This
    // ERASES the text — background interpolated over it — instead of the
    // old behavior of blurring everything.
    let base = "0:v";
    if (erasePlans.length > 0) {
      const chain = erasePlans
        .map((p) => `delogo=x=${p.delogoPx.x}:y=${p.delogoPx.y}:w=${p.delogoPx.w}:h=${p.delogoPx.h}:enable='between(t\\,${p.t0}\\,${p.t1})'`)
        .join(",");
      const outLabel = blurPlans.length === 0 ? "v" : "base";
      parts.push(`[${base}]${chain}[${outLabel}]`);
      base = outLabel;
    }
    if (blurPlans.length === 0) return parts.join(";");

    // Step 1: split the (possibly delogo'd) stream into base + one branch
    // per blur region.
    const branches = blurPlans.map((_, i) => `[r${i}]`);
    parts.push(`[${base}]split=${blurPlans.length + 1}[bg]${branches.join("")}`);

    // Step 2: each blur region produces a labeled fragment "f{i}".
    let polyMaskInputIdx = 1; // PNG mask inputs come right after the video.
    blurPlans.forEach((p, i) => {
      const { isPoly, bboxPx, radius } = p;
      if (isPoly) {
        // Crop the polygon's bounding box, blur it, force RGBA, then alphamerge
        // with the polygon-shaped luma mask so blur only appears inside the
        // actual polygon shape (not the rectangular bbox).
        parts.push(`[r${i}]crop=${bboxPx.w}:${bboxPx.h}:${bboxPx.x}:${bboxPx.y},boxblur=${radius}:1,format=yuva420p[bk${i}]`);
        parts.push(`[${polyMaskInputIdx}:v]format=gray,scale=${bboxPx.w}:${bboxPx.h}[mk${i}]`);
        parts.push(`[bk${i}][mk${i}]alphamerge[f${i}]`);
        polyMaskInputIdx++;
      } else {
        parts.push(`[r${i}]crop=${bboxPx.w}:${bboxPx.h}:${bboxPx.x}:${bboxPx.y},boxblur=${radius}:1[f${i}]`);
      }
    });

    // Step 3: chain overlays. Each fragment overlays back at its bbox origin,
    // gated to its time window via enable='between(t,start,end)'.
    let last = "bg";
    blurPlans.forEach((p, i) => {
      const next = i === blurPlans.length - 1 ? "v" : `t${i}`;
      parts.push(`[${last}][f${i}]overlay=${p.bboxPx.x}:${p.bboxPx.y}:enable='between(t\\,${p.t0}\\,${p.t1})'[${next}]`);
      last = next;
    });
    return parts.join(";");
  }

  async function fetchAsBlob(src) {
    let res;
    try {
      res = await fetch(src);
    } catch (e) {
      const err = new Error(`Couldn't fetch the source video. Network or CORS error: ${e.message}`);
      err.code = "FETCH_FAILED";
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Source video returned HTTP ${res.status}`);
      err.code = "HTTP_ERROR";
      throw err;
    }
    return await res.blob();
  }

  async function runExport(opts) {
    const {
      videoSrc, regions = [], fps = 24,
      videoWidth, videoHeight, durationSec,
      onProgress = () => {},
      onLog = () => {},
      signal,
    } = opts || {};

    if (!videoSrc) throw new Error("runExport: videoSrc required");
    if (!videoWidth || !videoHeight) throw new Error("runExport: videoWidth/Height required (read from <video>.videoWidth / .videoHeight)");
    if (!durationSec) throw new Error("runExport: durationSec required (read from <video>.duration)");

    const { ffmpeg, fetchFile } = await ensureFFmpeg(onProgress, onLog);

    if (signal?.aborted) throw new Error("Cancelled");

    onProgress({ phase: "fetching", message: "Fetching source video…", pct: 0 });
    const sourceBlob = await fetchAsBlob(videoSrc);
    onProgress({ phase: "fetching", message: `Fetched ${(sourceBlob.size / (1024 * 1024)).toFixed(1)} MB`, pct: 100 });

    if (signal?.aborted) throw new Error("Cancelled");

    // Plan once. Splits visible regions into rects vs polygons and pre-computes
    // pixel geometry / time windows for both the filter graph and mask gen.
    const plans = planRegions(regions, videoWidth, videoHeight, fps, durationSec);
    const filter = buildFilterGraph(plans);
    const polyPlans = plans.filter((p) => p.isPoly);

    // Write the source into FFmpeg's MEMFS.
    onProgress({ phase: "preparing", message: "Preparing source…", pct: 0 });
    const buf = await fetchFile(sourceBlob);
    await ffmpeg.writeFile("input.mp4", buf);

    // Generate + write a PNG mask per polygon region. Mask geometry matches
    // the polygon's bounding box exactly, so the filter graph's crop +
    // alphamerge dimensions align without per-pixel rescaling.
    if (polyPlans.length > 0) {
      onProgress({ phase: "preparing", message: `Building ${polyPlans.length} polygon mask${polyPlans.length === 1 ? "" : "s"}…`, pct: 50 });
      for (let i = 0; i < polyPlans.length; i++) {
        const p = polyPlans[i];
        const pngBytes = await makePolygonMaskPNG(p.r.points, p.bbox, p.bboxPx);
        await ffmpeg.writeFile(`mask_${i}.png`, pngBytes);
      }
    }

    // Wire ffmpeg's progress events.
    const progressHandler = ({ progress }) => {
      // progress is 0..1 for the encode step
      onProgress({ phase: "encoding", message: `Encoding… ${Math.round(progress * 100)}%`, pct: Math.round(progress * 100) });
    };
    ffmpeg.on("progress", progressHandler);

    // Build args. If no filter is needed, fall back to a plain remux.
    // Each polygon region adds one mask PNG input (right after the video).
    const args = ["-i", "input.mp4"];
    for (let i = 0; i < polyPlans.length; i++) args.push("-i", `mask_${i}.png`);
    if (filter) {
      args.push("-filter_complex", filter, "-map", "[v]", "-map", "0:a?");
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p");
      args.push("-c:a", "copy");
    } else {
      args.push("-c", "copy");
    }
    args.push("output.mp4");

    onProgress({ phase: "encoding", message: filter ? "Encoding with blur overlays…" : "Remuxing (no regions)…", pct: 0 });

    try {
      await ffmpeg.exec(args);
    } finally {
      ffmpeg.off("progress", progressHandler);
    }

    if (signal?.aborted) throw new Error("Cancelled");

    onProgress({ phase: "finalizing", message: "Reading output…", pct: 0 });
    const data = await ffmpeg.readFile("output.mp4");
    const blob = new Blob([data.buffer], { type: "video/mp4" });

    // Best-effort cleanup so subsequent exports don't pile up in MEMFS.
    try { await ffmpeg.deleteFile("input.mp4"); } catch (_) {}
    try { await ffmpeg.deleteFile("output.mp4"); } catch (_) {}
    for (let i = 0; i < polyPlans.length; i++) {
      try { await ffmpeg.deleteFile(`mask_${i}.png`); } catch (_) {}
    }

    const filename = `delogo-export-${Date.now()}.mp4`;
    onProgress({ phase: "done", message: `Done · ${(blob.size / (1024 * 1024)).toFixed(1)} MB`, pct: 100 });
    return { blob, filename };
  }

  global.runExport = runExport;
})(typeof window !== "undefined" ? window : globalThis);
