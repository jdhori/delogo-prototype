/* ocr.js — On-screen text gap analyzer for audio-description suggestions.
 *
 * Workflow (driven by the editor after Transcribe completes):
 *
 *   1. Look at the caption track. Find gaps between cues (and the head /
 *      tail of the clip) longer than `opts.minGapSec`.
 *   2. For each gap, sample a frame at its midpoint.
 *   3. Run Tesseract.js OCR on that frame.
 *   4. Take any text the OCR found, normalize it, and compare against
 *      the captions within ±`opts.coverageWindowSec` seconds. If the
 *      transcript already covers most of the words, no description is
 *      needed (the dialogue is talking about it). If it doesn't, surface
 *      it as a suggestion the user can accept as a draft audio
 *      description.
 *
 * Exposes: window.findUncoveredOnScreenText(videoSrc, captions, opts)
 *            → Promise<Suggestion[]>
 *
 *          where Suggestion = {
 *            startSeconds,        // gap start
 *            endSeconds,          // gap end
 *            sampleTime,          // exact frame we OCR'd
 *            detectedText,        // raw cleaned OCR result
 *            coverageRatio,       // [0..1] how much of OCR appears in transcript
 *            confidence,          // [0..100] Tesseract confidence
 *          }
 *
 * Tesseract is heavy. Defaults cap total samples at 10. Each sample takes
 * ~1-3 s. Language data (~10 MB English) downloads once and caches.
 *
 * CORS rules same as the rest of the editor — needs to be able to fetch
 * the video or read pixels from an attached <video>.
 */

(function (global) {
  "use strict";

  // ─── Tesseract.js lazy loader ───────────────────────────
  let tesseractPromise = null;
  function loadTesseract() {
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      // If the script is already on the page (manual include), grab it.
      if (global.Tesseract) return resolve(global.Tesseract);
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      s.async = true;
      s.onload = () => global.Tesseract ? resolve(global.Tesseract) : reject(new Error("Tesseract loaded but global is missing"));
      s.onerror = () => reject(new Error("Failed to load Tesseract.js from CDN"));
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  // ─── Caption gap detection ──────────────────────────────
  // Returns sorted gaps where audio descriptions could fit. A gap is the
  // interval between consecutive cue ends and the next cue start, plus
  // any head/tail dead time. Pre-sort sorts captions so callers don't
  // have to.
  function findCaptionGaps(captions, videoDurationSec, minGapSec) {
    if (!captions || captions.length === 0) {
      // Whole clip is one giant "gap" if there are no captions at all.
      return videoDurationSec >= minGapSec
        ? [{ startSeconds: 0, endSeconds: videoDurationSec }]
        : [];
    }
    const sorted = [...captions].sort((a, b) => a.startSeconds - b.startSeconds);
    const gaps = [];
    // Head gap.
    if (sorted[0].startSeconds >= minGapSec) {
      gaps.push({ startSeconds: 0, endSeconds: sorted[0].startSeconds });
    }
    // Inter-cue gaps.
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].startSeconds - sorted[i].endSeconds;
      if (gap >= minGapSec) {
        gaps.push({ startSeconds: sorted[i].endSeconds, endSeconds: sorted[i + 1].startSeconds });
      }
    }
    // Tail gap.
    const last = sorted[sorted.length - 1];
    if (videoDurationSec - last.endSeconds >= minGapSec) {
      gaps.push({ startSeconds: last.endSeconds, endSeconds: videoDurationSec });
    }
    return gaps;
  }

  // ─── Coverage check ─────────────────────────────────────
  // Returns [0..1] — fraction of "meaningful" OCR words that appear
  // somewhere in captions inside the time window. Words of length ≤ 3
  // are ignored (the/and/of/etc) since they don't distinguish content.
  function coverageRatio(ocrText, captions, atSeconds, windowSec) {
    if (!ocrText) return 1; // nothing to cover
    const words = ocrText.toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.length === 0) return 1;

    const t0 = atSeconds - windowSec;
    const t1 = atSeconds + windowSec;
    const relevant = captions.filter((c) => c.endSeconds >= t0 && c.startSeconds <= t1);
    const haystack = relevant
      .map((c) => c.text)
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ");

    if (!haystack.trim()) return 0;
    const found = words.filter((w) => haystack.includes(w)).length;
    return found / words.length;
  }

  // ─── Frame extraction helper ────────────────────────────
  // Accepts either:
  //   - an existing <video> element (preferred — already warm in the
  //     editor, no fetch/decode overhead, fast seeks), OR
  //   - a videoSrc URL (creates a hidden <video> as a fallback)
  // Returns a Promise<{ seekAndDraw, dispose, dims }>.
  async function makeFrameExtractor(videoOrSrc, maxWidth) {
    const isElement = videoOrSrc && typeof videoOrSrc === "object" && videoOrSrc.tagName === "VIDEO";
    let v, ownedVideo = false, ownedBlobUrl = null;

    if (isElement) {
      v = videoOrSrc;
      if (v.readyState < 2) {
        await new Promise((res) => v.addEventListener("canplay", res, { once: true }));
      }
    } else {
      // Pre-fetch into a blob URL so seeks are instant.
      let usableSrc = videoOrSrc;
      try {
        const blob = await (await fetch(videoOrSrc)).blob();
        usableSrc = URL.createObjectURL(blob);
        ownedBlobUrl = usableSrc;
      } catch (_) { /* fall back to streaming */ }

      v = document.createElement("video");
      v.src = usableSrc;
      v.muted = true;
      v.preload = "auto";
      // Append fully-visible (no styling) — browsers throttle decoding
      // of off-screen or zero-opacity/zero-size videos, which stretches
      // every cold seek to many seconds. A brief flash of the OCR video
      // on screen during the analysis is acceptable for the prototype.
      document.body.appendChild(v);
      ownedVideo = true;

      await new Promise((res, rej) => {
        v.addEventListener("canplay", res, { once: true });
        v.addEventListener("error", () => rej(new Error("Video load failed for OCR")), { once: true });
      });
      // Warmup: brief play+pause forces the decoder out of cold state.
      // Without this, the FIRST deep seek can take 30+ s on this server
      // — even though the standalone test (which HAS this warmup) seeks
      // the same time in <100 ms. The whole pipeline hinges on this.
      try { await v.play(); v.pause(); } catch (_) {}
    }

    const w = maxWidth || 960;
    const h = Math.round(w * v.videoHeight / v.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function seekAndDraw(t) {
      // Polling beats event listening here. In this environment 'seeked'
      // events sometimes never reach our listener even though the seek
      // visibly completed (`v.currentTime` matches the target,
      // `v.seeking` is false). Poll the video state directly — slightly
      // less efficient but actually reliable.
      v.currentTime = t;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (!v.seeking && Math.abs(v.currentTime - t) < 0.5) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (Math.abs(v.currentTime - t) >= 0.5) {
        throw new Error(`seek to ${t.toFixed(1)}s timed out (30 s) — at ${v.currentTime.toFixed(1)}s`);
      }
      // Compositor needs a tick to present the decoded frame.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      ctx.drawImage(v, 0, 0, w, h);
      return canvas;
    }

    function dispose() {
      if (ownedVideo) { try { document.body.removeChild(v); } catch (_) {} }
      if (ownedBlobUrl) { try { URL.revokeObjectURL(ownedBlobUrl); } catch (_) {} }
    }
    return { seekAndDraw, dispose, dims: { w, h } };
  }

  // ─── Main entrypoint ────────────────────────────────────
  async function findUncoveredOnScreenText(videoSrc, captions, opts) {
    opts = opts || {};
    const minGapSec        = opts.minGapSec ?? 3;
    const maxSamples       = opts.maxSamples ?? 10;
    const coverageThreshold = opts.coverageThreshold ?? 0.4;
    const minConfidence    = opts.minConfidence ?? 55;
    const minTextChars     = opts.minTextChars ?? 4;
    const coverageWindowSec = opts.coverageWindowSec ?? 15;
    const videoDurationSec = opts.videoDurationSec || 0;
    const onProgress       = opts.onProgress || function () {};
    // Prefer an existing warm <video> element (caller's editor video).
    // Falls back to fetching videoSrc and building a hidden element.
    const videoEl          = opts.videoEl || null;

    if (!videoEl && !videoSrc) throw new Error("No video source or element supplied");
    if (!videoDurationSec) throw new Error("Video duration required (pass opts.videoDurationSec)");

    onProgress({ stage: "gaps", message: "Finding transcript gaps…", pct: 0 });
    const allGaps = findCaptionGaps(captions, videoDurationSec, minGapSec);
    if (allGaps.length === 0) {
      onProgress({ stage: "done", message: "No transcript gaps to scan", pct: 100 });
      return [];
    }
    // Prioritize longer gaps — they're more likely to host description-worthy moments.
    const gaps = allGaps.slice().sort((a, b) =>
      (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds)
    ).slice(0, maxSamples);

    // ─── PHASE 1: extract all frames first ────────────────
    // Done BEFORE loading Tesseract because Tesseract spins up a Web
    // Worker that competes for resources with the <video> decoder, and
    // in practice seeks on a freshly-loaded hidden video stop firing
    // 'seeked' events once the worker is active. Decouple the two
    // phases entirely — get pixel data first, recognize second.
    onProgress({ stage: "extract", message: "Loading video for frame extraction…", pct: 0 });
    const extractor = await makeFrameExtractor(videoEl || videoSrc, 960);
    const extractedFrames = [];
    try {
      for (let i = 0; i < gaps.length; i++) {
        const g = gaps[i];
        const sampleTime = (g.startSeconds + g.endSeconds) / 2;
        onProgress({
          stage: "extract",
          message: `Extracting frame ${i + 1}/${gaps.length} at ${sampleTime.toFixed(1)}s`,
          pct: Math.round((i / gaps.length) * 50),
        });
        try {
          const canvas = await extractor.seekAndDraw(sampleTime);
          // Copy pixels off the shared canvas so they survive the next seek.
          const w = canvas.width, h = canvas.height;
          const dataUrl = canvas.toDataURL("image/png");
          extractedFrames.push({ gap: g, sampleTime, dataUrl, w, h });
        } catch (seekErr) {
          onProgress({ stage: "extract", message: `Skipped ${i + 1}/${gaps.length}: ${seekErr.message}`, pct: Math.round((i / gaps.length) * 50) });
        }
      }
    } finally {
      extractor.dispose();
    }

    if (extractedFrames.length === 0) {
      onProgress({ stage: "done", message: "No frames extracted", pct: 100 });
      return [];
    }

    // ─── PHASE 2: load Tesseract and OCR each extracted frame ─
    onProgress({ stage: "loading", message: `Loading OCR engine for ${extractedFrames.length} frame${extractedFrames.length === 1 ? "" : "s"}…`, pct: 50 });
    let Tesseract;
    try { Tesseract = await loadTesseract(); }
    catch (e) { throw new Error("OCR engine could not load: " + e.message); }

    const worker = await Tesseract.createWorker("eng", undefined, { logger: () => {} });
    await worker.setParameters({ tessedit_pageseg_mode: "11" });

    function binarizeForOCR(canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const v = lum > 200 ? 0 : 255;
        px[i] = px[i + 1] = px[i + 2] = v;
      }
      ctx.putImageData(d, 0, 0);
    }

    const suggestions = [];
    try {
      for (let i = 0; i < extractedFrames.length; i++) {
        const fr = extractedFrames[i];
        onProgress({
          stage: "ocr",
          message: `OCR ${i + 1}/${extractedFrames.length} at ${fr.sampleTime.toFixed(1)}s`,
          pct: 50 + Math.round((i / extractedFrames.length) * 50),
        });

        // Re-create a canvas from the saved dataURL for OCR.
        const img = new Image();
        img.src = fr.dataUrl;
        await new Promise((res) => img.onload = res);
        const c = document.createElement("canvas");
        c.width = fr.w; c.height = fr.h;
        c.getContext("2d").drawImage(img, 0, 0);
        binarizeForOCR(c);

        const result = await worker.recognize(c);
        const raw = (result?.data?.text || "").trim();
        const confidence = result?.data?.confidence ?? 0;
        if (!raw || raw.replace(/\s/g, "").length < minTextChars) continue;
        if (confidence < minConfidence) continue;

        const cleaned = raw.replace(/\s+/g, " ").replace(/[|]/g, "I").trim();
        const cov = coverageRatio(cleaned, captions, fr.sampleTime, coverageWindowSec);
        if (cov < coverageThreshold) {
          suggestions.push({
            startSeconds: fr.gap.startSeconds,
            endSeconds: fr.gap.endSeconds,
            sampleTime: fr.sampleTime,
            detectedText: cleaned,
            coverageRatio: cov,
            confidence,
          });
        }
      }
    } finally {
      try { await worker.terminate(); } catch (_) {}
    }

    onProgress({
      stage: "done",
      message: `${suggestions.length} description suggestion${suggestions.length === 1 ? "" : "s"} from ${gaps.length} gap${gaps.length === 1 ? "" : "s"}`,
      pct: 100,
    });
    return suggestions;
  }

  global.findUncoveredOnScreenText = findUncoveredOnScreenText;
  // Exported for tests/debugging
  global._ocrInternals = { findCaptionGaps, coverageRatio };
})(typeof window !== "undefined" ? window : globalThis);
