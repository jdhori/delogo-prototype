/* global React */
// scenes.jsx — mock video frame backgrounds with burned-in elements
// so the transparency effect has something to "cut a hole" through.
//
// Each scene is a stylized illustration that reads as "a frame from a video"
// — a city skyline, a stage, a landscape — done with SVG + gradients so it
// stays crisp at any size and doesn't need image files.
//
// `regions` is an array of { id, x, y, w, h, type, content, removed } in
// percentages. When `removed: true`, the region is replaced by the
// transparency checkerboard. Otherwise the burned-in content shows on top.

const SCENES = {
  /* ─── Tokyo at night — neon city, watermark floats across ───────── */
  tokyo: {
    name: "Tokyo Streets",
    bg: "linear-gradient(180deg, #0a1230 0%, #2a0f3d 40%, #4a1a3a 70%, #2a1020 100%)",
    render: () => (
      <svg viewBox="0 0 160 90" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0a1230" />
            <stop offset="60%" stopColor="#3a154a" />
            <stop offset="100%" stopColor="#5a1f3a" />
          </linearGradient>
          <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff5fa8" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#ff5fa8" stopOpacity="0" />
          </linearGradient>
          <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="0.4" />
          </filter>
        </defs>
        <rect width="160" height="90" fill="url(#sky)" />
        {/* Moon */}
        <circle cx="128" cy="22" r="6" fill="#fdf2c4" opacity="0.4" />
        <circle cx="128" cy="22" r="3.5" fill="#fdf2c4" />
        {/* Neon glow band */}
        <rect x="0" y="48" width="160" height="20" fill="url(#glow)" />
        {/* Back-row silhouette buildings */}
        <g fill="#0a0716" opacity="0.85">
          <rect x="0" y="42" width="14" height="48" />
          <rect x="12" y="38" width="10" height="52" />
          <rect x="20" y="44" width="14" height="46" />
          <rect x="32" y="35" width="18" height="55" />
          <rect x="48" y="40" width="12" height="50" />
          <rect x="58" y="32" width="22" height="58" />
          <rect x="78" y="38" width="14" height="52" />
          <rect x="90" y="34" width="16" height="56" />
          <rect x="104" y="40" width="12" height="50" />
          <rect x="114" y="36" width="20" height="54" />
          <rect x="132" y="42" width="14" height="48" />
          <rect x="144" y="38" width="16" height="52" />
        </g>
        {/* Front-row buildings with windows */}
        <g fill="#1a0f24">
          <rect x="6" y="58" width="20" height="32" />
          <rect x="28" y="52" width="24" height="38" />
          <rect x="54" y="48" width="20" height="42" />
          <rect x="76" y="55" width="18" height="35" />
          <rect x="96" y="50" width="26" height="40" />
          <rect x="124" y="56" width="18" height="34" />
          <rect x="144" y="52" width="16" height="38" />
        </g>
        {/* Window lights (yellow/cyan dots) */}
        <g fill="#fdd76a">
          {Array.from({ length: 40 }).map((_, i) => {
            const x = 6 + (i * 4.1) % 156;
            const y = 56 + ((i * 7) % 30);
            return <rect key={i} x={x} y={y} width="0.8" height="0.8" opacity={0.4 + (i % 3) * 0.2} />;
          })}
        </g>
        <g fill="#7df0ff">
          {Array.from({ length: 20 }).map((_, i) => {
            const x = 10 + (i * 7.7) % 145;
            const y = 58 + ((i * 11) % 28);
            return <rect key={i} x={x} y={y} width="0.7" height="0.7" opacity="0.7" />;
          })}
        </g>
        {/* Neon sign accents */}
        <rect x="38" y="58" width="6" height="0.6" fill="#ff5fa8" />
        <rect x="38" y="60" width="4" height="0.6" fill="#ff5fa8" />
        <rect x="100" y="60" width="8" height="0.6" fill="#7df0ff" />
        <rect x="100" y="62" width="5" height="0.6" fill="#7df0ff" />
        {/* Street reflection */}
        <rect x="0" y="80" width="160" height="10" fill="#1a0820" />
        <rect x="0" y="84" width="160" height="0.8" fill="#ff5fa8" opacity="0.4" filter="url(#blur)" />
        <rect x="0" y="87" width="160" height="0.4" fill="#7df0ff" opacity="0.3" filter="url(#blur)" />
      </svg>
    ),
  },

  /* ─── Conference / talking head ─────────────────────────────────── */
  conference: {
    name: "Conference Recording — Day 2",
    bg: "linear-gradient(180deg, #1a1d28 0%, #0f1318 100%)",
    render: () => (
      <svg viewBox="0 0 160 90" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <defs>
          <radialGradient id="spot" cx="50%" cy="20%" r="60%">
            <stop offset="0%" stopColor="#f5c14e" stopOpacity="0.4" />
            <stop offset="60%" stopColor="#f5c14e" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#f5c14e" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="spot2" cx="80%" cy="30%" r="40%">
            <stop offset="0%" stopColor="#7fb8ff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#7fb8ff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="160" height="90" fill="#1a1d28" />
        <rect width="160" height="90" fill="url(#spot)" />
        <rect width="160" height="90" fill="url(#spot2)" />
        {/* Back wall texture stripes */}
        <g opacity="0.06" fill="#fff">
          {Array.from({ length: 30 }).map((_, i) => (
            <rect key={i} x={i * 6} y="0" width="0.3" height="60" />
          ))}
        </g>
        {/* Stage floor */}
        <rect x="0" y="68" width="160" height="22" fill="#0a0c12" />
        <rect x="0" y="68" width="160" height="0.4" fill="#3a4050" />
        {/* Podium */}
        <rect x="68" y="50" width="24" height="22" fill="#2a2e38" />
        <rect x="66" y="48" width="28" height="3" fill="#3a4050" />
        {/* Speaker silhouette */}
        <ellipse cx="80" cy="38" rx="5" ry="5.5" fill="#1a1d28" />
        <path d="M 73 50 Q 73 42 80 42 Q 87 42 87 50 L 87 55 L 73 55 Z" fill="#1a1d28" />
        {/* Slide screen behind */}
        <rect x="20" y="12" width="50" height="32" fill="#0a0c12" stroke="#3a4050" strokeWidth="0.3" />
        <rect x="22" y="14" width="20" height="2" fill="#6ee7a8" opacity="0.5" />
        <rect x="22" y="18" width="36" height="0.6" fill="#fff" opacity="0.2" />
        <rect x="22" y="20" width="30" height="0.6" fill="#fff" opacity="0.2" />
        <rect x="22" y="22" width="34" height="0.6" fill="#fff" opacity="0.15" />
        <rect x="22" y="26" width="14" height="14" fill="#6ee7a8" opacity="0.15" />
        {/* Audience heads silhouettes */}
        <g fill="#0a0c12">
          {Array.from({ length: 14 }).map((_, i) => (
            <ellipse key={i} cx={6 + i * 11} cy="84" rx="2.5" ry="2" />
          ))}
        </g>
      </svg>
    ),
  },

  /* ─── Tutorial / screen recording ───────────────────────────────── */
  tutorial: {
    name: "Tutorial intro — Captions burned in",
    bg: "#1e1e1e",
    render: () => (
      <svg viewBox="0 0 160 90" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <rect width="160" height="90" fill="#1e1e1e" />
        {/* Window chrome */}
        <rect x="0" y="0" width="160" height="6" fill="#2d2d30" />
        <circle cx="4" cy="3" r="1.2" fill="#ff5f57" />
        <circle cx="8" cy="3" r="1.2" fill="#febc2e" />
        <circle cx="12" cy="3" r="1.2" fill="#28c840" />
        <rect x="40" y="1.5" width="60" height="3" rx="1" fill="#1e1e1e" />
        {/* Sidebar */}
        <rect x="0" y="6" width="32" height="84" fill="#252526" />
        <rect x="2" y="9" width="28" height="2" fill="#3c3c3c" />
        <rect x="4" y="14" width="20" height="1" fill="#6ee7a8" opacity="0.7" />
        <rect x="4" y="17" width="14" height="1" fill="#6e6e70" />
        <rect x="4" y="20" width="22" height="1" fill="#6e6e70" />
        <rect x="4" y="23" width="18" height="1" fill="#7aa8ff" />
        <rect x="4" y="26" width="20" height="1" fill="#6e6e70" />
        <rect x="4" y="32" width="16" height="1" fill="#6e6e70" />
        <rect x="4" y="35" width="22" height="1" fill="#6e6e70" />
        <rect x="4" y="38" width="14" height="1" fill="#6e6e70" />
        {/* Code area */}
        <g>
          {/* Line numbers */}
          <rect x="32" y="6" width="6" height="84" fill="#1e1e1e" />
          {Array.from({ length: 18 }).map((_, i) => (
            <text key={i} x="34" y={11 + i * 4.2} fontSize="2" fill="#5a5a5a" fontFamily="monospace">{i+1}</text>
          ))}
          {/* Code lines */}
          <g fontFamily="monospace" fontSize="2.6">
            <text x="40" y="11" fill="#c586c0">import</text>
            <text x="50" y="11" fill="#d4d4d4">{` { `}</text>
            <text x="53" y="11" fill="#9cdcfe">useState</text>
            <text x="63" y="11" fill="#d4d4d4">{` } `}</text>
            <text x="68" y="11" fill="#c586c0">from</text>
            <text x="74" y="11" fill="#ce9178">'react'</text>
            <text x="40" y="15" fill="#6a9955">// Set up the watermark tracker</text>
            <text x="40" y="19" fill="#569cd6">const</text>
            <text x="48" y="19" fill="#9cdcfe">tracker</text>
            <text x="58" y="19" fill="#d4d4d4">=</text>
            <text x="60" y="19" fill="#dcdcaa">createTracker</text>
            <text x="73" y="19" fill="#d4d4d4">({`{`}</text>
            <text x="44" y="23" fill="#9cdcfe">algorithm:</text>
            <text x="55" y="23" fill="#ce9178">'optical-flow'</text>
            <text x="44" y="27" fill="#9cdcfe">threshold:</text>
            <text x="56" y="27" fill="#b5cea8">0.84</text>
            <text x="40" y="31" fill="#d4d4d4">{`})`}</text>
            <text x="40" y="39" fill="#569cd6">await</text>
            <text x="46" y="39" fill="#9cdcfe">tracker</text>
            <text x="53" y="39" fill="#d4d4d4">.</text>
            <text x="54" y="39" fill="#dcdcaa">scan</text>
            <text x="58" y="39" fill="#d4d4d4">(</text>
            <text x="59" y="39" fill="#9cdcfe">video</text>
            <text x="64" y="39" fill="#d4d4d4">)</text>
          </g>
          {/* Cursor */}
          <rect x="65" y="36.5" width="0.4" height="3" fill="#fff" />
        </g>
        {/* Status bar */}
        <rect x="0" y="86" width="160" height="4" fill="#007acc" />
        <text x="3" y="89" fontFamily="monospace" fontSize="2" fill="#fff">main</text>
      </svg>
    ),
  },

  /* ─── Nature / vlog ─────────────────────────────────────────────── */
  nature: {
    name: "Travel Vlog 014 — Mountain Pass",
    bg: "linear-gradient(180deg, #ff8a4d 0%, #f5c14e 30%, #7fa8d8 60%, #2a3a5a 100%)",
    render: () => (
      <svg viewBox="0 0 160 90" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <defs>
          <linearGradient id="sunset" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff7a3d" />
            <stop offset="30%" stopColor="#ffae5a" />
            <stop offset="55%" stopColor="#c89ab8" />
            <stop offset="75%" stopColor="#5a7aa8" />
            <stop offset="100%" stopColor="#1f2a4a" />
          </linearGradient>
          <radialGradient id="sun" cx="70%" cy="55%" r="20%">
            <stop offset="0%" stopColor="#fff5d4" />
            <stop offset="50%" stopColor="#ffd57a" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#ff8a4d" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="160" height="90" fill="url(#sunset)" />
        <rect width="160" height="90" fill="url(#sun)" />
        <circle cx="112" cy="50" r="6" fill="#fff5d4" opacity="0.95" />
        {/* Cloud streaks */}
        <ellipse cx="40" cy="22" rx="20" ry="1.5" fill="#fff" opacity="0.25" />
        <ellipse cx="90" cy="30" rx="14" ry="1" fill="#fff" opacity="0.2" />
        <ellipse cx="130" cy="18" rx="18" ry="1.2" fill="#fff" opacity="0.18" />
        {/* Far mountains */}
        <path d="M 0 60 L 20 48 L 38 55 L 56 42 L 74 50 L 92 45 L 110 52 L 130 44 L 150 50 L 160 48 L 160 90 L 0 90 Z" fill="#3a4a6a" opacity="0.85" />
        {/* Mid mountains */}
        <path d="M 0 68 L 18 56 L 32 64 L 50 50 L 68 60 L 88 54 L 108 64 L 128 58 L 148 65 L 160 60 L 160 90 L 0 90 Z" fill="#2a3a5a" />
        {/* Near hills with trees */}
        <path d="M 0 78 L 22 70 L 44 75 L 66 68 L 88 74 L 110 72 L 134 76 L 160 74 L 160 90 L 0 90 Z" fill="#1a2a4a" />
        {/* Tree silhouettes */}
        <g fill="#0a1428">
          {Array.from({ length: 18 }).map((_, i) => {
            const x = 4 + i * 9;
            const h = 3 + ((i * 13) % 4);
            const y = 76 - h;
            return (
              <g key={i}>
                <rect x={x} y={y + h - 1} width="0.6" height="1.5" />
                <path d={`M ${x - 1.6} ${y + h - 1} L ${x + 0.3} ${y} L ${x + 2.2} ${y + h - 1} Z`} />
              </g>
            );
          })}
        </g>
        {/* Road */}
        <path d="M 70 90 L 90 90 L 86 72 L 82 72 Z" fill="#252a3a" />
        <rect x="83" y="76" width="2" height="1.5" fill="#fff5d4" opacity="0.4" />
        <rect x="83" y="80" width="2" height="1.5" fill="#fff5d4" opacity="0.3" />
      </svg>
    ),
  },
};

/* ─── Burned-in element renderers ────────────────────────────────── */
// These are the things the user wants to REMOVE from the video.
// They render as overlays on top of the scene. When `removed`, they're
// replaced by a transparency checkerboard.

const BurnedIn = {
  // Network/TV logo — top-right corner, looks "official"
  logo: ({ scene }) => (
    <div style={{
      position: "absolute", inset: 0,
      display: "flex", flexDirection: "column",
      alignItems: "flex-end", padding: "3% 3.5%",
      fontFamily: "Geist, sans-serif",
      color: "#fff",
      pointerEvents: "none",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: "0.4em",
        background: "rgba(0,0,0,.55)",
        padding: "0.4em 0.7em",
        borderRadius: "0.3em",
        backdropFilter: "blur(4px)",
        fontSize: "0.9em",
        fontWeight: 600,
        letterSpacing: "0.04em",
      }}>
        <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
        <span>NETWORK</span>
        <span style={{ opacity: 0.6, fontSize: "0.7em" }}>LIVE</span>
      </div>
    </div>
  ),

  // Burned-in subtitle bar — bottom. When `cleaned`, render the bar with
  // no text — that's the realistic look of a caption after delogo: the
  // original video underneath was already obscured by an opaque burn-in,
  // so the cleanup just leaves the bar shape (think network news lower-
  // thirds — you can't recover what was never visible).
  caption: ({ text = "And honestly, I never thought we'd make it this far.", cleaned = false }) => (
    <div style={{
      position: "absolute", left: 0, right: 0, bottom: 0,
      padding: "0 8% 8%",
      pointerEvents: "none",
      display: "flex", justifyContent: "center",
    }}>
      <div style={{
        background: "rgba(0,0,0,.82)",
        color: "#fff",
        padding: "0.4em 1em",
        fontSize: "0.85em",
        fontWeight: 500,
        textAlign: "center",
        fontFamily: "Geist, sans-serif",
        textShadow: cleaned ? "none" : "0 1px 2px rgba(0,0,0,.8)",
        borderRadius: "0.2em",
        lineHeight: 1.25,
        // Keep the bar width even when text is hidden so the geometry matches
        minWidth: "60%",
        minHeight: "1.5em",
      }}>{cleaned ? "" : text}</div>
    </div>
  ),

  // Floating watermark — moves across frame, has a "© handle" feel
  watermark: ({ x = 50, y = 35 }) => (
    <div style={{
      position: "absolute",
      left: x + "%", top: y + "%",
      transform: "translate(-50%, -50%)",
      pointerEvents: "none",
      fontFamily: "Geist Mono, monospace",
      color: "rgba(255,255,255,.85)",
      fontSize: "0.75em",
      fontWeight: 600,
      letterSpacing: "0.05em",
      textShadow: "0 1px 3px rgba(0,0,0,.7)",
      display: "flex", alignItems: "center", gap: "0.4em",
      padding: "0.4em 0.8em",
      background: "rgba(255,255,255,.08)",
      backdropFilter: "blur(2px)",
      border: "1px solid rgba(255,255,255,.15)",
      borderRadius: "0.2em",
    }}>
      <span style={{ fontSize: "1.2em" }}>©</span>
      <span>@vidshare · 2026</span>
    </div>
  ),

  // Broadcaster bug — small DOG bug in corner
  broadcaster: () => (
    <div style={{
      position: "absolute", left: "3%", bottom: "12%",
      pointerEvents: "none",
      fontFamily: "Geist, sans-serif",
      fontWeight: 700,
      fontSize: "0.85em",
      color: "#fff",
      background: "linear-gradient(135deg, #d92626 0%, #8a1717 100%)",
      padding: "0.3em 0.6em 0.3em 0.4em",
      letterSpacing: "0.1em",
      display: "flex", alignItems: "center", gap: "0.3em",
      borderRadius: "0.1em",
    }}>
      <span style={{ width: "0.5em", height: "0.5em", borderRadius: "50%", background: "#fff", display: "inline-block", animation: "pulse 1.4s ease-in-out infinite" }} />
      LIVE
    </div>
  ),
};

/* ─── MockScene component ────────────────────────────────────────── */
// Renders a scene with its burned-in elements. Regions with `removed: true`
// punch a transparency checkerboard through the burned-in layer at that spot.
//
// fontScale lets thumbnails use proportionally smaller burned-in text.

const MockScene = ({
  scene = "tokyo",
  regions = [],
  cleaned = false,
  watermarkPos = null,
  fontScale = 1,
  showRegionOverlays = false,
}) => {
  const def = SCENES[scene] || SCENES.tokyo;

  // What regions actually represent burned-in content (vs just user-drawn boxes)
  // A region must be visible AND active (within its time range) to render its
  // burned-in element.
  const isLive = (r) => r.visible !== false && r.active !== false;
  const hasLogo = regions.find((r) => r.type === "logo" && isLive(r));
  const hasCaption = regions.find((r) => r.type === "caption" && isLive(r));
  const hasWatermark = regions.find((r) => r.type === "watermark" && isLive(r));
  const hasBroadcaster = regions.find((r) => r.type === "broadcaster" && isLive(r));

  // Where to render each burned-in. When `cleaned`, we hide the logo /
  // watermark / broadcaster (the scene SVG already paints the surrounding
  // pixels, so hiding the overlay LOOKS like a content-aware blur fill —
  // exactly what ffmpeg's delogo does). Captions are special: the real
  // burn-in is opaque so cleanup leaves a black bar with no text.
  return (
    <div style={{
      position: "absolute", inset: 0, overflow: "hidden",
      fontSize: (fontScale * 16) + "px",
    }}>
      {/* Scene background */}
      <div style={{ position: "absolute", inset: 0, background: def.bg }} />
      {def.render()}

      {/* Logo / watermark / broadcaster: hidden when cleaned */}
      {!cleaned && hasLogo && <BurnedIn.logo scene={scene} />}
      {!cleaned && hasWatermark && (
        <BurnedIn.watermark
          x={watermarkPos?.x ?? (hasWatermark.x + hasWatermark.w / 2)}
          y={watermarkPos?.y ?? (hasWatermark.y + hasWatermark.h / 2)}
        />
      )}
      {!cleaned && hasBroadcaster && <BurnedIn.broadcaster />}

      {/* Caption: always render the bar; only the text is removed when cleaned */}
      {hasCaption && <BurnedIn.caption cleaned={cleaned} />}
    </div>
  );
};

// Keyframe injected once
if (typeof document !== "undefined" && !document.getElementById("mock-scene-keyframes")) {
  const st = document.createElement("style");
  st.id = "mock-scene-keyframes";
  st.textContent = "@keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }";
  document.head.appendChild(st);
}

window.MockScene = MockScene;
window.SCENES = SCENES;
