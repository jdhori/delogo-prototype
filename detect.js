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

  // Seek to t AND wait until a new frame is actually decoded and ready to
  // draw. The 'seeked' event alone is unreliable for offscreen / muted /
  // never-played videos because the browser may fire it before the
  // GPU-decoded frame is available — drawImage then captures the OLD
  // frame and every sampled "frame" looks identical to frame 0.
  //
  // requestVideoFrameCallback (Chrome 83+, Edge, Opera) is the modern
  // signal for "new frame is here". Fallback: 'seeked' + a small RAF
  // chain to let the compositor catch up.
  function seekTo(video, t) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };

      const useRVFC = typeof video.requestVideoFrameCallback === "function";
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        if (useRVFC) {
          video.requestVideoFrameCallback(() => finish());
        } else {
          // Two RAFs ≈ ~32ms; gives the compositor time to receive the
          // decoded frame before we read pixels off the canvas.
          requestAnimationFrame(() => requestAnimationFrame(finish));
        }
      };
      video.addEventListener("seeked", onSeeked);
      // Safety timeout — if neither seeked nor RVFC fires (very rare on
      // malformed sources), don't hang the whole scan.
      setTimeout(finish, 1500);
      video.currentTime = t;
    });
  }

  // Find caption bands in the bottom half of a frame, with per-band width
  // measurement. Returns an array of bands — empty if no caption present.
  // Each band represents one text line and includes its tight horizontal
  // extent so multi-line captions with different line widths get
  // individually-sized rectangles instead of one bbox over both lines.
  function findCaptionBands(frame, w, h) {
    const data = frame.data;
    const bottomStart = Math.floor(h * 0.45);
    const edgeThreshold = 38;
    const rowHotnessThreshold = 0.06;
    const colHotnessThreshold = 0.10; // for measuring band's horizontal extent

    // 1) Per-row edge density in the bottom half.
    const rowDensity = new Array(h - bottomStart);
    for (let y = bottomStart; y < h; y++) {
      let edges = 0;
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 4;
        const j = (y * w + x - 1) * 4;
        const la = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const lb = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
        if (Math.abs(la - lb) > edgeThreshold) edges++;
      }
      rowDensity[y - bottomStart] = edges / w;
    }

    // 2) Group contiguous "hot" rows into vertical bands (allow 1-row gap).
    const verticalBands = [];
    let start = -1, gap = 0;
    for (let k = 0; k <= rowDensity.length; k++) {
      const hot = k < rowDensity.length && rowDensity[k] > rowHotnessThreshold;
      if (hot) { if (start < 0) start = k; gap = 0; }
      else if (start >= 0) {
        gap++;
        if (gap > 1) {
          const len = k - gap - start;
          if (len >= 3) verticalBands.push({ y0: bottomStart + start, y1: bottomStart + k - gap - 1, len });
          start = -1; gap = 0;
        }
      }
    }
    if (verticalBands.length === 0) return [];

    // 3) For each vertical band, scan columns to find its true horizontal
    // extent. Text lines start where columns first show edge activity and
    // end at the last column with activity. This catches "short bottom
    // line" cases where a 2-line caption has uneven sentence lengths.
    const bands = [];
    for (const vb of verticalBands) {
      const bandHeight = vb.y1 - vb.y0 + 1;
      const colEdges = new Array(w).fill(0);
      for (let y = vb.y0; y <= vb.y1; y++) {
        for (let x = 1; x < w; x++) {
          const i = (y * w + x) * 4;
          const j = (y * w + x - 1) * 4;
          const la = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          const lb = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
          if (Math.abs(la - lb) > edgeThreshold) colEdges[x]++;
        }
      }
      // Normalize to fraction of band rows that have an edge in this column.
      const norm = colEdges.map((c) => c / bandHeight);

      // Find leftmost & rightmost column with sufficient density,
      // tolerating short gaps (single-column quiet spots between letters).
      let left = -1, right = -1;
      for (let x = 0; x < w; x++) if (norm[x] > colHotnessThreshold) { left = x; break; }
      for (let x = w - 1; x >= 0; x--) if (norm[x] > colHotnessThreshold) { right = x; break; }
      if (left < 0 || right < 0 || right - left < w * 0.05) continue; // too narrow

      bands.push({
        y0Pct: (vb.y0 / h) * 100,
        y1Pct: (vb.y1 / h) * 100,
        x0Pct: (left / w) * 100,
        x1Pct: (right / w) * 100,
        heightPct: (bandHeight / h) * 100,
        widthPct: ((right - left) / w) * 100,
      });
    }
    return bands;
  }

  // Backwards-compat: keep findCaptionBand returning the strongest band
  // as the older signature (some test paths and the legacy run-grouper
  // still consume it). Built on top of findCaptionBands.
  function findCaptionBand(frame, w, h) {
    const bands = findCaptionBands(frame, w, h);
    if (bands.length === 0) return null;
    bands.sort((a, b) => b.heightPct * b.widthPct - a.heightPct * a.widthPct);
    return bands[0];
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

  // Group consecutive samples that show captions into time ranges.
  // For multi-line captions we emit ONE region per text line so each line
  // gets its own measured width — the "short bottom line" case that's
  // common with multi-sentence captions. bandsListBySample is the new
  // shape: array of arrays of bands (each band = one text line).
  function groupCaptionRanges(bandsListBySample, samples, totalDurationSec) {
    const regions = [];
    let runStart = -1;
    const pad = 0.3;

    const presentAt = (i) => Array.isArray(bandsListBySample[i]) && bandsListBySample[i].length > 0;

    for (let i = 0; i <= bandsListBySample.length; i++) {
      const present = i < bandsListBySample.length && presentAt(i);
      if (present && runStart < 0) runStart = i;
      else if (!present && runStart >= 0) {
        const runEnd = i - 1;
        // Across the run, find the MAX line count seen in any sample and
        // average the geometry of each line slot. If frames show different
        // line counts (1 line vs 2 lines mid-run), we still output one
        // region per line up to the max — the per-line time bounds match
        // the whole run (sentence-change detection handles the time split).
        let maxLines = 0;
        for (let k = runStart; k <= runEnd; k++) maxLines = Math.max(maxLines, bandsListBySample[k]?.length || 0);
        if (maxLines === 0) { runStart = -1; continue; }

        // Build per-line aggregates. Bands within a sample are top-to-bottom
        // (sorted by y0 below) so line index 0 is always the topmost line.
        for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
          let y0 = 0, y1 = 0, x0 = 0, x1 = 0, n = 0;
          for (let k = runStart; k <= runEnd; k++) {
            const sorted = (bandsListBySample[k] || []).slice().sort((a, b) => a.y0Pct - b.y0Pct);
            const band = sorted[lineIdx];
            if (!band) continue;
            y0 += band.y0Pct; y1 += band.y1Pct;
            x0 += band.x0Pct; x1 += band.x1Pct;
            n++;
          }
          if (n === 0) continue;
          y0 /= n; y1 /= n; x0 /= n; x1 /= n;
          const heightPct = Math.max(y1 - y0 + 1, 4);
          const widthPct  = Math.max(x1 - x0 + 1, 6);
          const tStart = Math.max(0, samples[runStart].t - pad);
          const tEnd   = Math.min(totalDurationSec, samples[runEnd].t + pad);
          regions.push({
            kind: "caption",
            lineCount: maxLines,
            lineIndex: lineIdx,
            // Pad slightly on each side so feathered blur covers the edges.
            xPct: Math.max(0, x0 - 1.5),
            yPct: Math.max(0, y0 - 1),
            wPct: Math.min(100, widthPct + 3),
            hPct: heightPct + 2,
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

  // Build a coarse signature of a caption band's pixel content. Splits the
  // band into N horizontal cells and computes per-cell mean luma. Used to
  // detect when the caption text CHANGES (different sentence) vs stays
  // the same. Returns a Float32Array of length cellCount.
  function captionBandSignature(frame, w, h, band, cellCount) {
    cellCount = cellCount || 16;
    const sig = new Float32Array(cellCount);
    const y0 = Math.max(0, Math.floor((band.y0Pct / 100) * h));
    const y1 = Math.min(h - 1, Math.ceil((band.y1Pct / 100) * h));
    const x0 = Math.max(0, Math.floor((band.x0Pct / 100) * w));
    const x1 = Math.min(w - 1, Math.ceil((band.x1Pct / 100) * w));
    const bandW = x1 - x0 + 1;
    if (bandW <= 0 || y1 <= y0) return sig;
    const cellW = Math.max(1, Math.floor(bandW / cellCount));
    const data = frame.data;
    for (let c = 0; c < cellCount; c++) {
      const cx0 = x0 + c * cellW;
      const cx1 = Math.min(x1, cx0 + cellW - 1);
      let sum = 0, count = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = cx0; x <= cx1; x++) {
          const i = (y * w + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          count++;
        }
      }
      sig[c] = count > 0 ? sum / count : 0;
    }
    return sig;
  }

  // Cosine-distance-style change score between two signatures (0 = same,
  // higher = more different). Normalized RMS difference scaled to [0, 1].
  function signatureDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let sumSq = 0;
    for (let i = 0; i < a.length; i++) sumSq += (a[i] - b[i]) ** 2;
    return Math.sqrt(sumSq / a.length) / 255;
  }

  async function detectRegions(video, opts) {
    opts = opts || {};
    const sampleCount = opts.sampleCount || 14;
    const analysisWidth = opts.analysisWidth || 320;
    const onProgress = opts.onProgress || function () {};
    const categories = Object.assign({ captions: true, logos: true, watermarks: false }, opts.categories || {});
    // Dense sampling for sentence-change detection within caption windows.
    // Default ~1 sample per 1.5s of detected caption window. Bypass with 0.
    const sentenceSampleSecs = opts.sentenceSampleSecs ?? 1.2;

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
    // Per-sample multi-band caption detection: each entry is an array of
    // bands (one per text line). Empty array = no caption in this sample.
    const bandsListBySample = categories.captions
      ? samples.map((s) => findCaptionBands(s.frame, w, h))
      : samples.map(() => []);
    const logoCorner = categories.logos ? findStaticLogo(samples, w, h) : null;
    const watermark = categories.watermarks ? findStaticWatermark(samples, w, h) : null;
    const captionRegions = categories.captions
      ? groupCaptionRanges(bandsListBySample, samples, tEnd)
      : [];

    // ─── Sentence-change refinement pass ──────────────────
    // If captions were detected and dense sampling is enabled, walk each
    // caption region and densely sample frames inside it. When the
    // pixel-content signature of the caption band shifts substantially
    // between dense samples, split that one region into multiple shorter
    // regions — one per detected sentence.
    let refinedCaptionRegions = captionRegions;
    if (categories.captions && sentenceSampleSecs > 0 && captionRegions.length > 0) {
      onProgress({ stage: "sentence-pass", index: 1, total: 1, message: "Detecting sentence changes…" });
      refinedCaptionRegions = [];
      for (const cap of captionRegions) {
        // We only do sentence detection per LINE region; multi-line regions
        // already get one row each from groupCaptionRanges.
        const windowDur = cap.endSeconds - cap.startSeconds;
        const denseCount = Math.max(2, Math.ceil(windowDur / sentenceSampleSecs));
        if (denseCount < 3) { refinedCaptionRegions.push(cap); continue; }

        // Sample evenly across the window and record band signature each time.
        const dense = [];
        for (let i = 0; i < denseCount; i++) {
          const t = cap.startSeconds + ((i + 0.5) * windowDur) / denseCount;
          if (t < tStart || t > tEnd) continue;
          await seekTo(video, t);
          ctx.drawImage(video, 0, 0, w, h);
          let frame;
          try { frame = ctx.getImageData(0, 0, w, h); } catch (_) { continue; }
          const bands = findCaptionBands(frame, w, h);
          if (bands.length === 0) { dense.push({ t, present: false, sig: null }); continue; }
          // Match the band closest to this caption's vertical position
          // (lineIndex was lost in the cap shape; we have y0Pct on cap).
          bands.sort((a, b) => Math.abs(a.y0Pct - cap.yPct) - Math.abs(b.y0Pct - cap.yPct));
          const band = bands[0];
          dense.push({ t, present: true, sig: captionBandSignature(frame, w, h, band) });
        }

        // Walk dense samples; cut into sub-regions where signature distance
        // crosses a threshold (caption text changed). Also cut at absences.
        const changeThreshold = 0.06; // tuned roughly — 0.06 ≈ ~15 luma RMS
        const cuts = [];
        let runStart = -1, lastSig = null;
        for (let i = 0; i <= dense.length; i++) {
          const item = dense[i];
          const present = item && item.present;
          if (present && runStart < 0) { runStart = i; lastSig = item.sig; continue; }
          if (present && runStart >= 0) {
            const dist = signatureDistance(lastSig, item.sig);
            if (dist > changeThreshold) {
              // Sentence boundary: close current run, start new one HERE.
              cuts.push({ start: runStart, end: i - 1 });
              runStart = i;
            }
            lastSig = item.sig;
            continue;
          }
          // !present: close the current run if any.
          if (runStart >= 0) { cuts.push({ start: runStart, end: i - 1 }); runStart = -1; lastSig = null; }
        }

        // ─── Static-text rejection ─────────────────────────
        // If the band's signature never changes across dense samples AND
        // we got 3+ samples, this is almost certainly static on-screen text
        // (a title card, a lower-third graphic, persistent slide content) —
        // not a caption. Caption text changes when sentences change.
        //
        // We measure max signature distance across consecutive present
        // samples. A real caption typically shows ≥ 0.04 (≈ 10 luma RMS)
        // somewhere in the window; persistent text stays under that.
        const presentSigs = dense.filter((d) => d.present);
        if (presentSigs.length >= 3) {
          let maxAdjDist = 0;
          for (let k = 1; k < presentSigs.length; k++) {
            const dist = signatureDistance(presentSigs[k - 1].sig, presentSigs[k].sig);
            if (dist > maxAdjDist) maxAdjDist = dist;
          }
          // Threshold deliberately lower than the sentence-cut threshold
          // (0.06) so wobble from compression noise doesn't promote static
          // text to "caption". 0.025 ≈ 6 luma RMS.
          if (maxAdjDist < 0.025) {
            // Drop this region entirely — it's static text, leave it visible.
            continue;
          }
        }

        if (cuts.length <= 1) { refinedCaptionRegions.push(cap); continue; }

        // Emit one region per cut, geometry inherited from the parent cap.
        for (const c of cuts) {
          const cutStart = dense[c.start]?.t ?? cap.startSeconds;
          const cutEnd   = dense[c.end]?.t   ?? cap.endSeconds;
          refinedCaptionRegions.push({
            ...cap,
            startSeconds: Math.max(cap.startSeconds, cutStart - 0.2),
            endSeconds:   Math.min(cap.endSeconds,   cutEnd + 0.2),
          });
        }
      }
    }

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
    out.push(...refinedCaptionRegions);
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
