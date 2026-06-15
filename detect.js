/* detect.js — heuristic caption + static-logo detector.
 *
 * Strategy: sample N evenly spaced frames from a <video>, draw each to an
 * offscreen <canvas>, then:
 *
 *   1. Find horizontal bands of high pixel-to-pixel luma contrast in the
 *      bottom half of each frame. Wide bands ≈ burned-in captions.
 *      Band height classifies 1-line vs 2-line.
 *
 *   2. For each corner (~20% × 15% of frame), count pixels that stay
 *      bright across most samples. Persistent-bright corners ≈ static logos.
 *
 *   3. Group consecutive sampled frames that share a caption band into a
 *      single time range so the region only "fires" while captions are
 *      actually on screen.
 *
 * No CV library. Pure ImageData arithmetic. ~5s on a 10-min video for 14
 * samples on a typical laptop. Fails on cross-origin videos without CORS
 * (canvas.getImageData throws SecurityError — caught and reported).
 *
 * Exposes: window.detectRegions(videoEl, opts) → Promise<Region[]>
 *   opts.sampleCount     default 14
 *   opts.analysisWidth   default 320  (downscale for speed)
 *   opts.onProgress      ({ stage, index, total, message }) callback
 *   opts.categories      { captions, logos } — enable/disable each detector branch (default both on)
 *   opts.startSeconds    only sample frames from this time onward (default 0)
 *   opts.endSeconds      only sample frames up to this time (default video.duration)
 *   opts.spatialBBox     { xPct, yPct, wPct, hPct } — restrict caption search to this rect (default whole frame)
 *
 * Also exposes: window.detectAudioPauses(videoSrcOrBlob, opts) → Promise<Opportunity[]>
 *   Scans the audio track for silent stretches that could host an audio
 *   description. Returns [{ startSeconds, endSeconds, durationSeconds }, ...].
 */

(function (global) {
  "use strict";

  function seekTo(video, t) {
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = t;
    });
  }

  // Per-row edge density in the bottom half. Returns the strongest contiguous
  // band (y0Pct, y1Pct, density) or null if none looks caption-shaped.
  function findCaptionBand(frame, w, h) {
    const data = frame.data;
    const bottomStart = Math.floor(h * 0.45);
    const edgeThreshold = 38; // luma diff between adjacent pixels
    const rowHotnessThreshold = 0.06; // fraction of edges per row to qualify

    const density = new Array(h - bottomStart);
    for (let y = bottomStart; y < h; y++) {
      let edges = 0;
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4;
        const j = (y * w + x - 1) * 4;
        const la = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const lb = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
        if (Math.abs(la - lb) > edgeThreshold) edges++;
      }
      density[y - bottomStart] = edges / w;
    }

    // Group contiguous "hot" rows (≥ 3 rows wide, allow 1-row gaps).
    const bands = [];
    let start = -1;
    let gap = 0;
    for (let k = 0; k <= density.length; k++) {
      const hot = k < density.length && density[k] > rowHotnessThreshold;
      if (hot) {
        if (start < 0) start = k;
        gap = 0;
      } else if (start >= 0) {
        gap++;
        if (gap > 1) {
          const len = k - gap - start;
          if (len >= 3) bands.push({ y0: bottomStart + start, y1: bottomStart + k - gap - 1, len });
          start = -1;
          gap = 0;
        }
      }
    }
    if (bands.length === 0) return null;
    bands.sort((a, b) => b.len - a.len);
    const b = bands[0];
    return {
      y0Pct: (b.y0 / h) * 100,
      y1Pct: (b.y1 / h) * 100,
      heightPct: ((b.y1 - b.y0) / h) * 100,
    };
  }

  /* Static watermark detector — finds persistent low-contrast structures
   * away from the corners (logos live there) and away from the bottom band
   * (burned-in captions live there). Watermarks tend to be:
   *   - semi-transparent → low pixel variance across frames AND mid-luma
   *   - off-corner       → sit in upper-mid or center of frame
   *   - text or graphic  → sufficient pixel density inside a tight bbox
   *
   * Returns { xPct, yPct, wPct, hPct, density } or null. Does NOT handle
   * floating/moving watermarks — those need optical-flow tracking, which
   * is a separate detector. For moving watermarks, the user draws + tracks.
   */
  function findStaticWatermark(samples, w, h) {
    // Search zone: skip 12% margins (corners are logo territory) and skip
    // the bottom 45% (caption territory).
    const xMin = Math.floor(w * 0.12);
    const xMax = Math.floor(w * 0.88);
    const yMin = Math.floor(h * 0.12);
    const yMax = Math.floor(h * 0.55);
    if (xMax <= xMin || yMax <= yMin) return null;

    const zoneW = xMax - xMin;
    const zoneH = yMax - yMin;
    const candidates = new Uint8Array(zoneW * zoneH);
    let candidateCount = 0;

    const varianceThreshold = 65;   // higher = less strict, more candidate pixels
    const lumaLo = 70, lumaHi = 210; // exclude near-black and near-white background

    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        // Compute luma at (x, y) across all samples → mean + variance.
        let sum = 0;
        for (let s = 0; s < samples.length; s++) {
          const i = (y * w + x) * 4;
          const d = samples[s].frame.data;
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
        const mean = sum / samples.length;
        let varSum = 0;
        for (let s = 0; s < samples.length; s++) {
          const i = (y * w + x) * 4;
          const d = samples[s].frame.data;
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          varSum += (l - mean) * (l - mean);
        }
        const variance = varSum / samples.length;
        if (variance < varianceThreshold && mean > lumaLo && mean < lumaHi) {
          candidates[(y - yMin) * zoneW + (x - xMin)] = 1;
          candidateCount++;
        }
      }
    }
    if (candidateCount < 80) return null; // too sparse to be a real watermark

    // Bounding box of all candidate pixels. (Lightweight — skips connected
    // component analysis which would be more accurate but slower.)
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (let y = 0; y < zoneH; y++) {
      for (let x = 0; x < zoneW; x++) {
        if (candidates[y * zoneW + x]) {
          if (x < bMinX) bMinX = x;
          if (y < bMinY) bMinY = y;
          if (x > bMaxX) bMaxX = x;
          if (y > bMaxY) bMaxY = y;
        }
      }
    }
    const bboxArea = (bMaxX - bMinX + 1) * (bMaxY - bMinY + 1);
    const zoneArea = zoneW * zoneH;
    // Reject huge bboxes (probably just the whole background having mid-luma).
    if (bboxArea > zoneArea * 0.45) return null;
    const density = candidateCount / bboxArea;
    if (density < 0.06) return null;

    return {
      xPct: ((bMinX + xMin) / w) * 100,
      yPct: ((bMinY + yMin) / h) * 100,
      wPct: ((bMaxX - bMinX + 1) / w) * 100,
      hPct: ((bMaxY - bMinY + 1) / h) * 100,
      density,
    };
  }

  // Find a corner where bright pixels persist across most samples.
  function findStaticLogo(samples, w, h) {
    const cw = Math.floor(w * 0.2);
    const ch = Math.floor(h * 0.18);
    const corners = [
      { name: "tl", x0: 0,           y0: 0,           xPct: 0,  yPct: 0  },
      { name: "tr", x0: w - cw,      y0: 0,           xPct: 80, yPct: 0  },
      { name: "bl", x0: 0,           y0: h - ch,      xPct: 0,  yPct: 82 },
      { name: "br", x0: w - cw,      y0: h - ch,      xPct: 80, yPct: 82 },
    ];
    const persistFrac = 0.7;
    const brightCutoff = 200;
    let best = null;
    for (const c of corners) {
      let persistent = 0;
      for (let yy = 0; yy < ch; yy++) {
        for (let xx = 0; xx < cw; xx++) {
          let brightCount = 0;
          for (let s = 0; s < samples.length; s++) {
            const i = ((c.y0 + yy) * w + (c.x0 + xx)) * 4;
            const d = samples[s].frame.data;
            const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            if (luma > brightCutoff) brightCount++;
          }
          if (brightCount >= samples.length * persistFrac) persistent++;
        }
      }
      const score = persistent / (cw * ch);
      if (score > 0.04 && (!best || score > best.score)) {
        best = { ...c, score };
      }
    }
    return best;
  }

  function groupCaptionRanges(bandsBySample, samples, totalDurationSec) {
    const regions = [];
    let runStart = -1;
    const pad = 0.3; // seconds of padding on each side of the run

    for (let i = 0; i <= bandsBySample.length; i++) {
      const present = i < bandsBySample.length && !!bandsBySample[i];
      if (present && runStart < 0) runStart = i;
      else if (!present && runStart >= 0) {
        const runEnd = i - 1;
        let y0 = 0, y1 = 0, n = 0;
        for (let k = runStart; k <= runEnd; k++) {
          if (!bandsBySample[k]) continue;
          y0 += bandsBySample[k].y0Pct;
          y1 += bandsBySample[k].y1Pct;
          n++;
        }
        if (n > 0) {
          y0 /= n; y1 /= n;
          const heightPct = y1 - y0;
          const lineCount = heightPct > 8 ? 2 : 1;
          const tStart = Math.max(0, samples[runStart].t - pad);
          const tEnd = Math.min(totalDurationSec, samples[runEnd].t + pad);
          regions.push({
            kind: "caption",
            lineCount,
            xPct: 5,
            yPct: Math.max(0, y0 - 1),
            wPct: 90,
            hPct: Math.max(heightPct + 2, 6),
            startSeconds: tStart,
            endSeconds: tEnd,
            confidence: Math.min(0.95, 0.55 + 0.08 * n),
          });
        }
        runStart = -1;
      }
    }
    return regions;
  }

  async function detectRegions(video, opts) {
    opts = opts || {};
    const sampleCount = opts.sampleCount || 14;
    const analysisWidth = opts.analysisWidth || 320;
    const onProgress = opts.onProgress || function () {};
    const categories = Object.assign({ captions: true, logos: true, watermarks: false }, opts.categories || {});

    if (!video.duration || !isFinite(video.duration) || !video.videoWidth) {
      throw new Error("Video metadata not loaded yet");
    }

    // Restrict to a time window when supplied. Falls back to the whole clip.
    const tStart = Math.max(0, opts.startSeconds ?? 0);
    const tEnd   = Math.min(video.duration, opts.endSeconds ?? video.duration);
    if (tEnd <= tStart) throw new Error("Empty detection window");

    const ratio = video.videoHeight / video.videoWidth;
    const w = analysisWidth;
    const h = Math.max(2, Math.round(analysisWidth * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const wasPlaying = !video.paused;
    const originalTime = video.currentTime;
    if (wasPlaying) video.pause();

    const samples = [];
    try {
      for (let i = 0; i < sampleCount; i++) {
        const t = tStart + ((tEnd - tStart) * (i + 0.5)) / sampleCount;
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, w, h);
        let frame;
        try {
          frame = ctx.getImageData(0, 0, w, h);
        } catch (e) {
          // Tainted canvas — cross-origin source without CORS headers.
          const err = new Error(
            "Auto-detect can't read pixel data from this video. " +
            "The source is cross-origin and doesn't allow CORS. " +
            "Upload the file directly, or use a CORS-enabled URL."
          );
          err.code = "CORS_TAINTED";
          err.cause = e;
          throw err;
        }
        samples.push({ t, frame });
        onProgress({
          stage: "sampling",
          index: i + 1,
          total: sampleCount,
          message: `Scanning frame ${i + 1} / ${sampleCount}`,
        });
      }
    } finally {
      try { video.currentTime = originalTime; } catch (_) {}
      if (wasPlaying) video.play().catch(() => {});
    }

    onProgress({ stage: "analyzing", index: 1, total: 1, message: "Classifying captions, logos, and watermarks…" });
    const bandsBySample = categories.captions ? samples.map((s) => findCaptionBand(s.frame, w, h)) : samples.map(() => null);
    const logoCorner = categories.logos ? findStaticLogo(samples, w, h) : null;
    const watermark = categories.watermarks ? findStaticWatermark(samples, w, h) : null;
    const captionRegions = categories.captions
      ? groupCaptionRanges(bandsBySample, samples, tEnd)
      : [];

    const out = [];
    if (logoCorner) {
      out.push({
        kind: "logo",
        cornerName: logoCorner.name,
        xPct: logoCorner.xPct,
        yPct: logoCorner.yPct,
        wPct: 20,
        hPct: 15,
        confidence: Math.min(0.99, 0.7 + logoCorner.score * 2),
      });
    }
    if (watermark) {
      // Pad the bbox slightly so the edges of semi-transparent text aren't
      // clipped — under-detection is more annoying than slight over-cover.
      const pad = 1.5;
      out.push({
        kind: "watermark",
        xPct: Math.max(0, watermark.xPct - pad),
        yPct: Math.max(0, watermark.yPct - pad),
        wPct: Math.min(100, watermark.wPct + pad * 2),
        hPct: Math.min(100, watermark.hPct + pad * 2),
        confidence: Math.min(0.95, 0.55 + watermark.density),
      });
    }
    out.push(...captionRegions);
    onProgress({ stage: "done", index: 1, total: 1, message: `Found ${out.length} region${out.length === 1 ? "" : "s"}` });
    return out;
  }

  /* ─── Audio pause detector ─────────────────────────────
   * Decodes the audio track, computes RMS amplitude per ~100ms window,
   * finds quiet stretches longer than `minDurationSec`, returns time
   * ranges that could host an audio description.
   *
   * Threshold is auto-calibrated against the median amplitude — works on
   * loud and quiet baselines without manual tuning. Fails clearly when the
   * source has no audio track or is blocked by CORS.
   */
  async function detectAudioPauses(videoSrc, opts) {
    opts = opts || {};
    const minDurationSec = opts.minDurationSec || 1.6;
    const windowMs = opts.windowMs || 100;
    const onProgress = opts.onProgress || function () {};

    onProgress({ stage: "decoding", message: "Decoding audio for pause analysis…" });
    let buffer;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("AudioContext not available in this browser");
      const ctx = new Ctx();
      const arrayBuf = await (await fetch(videoSrc)).arrayBuffer();
      buffer = await ctx.decodeAudioData(arrayBuf);
      try { ctx.close(); } catch (_) {}
    } catch (e) {
      // Likely causes: CORS-blocked source, no audio track, unsupported codec.
      throw new Error(`Audio decode failed: ${e.message || e}`);
    }

    const ch = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const windowSize = Math.round(sampleRate * windowMs / 1000);
    const windowCount = Math.floor(ch.length / windowSize);

    onProgress({ stage: "analyzing", message: "Scanning for silent stretches…" });
    const rmsByWindow = new Float32Array(windowCount);
    for (let i = 0; i < windowCount; i++) {
      let sumSq = 0;
      const start = i * windowSize;
      for (let j = 0; j < windowSize; j++) {
        const s = ch[start + j];
        sumSq += s * s;
      }
      rmsByWindow[i] = Math.sqrt(sumSq / windowSize);
    }

    // Median + adaptive threshold so both quiet and loud sources work.
    const sorted = Float32Array.from(rmsByWindow).sort();
    const median = sorted[Math.floor(sorted.length / 2)] || 0.01;
    const threshold = Math.max(0.015, median * 0.35);

    const minWindows = Math.ceil(minDurationSec * 1000 / windowMs);
    const opportunities = [];
    let runStart = -1;
    for (let i = 0; i <= rmsByWindow.length; i++) {
      const quiet = i < rmsByWindow.length && rmsByWindow[i] < threshold;
      if (quiet && runStart < 0) runStart = i;
      else if (!quiet && runStart >= 0) {
        const len = i - runStart;
        if (len >= minWindows) {
          opportunities.push({
            startSeconds: (runStart * windowMs) / 1000,
            endSeconds: (i * windowMs) / 1000,
            durationSeconds: (len * windowMs) / 1000,
          });
        }
        runStart = -1;
      }
    }

    onProgress({ stage: "done", message: `Found ${opportunities.length} pause opportunity${opportunities.length === 1 ? "" : "ies"}` });
    return opportunities;
  }

  global.detectRegions = detectRegions;
  global.detectAudioPauses = detectAudioPauses;
})(typeof window !== "undefined" ? window : globalThis);
