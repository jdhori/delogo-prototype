/* global React, Icons, detectRegions */
// editor.jsx — main editor with detect / draw / track / compare modes.
// Exposes: window.Editor

const { useState, useEffect, useRef, useCallback, useMemo } = React;
const I = () => Icons;

/* ─── Auto-detect glue ────────────────────────────────────
 * Converts a raw detector result (xPct/yPct/wPct/hPct + startSeconds/endSeconds)
 * into the editor's Region shape, then runs the heuristic detector against the
 * supplied video element. Returns the new regions or throws on failure. */
const cornerName = (n) => ({ tl: "top-left", tr: "top-right", bl: "bottom-left", br: "bottom-right" }[n] || n);

function detectionToRegions(detected, fps, totalSeconds) {
  return detected.map((d, idx) => {
    if (d.kind === "logo") {
      // Logos: corner-anchored, opaque, "delogo" inpaint method works best
      // (carries surrounding color/texture inward). Heavy feather since
      // logos sit against varied backgrounds.
      return {
        id: `auto-logo-${idx + 1}`,
        name: `Network logo (auto · ${cornerName(d.cornerName)})`,
        type: "logo", cls: "r-logo",
        x: d.xPct, y: d.yPct, w: d.wPct, h: d.hPct,
        method: "delogo", opacity: 100, feather: 8,
        motion: "static", visible: true,
        startFrame: 0, endFrame: Math.floor(totalSeconds * fps),
        confidence: d.confidence,
      };
    }
    if (d.kind === "watermark") {
      // Watermarks: usually semi-transparent text over body of frame.
      // Default to blur (the original under-content is still mostly visible,
      // so blur is less jarring than inpaint here). Wider feather to soften
      // the rectangular boundary on transparent edges.
      return {
        id: `auto-watermark-${idx + 1}`,
        name: `Watermark (auto)`,
        type: "watermark", cls: "r-watermark",
        x: d.xPct, y: d.yPct, w: d.wPct, h: d.hPct,
        method: "blur", opacity: 100, feather: 14,
        motion: "static", visible: true,
        startFrame: 0, endFrame: Math.floor(totalSeconds * fps),
        confidence: d.confidence,
      };
    }
    // Captions now come one-per-line. lineCount tells us how many lines
    // were detected together; lineIndex (0 = top) identifies this region.
    const lineLabel = d.lineCount > 1
      ? `line ${d.lineIndex + 1} of ${d.lineCount}`
      : "1 line";
    return {
      id: `auto-caption-${idx + 1}`,
      name: `Burned-in caption (auto · ${lineLabel})`,
      type: "caption", cls: "r-caption",
      x: d.xPct, y: d.yPct, w: d.wPct, h: d.hPct,
      method: "inpaint", opacity: 100, feather: 12,
      motion: "static", visible: true,
      startFrame: Math.floor(d.startSeconds * fps),
      endFrame: Math.ceil(d.endSeconds * fps),
      confidence: d.confidence,
    };
  });
}

/* ─── Sample data ─────────────────────────────────────── */

// Region geometry is stored as percentages of the video frame.
// Time bounds are in frames (assuming 24fps the whole clip is 7200 frames = 5 min).
const DEFAULT_REGIONS = [
  {
    id: "r1",
    name: "TV Network Logo",
    type: "logo",
    cls: "r-logo",
    x: 86, y: 4, w: 11, h: 9,
    method: "delogo",
    opacity: 100,
    feather: 8,
    motion: "static",
    visible: true,
    // Static logo is present the entire clip
    startFrame: 0, endFrame: 7200,
    confidence: 0.97,
  },
  {
    id: "r2",
    name: "Burned-in subtitle",
    type: "caption",
    cls: "r-caption",
    x: 8, y: 78, w: 84, h: 13,
    method: "inpaint",
    opacity: 100,
    feather: 12,
    motion: "static",
    visible: true,
    // Captions only appear from 1:30 to 3:30 (the dialogue section).
    // The edit pads ±0.5s so the bar's fade in/out is also covered.
    startFrame: 2160, endFrame: 5040,
    confidence: 0.91,
  },
  {
    id: "r3",
    name: "Floating watermark",
    type: "watermark",
    cls: "r-watermark",
    x: 22, y: 18, w: 16, h: 8,
    method: "delogo",
    opacity: 100,
    feather: 6,
    motion: "tracked",
    visible: true,
    // Watermark is present the entire clip
    startFrame: 0, endFrame: 7200,
    confidence: 0.84,
    keyframes: [
      { t: 0,    x: 8,  y: 14 },
      { t: 0.18, x: 22, y: 18 },
      { t: 0.36, x: 38, y: 28 },
      { t: 0.52, x: 56, y: 22 },
      { t: 0.70, x: 70, y: 36 },
      { t: 0.88, x: 80, y: 30 },
      { t: 1.00, x: 88, y: 18 },
    ],
  },
];

const TYPE_META = {
  logo:         { cls: "r-logo",         color: "var(--accent)", label: "Static logo" },
  watermark:    { cls: "r-watermark",    color: "var(--pink)",   label: "Moving watermark" },
  caption:      { cls: "r-caption",      color: "var(--warn)",   label: "Burned-in caption" },
  broadcaster:  { cls: "r-broadcaster",  color: "var(--blue)",   label: "Broadcaster bug" },
};

/* ─── Helpers ─────────────────────────────────────────── */

const fmtTC = (frames, fps = 24) => {
  const s = Math.floor(frames / fps);
  const f = Math.floor(frames % fps);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  const ff = String(f).padStart(2, "0");
  return `${mm}:${ss}:${ff}`;
};

/* Parse a flexible time string into seconds.
 *   "1:23"      → 83
 *   "01:23"     → 83
 *   "1:02:03"   → 3723
 *   "45"        → 45
 *   "45.5"      → 45.5
 * Returns null on unparseable input. */
const parseTC = (str) => {
  const s = String(str || "").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(":");
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.map((p) => parseFloat(p));
    if (nums.some((n) => isNaN(n) || n < 0)) return null;
    if (parts.length === 2) return nums[0] * 60 + nums[1];
    return nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  return null;
};

/* TimecodeInput — a controlled-ish input that lets the user type freely,
 * parses on blur or Enter, clamps to [minSec, maxSec], and reverts on bad
 * input. Solves the stock prototype's "controlled regex fights typing" bug. */
const TimecodeInput = ({ valueFrames, fps, minSec, maxSec, onCommit, className }) => {
  const display = fmtTC(valueFrames, fps).slice(0, 5);
  const [draft, setDraft] = React.useState(display);
  const [focused, setFocused] = React.useState(false);

  // Re-sync draft from prop value, but only while the user isn't editing.
  React.useEffect(() => {
    if (!focused) setDraft(display);
  }, [display, focused]);

  const commit = () => {
    const parsed = parseTC(draft);
    if (parsed == null) {
      setDraft(display); // revert
      return;
    }
    const clamped = Math.max(minSec, Math.min(maxSec, parsed));
    onCommit(clamped);
    // Show the canonical formatted value after commit (next prop sync will
    // overwrite draft, but do it eagerly so revert-to-clamped is visible).
    setDraft(fmtTC(Math.round(clamped * fps), fps).slice(0, 5));
  };

  return (
    <input
      className={className}
      type="text"
      inputMode="numeric"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => { setFocused(true); e.target.select(); }}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.currentTarget.blur(); }
        else if (e.key === "Escape") { setDraft(display); e.currentTarget.blur(); }
      }}
    />
  );
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ─── Polygon helpers ──────────────────────────────────
 * A polygon region carries `points: [{x, y}, ...]` as percentages of the
 * full frame. The existing `x, y, w, h` fields are auto-derived from those
 * points as a bounding box, so legacy code paths (timeline track, inspector
 * geometry, side panel) keep working without per-call special-casing. */
const polygonBBox = (points) => {
  if (!points || points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

// Build a CSS clip-path polygon() string with vertex positions expressed
// as percentages of the region box (not the full frame). Returns null when
// the bounding box has zero area (no clip possible).
const polygonToClipPath = (points, bbox) => {
  if (!points || points.length < 3 || bbox.w <= 0 || bbox.h <= 0) return null;
  const segs = points.map((p) => {
    const px = ((p.x - bbox.x) / bbox.w) * 100;
    const py = ((p.y - bbox.y) / bbox.h) * 100;
    return `${px.toFixed(3)}% ${py.toFixed(3)}%`;
  });
  return `polygon(${segs.join(", ")})`;
};

// Apply polygon-derived bbox to a region for downstream code that still
// reads x/y/w/h. Pure: returns a new object.
const withPolyBBox = (r) => {
  if (r.shape !== "polygon" || !r.points) return r;
  const b = polygonBBox(r.points);
  return { ...r, x: b.x, y: b.y, w: b.w, h: b.h };
};

// Sample a watermark's tracked position at a given t (0..1).
const sampleKeyframes = (keyframes, t) => {
  if (!keyframes || !keyframes.length) return null;
  if (t <= keyframes[0].t) return { x: keyframes[0].x, y: keyframes[0].y };
  if (t >= keyframes[keyframes.length - 1].t) {
    const k = keyframes[keyframes.length - 1];
    return { x: k.x, y: k.y };
  }
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i], b = keyframes[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = (t - a.t) / (b.t - a.t);
      // ease-in-out
      const e = p * p * (3 - 2 * p);
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
    }
  }
  return null;
};

/* ─── Stage region (a draggable, resizable box) ───────── */

const RegionBox = ({ region, selected, onSelect, onChange, locked }) => {
  const ref = useRef(null);
  const startRef = useRef(null);
  const isPolygon = region.shape === "polygon" && Array.isArray(region.points);

  // Drag handler for rectangle regions: edges + corners + body translate.
  const onPointerDown = (e, handle) => {
    if (locked) return;
    e.stopPropagation();
    onSelect(region.id);
    const parent = ref.current.parentElement.getBoundingClientRect();
    startRef.current = {
      handle,
      sx: e.clientX, sy: e.clientY,
      rx: region.x, ry: region.y, rw: region.w, rh: region.h,
      pw: parent.width, ph: parent.height,
      points: isPolygon ? region.points.map((p) => ({ ...p })) : null,
    };
    const move = (ev) => {
      const s = startRef.current; if (!s) return;
      const dx = ((ev.clientX - s.sx) / s.pw) * 100;
      const dy = ((ev.clientY - s.sy) / s.ph) * 100;
      // Polygon body move: translate every vertex by the same delta.
      if (isPolygon && s.handle === "move") {
        // Clamp delta so no vertex leaves the frame.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of s.points) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
        const clampedDx = clamp(dx, -minX, 100 - maxX);
        const clampedDy = clamp(dy, -minY, 100 - maxY);
        const next = s.points.map((p) => ({ x: p.x + clampedDx, y: p.y + clampedDy }));
        onChange({ ...region, points: next, userEdited: true });
        return;
      }
      // Rectangle handle drags.
      let { rx, ry, rw, rh } = s;
      if (s.handle === "move") {
        rx = clamp(rx + dx, 0, 100 - rw);
        ry = clamp(ry + dy, 0, 100 - rh);
      } else {
        if (s.handle.includes("w")) { rw = Math.max(2, rw - dx); rx = clamp(rx + dx, 0, rx + rw - 2); }
        if (s.handle.includes("e")) { rw = clamp(rw + dx, 2, 100 - rx); }
        if (s.handle.includes("n")) { rh = Math.max(2, rh - dy); ry = clamp(ry + dy, 0, ry + rh - 2); }
        if (s.handle.includes("s")) { rh = clamp(rh + dy, 2, 100 - ry); }
      }
      onChange({ ...region, x: rx, y: ry, w: rw, h: rh, userEdited: true });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      startRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Drag handler for a single polygon vertex (when polygon is selected).
  // Index identifies which point in region.points to mutate.
  const onVertexDown = (e, index) => {
    if (locked || !isPolygon) return;
    e.stopPropagation();
    onSelect(region.id);
    const parent = ref.current.parentElement.getBoundingClientRect();
    const orig = region.points.map((p) => ({ ...p }));
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => {
      const dx = ((ev.clientX - sx) / parent.width) * 100;
      const dy = ((ev.clientY - sy) / parent.height) * 100;
      const next = orig.map((p, i) => (
        i === index ? { x: clamp(p.x + dx, 0, 100), y: clamp(p.y + dy, 0, 100) } : p
      ));
      onChange({ ...region, points: next });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Right-click a vertex to delete it (minimum 3 vertices kept).
  const onVertexContextMenu = (e, index) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isPolygon || region.points.length <= 3) return;
    const next = region.points.filter((_, i) => i !== index);
    onChange({ ...region, points: next });
  };

  if (!region.visible) return null;

  // Default to 'blurred' so the user sees a real backdrop-filter preview of
  // what removal will look like, instead of a flat colored block. Set
  // region.previewMode = 'removed' or 'none' to opt out.
  const previewMethod = region.previewMode || "blurred"; // 'removed' | 'blurred' | 'none'

  // For polygons, derive the bounding box from the points so positioning
  // still uses left/top/w/h. The clip-path then carves the polygon shape
  // out of that rectangle. Vertex handles are positioned in % of the
  // parent (the stage) so they don't need bbox renormalization.
  const bbox = isPolygon ? polygonBBox(region.points) : { x: region.x, y: region.y, w: region.w, h: region.h };
  const clipPath = isPolygon ? polygonToClipPath(region.points, bbox) : null;

  return (
    <>
      <div
        ref={ref}
        className={`region-box ${region.cls} ${selected ? "selected" : ""} ${
          previewMethod === "removed" ? "r-removed" : ""
        } ${previewMethod === "blurred" ? "r-blurred" : ""} ${region.active === false ? "r-inactive" : ""} ${isPolygon ? "r-polygon" : ""}`}
        data-name={region.name + (region.active === false ? " · off" : "")}
        style={{
          left: bbox.x + "%",
          top: bbox.y + "%",
          width: bbox.w + "%",
          height: bbox.h + "%",
          // clip-path carves the polygon shape out of the bbox-sized rect.
          // The outline remains rectangular here; an SVG overlay below
          // draws the real polygon stroke so the user sees the actual shape.
          clipPath: clipPath || undefined,
          WebkitClipPath: clipPath || undefined,
          "--rm-opacity": (region.opacity ?? 100) / 100,
          // For polygons hide the rectangular border (clipped) since the SVG
          // overlay will draw the real polygon outline.
          border: isPolygon ? "none" : undefined,
        }}
        onPointerDown={(e) => onPointerDown(e, "move")}
      >
        {selected && !locked && !isPolygon && (
          <>
            <div className="handle h-nw" onPointerDown={(e) => onPointerDown(e, "nw")} />
            <div className="handle h-ne" onPointerDown={(e) => onPointerDown(e, "ne")} />
            <div className="handle h-sw" onPointerDown={(e) => onPointerDown(e, "sw")} />
            <div className="handle h-se" onPointerDown={(e) => onPointerDown(e, "se")} />
          </>
        )}
      </div>
      {/* Polygon outline + vertex handles render as siblings of the clipped
          blur box so they don't get clipped themselves. Positioned in
          parent-stage coordinates (percent of the full frame). */}
      {isPolygon && (
        <svg
          className={`region-polygon-stroke ${selected ? "selected" : ""}`}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{
            position: "absolute", inset: 0, width: "100%", height: "100%",
            pointerEvents: "none", overflow: "visible",
          }}
        >
          <polygon
            points={region.points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="0.25"
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: "stroke", cursor: "move" }}
            onPointerDown={(e) => onPointerDown(e, "move")}
          />
        </svg>
      )}
      {isPolygon && selected && !locked && region.points.map((p, i) => (
        <div
          key={i}
          className="poly-vertex"
          style={{
            position: "absolute",
            left: `calc(${p.x}% - 5px)`,
            top: `calc(${p.y}% - 5px)`,
            width: 10, height: 10,
            borderRadius: 999,
            background: "var(--bg)",
            border: "2px solid currentColor",
            color: "inherit",
            cursor: "grab",
            zIndex: 5,
          }}
          title="Drag to move · right-click to delete"
          onPointerDown={(e) => onVertexDown(e, i)}
          onContextMenu={(e) => onVertexContextMenu(e, i)}
        />
      ))}
    </>
  );
};

/* ─── The motion path overlay (for the moving watermark) ── */

const MotionPath = ({ region, showDots = true }) => {
  if (!region || !region.keyframes) return null;
  const pts = region.keyframes;
  const path = pts
    .map((k, i) => {
      const cx = k.x + region.w / 2;
      const cy = k.y + region.h / 2;
      return (i === 0 ? "M" : "L") + cx + "," + cy;
    })
    .join(" ");
  return (
    <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d={path} stroke="var(--pink)" strokeWidth="0.25" strokeDasharray="0.6 0.6" fill="none" />
      {showDots && pts.map((k, i) => (
        <circle
          key={i}
          cx={k.x + region.w / 2}
          cy={k.y + region.h / 2}
          r="0.6"
          fill={i === 0 || i === pts.length - 1 ? "var(--ink)" : "var(--pink)"}
          stroke="rgba(0,0,0,.4)"
          strokeWidth="0.15"
        />
      ))}
    </svg>
  );
};

/* ─── Stage ──────────────────────────────────────────── */

const VideoStage = ({ regions, selectedId, onSelectRegion, onChangeRegion, mode, drawing, onDraw, onDrawPolygon, playhead, drawingPreview, onDrawingPreview, scene, videoSrc, videoRef }) => {
  const stageRef = useRef(null);
  const [drawStart, setDrawStart] = useState(null);
  // In-progress polygon vertices when mode === "polygon". Each entry is
  // {x, y} as % of frame. Polygon commits on double-click or click-near-first.
  const [polyPoints, setPolyPoints] = useState([]);
  const [polyCursor, setPolyCursor] = useState(null); // hovered position for preview line

  const isDrawMode = mode === "draw";
  const isPolyMode = mode === "polygon";

  // Cancel an in-progress polygon when the user switches away from polygon mode.
  useEffect(() => {
    if (!isPolyMode) { setPolyPoints([]); setPolyCursor(null); }
  }, [isPolyMode]);

  // Escape cancels in-progress polygon.
  useEffect(() => {
    if (!isPolyMode || polyPoints.length === 0) return;
    const onKey = (e) => {
      if (e.key === "Escape") { setPolyPoints([]); setPolyCursor(null); }
      else if (e.key === "Enter" && polyPoints.length >= 3) {
        onDrawPolygon?.(polyPoints);
        setPolyPoints([]); setPolyCursor(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPolyMode, polyPoints, onDrawPolygon]);

  const stagePct = (e) => {
    const r = stageRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 100,
      y: ((e.clientY - r.top) / r.height) * 100,
    };
  };

  const onPointerDown = (e) => {
    // Polygon mode: each click adds a vertex. Click within 2% of the first
    // vertex closes the polygon (needs >= 3 vertices).
    if (isPolyMode) {
      const p = stagePct(e);
      if (polyPoints.length >= 3) {
        const first = polyPoints[0];
        const dx = p.x - first.x, dy = p.y - first.y;
        if (Math.hypot(dx, dy) < 2) {
          onDrawPolygon?.(polyPoints);
          setPolyPoints([]); setPolyCursor(null);
          return;
        }
      }
      setPolyPoints((pts) => [...pts, p]);
      return;
    }
    if (!isDrawMode) {
      onSelectRegion(null);
      return;
    }
    const p = stagePct(e);
    setDrawStart(p);
    onDrawingPreview({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPointerMove = (e) => {
    if (isPolyMode && polyPoints.length > 0) {
      setPolyCursor(stagePct(e));
      return;
    }
    if (!drawStart) return;
    const p = stagePct(e);
    onDrawingPreview({
      x: Math.min(drawStart.x, p.x),
      y: Math.min(drawStart.y, p.y),
      w: Math.abs(p.x - drawStart.x),
      h: Math.abs(p.y - drawStart.y),
    });
  };
  const onPointerUp = () => {
    if (isPolyMode) return;
    if (drawStart && drawingPreview && drawingPreview.w > 1 && drawingPreview.h > 1) {
      onDraw(drawingPreview);
    }
    setDrawStart(null);
    onDrawingPreview(null);
  };

  // Double-click commits the polygon (when valid).
  const onDoubleClick = (e) => {
    if (!isPolyMode || polyPoints.length < 3) return;
    e.stopPropagation();
    onDrawPolygon?.(polyPoints);
    setPolyPoints([]); setPolyCursor(null);
  };

  // For tracked watermark — compute its centre position at the playhead.
  const watermarkPos = useMemo(() => {
    const wm = regions.find((r) => r.motion === "tracked" && r.keyframes);
    if (!wm) return null;
    const sampled = sampleKeyframes(wm.keyframes, playhead?.t ?? 0);
    if (!sampled) return null;
    // sampled.x/y are top-left percentages of the watermark box; we want centre.
    return { x: sampled.x + wm.w / 2, y: sampled.y + wm.h / 2 };
  }, [regions, playhead?.t]);

  // Compute which regions are currently active at the playhead.
  // A region is active when startFrame <= currentFrame <= endFrame.
  // (Default both bounds = full clip so old/unbounded regions keep working.)
  const currentFrame = playhead?.frame ?? 0;
  const activeRegions = useMemo(() => {
    return regions.map((r) => ({
      ...r,
      active: currentFrame >= (r.startFrame ?? 0) && currentFrame <= (r.endFrame ?? Infinity),
    }));
  }, [regions, currentFrame]);

  // For tracked watermark — render at the position sampled at current playhead t.
  const trackedRegions = useMemo(() => {
    return activeRegions.map((r) => {
      if (r.motion !== "tracked" || !r.keyframes) return r;
      const t = playhead?.t ?? 0;
      const sampled = sampleKeyframes(r.keyframes, t);
      if (!sampled) return r;
      return { ...r, x: sampled.x, y: sampled.y };
    });
  }, [regions, playhead?.t]);

  return (
    <div
      ref={stageRef}
      className="stage-frame"
      style={{
        width: "min(100%, 1040px)",
        aspectRatio: "16 / 9",
        cursor: isDrawMode || isPolyMode ? "crosshair" : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {/* If a real videoSrc is supplied (direct .mp4/.webm/.m3u8 URL), render
          a <video> as the stage background. Otherwise fall back to the
          MockScene + drop-target image-slot used by the original prototype. */}
      {videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          playsInline
          // Native controls intentionally OFF: the editor's transport bar is the
          // single source of truth. Click the stage to toggle play, just like
          // the rest of the editor surface.
          onClick={(e) => {
            e.stopPropagation();
            const v = videoRef?.current;
            if (!v) return;
            if (v.paused) v.play().catch(() => {}); else v.pause();
          }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000", cursor: "pointer" }}
        />
      ) : (
        <>
          <MockScene
            scene={scene || "tokyo"}
            regions={activeRegions}
            watermarkPos={watermarkPos}
            fontScale={1.6}
          />
          <image-slot
            id="delogo-source"
            shape="rect"
            placeholder=""
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" }}
          ></image-slot>
        </>
      )}

      {/* Region boxes — strict time-gated visibility.
          A region renders ONLY when the current playhead is inside its
          [startFrame, endFrame] window. No exceptions for selected-but-off
          regions or for draw mode — outside its window, a region is fully
          invisible on the video stage. Editing an off-window region's
          IN/OUT is still possible via the inspector inputs in the right
          rail; clicking its row in the left panel seeks into its window
          so it becomes visible again. */}
      {trackedRegions
        .filter((r) => r.active)
        .map((r) => (
          <RegionBox
            key={r.id}
            region={r}
            selected={r.id === selectedId}
            onSelect={onSelectRegion}
            onChange={onChangeRegion}
            locked={mode === "compare"}
          />
        ))}

      {/* Motion path overlay (only show in track mode for selected tracked region) */}
      {mode === "track" &&
        regions.filter((r) => r.motion === "tracked" && r.visible).map((r) => (
          <MotionPath key={r.id + "-path"} region={r} />
        ))}

      {/* Draw-in-progress preview */}
      {isDrawMode && drawingPreview && (
        <div
          className="region-box r-logo"
          style={{
            left: drawingPreview.x + "%",
            top: drawingPreview.y + "%",
            width: drawingPreview.w + "%",
            height: drawingPreview.h + "%",
            pointerEvents: "none",
          }}
          data-name="New region"
        />
      )}
      {/* Polygon-in-progress preview: dashed open path from each placed vertex
          to the cursor, with circles at each placed vertex. Closes visually
          when the cursor is near the first vertex (snap target). */}
      {isPolyMode && polyPoints.length > 0 && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
        >
          {(() => {
            const segments = polyPoints.map((p) => `${p.x},${p.y}`).join(" ");
            const last = polyPoints[polyPoints.length - 1];
            const first = polyPoints[0];
            const showSnap = polyCursor && polyPoints.length >= 3 &&
              Math.hypot(polyCursor.x - first.x, polyCursor.y - first.y) < 2;
            return (
              <>
                {/* Placed segments — solid */}
                <polyline
                  points={segments}
                  fill="none"
                  stroke="#7aa8ff"
                  strokeWidth="0.3"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Live rubber-band line from last vertex to cursor — dashed */}
                {polyCursor && (
                  <line
                    x1={last.x} y1={last.y}
                    x2={polyCursor.x} y2={polyCursor.y}
                    stroke={showSnap ? "#9ee493" : "#7aa8ff"}
                    strokeWidth="0.3"
                    strokeDasharray="1,0.6"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {/* Vertex dots */}
                {polyPoints.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r="0.6" fill={i === 0 ? "#9ee493" : "#7aa8ff"} />
                ))}
              </>
            );
          })()}
        </svg>
      )}
      {/* Polygon mode hint banner. */}
      {isPolyMode && (
        <div style={{
          position: "absolute", top: 14, left: 14, zIndex: 6,
          padding: "6px 10px", borderRadius: 6,
          background: "var(--overlay-surface)", border: "1px solid var(--overlay-border)",
          color: "var(--ink-2)", fontSize: 11, lineHeight: 1.4, pointerEvents: "none",
          boxShadow: "var(--shadow)",
        }}>
          {polyPoints.length === 0
            ? "Click to place vertices. Double-click or click the first vertex to close. Esc to cancel."
            : `${polyPoints.length} vertex${polyPoints.length === 1 ? "" : "es"} · ${polyPoints.length >= 3 ? "double-click or click first vertex to close" : "need ≥ 3 to close"} · Esc cancels`}
        </div>
      )}
    </div>
  );
};

/* ─── Left rail — regions list ────────────────────────── */

const LeftRail = ({
  regions, selectedId, onSelect, onToggleVisible, onDelete, onAdd, onJumpTo, fps,
  notes = [], selectedNoteId, onSelectNote, onJumpToNote, onEditNote, onDeleteNote, onAddNote,
  captions = [], selectedCueId, onSelectCue, onJumpToCue, onChangeCue, onDeleteCue, onAddCue,
  onAutoCaption, onScanText, autoCaptionStatus, autoCaptionError,
}) => {
  // Format seconds → "M:SS" for caption rows (notes use frame-based formatTime
  // below; captions are stored in seconds so they don't need the fps round-trip).
  const formatSec = (s) => {
    if (!isFinite(s)) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };
  const formatTime = (frame) => {
    const s = frame / fps;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };
  return (
    <>
      <div style={{ padding: "14px 14px 8px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 4 }}>
          Regions
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {regions.length} found · {regions.filter(r => r.visible).length} active
        </div>
      </div>
      <div className="regions-list">
        {regions.map((r) => (
          <div
            key={r.id}
            className={`region-item ${r.cls} ${r.id === selectedId ? "active" : ""} ${!r.visible ? "hidden" : ""}`}
            // Clicking a row both selects the region AND seeks the video to
            // its start frame, so the user lands inside its active window
            // and the blur preview is visible immediately.
            onClick={() => { onSelect(r.id); onJumpTo?.(r); }}
            title="Click to select and jump to this region's start"
          >
            <div className="swatch" />
            <div className="info">
              <div className="name">{r.name}</div>
              <div className="meta">
                {Math.round(r.w)}×{Math.round(r.h)}% · {r.motion === "tracked" ? `${r.keyframes?.length || 0}kf` : "static"}
                {(r.startFrame ?? 0) > 0 || (r.endFrame ?? Infinity) < 7200 ? (
                  <span style={{ color: "var(--warn)", marginLeft: 6 }}>
                    · {Math.round(((r.endFrame ?? 7200) - (r.startFrame ?? 0)) / (fps || 24))}s
                  </span>
                ) : null}
              </div>
            </div>
            <button
              className="eye"
              onClick={(e) => { e.stopPropagation(); onToggleVisible(r.id); }}
              title={r.visible ? "Hide" : "Show"}
            >
              {r.visible
                ? <Icons.Eye size={14} sw={1.5} />
                : <Icons.EyeOff size={14} sw={1.5} />}
            </button>
          </div>
        ))}
        {regions.length === 0 && (
          <div className="empty-state">
            <div className="glyph"><Icons.Crosshair size={18} /></div>
            No regions yet. Switch to <b style={{ color: "var(--ink-2)" }}>Draw</b> and select an area on the video.
          </div>
        )}
      </div>
      <div className="left-add">
        <button className="btn" onClick={() => onAdd("logo")}>
          <Icons.Plus size={13} /> Region
        </button>
        <button className="btn" onClick={() => onAdd("auto")}>
          <Icons.Sparkle size={13} /> Auto
        </button>
      </div>

      {/* ─── Accessibility track ───────────────────────────
          One unified surface for the CC cues (what gets visibly burned
          into the cleaned output) AND audio descriptions (audio-only
          insertions for moments where on-screen content isn't covered
          by the dialogue). They share a panel because authoring a
          description means scanning gaps in the caption transcript —
          they're two halves of the same accessibility track. The
          stage overlay still renders ONLY captions (descriptions are
          audio-only by design and never show as visible text). */}
      <div style={{ borderTop: "1px solid var(--line)", padding: "14px 14px 8px" }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
          <Icons.Speaker size={11} sw={2} /> Accessibility track
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {captions.length} caption{captions.length === 1 ? "" : "s"} · {notes.length} description{notes.length === 1 ? "" : "s"}
          {captions.some((c) => c.source === "whisper") && <span style={{ marginLeft: 6 }}>· transcribed</span>}
        </div>
        {autoCaptionStatus && (
          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--overlay-surface)", border: "1px solid var(--overlay-border)", fontSize: 11, color: "var(--ink)", display: "flex", alignItems: "center", gap: 8 }}>
            <div aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, border: "2px solid var(--accent)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite", flex: "none" }} />
            <span>{autoCaptionStatus.message}</span>
          </div>
        )}
        {autoCaptionError && (
          <div role="alert" style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "rgba(239,83,80,.12)", border: "1px solid rgba(239,83,80,.4)", fontSize: 11, color: "var(--ink)" }}>
            <strong>Transcribe failed.</strong> {autoCaptionError}
          </div>
        )}
      </div>
      <div className="regions-list">
        {/* Build a unified, time-sorted list. Each item carries `kind`
            ("caption" | "description") and we render the appropriate
            row UI. Descriptions keep their existing modal-edit flow;
            captions stay inline-editable. */}
        {(() => {
          const items = [
            ...captions.map((c) => ({ kind: "caption", startSec: c.startSeconds, endSec: c.endSeconds, raw: c })),
            ...notes.map((n)    => ({ kind: "description", startSec: n.frame / fps, endSec: (n.frame + n.durationFrames) / fps, raw: n })),
          ].sort((a, b) => a.startSec - b.startSec);

          if (items.length === 0) {
            return (
              <div className="empty-state" style={{ padding: "20px 18px" }}>
                <div style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
                  Empty accessibility track. Use <strong>Transcribe</strong> to generate captions from the audio, then add audio descriptions in any gaps where on-screen text isn't covered by the dialogue.
                </div>
              </div>
            );
          }

          return items.map((item) => {
            if (item.kind === "caption") {
              const cue = item.raw;
              const isActive = cue.id === selectedCueId;
              return (
                <div
                  key={`cap-${cue.id}`}
                  className={`region-item ${isActive ? "active" : ""}`}
                  title="Caption · click to jump · type to edit"
                  onClick={() => { onSelectCue?.(cue.id); onJumpToCue?.(cue); }}
                >
                  <div
                    className="swatch"
                    style={{ background: cue.source === "whisper" ? "var(--accent)" : "var(--ink-3)" }}
                    aria-label="Caption row"
                    title="Caption (visible text)"
                  />
                  <div className="info" style={{ flex: 1, minWidth: 0 }}>
                    <input
                      type="text"
                      value={cue.text}
                      placeholder="(empty caption · type text)"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onChangeCue?.(cue.id, { text: e.target.value })}
                      style={{ width: "100%", background: "transparent", border: "none", color: "var(--ink)", fontSize: 13, padding: 0, marginBottom: 2, outline: "none" }}
                      aria-label="Caption text"
                    />
                    <div className="meta" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
                      <span style={{ padding: "0 4px", borderRadius: 3, background: "rgba(63,140,255,.18)", color: "var(--ink-2)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>CC</span>
                      <input
                        type="number" step="0.1" min="0"
                        value={cue.startSeconds.toFixed(2)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!isNaN(v)) onChangeCue?.(cue.id, { startSeconds: Math.max(0, v) });
                        }}
                        style={{ width: 56, fontSize: 11, padding: "1px 4px", background: "var(--surface)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 3 }}
                        aria-label="Caption start (seconds)"
                      />→
                      <input
                        type="number" step="0.1" min="0"
                        value={cue.endSeconds.toFixed(2)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!isNaN(v)) onChangeCue?.(cue.id, { endSeconds: Math.max(cue.startSeconds + 0.1, v) });
                        }}
                        style={{ width: 56, fontSize: 11, padding: "1px 4px", background: "var(--surface)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 3 }}
                        aria-label="Caption end (seconds)"
                      />
                      <span style={{ color: "var(--ink-3)" }}>· {(cue.endSeconds - cue.startSeconds).toFixed(1)}s</span>
                      {cue.source === "whisper" && <span style={{ marginLeft: 4, color: "var(--accent)" }}>· auto</span>}
                    </div>
                  </div>
                  <button
                    className="eye"
                    title="Delete caption"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Delete this caption?\n\n"${(cue.text || "").slice(0, 80)}"`)) onDeleteCue?.(cue.id);
                    }}
                  >×</button>
                </div>
              );
            }
            // Audio description row
            const n = item.raw;
            const isDraft = !!n.draft;
            return (
              <div
                key={`desc-${n.id}`}
                className={`region-item ${n.id === selectedNoteId ? "active" : ""}`}
                style={{
                  opacity: isDraft ? 0.85 : 1,
                  borderLeft: isDraft ? "2px dashed var(--warn)" : undefined,
                }}
                title="Audio description (audio-only · never shown as caption) · click to jump · double-click to edit"
                onClick={() => { onSelectNote?.(n.id); onJumpToNote?.(n); }}
                onDoubleClick={() => onEditNote?.(n)}
              >
                <div
                  className="swatch"
                  style={{ background: "var(--warn)" }}
                  aria-label="Audio description row"
                  title="Audio description (audio-only)"
                />
                <div className="info">
                  <div className="name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {n.text || "(empty description)"}
                  </div>
                  <div className="meta" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ padding: "0 4px", borderRadius: 3, background: "rgba(255,180,80,.18)", color: "var(--ink-2)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em" }}>AD</span>
                    {formatTime(n.frame)} → {formatTime(n.frame + n.durationFrames)}
                    · {(n.durationFrames / fps).toFixed(1)}s
                    {n.mode === "pause" && <span style={{ marginLeft: 4, color: "var(--accent)" }}>· pauses</span>}
                    {isDraft && <span style={{ marginLeft: 4, color: "var(--ink-3)" }}>· draft</span>}
                  </div>
                </div>
                <button
                  className="eye"
                  title="Edit description"
                  onClick={(e) => { e.stopPropagation(); onEditNote?.(n); }}
                  style={{ marginRight: 4 }}
                ><Icons.Code size={12} sw={1.5} /></button>
                <button
                  className="eye"
                  title="Delete description"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete this audio description?\n\n"${(n.text || "").slice(0, 80)}"`)) onDeleteNote?.(n.id);
                  }}
                >×</button>
              </div>
            );
          });
        })()}
      </div>
      <div className="left-add" style={{ borderTop: "1px solid var(--line)", display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => onAddCue?.()} title="Add a caption cue at the current playhead">
          <Icons.Plus size={13} /> Caption
        </button>
        <button className="btn" onClick={() => onAddNote?.()} title="Add an audio description (audio-only) at the current playhead">
          <Icons.Plus size={13} /> Description
        </button>
        <button
          className="btn"
          onClick={() => onAutoCaption?.()}
          disabled={!!autoCaptionStatus}
          title="Transcribe audio to captions using Whisper (in-browser, ~80 MB first-time download)"
          style={{ opacity: autoCaptionStatus ? 0.6 : 1 }}
        >
          <Icons.Sparkle size={13} /> {autoCaptionStatus ? "Transcribing…" : "Transcribe"}
        </button>
        <button
          className="btn"
          onClick={() => onScanText?.()}
          disabled={!!autoCaptionStatus || captions.length === 0}
          title="Scan caption gaps for on-screen text (OCR, in-browser) and draft audio descriptions for visible text the dialogue doesn't cover"
          style={{ opacity: (autoCaptionStatus || captions.length === 0) ? 0.6 : 1 }}
        >
          <Icons.Sparkle size={13} /> Scan on-screen text
        </button>
      </div>
    </>
  );
};

/* ─── Right inspector — varies by mode ────────────────── */

const Inspector = ({ region, mode, onChange, onDelete, onCommitTrack, fps, duration, selectedTakeId, onSelectTake, onRefit }) => {
  if (!region && mode !== "track") {
    return (
      <div className="empty-state" style={{ padding: "44px 24px" }}>
        <div className="glyph"><Icons.Square size={18} /></div>
        Select a region to edit its properties, or draw a new one on the video.
      </div>
    );
  }

  // Track mode: 2 "takes" produced by the tracker.
  if (mode === "track") {
    return (
      <div className="track-takes">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Icons.Track size={14} style={{ color: "var(--pink)" }} />
          <div style={{ fontSize: 13, fontWeight: 500 }}>Tracker results</div>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14, lineHeight: 1.5 }}>
          The tracker watched the floating watermark across <b style={{ color: "var(--ink-2)" }}>5m 00s</b> and produced two motion paths. Pick the one that follows the watermark best, or generate more takes.
        </div>

        <TakeCard
          id="take-a"
          active={selectedTakeId === "take-a"}
          onClick={() => onSelectTake("take-a")}
          badge="Best"
          name="Optical-flow"
          confidence={0.94}
          desc="Tracks every frame using dense optical flow. Smooth path, slightly drifts when the watermark crosses high-contrast edges."
          path="M 5 60 C 20 30, 35 20, 50 35 S 80 60, 95 25"
        />
        <TakeCard
          id="take-b"
          active={selectedTakeId === "take-b"}
          onClick={() => onSelectTake("take-b")}
          name="Feature-match"
          confidence={0.81}
          desc="Locks to the logo's corner features. Snappier but loses the watermark for ~14 frames during a fast pan at 02:18."
          path="M 5 55 L 22 25 L 38 40 L 55 28 L 72 50 L 88 30"
        />

        <div style={{ marginTop: 14, display: "flex", gap: 6 }}>
          <button className="btn" style={{ flex: 1, justifyContent: "center" }}>
            <Icons.Wand size={13} /> Re-track
          </button>
          <button className="btn" style={{ flex: 1, justifyContent: "center" }}>
            <Icons.Plus size={13} /> Another take
          </button>
        </div>

        <div style={{ marginTop: 18, padding: 12, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span className="chip pink dot">7 keyframes</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>
            Drag any keyframe on the timeline to adjust manually. The path between keyframes is smoothed with cubic interpolation.
          </div>
        </div>
      </div>
    );
  }

  // Detect/draw — full inspector.
  const r = region;
  // Any inspector edit marks the region as user-touched so Re-detect can
  // preserve manual time/geometry adjustments instead of clobbering them.
  // Auto-generated regions stay overwritable; once the user types a value
  // in IN/OUT/X/Y/W/H or drags a vertex, the region is "theirs".
  const set = (patch) => onChange({ ...r, ...patch, userEdited: true });

  return (
    <>
      <div className="insp">
        <div className="group">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span className={`chip ${
              r.type === "watermark" ? "pink" :
              r.type === "caption" ? "warn" :
              r.type === "broadcaster" ? "blue" : ""
            } dot`}>
              {TYPE_META[r.type]?.label || "Region"}
            </span>
            {r.confidence !== undefined && (
              <span style={{ fontSize: 11, fontFamily: "Geist Mono, monospace", color: "var(--ink-3)" }}>
                {Math.round(r.confidence * 100)}% conf
              </span>
            )}
          </div>
          <input
            className="num-input"
            value={r.name}
            onChange={(e) => set({ name: e.target.value })}
            style={{ width: "100%", fontFamily: "Geist, sans-serif", fontSize: 13, padding: "8px 10px" }}
          />
        </div>

        <div className="group">
          <h4>
            Geometry
            {r.shape === "polygon" && (
              <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 400, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".08em" }}>
                · polygon · {r.points?.length || 0} pts
              </span>
            )}
          </h4>
          {r.shape === "polygon" ? (
            <>
              <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5, marginBottom: 8 }}>
                Drag vertex handles on the video to reshape. Right-click a vertex to remove it (min 3). The numeric fields below show the polygon's bounding box.
              </div>
              <div className="field-row">
                <div className="num-with-label">
                  <span className="lbl">X</span>
                  <input className="num-input" type="number" value={r.x.toFixed(1)} disabled readOnly />
                </div>
                <div className="num-with-label">
                  <span className="lbl">Y</span>
                  <input className="num-input" type="number" value={r.y.toFixed(1)} disabled readOnly />
                </div>
              </div>
              <div className="field-row" style={{ marginTop: 6 }}>
                <div className="num-with-label">
                  <span className="lbl">W</span>
                  <input className="num-input" type="number" value={r.w.toFixed(1)} disabled readOnly />
                </div>
                <div className="num-with-label">
                  <span className="lbl">H</span>
                  <input className="num-input" type="number" value={r.h.toFixed(1)} disabled readOnly />
                </div>
              </div>
              <button
                className="btn ghost"
                style={{ marginTop: 8, width: "100%", justifyContent: "center", fontSize: 11 }}
                onClick={() => set({ shape: "rect", points: undefined })}
                title="Discard polygon vertices and use the bounding rectangle instead"
              >
                Convert to rectangle
              </button>
            </>
          ) : (
            <>
              <div className="field-row">
                <div className="num-with-label">
                  <span className="lbl">X</span>
                  <input className="num-input" type="number" value={r.x.toFixed(1)} onChange={(e) => set({ x: Number(e.target.value) })} />
                </div>
                <div className="num-with-label">
                  <span className="lbl">Y</span>
                  <input className="num-input" type="number" value={r.y.toFixed(1)} onChange={(e) => set({ y: Number(e.target.value) })} />
                </div>
              </div>
              <div className="field-row" style={{ marginTop: 6 }}>
                <div className="num-with-label">
                  <span className="lbl">W</span>
                  <input className="num-input" type="number" value={r.w.toFixed(1)} onChange={(e) => set({ w: Number(e.target.value) })} />
                </div>
                <div className="num-with-label">
                  <span className="lbl">H</span>
                  <input className="num-input" type="number" value={r.h.toFixed(1)} onChange={(e) => set({ h: Number(e.target.value) })} />
                </div>
              </div>
              <button
                className="btn ghost"
                style={{ marginTop: 8, width: "100%", justifyContent: "center", fontSize: 11 }}
                onClick={() => set({
                  shape: "polygon",
                  // Seed with the rect's four corners as the polygon's vertices.
                  points: [
                    { x: r.x,        y: r.y },
                    { x: r.x + r.w,  y: r.y },
                    { x: r.x + r.w,  y: r.y + r.h },
                    { x: r.x,        y: r.y + r.h },
                  ],
                })}
                title="Promote this rectangle to a polygon — its four corners become draggable vertices"
              >
                Convert to polygon
              </button>
            </>
          )}
        </div>

        <div className="group">
          <h4>Active range</h4>
          <div className="seg" style={{ marginBottom: 8 }}>
            <button
              className={(r.startFrame ?? 0) === 0 && (r.endFrame ?? Infinity) >= duration * fps ? "active" : ""}
              onClick={() => set({ startFrame: 0, endFrame: duration * fps })}
            >Whole clip</button>
            <button
              className={(r.startFrame ?? 0) > 0 || (r.endFrame ?? Infinity) < duration * fps ? "active" : ""}
              onClick={() => set({ startFrame: r.startFrame ?? 0, endFrame: r.endFrame ?? duration * fps })}
            >Time range</button>
          </div>
          <div className="field-row">
            <div className="num-with-label">
              <span className="lbl">IN</span>
              <TimecodeInput
                className="num-input"
                valueFrames={r.startFrame ?? 0}
                fps={fps}
                minSec={0}
                maxSec={Math.max(0, (r.endFrame ?? duration * fps) / fps - 1 / fps)}
                onCommit={(sec) => set({ startFrame: Math.round(sec * fps) })}
              />
            </div>
            <div className="num-with-label">
              <span className="lbl">OUT</span>
              <TimecodeInput
                className="num-input"
                valueFrames={r.endFrame ?? duration * fps}
                fps={fps}
                minSec={(r.startFrame ?? 0) / fps + 1 / fps}
                maxSec={duration}
                onCommit={(sec) => set({ endFrame: Math.round(sec * fps) })}
              />
            </div>
          </div>
          {/* Per-region surgical refit: re-runs caption detection ONLY within
              this region's IN/OUT window, then tightens geometry + time
              bounds to what's actually present. Useful when the global scan
              covered too much (or the wrong frames). Captions only — logos
              don't change with time the way burned-in text does. */}
          {onRefit && (r.type === "caption" || r.type === "logo") && (
            <button
              className="btn ghost"
              style={{ width: "100%", justifyContent: "center", marginTop: 8, fontSize: 11 }}
              onClick={() => onRefit(r.id)}
              title="Re-run caption detection only within this region's time range and tighten its geometry"
            >
              <Icons.Sparkle size={11} /> Re-fit to active range
            </button>
          )}
          <div style={{
            marginTop: 8,
            padding: "6px 9px",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 5,
            fontSize: 11,
            color: r.active === false ? "var(--ink-4)" : "var(--accent)",
            fontFamily: "Geist Mono, monospace",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: r.active === false ? "var(--ink-4)" : "var(--accent)",
              ...(r.active === false ? {} : { animation: "pulse 1.4s ease-in-out infinite" }),
              flex: "none",
            }} />
            {r.active === false ? "Inactive at playhead" : "Active now"} ·
            <span style={{ color: "var(--ink-3)" }}>
              {Math.round(((r.endFrame ?? duration * fps) - (r.startFrame ?? 0)) / fps)}s coverage
            </span>
          </div>
        </div>

        <div className="group">
          <h4>Removal Method</h4>
          <div className="seg">
            <button className={r.method === "delogo" ? "active" : ""} onClick={() => set({ method: "delogo" })}>delogo</button>
            <button className={r.method === "inpaint" ? "active" : ""} onClick={() => set({ method: "inpaint" })}>inpaint</button>
            <button className={r.method === "blur" ? "active" : ""} onClick={() => set({ method: "blur" })}>blur</button>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.45 }}>
            {r.method === "delogo" && "FFmpeg's delogo: reconstructs pixels from the box edges. Best for translucent logos."}
            {r.method === "inpaint" && "Inpaints from surrounding video. Best for opaque captions over moving backgrounds."}
            {r.method === "blur" && "Gaussian blur over the region. Lowest effort, keeps content shape visible."}
          </div>
        </div>

        <div className="group">
          <h4>Output</h4>
          <div className="field">
            <label>Opacity (preview transparency)</label>
            <div className="slider-row">
              <input type="range" min="0" max="100" value={r.opacity ?? 100} onChange={(e) => set({ opacity: Number(e.target.value) })} />
              <span className="val">{r.opacity ?? 100}%</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.4 }}>
              When exporting with alpha (ProRes 4444 / WebM), the region becomes transparent at this strength.
            </div>
          </div>
          <div className="field">
            <label>Edge feather</label>
            <div className="slider-row">
              <input type="range" min="0" max="40" value={r.feather ?? 0} onChange={(e) => set({ feather: Number(e.target.value) })} />
              <span className="val">{r.feather ?? 0}px</span>
            </div>
          </div>
        </div>

        <div className="group">
          <h4>Motion</h4>
          <div className="seg">
            <button className={r.motion === "static" ? "active" : ""} onClick={() => set({ motion: "static" })}>Static</button>
            <button className={r.motion === "tracked" ? "active" : ""} onClick={() => set({ motion: "tracked" })}>Track</button>
          </div>
          {r.motion === "tracked" && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--ink-3)", lineHeight: 1.45 }}>
              This region follows the source object across {r.keyframes?.length ?? 0} keyframes. Switch to the <b style={{ color: "var(--ink-2)" }}>Track</b> mode to refine.
            </div>
          )}
        </div>
      </div>

      <div className="insp-foot">
        <button className="btn ghost" onClick={() => onDelete(r.id)}>
          <Icons.Trash size={13} /> Delete
        </button>
        <button className="btn primary">
          <Icons.Check size={13} /> Apply
        </button>
      </div>
    </>
  );
};

const TakeCard = ({ id, active, onClick, badge, name, confidence, desc, path }) => (
  <div className={`take-card ${active ? "active" : ""}`} onClick={onClick}>
    <div className="head">
      <div className="name">
        {name}
        {badge && <span className="badge">{badge}</span>}
      </div>
      <div className="conf">conf <span className="v">{(confidence * 100).toFixed(0)}%</span></div>
    </div>
    <div className="preview">
      <svg viewBox="0 0 100 80" preserveAspectRatio="none">
        <defs>
          <pattern id={`grid-${id}`} width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(110,231,168,.07)" strokeWidth="0.3" />
          </pattern>
        </defs>
        <rect width="100" height="80" fill={`url(#grid-${id})`} />
        <path d={path} fill="none" stroke="var(--pink)" strokeWidth="1.2" strokeDasharray="2 1.5" />
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t, i) => {
          const m = path.match(/[ML]\s*([\d.]+)\s+([\d.]+)/g) || [];
          // Just place small dots evenly along x for a quick visual.
          return <circle key={i} cx={5 + t * 90} cy={40 + Math.sin(t * 6) * 14} r="1" fill="var(--pink)" />;
        })}
      </svg>
    </div>
    <div className="desc">{desc}</div>
  </div>
);

/* ─── Timeline ────────────────────────────────────────── */

const Timeline = ({ duration, fps, playhead, setPlayhead, regions, playing, setPlaying, onChangeRegion,
                    selectedId, onSelectRegion,
                    notes, selectedNoteId, onSelectNote, onEditNote, onChangeNote, onDeleteNote, onAddNote,
                    firingNote, firingProgress }) => {
  const tlRef = useRef(null);
  const totalFrames = duration * fps;

  // Helpers for clip drag: returns a function that scrubs the clip's
  // startFrame / endFrame based on which edge is grabbed.
  const dragClip = (region, edge) => (e) => {
    e.stopPropagation();
    const tl = tlRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const orig = { startFrame: region.startFrame, endFrame: region.endFrame };
    const move = (ev) => {
      const deltaFrac = (ev.clientX - startX) / tl.width;
      const deltaFrames = Math.round(deltaFrac * totalFrames);
      let next = { ...orig };
      if (edge === "left")  next.startFrame = clamp(orig.startFrame + deltaFrames, 0, orig.endFrame - fps);
      if (edge === "right") next.endFrame   = clamp(orig.endFrame   + deltaFrames, orig.startFrame + fps, totalFrames);
      if (edge === "body") {
        const dur = orig.endFrame - orig.startFrame;
        next.startFrame = clamp(orig.startFrame + deltaFrames, 0, totalFrames - dur);
        next.endFrame   = next.startFrame + dur;
      }
      onChangeRegion?.({ ...region, ...next });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onScrub = (e) => {
    const r = tlRef.current.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width, 0, 1);
    setPlayhead({ t: x, frame: Math.floor(x * totalFrames) });
  };
  const onPointerDown = (e) => {
    onScrub(e);
    const move = (ev) => onScrub(ev);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // generate ruler ticks every ~30s
  const ticks = [];
  for (let s = 0; s <= duration; s += 30) {
    const t = s / duration;
    ticks.push({ t, label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, major: s % 60 === 0 });
  }

  return (
    <>
      <div className="tl-head">
        <div className="tl-transport">
          <button title="Back"><Icons.SkipBack size={14} /></button>
          <button className="play" onClick={() => setPlaying(!playing)} title={playing ? "Pause" : "Play"}>
            {playing ? <Icons.Pause size={13} /> : <Icons.Play size={13} />}
          </button>
          <button title="Forward"><Icons.Skip size={14} /></button>
        </div>
        <div className="tc">
          <span className="cur">{fmtTC(playhead.frame, fps)}</span>
          <span className="div">/</span>
          <span>{fmtTC(totalFrames, fps)}</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button
            className="btn"
            onClick={onAddNote}
            title="Add audio description at playhead (N)"
            style={{ paddingLeft: 9 }}
          >
            <Icons.Speaker size={13} sw={1.8} /> Add note
          </button>
          <span className="chip">{fps} fps</span>
          <span className="chip">1920×1080</span>
          <button className="btn ghost" title="Fit to view">
            <Icons.Layers size={13} />
          </button>
        </div>
      </div>
      <div className="tl-body">
        <div className="tl-inner" ref={tlRef} onPointerDown={onPointerDown} style={{ cursor: "ew-resize" }}>
          <div className="tl-ruler">
            {ticks.map((tk, i) => (
              <div key={i} className={`tl-tick ${tk.major ? "major" : ""}`} style={{ left: (tk.t * 100) + "%" }}>
                {tk.label}
              </div>
            ))}
          </div>
          <WaveformBackdrop />
          <NotesTrack
            notes={notes || []}
            totalFrames={totalFrames}
            selectedId={selectedNoteId}
            onSelect={onSelectNote}
            onEdit={onEditNote}
            onChange={onChangeNote}
            onDelete={onDeleteNote}
            firingNote={firingNote}
            firingProgress={firingProgress}
          />
          {regions.map((r) => {
            // Sync the timeline track with the video position so the user can
            // see at a glance which region is currently in effect (active) and
            // which one the inspector is editing (selected).
            const isActive   = playhead.frame >= (r.startFrame ?? 0) && playhead.frame <= (r.endFrame ?? totalFrames);
            const isSelected = r.id === selectedId;
            return (
            <div
              className={`tl-row ${isSelected ? "selected" : ""}`}
              key={r.id}
              onClick={(e) => { if (e.target.closest('.tl-clip')) return; onSelectRegion?.(r.id); }}
              title="Click to select this region"
            >
              <div className="rname">
                <span className="sw" style={{ background: TYPE_META[r.type]?.color }} />
                {r.name}
              </div>
              <div
                className={`tl-clip ${
                  r.type === "watermark" ? "pink" :
                  r.type === "caption" ? "warn" :
                  r.type === "broadcaster" ? "blue" : ""
                } ${isActive ? "active" : ""} ${isSelected ? "selected" : ""}`}
                style={{
                  left: (r.startFrame / totalFrames) * 100 + "%",
                  width: ((r.endFrame - r.startFrame) / totalFrames) * 100 + "%",
                  cursor: "grab",
                }}
                onPointerDown={dragClip(r, "body")}
                onClick={(e) => { e.stopPropagation(); onSelectRegion?.(r.id); }}
              >
                <div className="tl-clip-handle left"  onPointerDown={dragClip(r, "left")} />
                <div className="tl-clip-handle right" onPointerDown={dragClip(r, "right")} />
              </div>
              {r.motion === "tracked" && r.keyframes && r.keyframes.map((k, i) => (
                <div
                  key={i}
                  className="tl-keyframe"
                  style={{
                    left: `calc(${(r.startFrame / totalFrames) * 100 + k.t * ((r.endFrame - r.startFrame) / totalFrames) * 100}% - 4px)`,
                  }}
                />
              ))}
            </div>
          );
          })}
          <div className="tl-playhead" style={{ left: (playhead.t * 100) + "%" }} />
        </div>
      </div>
    </>
  );
};

/* ─── Compare overlay (before/after split) ───────────── */

const CompareStage = ({ regions, scene, playhead }) => {
  const [split, setSplit] = useState(50);
  const wrap = useRef(null);

  // Sample watermark position at current playhead for the compare frame.
  const watermarkPos = useMemo(() => {
    const wm = regions.find((r) => r.motion === "tracked" && r.keyframes);
    if (!wm) return null;
    const sampled = sampleKeyframes(wm.keyframes, playhead?.t ?? 0);
    if (!sampled) return null;
    return { x: sampled.x + wm.w / 2, y: sampled.y + wm.h / 2 };
  }, [regions, playhead?.t]);

  const onDown = (e) => {
    const move = (ev) => {
      const r = wrap.current.getBoundingClientRect();
      setSplit(clamp(((ev.clientX - r.left) / r.width) * 100, 5, 95));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="compare-stage" ref={wrap} style={{ "--split": split + "%" }}>
      <div className="layer before">
        <MockScene
          scene={scene || "tokyo"}
          regions={regions}
          cleaned={false}
          watermarkPos={watermarkPos}
          fontScale={1.6}
        />
        <span className="compare-label before">BEFORE</span>
      </div>
      <div className="layer after">
        <MockScene
          scene={scene || "tokyo"}
          regions={regions}
          cleaned={true}
          watermarkPos={watermarkPos}
          fontScale={1.6}
        />
        <span className="compare-label after">AFTER · ALPHA</span>
      </div>
      <div className="compare-divider">
        <div className="knob" onPointerDown={onDown}>
          <Icons.Move size={14} />
        </div>
      </div>
    </div>
  );
};

/* ─── The whole Editor screen ──────────────────────────── */

// Stream status overlay — appears top-left of stage in live / url mode.
// Shows source, latency sparkline, buffer health.
const StreamStatus = ({ project }) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 600);
    return () => clearInterval(id);
  }, []);

  // Fake a latency sparkline. 12 bars, jittering.
  const bars = useMemo(() => {
    return Array.from({ length: 12 }).map((_, i) => 4 + Math.round(Math.abs(Math.sin((tick + i) * 1.7)) * 7));
  }, [tick]);

  const isLive = project?.source === "live";
  const latency = isLive ? 164 + Math.round((tick % 6) - 2) : 38;

  return (
    <div className="stream-status">
      <div className={`sb ${isLive ? "live" : ""}`}>
        {isLive ? "LIVE" : (project?.platform || "").toUpperCase()} {!isLive && "·"} <span style={{ color: "var(--ink)" }}>{!isLive ? "1080p" : "1080p60"}</span>
      </div>
      <div className="sb">
        <span style={{ color: "var(--ink-3)" }}>latency</span>
        <span className="spark">
          {bars.map((h, i) => <span key={i} style={{ height: h + "px" }} />)}
        </span>
        <span style={{ color: "var(--accent)" }}>{latency} ms</span>
      </div>
      <div className="sb">
        <span style={{ color: "var(--ink-3)" }}>delogo</span>
        <span style={{ color: "var(--accent)" }}>● applied</span>
        <span style={{ color: "var(--ink-3)" }}>· {isLive ? "12.4k" : "8.2k"} frames</span>
      </div>
    </div>
  );
};

/* ─── Pre-detect modal ──────────────────────────────────
 * Shown after a real video loads (or whenever the user hits Re-detect).
 * Lets the user pick which detector categories to run BEFORE we touch the
 * video — no more automatic full-clip scan that surprises users with
 * regions they didn't ask for. Selections persist within the session so
 * Re-detect doesn't keep re-asking. */
const PreDetectModal = ({ open, defaults, onConfirm, onCancel }) => {
  const [categories, setCategories] = useState(defaults);
  React.useEffect(() => { if (open) setCategories(defaults); }, [open, defaults]);
  if (!open) return null;
  const anyChecked = categories.captions || categories.logos || categories.watermarks || categories.audioOpps;
  const toggle = (k) => setCategories((c) => ({ ...c, [k]: !c[k] }));
  return (
    <div
      role="dialog" aria-modal="true" aria-label="What to detect"
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: "min(440px, calc(100vw - 32px))",
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: 10,
          boxShadow: "var(--shadow)",
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 6 }}>Detect</div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>What should we look for?</h2>
        <p style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5, margin: "8px 0 16px" }}>
          Pick the categories to scan for. You can re-run this at any time from the Re-detect button. Skipping is fine — you can draw regions and add notes manually.
        </p>

        {[
          { key: "captions",   title: "Burned-in captions",                desc: "Open captions or subtitles burned into the video that need removal." },
          { key: "logos",      title: "Network / channel logos",           desc: "Static, opaque graphics in a corner — broadcaster idents, channel bugs, station IDs." },
          { key: "watermarks", title: "Watermarks",                        desc: "Semi-transparent text or graphics outside the corners — content-ID, anti-piracy, vendor stamps. Heuristic — review results carefully." },
          { key: "audioOpps",  title: "Audio description opportunities",   desc: "Pauses in the audio long enough to host a description. Adds draft notes you can record over." },
        ].map((item) => (
          <label
            key={item.key}
            style={{
              display: "flex", gap: 10, alignItems: "flex-start",
              padding: "10px 12px", marginBottom: 6,
              border: `1px solid ${categories[item.key] ? "var(--accent)" : "var(--line)"}`,
              borderRadius: 8, cursor: "pointer",
              background: categories[item.key] ? "rgba(122,168,255,.06)" : "transparent",
            }}
          >
            <input
              type="checkbox"
              checked={categories[item.key]}
              onChange={() => toggle(item.key)}
              style={{ accentColor: "var(--accent)", marginTop: 3 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{item.title}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5, marginTop: 2 }}>{item.desc}</div>
            </div>
          </label>
        ))}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button className="btn ghost" style={{ flex: 1, justifyContent: "center" }} onClick={onCancel}>Skip</button>
          <button
            className="btn primary"
            style={{ flex: 1.2, justifyContent: "center" }}
            disabled={!anyChecked}
            onClick={() => onConfirm(categories)}
            title={anyChecked ? "Run the selected detectors" : "Tick at least one category"}
          >
            Start scan
          </button>
        </div>
      </div>
    </div>
  );
};

const Editor = ({ project, onBack, onExport, tweaks }) => {
  const [regions, setRegions] = useState(DEFAULT_REGIONS);
  const [selectedId, setSelectedId] = useState("r1");
  const [mode, setMode] = useState("detect"); // detect | draw | track | compare
  const [playhead, setPlayhead] = useState({ t: 0.36, frame: Math.floor(0.36 * 7200) });
  const [playing, setPlaying] = useState(false);
  const [drawingPreview, setDrawingPreview] = useState(null);
  const [selectedTake, setSelectedTake] = useState("take-a");
  const fps = 24;
  // duration: starts at 300s (mock default) but is replaced with the actual
  // video's duration once metadata loads. videoRef lets the timeline scrubber
  // and play/pause buttons drive the real <video> element.
  const [duration, setDuration] = useState(300);
  const videoRef = useRef(null);
  const totalFrames = duration * fps;
  const scene = project?.scene || "tokyo";
  const hasRealVideo = !!project?.videoSrc;

  // Sync: <video> → editor.
  // Read real duration on metadata, and mirror currentTime into playhead.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      if (v.duration && isFinite(v.duration)) setDuration(v.duration);
    };
    const onTime = () => {
      if (!v.duration || !isFinite(v.duration)) return;
      const t = v.currentTime / v.duration;
      setPlayhead({ t, frame: Math.floor(t * v.duration * fps) });
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    // Catch the case where metadata was already loaded before the listener.
    if (v.readyState >= 1) onMeta();
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [hasRealVideo, fps]);

  // Sync: editor.playing → <video>.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing && v.paused) v.play().catch(() => setPlaying(false));
    if (!playing && !v.paused) v.pause();
  }, [playing]);

  // ─── Heuristic auto-detect ─────────────────────────────
  // Runs once per real-video mount. Replaces DEFAULT_REGIONS with detected
  // caption bands and logo corners. Errors surface in detectError.
  const [detectStatus, setDetectStatus] = useState(null); // { message, pct } | null
  const [detectError, setDetectError] = useState(null);
  const [autoDetectDone, setAutoDetectDone] = useState(false);
  // When a real video first loads we don't auto-scan: the user picks which
  // categories (captions / logos / audio description opportunities) they
  // want detected via the pre-detect modal.
  const [preDetectOpen, setPreDetectOpen] = useState(false);
  const [detectCategories, setDetectCategories] = useState({
    captions: true, logos: true, watermarks: false, audioOpps: false,
  });

  // Convert detector output to the editor's audio-note shape.
  // Each opportunity becomes a draft "overlay" note seeded with a label
  // the user can edit. The pause window is preserved as the note's duration.
  const opportunityToNote = (op, i) => ({
    id: `auto-note-${Date.now()}-${i}`,
    frame: Math.round(op.startSeconds * fps),
    durationFrames: Math.max(24, Math.round((op.endSeconds - op.startSeconds) * fps)),
    text: `Pause detected (${(op.endSeconds - op.startSeconds).toFixed(1)}s) — add description`,
    mode: "overlay",
    draft: true,
  });

  // Generic detection runner used by the modal-driven first scan, the
  // global Re-detect control, and the per-region Re-fit affordance.
  // `scope` is either "global" (replace all regions) or { regionId } to
  // surgically refit a single region's geometry + time bounds.
  const runDetection = useCallback(async ({ categories, startSeconds, endSeconds, scope = "global" }) => {
    const v = videoRef.current;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    if (typeof detectRegions !== "function") {
      setDetectError("Detector script not loaded");
      return;
    }
    setDetectError(null);
    setDetectStatus({ message: scope === "global" ? "Preparing scan…" : "Re-fitting region…", pct: 0 });

    try {
      // Image-based detection (captions + logos + watermarks gated by categories).
      const wantImage = categories.captions || categories.logos || categories.watermarks;
      const found = wantImage
        ? await detectRegions(v, {
            sampleCount: scope === "global" ? 14 : 10,
            categories: {
              captions: !!categories.captions,
              logos: !!categories.logos,
              watermarks: !!categories.watermarks,
            },
            startSeconds, endSeconds,
            onProgress: (p) => setDetectStatus({
              message: p.message,
              pct: p.stage === "sampling" ? Math.round((p.index / p.total) * 100) : 100,
            }),
          })
        : [];

      // Audio pause detection runs independently of image analysis.
      let audioOpps = [];
      if (categories.audioOpps && scope === "global" && typeof detectAudioPauses === "function") {
        setDetectStatus({ message: "Scanning audio for pause opportunities…", pct: 50 });
        try {
          audioOpps = await detectAudioPauses(project?.videoSrc, { minDurationSec: 1.6 });
          if (startSeconds !== undefined || endSeconds !== undefined) {
            const s0 = startSeconds ?? 0;
            const e0 = endSeconds ?? Infinity;
            audioOpps = audioOpps.filter((op) => op.startSeconds >= s0 && op.endSeconds <= e0);
          }
        } catch (audioErr) {
          // Don't fail the whole scan if audio decode failed.
          console.warn("[audio detect] skipped:", audioErr.message);
        }
      }

      // Apply results.
      if (scope === "global") {
        const newRegions = detectionToRegions(found, fps, v.duration);
        const newNotes = audioOpps.map(opportunityToNote);
        // A global scan replaces the auto-detected set: drop every
        // non-user-edited region — including the demo/seed regions for
        // categories the user did NOT pick — and swap in only what this scan
        // found. This MUST run even when newRegions is empty; otherwise seed
        // logo/watermark regions linger and still get removed on export even
        // though the user only selected captions. User-edited regions are
        // preserved so manual work (IN/OUT, geometry, polygons) is never lost.
        setRegions((prev) => {
          const keepers = prev.filter((r) => r.userEdited);
          return [...keepers, ...newRegions];
        });
        if (newRegions.length > 0) setSelectedId(newRegions[0].id);
        if (newNotes.length > 0) {
          setNotes((prev) => [...prev, ...newNotes]);
        }
        const totalFound = newRegions.length + newNotes.length;
        setDetectStatus({
          message: totalFound > 0
            ? `Found ${newRegions.length} region${newRegions.length === 1 ? "" : "s"}${newNotes.length ? ` + ${newNotes.length} audio opportunit${newNotes.length === 1 ? "y" : "ies"}` : ""} · review and adjust`
            : "Nothing detected in selected categories — draw regions manually.",
          pct: 100,
        });
        setTimeout(() => setDetectStatus(null), 3500);
      } else {
        // Refit scope: merge the strongest caption into the named region.
        // Re-fit is an explicit per-region user action, so it's OK to update
        // bounds — but if the user has manually narrowed the time range,
        // KEEP their narrower IN/OUT and only update geometry. Otherwise
        // Re-fit would undo the very thing the user was trying to commit.
        const captionResult = found.find((d) => d.kind === "caption");
        if (!captionResult) {
          setDetectStatus({ message: "No captions found in that range — region kept as-is.", pct: 100 });
          setTimeout(() => setDetectStatus(null), 3000);
        } else {
          setRegions((rs) => rs.map((reg) => {
            if (reg.id !== scope.regionId) return reg;
            const patch = {
              x: captionResult.xPct, y: captionResult.yPct,
              w: captionResult.wPct, h: captionResult.hPct,
              confidence: captionResult.confidence,
            };
            // Only widen / tighten time bounds if user hasn't pinned them.
            if (!reg.userEdited) {
              patch.startFrame = Math.floor(captionResult.startSeconds * fps);
              patch.endFrame   = Math.ceil(captionResult.endSeconds * fps);
            }
            return { ...reg, ...patch };
          }));
          setDetectStatus({
            message: "Region refit (geometry updated · IN/OUT preserved if you edited them).",
            pct: 100,
          });
          setTimeout(() => setDetectStatus(null), 3000);
        }
      }
    } catch (e) {
      setDetectError(e.message || String(e));
      setDetectStatus(null);
    } finally {
      if (scope === "global") setAutoDetectDone(true);
    }
  }, [fps, project?.videoSrc]);

  // Convenience: refit a single region by id.
  const refitRegion = useCallback(async (regionId) => {
    const r = regions.find((reg) => reg.id === regionId);
    if (!r) return;
    const v = videoRef.current;
    if (!v) return;
    const t0 = (r.startFrame ?? 0) / fps;
    const t1 = Math.min(v.duration, (r.endFrame ?? v.duration * fps) / fps);
    if (t1 - t0 < 0.3) {
      setDetectError("Region's active range is too short to refit.");
      return;
    }
    await runDetection({
      categories: { captions: true, logos: false, audioOpps: false },
      startSeconds: t0, endSeconds: t1,
      scope: { regionId },
    });
  }, [regions, fps, runDetection]);

  // First-load gate: when a new real video is detected, show the modal so
  // the user picks what to scan for. We never auto-fire detection anymore.
  useEffect(() => {
    if (!hasRealVideo || autoDetectDone || preDetectOpen) return;
    const v = videoRef.current;
    if (!v) return;
    if (v.readyState >= 1 && v.videoWidth) {
      setPreDetectOpen(true);
    } else {
      const onReady = () => { v.removeEventListener("loadedmetadata", onReady); setPreDetectOpen(true); };
      v.addEventListener("loadedmetadata", onReady);
      return () => v.removeEventListener("loadedmetadata", onReady);
    }
  }, [hasRealVideo, autoDetectDone, preDetectOpen]);

  // Compatibility shim: existing "Re-detect" button + retry paths call this.
  const runAutoDetect = useCallback(() => {
    // Default the re-scan to whatever the user picked in the modal, falling
    // back to the obvious defaults if they never went through it.
    setPreDetectOpen(true);
  }, []);

  // Sync: editor.playhead.t (set by timeline scrub) → <video>.currentTime.
  // Use a ref to suppress feedback loops with the timeupdate listener above.
  const seekingRef = useRef(false);
  const seekFromEditor = useCallback((t) => {
    const v = videoRef.current;
    if (!v || !v.duration || !isFinite(v.duration)) {
      setPlayhead({ t, frame: Math.floor(t * totalFrames) });
      return;
    }
    seekingRef.current = true;
    v.currentTime = t * v.duration;
    setPlayhead({ t, frame: Math.floor(t * v.duration * fps) });
  }, [totalFrames, fps]);

  /* ─── Audio notes state + trigger logic ─────────────── */
  const [notes, setNotes] = useState(DEFAULT_NOTES);
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [showRecorder, setShowRecorder] = useState(false);
  const [editingNote, setEditingNote] = useState(null);

  /* ─── Caption cues (replacement closed captions) ────
   * Cue shape: { id, startSeconds, endSeconds, text, source }
   *   source: "manual" | "whisper" | "import"
   * These are NEW captions we generate or hand-author to REPLACE the
   * burned-in open captions we're removing. They render as a real
   * overlay on the video and can be exported as a WebVTT track. */
  const [captions, setCaptions] = useState([]);
  const [selectedCueId, setSelectedCueId] = useState(null);
  const [autoCaption, setAutoCaption] = useState(null); // { stage, message, pct } | null
  const [autoCaptionError, setAutoCaptionError] = useState(null);

  const onAddCaption = useCallback((startOverride) => {
    const start = startOverride ?? (videoRef.current?.currentTime ?? 0);
    const dur = videoRef.current?.duration ?? 0;
    const id = `cue-${Date.now()}`;
    const cue = {
      id,
      startSeconds: start,
      endSeconds: Math.min(dur, start + 3),
      text: "",
      source: "manual",
    };
    setCaptions((cs) => [...cs, cue].sort((a, b) => a.startSeconds - b.startSeconds));
    setSelectedCueId(id);
  }, []);

  const onChangeCaption = useCallback((id, patch) => {
    setCaptions((cs) => cs.map((c) => c.id === id ? { ...c, ...patch } : c)
      .sort((a, b) => a.startSeconds - b.startSeconds));
  }, []);

  const onDeleteCaption = useCallback((id) => {
    setCaptions((cs) => cs.filter((c) => c.id !== id));
    setSelectedCueId((cur) => cur === id ? null : cur);
  }, []);

  const onJumpToCaption = useCallback((cue) => {
    const v = videoRef.current;
    if (v) v.currentTime = cue.startSeconds;
    setSelectedCueId(cue.id);
  }, []);

  // Current cue under playhead (for the on-stage overlay).
  // playhead is the editor's state object { frame, t } where t is seconds.
  const currentTimeSec = typeof playhead === "object" && playhead ? (playhead.t ?? (playhead.frame / fps)) : (playhead || 0);
  const activeCue = captions.find(
    (c) => currentTimeSec >= c.startSeconds && currentTimeSec <= c.endSeconds
  );

  // Auto-transcribe entry point (Whisper via transformers.js, lazy-loaded).
  // range: optional { startSeconds, endSeconds } to scope transcription to
  // a window instead of the whole clip. Passed straight to transcribe.js;
  // returned cue timestamps are already shifted to original-video time.
  const runAutoCaption = useCallback(async (range) => {
    setAutoCaptionError(null);
    const rangeLabel = range
      ? ` for ${Math.floor((range.startSeconds || 0) / 60)}:${String(Math.floor((range.startSeconds || 0) % 60)).padStart(2, "0")}–${Math.floor((range.endSeconds || 0) / 60)}:${String(Math.floor((range.endSeconds || 0) % 60)).padStart(2, "0")}`
      : "";
    setAutoCaption({ stage: "init", message: `Loading speech model${rangeLabel} (one-time ~80 MB)…`, pct: 0 });
    try {
      if (typeof window.runWhisperCaption !== "function") {
        // Lazy-load the transcriber wrapper on demand.
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "transcribe.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("Could not load transcribe.js"));
          document.body.appendChild(s);
        });
      }
      if (typeof window.runWhisperCaption !== "function") {
        throw new Error("Transcriber not available after load");
      }
      const cues = await window.runWhisperCaption(project?.videoSrc, {
        startSeconds: range?.startSeconds,
        endSeconds:   range?.endSeconds,
        onProgress: (p) => setAutoCaption(p),
      });
      const stamped = cues.map((c, i) => ({
        ...c,
        id: `whisper-${Date.now()}-${i}`,
        source: "whisper",
      }));
      // Merge with existing captions (don't clobber manual cues).
      setCaptions((prev) => {
        const manual = prev.filter((c) => c.source !== "whisper");
        return [...manual, ...stamped].sort((a, b) => a.startSeconds - b.startSeconds);
      });
      setAutoCaption({
        stage: "done",
        message: `Generated ${stamped.length} caption${stamped.length === 1 ? "" : "s"}`,
        pct: 100,
      });

      setTimeout(() => setAutoCaption(null), 5000);
    } catch (e) {
      setAutoCaptionError(e.message || String(e));
      setAutoCaption(null);
    }
  }, [project?.videoSrc]);

  // Manual on-screen text scan (opt-in). Finds gaps in the caption track,
  // OCRs the middle of each gap, and drafts audio descriptions for visible
  // text the dialogue doesn't cover. Lazy-loads ocr.js + Tesseract on first
  // run. Kept separate from Transcribe so it never auto-fires — the user
  // invokes it explicitly, which also avoids the frame-seek stall some
  // embedded Chromium environments hit when OCR runs right after Whisper.
  const runOCRScan = useCallback(async () => {
    setAutoCaptionError(null);
    const v = videoRef.current;
    if (!v || !isFinite(v.duration)) {
      setAutoCaptionError("Load a video before scanning for on-screen text.");
      return;
    }
    setAutoCaption({ stage: "init", message: "Loading on-screen text scanner…", pct: 0 });
    try {
      if (typeof window.findUncoveredOnScreenText !== "function") {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "ocr.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("Could not load ocr.js"));
          document.body.appendChild(s);
        });
      }
      if (typeof window.findUncoveredOnScreenText !== "function") {
        throw new Error("OCR module not available after load");
      }
      const suggestions = await window.findUncoveredOnScreenText(
        project?.videoSrc,
        captions,
        {
          // ocr.js creates its own tiny blob-backed <video> for seeks so it
          // doesn't fight the editor's playhead sync.
          videoDurationSec: v.duration,
          maxSamples: 10,
          minGapSec: 3,
          coverageThreshold: 0.4,
          onProgress: (p) => setAutoCaption({
            stage: p.stage,
            message: `On-screen text: ${p.message}`,
            pct: p.pct ?? 0,
          }),
        }
      );

      if (suggestions.length > 0) {
        const draftNotes = suggestions.map((s, i) => ({
          id: `ocr-${Date.now()}-${i}`,
          frame: Math.round(s.sampleTime * fps),
          durationFrames: Math.max(72, Math.round(s.detectedText.split(/\s+/).length * 0.35 * fps)),
          text: `On-screen: "${s.detectedText.replace(/\n/g, " ").slice(0, 120)}" — not in dialogue`,
          mode: "pause",
          draft: true,
          ocrConfidence: s.confidence,
          ocrCoverage: s.coverageRatio,
        }));
        setNotes((prev) => [...prev, ...draftNotes].sort((a, b) => a.frame - b.frame));
        setAutoCaption({
          stage: "done",
          message: `${draftNotes.length} draft description${draftNotes.length === 1 ? "" : "s"} from on-screen text`,
          pct: 100,
        });
      } else {
        setAutoCaption({
          stage: "done",
          message: "No uncovered on-screen text found in caption gaps",
          pct: 100,
        });
      }
      setTimeout(() => setAutoCaption(null), 5000);
    } catch (ocrErr) {
      setAutoCaptionError(`On-screen text scan failed: ${ocrErr.message}`);
      setAutoCaption(null);
    }
  }, [project?.videoSrc, captions, fps]);
  // firing = { id, mode, startedAt, durationMs, wasPlaying }; null when nothing playing.
  const [firing, setFiring] = useState(null);
  const [firingProgress, setFiringProgress] = useState(0);

  // Crossing detection: did the playhead just step over any note's start frame?
  const lastFrameRef = useRef(playhead.frame);
  useEffect(() => {
    const last = lastFrameRef.current;
    const cur = playhead.frame;
    lastFrameRef.current = cur;
    // Don't re-trigger on scrub-back or while already firing.
    if (cur < last || firing) return;
    // Only trigger while play is advancing forward — so manual scrubs don't fire.
    if (!playing) return;
    const hit = notes.find((n) => last < n.frame && cur >= n.frame);
    if (hit) {
      const durationMs = (hit.durationFrames / fps) * 1000;
      const wasPlaying = playing;
      if (hit.mode === "pause") setPlaying(false);
      setFiring({ id: hit.id, mode: hit.mode, startedAt: Date.now(), durationMs, wasPlaying });
      setFiringProgress(0);
    }
  }, [playhead.frame, playing, notes, firing, fps]);

  // While firing — drive progress and auto-end after durationMs of real time.
  useEffect(() => {
    if (!firing) return;
    const tick = () => {
      const elapsed = Date.now() - firing.startedAt;
      const p = Math.min(1, elapsed / firing.durationMs);
      setFiringProgress(p);
      if (p >= 1) {
        clearInterval(iv);
        // Resume only if we were the one who paused it.
        if (firing.mode === "pause" && firing.wasPlaying) setPlaying(true);
        setFiring(null);
      }
    };
    const iv = setInterval(tick, 80);
    return () => clearInterval(iv);
  }, [firing]);

  const skipNote = () => {
    if (!firing) return;
    if (firing.mode === "pause" && firing.wasPlaying) setPlaying(true);
    setFiring(null);
  };

  const firingNote = firing ? notes.find((n) => n.id === firing.id) : null;

  // CRUD handlers for notes
  const onAddNote = () => { setEditingNote(null); setShowRecorder(true); };
  const onEditNote = (note) => { setEditingNote(note); setShowRecorder(true); };
  const onChangeNote = (next) => {
    setNotes((ns) => ns.map((n) => (n.id === next.id ? next : n)));
  };
  const onSaveNote = (next) => {
    setNotes((ns) => ns.some((n) => n.id === next.id)
      ? ns.map((n) => (n.id === next.id ? next : n))
      : [...ns, next]);
    setSelectedNoteId(next.id);
  };
  const onDeleteNote = (id) => {
    setNotes((ns) => ns.filter((n) => n.id !== id));
    if (selectedNoteId === id) setSelectedNoteId(null);
  };

  // Keyboard shortcut: N adds a note at playhead.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches("input, textarea")) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        onAddNote();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-advance playhead when playing.
  // Skip this when a real video is loaded — the <video> element's timeupdate
  // listener already drives the playhead at the true playback rate.
  useEffect(() => {
    if (!playing || hasRealVideo) return;
    const id = setInterval(() => {
      setPlayhead((p) => {
        const next = (p.t + 0.002) % 1;
        return { t: next, frame: Math.floor(next * duration * fps) };
      });
    }, 33);
    return () => clearInterval(id);
  }, [playing, duration, fps, hasRealVideo]);

  // When user switches to track mode, select the watermark region.
  useEffect(() => {
    if (mode === "track") {
      const wm = regions.find((r) => r.motion === "tracked");
      if (wm) setSelectedId(wm.id);
    }
  }, [mode]);

  const onSelectRegion = (id) => setSelectedId(id);
  const onChangeRegion = (next) => {
    setRegions((rs) => rs.map((r) => (r.id === next.id ? next : r)));
  };
  const onToggleVisible = (id) => {
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, visible: !r.visible } : r)));
  };
  const onDeleteRegion = (id) => {
    setRegions((rs) => rs.filter((r) => r.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const onAddRegion = (kind) => {
    if (kind === "auto") {
      // simulate detection adding one more
      const id = "r" + Date.now();
      setRegions((rs) => [
        ...rs,
        {
          id, name: "Broadcaster bug", type: "broadcaster", cls: "r-broadcaster",
          x: 4, y: 84, w: 14, h: 8,
          method: "delogo", opacity: 100, feather: 6, motion: "static", visible: true,
          startFrame: 0, endFrame: 7200, confidence: 0.88,
        },
      ]);
      setSelectedId(id);
      return;
    }
    setMode("draw");
  };
  const onDraw = (geom) => {
    const id = "r" + Date.now();
    setRegions((rs) => [
      ...rs,
      {
        id,
        name: "Region " + (rs.length + 1),
        type: "logo",
        cls: "r-logo",
        shape: "rect",
        x: geom.x, y: geom.y, w: geom.w, h: geom.h,
        method: "delogo", opacity: 100, feather: 4, motion: "static", visible: true,
        startFrame: 0, endFrame: duration * fps, confidence: undefined,
      },
    ]);
    setSelectedId(id);
    setMode("detect");
  };

  // Commit a freshly drawn polygon as a new region. `points` is an array of
  // {x, y} percentages of the frame. Bounding box is derived for legacy
  // consumers; the polygon shape itself drives rendering and export.
  const onDrawPolygon = (points) => {
    if (!points || points.length < 3) return;
    const bbox = polygonBBox(points);
    const id = "r" + Date.now();
    setRegions((rs) => [
      ...rs,
      {
        id,
        name: "Polygon " + (rs.length + 1),
        type: "caption",
        cls: "r-caption",
        shape: "polygon",
        points: points.map((p) => ({ x: p.x, y: p.y })),
        x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h,
        method: "inpaint", opacity: 100, feather: 8, motion: "static", visible: true,
        startFrame: 0, endFrame: duration * fps, confidence: undefined,
      },
    ]);
    setSelectedId(id);
    setMode("detect");
  };

  const selectedRegion = regions.find((r) => r.id === selectedId);

  return (
    <div className="editor">
      {/* Left rail */}
      <div className="ed-left">
        <LeftRail
          regions={regions}
          selectedId={selectedId}
          onSelect={onSelectRegion}
          onToggleVisible={onToggleVisible}
          onDelete={onDeleteRegion}
          onAdd={onAddRegion}
          fps={fps}
          // Seek the video (and editor playhead) into the region's active
          // window when its row is clicked. Land 1 frame past startFrame so
          // bounds-strict comparisons still consider the region active.
          onJumpTo={(r) => {
            const target = (r.startFrame ?? 0) + 1;
            const t = target / fps;
            setPlayhead({ frame: target, t });
            const v = videoRef.current;
            if (v && isFinite(v.duration)) v.currentTime = t;
          }}
          notes={notes}
          selectedNoteId={selectedNoteId}
          onSelectNote={setSelectedNoteId}
          onEditNote={onEditNote}
          onDeleteNote={onDeleteNote}
          onAddNote={onAddNote}
          // Same jump treatment for audio notes: clicking a note seeks the
          // video to one frame past the note start so it's clearly inside.
          onJumpToNote={(n) => {
            const target = n.frame + 1;
            const t = target / fps;
            setPlayhead({ frame: target, t });
            const v = videoRef.current;
            if (v && isFinite(v.duration)) v.currentTime = t;
          }}
          captions={captions}
          selectedCueId={selectedCueId}
          onSelectCue={setSelectedCueId}
          onJumpToCue={onJumpToCaption}
          onChangeCue={onChangeCaption}
          onDeleteCue={onDeleteCaption}
          onAddCue={onAddCaption}
          onAutoCaption={runAutoCaption}
          onScanText={runOCRScan}
          autoCaptionStatus={autoCaption}
          autoCaptionError={autoCaptionError}
        />
      </div>

      {/* Stage */}
      <div className="ed-stage">
        {/* Live stream status overlay (top-left) */}
        {(project?.source === "live" || project?.source === "url") && (
          <StreamStatus project={project} />
        )}

        {/* Replacement-caption overlay — shows the current cue's text
            burned-in over the video so the user can preview what the
            exported file's CC track will look like. */}
        {activeCue?.text && (
          <div
            aria-live="off"
            style={{
              position: "absolute",
              left: "50%", bottom: "8%",
              transform: "translateX(-50%)",
              maxWidth: "80%",
              padding: "6px 14px",
              background: "rgba(0,0,0,0.75)",
              color: "#fff",
              fontSize: "clamp(14px, 2vw, 22px)",
              fontFamily: "system-ui, sans-serif",
              lineHeight: 1.3,
              textAlign: "center",
              borderRadius: 4,
              pointerEvents: "none",
              zIndex: 5,
              textShadow: "0 1px 2px rgba(0,0,0,0.9)",
            }}
          >
            {activeCue.text}
          </div>
        )}

        {/* Mode toolbar floating */}
        <div className="stage-tools">
          <button className={`stage-tool ${mode === "detect" ? "active" : ""}`} onClick={() => setMode("detect")} title="Select & adjust">
            <Icons.Move size={16} />
          </button>
          <button className={`stage-tool ${mode === "draw" ? "active" : ""}`} onClick={() => setMode("draw")} title="Draw rectangle region (R)">
            <Icons.Square size={16} />
          </button>
          <button className={`stage-tool ${mode === "polygon" ? "active" : ""}`} onClick={() => setMode("polygon")} title="Draw polygon region (P) — click vertices, double-click to close">
            {/* Tiny inline polygon glyph. Avoids hunting for a missing icon. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="12 3 21 9 18 20 6 20 3 9" />
            </svg>
          </button>
          <button className={`stage-tool ${mode === "track" ? "active" : ""}`} onClick={() => setMode("track")} title="Track watermark (T)">
            <Icons.Track size={16} />
          </button>
          <button className={`stage-tool ${mode === "compare" ? "active" : ""}`} onClick={() => setMode("compare")} title="Before / After (\)">
            <Icons.Split size={16} />
          </button>
        </div>

        {mode === "compare" ? (
          <CompareStage regions={regions.filter((r) => r.visible)} scene={scene} playhead={playhead} />
        ) : (
          <VideoStage
            regions={regions}
            selectedId={selectedId}
            onSelectRegion={onSelectRegion}
            onChangeRegion={onChangeRegion}
            mode={mode}
            onDraw={onDraw}
            onDrawPolygon={onDrawPolygon}
            playhead={playhead}
            drawingPreview={drawingPreview}
            onDrawingPreview={setDrawingPreview}
            scene={scene}
            videoSrc={project?.videoSrc}
            videoRef={videoRef}
          />
        )}

        {firingNote && (
          <AudioDescOverlay
            note={firingNote}
            progress={firingProgress}
            onSkip={skipNote}
          />
        )}

        {/* Auto-detect status / re-detect control */}
        {hasRealVideo && (detectStatus || detectError || autoDetectDone) && (
          <div
            role="status"
            aria-live="polite"
            style={{
              position: "absolute", top: 14, right: 14, zIndex: 6,
              maxWidth: 320, padding: "8px 12px",
              borderRadius: 8,
              background: detectError ? "rgba(239,83,80,.12)" : "var(--overlay-surface)",
              border: `1px solid ${detectError ? "rgba(239,83,80,.4)" : "var(--overlay-border)"}`,
              color: "var(--ink)",
              fontSize: 12, lineHeight: 1.4,
              boxShadow: "var(--shadow)",
              display: "flex", alignItems: "center", gap: 10,
            }}
          >
            {detectStatus ? (
              <>
                <div
                  aria-hidden="true"
                  style={{
                    width: 12, height: 12, borderRadius: 999,
                    border: "2px solid var(--accent)", borderTopColor: "transparent",
                    animation: "spin 0.8s linear infinite", flex: "none",
                  }}
                />
                <span>{detectStatus.message}</span>
              </>
            ) : detectError ? (
              <>
                <span style={{ flex: 1 }}><strong>Auto-detect skipped.</strong> {detectError}</span>
                <button className="btn ghost" style={{ padding: "2px 8px", fontSize: 11 }} onClick={runAutoDetect}>Retry</button>
              </>
            ) : (
              <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => { setAutoDetectDone(false); runAutoDetect(); }}>
                <Icons.Sparkle size={12} /> Re-detect
              </button>
            )}
          </div>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

        <div className="stage-zoom">
          <Icons.Layers size={11} /> Fit · 64%
        </div>
      </div>

      {/* Right inspector */}
      <div className="ed-right">
        <div style={{ padding: "14px 14px 8px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 4 }}>
            {mode === "track" ? "Tracker" : mode === "compare" ? "Compare" : "Region"}
          </div>
          <div style={{ fontSize: 13 }}>
            {mode === "compare" ? "Drag the divider to compare" :
             mode === "track" ? "Refine motion path" :
             selectedRegion ? selectedRegion.name : "Nothing selected"}
          </div>
        </div>
        {mode === "compare" ? (
          <div className="empty-state" style={{ padding: "36px 24px" }}>
            <div className="glyph"><Icons.Split size={18} /></div>
            <div style={{ marginBottom: 14 }}>
              Drag the divider on the stage to wipe between the original and the alpha-cleaned output.
            </div>
            <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={onExport}>
              <Icons.Download size={13} /> Continue to export
            </button>
          </div>
        ) : (
          <Inspector
            region={selectedRegion ? {
              ...selectedRegion,
              active: playhead.frame >= (selectedRegion.startFrame ?? 0) &&
                      playhead.frame <= (selectedRegion.endFrame ?? Infinity),
            } : null}
            mode={mode}
            onChange={onChangeRegion}
            onDelete={onDeleteRegion}
            onRefit={refitRegion}
            fps={fps}
            duration={duration}
            selectedTakeId={selectedTake}
            onSelectTake={setSelectedTake}
          />
        )}
      </div>

      {/* Timeline */}
      <div className="ed-timeline">
        <Timeline
          duration={duration}
          fps={fps}
          playhead={playhead}
          // When a real video is loaded, scrubs go through seekFromEditor so
          // <video>.currentTime is updated alongside the playhead. With no
          // real video, fall back to the original mock-state setter.
          setPlayhead={hasRealVideo
            ? (p) => seekFromEditor(typeof p === "function" ? p(playhead).t : p.t)
            : setPlayhead}
          regions={regions}
          playing={playing}
          setPlaying={setPlaying}
          onChangeRegion={onChangeRegion}
          selectedId={selectedId}
          onSelectRegion={onSelectRegion}
          notes={notes}
          selectedNoteId={selectedNoteId}
          onSelectNote={setSelectedNoteId}
          onEditNote={onEditNote}
          onChangeNote={onChangeNote}
          onDeleteNote={onDeleteNote}
          onAddNote={onAddNote}
          firingNote={firingNote}
          firingProgress={firingProgress}
        />
      </div>

      {showRecorder && (
        <NoteRecorderModal
          playheadFrame={playhead.frame}
          fps={fps}
          totalFrames={totalFrames}
          editing={editingNote}
          onSave={onSaveNote}
          onDelete={onDeleteNote}
          onClose={() => { setShowRecorder(false); setEditingNote(null); }}
        />
      )}

      <PreDetectModal
        open={preDetectOpen}
        defaults={detectCategories}
        onCancel={() => { setPreDetectOpen(false); setAutoDetectDone(true); }}
        onConfirm={(cats) => {
          setDetectCategories(cats);
          setPreDetectOpen(false);
          // Mark autoDetectDone immediately so the first-load useEffect
          // doesn't see an in-flight detection as "no decision made yet"
          // and re-open the modal mid-scan.
          setAutoDetectDone(true);
          runDetection({ categories: cats, scope: "global" });
        }}
      />
    </div>
  );
};

window.Editor = Editor;
window.DEFAULT_REGIONS = DEFAULT_REGIONS;
