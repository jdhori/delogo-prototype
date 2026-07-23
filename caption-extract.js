/* caption-extract.js — burned-in caption → closed-caption converter.
 *
 * The replace-open-captions workflow, in two passes:
 *
 *   PASS 1 — identify + transcribe. Sample frames across the window, OCR the
 *   caption zone of each, and group consecutive samples whose text matches
 *   (fuzzy — OCR jitters) into ONE deduplicated cue. A caption that stays on
 *   screen for 3s across 4 samples yields a single cue, not four.
 *
 *   PASS 2 — geometry. Each cue accumulated the OCR word boxes of every
 *   sample that showed it. Cluster those boxes into text lines and emit
 *   removal shapes: a tight rectangle for single-line captions, a staircase
 *   POLYGON for multi-line captions whose lines differ in width (so the
 *   eraser doesn't bite into background the text never covered).
 *
 * Exposes: window.extractBurnedCaptions(videoElOrSrc, opts)
 *            → Promise<{ cues, regions, sampledFrames }>
 *
 *   cues:    [{ startSeconds, endSeconds, text, confidence }]
 *   regions: editor-shaped region objects (percent geometry, frame times)
 *
 *   opts.startSec / endSec   window to scan (default whole clip)
 *   opts.videoDurationSec    required when passing a URL
 *   opts.stepSec             sampling cadence (default 0.75s)
 *   opts.fps                 for region frame times (default 24)
 *   opts.zoneTopPct          caption zone starts at this % of height (default 55)
 *   opts.onProgress          ({stage, message, pct})
 *
 * Reuses the Tesseract loader pattern and frame-extractor lessons from
 * ocr.js (decode frames BEFORE spinning up the OCR worker — they fight).
 */

(function (global) {
  "use strict";

  let tesseractPromise = null;
  function loadTesseract() {
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
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

  // Normalized token set for fuzzy matching (OCR jitters on punctuation and
  // the odd character; token overlap is stable).
  function tokens(text) {
    return new Set(
      String(text).toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length > 1)
    );
  }
  function similarity(a, b) {
    const ta = tokens(a), tb = tokens(b);
    if (ta.size === 0 && tb.size === 0) return 1;
    if (ta.size === 0 || tb.size === 0) return 0;
    let inter = 0;
    for (const w of ta) if (tb.has(w)) inter++;
    return inter / (ta.size + tb.size - inter);
  }

  // Cluster word boxes into text lines by vertical proximity.
  function clusterLines(boxes) {
    const sorted = boxes.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    for (const b of sorted) {
      const cy = (b.y0 + b.y1) / 2;
      const h = b.y1 - b.y0;
      const line = lines.find((L) => Math.abs(cy - L.cy) < Math.max(6, h * 0.7));
      if (line) {
        line.x0 = Math.min(line.x0, b.x0); line.y0 = Math.min(line.y0, b.y0);
        line.x1 = Math.max(line.x1, b.x1); line.y1 = Math.max(line.y1, b.y1);
        line.cy = (line.y0 + line.y1) / 2;
      } else {
        lines.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, cy });
      }
    }
    return lines.sort((a, b) => a.y0 - b.y0);
  }

  // Staircase polygon around stacked line boxes (frame-percent points,
  // clockwise). Lets a two-line caption with a short bottom line be erased
  // without covering the background beside the short line.
  function staircasePolygon(linesPct) {
    const pts = [];
    // Down the right side, top line to bottom line…
    for (const L of linesPct) {
      pts.push({ x: L.x1, y: L.y0 });
      pts.push({ x: L.x1, y: L.y1 });
    }
    // …and back up the left side.
    for (let i = linesPct.length - 1; i >= 0; i--) {
      const L = linesPct[i];
      pts.push({ x: L.x0, y: L.y1 });
      pts.push({ x: L.x0, y: L.y0 });
    }
    return pts;
  }

  async function extractBurnedCaptions(videoOrSrc, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const stepSec = opts.stepSec ?? 0.75;
    const fps = opts.fps ?? 24;
    // Caption band = the bottom (100 - zoneTopPct)% of the frame. Tight by
    // default (bottom ~28%): captions live at the bottom, and OCRing the whole
    // lower-half swamps small caption text in unrelated pixels → garbage.
    const zoneTopPct = opts.zoneTopPct ?? 72;
    // OCR reads the caption band UPSCALED — the single biggest quality win on
    // low-resolution sources (a 450p clip's captions are only legible enlarged).
    const ocrScale = opts.ocrScale ?? 2.5;
    // Bright caption text → black-on-white. Gentler than the old 200 cutoff so
    // anti-aliased / shadowed glyph edges survive instead of shattering.
    const lumThreshold = opts.lumThreshold ?? 140;
    const minConfidence = opts.minConfidence ?? 45;
    const simThreshold = opts.simThreshold ?? 0.55;
    const rejoinGapSec = opts.rejoinGapSec ?? 1.2; // one bad OCR sample can't split a cue

    // ── Frame extraction (all frames FIRST — see ocr.js lesson) ──
    const isElement = videoOrSrc && typeof videoOrSrc === "object" && videoOrSrc.tagName === "VIDEO";
    const v = isElement ? videoOrSrc : null;
    if (!v) throw new Error("extractBurnedCaptions currently needs the editor's <video> element");
    if (v.readyState < 2) await new Promise((res) => v.addEventListener("canplay", res, { once: true }));

    const durationSec = opts.videoDurationSec || v.duration;
    const startSec = Math.max(0, opts.startSec ?? 0);
    const endSec = Math.min(durationSec, opts.endSec ?? durationSec);
    if (endSec <= startSec) throw new Error("Empty extraction window");

    // Percent geometry (pass 2) is computed against the NATIVE frame size, so
    // OCR box coords are mapped back to native pixels below.
    const W = v.videoWidth;
    const H = v.videoHeight;
    const bandY = Math.floor(H * (zoneTopPct / 100)); // top of the caption band, native px
    const bandH = H - bandY;
    // The band is drawn straight from the <video> at native resolution, then
    // enlarged ocrScale× into the OCR canvas.
    const ocrW = Math.max(2, Math.round(W * ocrScale));
    const ocrH = Math.max(2, Math.round(bandH * ocrScale));

    const times = [];
    for (let t = startSec + stepSec / 2; t < endSec; t += stepSec) times.push(t);

    const restoreTime = v.currentTime;
    const frames = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      onProgress({ stage: "extract", message: `Sampling frame ${i + 1}/${times.length}`, pct: Math.round((i / times.length) * 35) });
      v.currentTime = t;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (!v.seeking && Math.abs(v.currentTime - t) < 0.4) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      // Plain timeout, NOT requestAnimationFrame: rAF never fires in
      // occluded/backgrounded tabs and would hang the whole pass. drawImage
      // reads the decoded frame without needing the compositor anyway.
      await new Promise((r) => setTimeout(r, 120));
      // Draw the caption band from the video at native res, enlarged into the
      // OCR canvas; binarize (bright text → black on white) with a gentle
      // cutoff so small/soft glyphs survive.
      const zone = document.createElement("canvas");
      zone.width = ocrW; zone.height = ocrH;
      const zctx = zone.getContext("2d", { willReadFrequently: true });
      zctx.imageSmoothingEnabled = true;
      zctx.imageSmoothingQuality = "high";
      zctx.drawImage(v, 0, bandY, W, bandH, 0, 0, ocrW, ocrH);
      const d = zctx.getImageData(0, 0, ocrW, ocrH);
      const px = d.data;
      for (let p = 0; p < px.length; p += 4) {
        const lum = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
        const val = lum > lumThreshold ? 0 : 255;
        px[p] = px[p + 1] = px[p + 2] = val;
      }
      zctx.putImageData(d, 0, 0);
      frames.push({ t, dataUrl: zone.toDataURL("image/png") });
    }
    try { v.currentTime = restoreTime; } catch (_) {}

    // ── PASS 1: OCR + fuzzy grouping into deduplicated cues ──
    onProgress({ stage: "ocr", message: "Loading OCR engine…", pct: 36 });
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker("eng", undefined, { logger: () => {} });
    await worker.setParameters({ tessedit_pageseg_mode: "6" });

    const observations = []; // { t, text, confidence, boxes[] } — text "" when no caption
    try {
      for (let i = 0; i < frames.length; i++) {
        onProgress({ stage: "ocr", message: `Reading captions ${i + 1}/${frames.length}`, pct: 36 + Math.round((i / frames.length) * 44) });
        const img = new Image();
        img.src = frames[i].dataUrl;
        await new Promise((res) => { img.onload = res; });
        const c = document.createElement("canvas");
        c.width = ocrW; c.height = ocrH;
        c.getContext("2d").drawImage(img, 0, 0);
        const result = await worker.recognize(c);
        const words = (result?.data?.words || []).filter(
          (w) => (w.confidence ?? 0) >= minConfidence && (w.text || "").trim().length > 0
        );
        const text = words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
        const conf = words.length
          ? words.reduce((s, w) => s + w.confidence, 0) / words.length
          : 0;
        observations.push({
          t: frames[i].t,
          text: text.length >= 3 ? text : "",
          confidence: conf,
          // OCR boxes are in the upscaled band; map back to native frame px
          // (÷ ocrScale, then offset by the band's top) so pass-2 percent
          // geometry lines up with the real frame.
          boxes: words.map((w) => ({
            x0: w.bbox.x0 / ocrScale,
            y0: w.bbox.y0 / ocrScale + bandY,
            x1: w.bbox.x1 / ocrScale,
            y1: w.bbox.y1 / ocrScale + bandY,
          })),
        });
      }
    } finally {
      try { await worker.terminate(); } catch (_) {}
    }

    onProgress({ stage: "group", message: "Deduplicating captions…", pct: 82 });
    const cues = [];
    let cur = null;
    const close = () => { if (cur) { cues.push(cur); cur = null; } };
    for (const ob of observations) {
      if (!ob.text) {
        // Absence closes the cue — unless the very next sample resumes the
        // same text (handled by the rejoin check below on the next hit).
        if (cur && ob.t - cur.endSeconds > rejoinGapSec) close();
        continue;
      }
      if (cur && similarity(cur.text, ob.text) >= simThreshold) {
        cur.endSeconds = ob.t;
        cur.boxes.push(...ob.boxes);
        if (ob.confidence > cur.confidence) { cur.text = ob.text; cur.confidence = ob.confidence; }
        continue;
      }
      // Rejoin: a cue that "ended" a moment ago with the same text was a
      // dropped OCR sample, not a new caption — resume it (dedupe).
      const prev = cues[cues.length - 1];
      if (!cur && prev && ob.t - prev.endSeconds <= rejoinGapSec && similarity(prev.text, ob.text) >= simThreshold) {
        cur = cues.pop();
        cur.endSeconds = ob.t;
        cur.boxes.push(...ob.boxes);
        continue;
      }
      close();
      cur = { startSeconds: ob.t, endSeconds: ob.t, text: ob.text, confidence: ob.confidence, boxes: [...ob.boxes] };
    }
    close();

    // Pad cue edges by half a sample step (true boundaries sit between samples).
    for (const cue of cues) {
      cue.startSeconds = Math.max(startSec, +(cue.startSeconds - stepSec / 2).toFixed(3));
      cue.endSeconds = Math.min(endSec, +(cue.endSeconds + stepSec / 2).toFixed(3));
    }

    // ── PASS 2: removal shapes from the accumulated OCR geometry ──
    onProgress({ stage: "shapes", message: "Cutting removal shapes…", pct: 90 });
    const regions = [];
    const padXPct = 1.2, padYPct = 0.8;
    cues.forEach((cue, idx) => {
      if (cue.boxes.length === 0) return;
      const lines = clusterLines(cue.boxes).map((L) => ({
        x0: Math.max(0, (L.x0 / W) * 100 - padXPct),
        x1: Math.min(100, (L.x1 / W) * 100 + padXPct),
        y0: Math.max(0, (L.y0 / H) * 100 - padYPct),
        y1: Math.min(100, (L.y1 / H) * 100 + padYPct),
      }));
      const x0 = Math.min(...lines.map((L) => L.x0));
      const x1 = Math.max(...lines.map((L) => L.x1));
      const y0 = Math.min(...lines.map((L) => L.y0));
      const y1 = Math.max(...lines.map((L) => L.y1));
      const widths = lines.map((L) => L.x1 - L.x0);
      const staircase = lines.length > 1 && (Math.max(...widths) - Math.min(...widths)) > 15;

      const base = {
        id: `cc-${Date.now()}-${idx}`,
        name: `CC removal: "${cue.text.slice(0, 32)}${cue.text.length > 32 ? "…" : ""}"`,
        type: "caption", cls: "r-caption",
        method: "inpaint", opacity: 100, feather: 10, motion: "static", visible: true,
        startFrame: Math.floor(cue.startSeconds * fps),
        endFrame: Math.ceil(cue.endSeconds * fps),
        confidence: Math.min(0.95, cue.confidence / 100),
        x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      };
      if (staircase) {
        base.shape = "polygon";
        base.points = staircasePolygon(lines);
      }
      regions.push(base);
    });

    // Merge shapes of ADJACENT cues with near-identical geometry into one
    // block (region list stays reviewable); the cue list itself is never
    // merged — each caption stays its own subtitle.
    const merged = [];
    for (const r of regions) {
      const prev = merged[merged.length - 1];
      const closeGeom = prev && !prev.points && !r.points &&
        Math.abs(prev.y - r.y) < 3 && Math.abs(prev.h - r.h) < 4 &&
        Math.abs(prev.x - r.x) < 8 && Math.abs((prev.x + prev.w) - (r.x + r.w)) < 8;
      if (closeGeom && r.startFrame - prev.endFrame <= fps * 1.5) {
        prev.endFrame = r.endFrame;
        prev.x = Math.min(prev.x, r.x); prev.y = Math.min(prev.y, r.y);
        const px1 = Math.max(prev.x + prev.w, r.x + r.w);
        const py1 = Math.max(prev.y + prev.h, r.y + r.h);
        prev.w = px1 - prev.x; prev.h = py1 - prev.y;
        prev.name = "CC removal block";
      } else {
        merged.push({ ...r });
      }
    }

    onProgress({
      stage: "done",
      message: `${cues.length} caption${cues.length === 1 ? "" : "s"} → ${merged.length} removal shape${merged.length === 1 ? "" : "s"}`,
      pct: 100,
    });
    return {
      cues: cues.map(({ boxes, ...c }) => c),
      regions: merged,
      sampledFrames: frames.length,
      // Debug: raw per-sample OCR (text + confidence) feeding the dedup pass.
      _observations: observations.map((o) => ({ t: +o.t.toFixed(2), text: o.text, conf: Math.round(o.confidence) })),
    };
  }

  // ── SRT serializer (for download / soft-subtitle muxing) ──
  function cuesToSrt(cues) {
    const stamp = (sec) => {
      const ms = Math.max(0, Math.round(sec * 1000));
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
      const p = (n, l) => String(n).padStart(l, "0");
      return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(r, 3)}`;
    };
    return cues
      .slice().sort((a, b) => a.startSeconds - b.startSeconds)
      .map((c, i) => `${i + 1}\n${stamp(c.startSeconds)} --> ${stamp(c.endSeconds)}\n${c.text}\n`)
      .join("\n");
  }

  global.extractBurnedCaptions = extractBurnedCaptions;
  global.cuesToSrt = cuesToSrt;
})(typeof window !== "undefined" ? window : globalThis);
