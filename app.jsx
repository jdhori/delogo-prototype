/* global React, ReactDOM, Icons, Editor, DEFAULT_REGIONS, TweaksPanel, useTweaks, TweakSection, TweakRadio, TweakSlider, TweakToggle, TweakSelect */
// app.jsx — top-level: routing + projects + upload + detect + export + tweaks.

const { useState, useEffect, useRef } = React;

/* ─── TopBar ──────────────────────────────────────────── */
const TopBar = ({ screen, project, onHome, onNew, onExport, hasProject, theme, onToggleTheme }) => {
  const projectName = project?.name;
  const isLive = project?.source === "live";
  const isUrl = project?.source === "url";
  return (
    <div className="topbar">
      <button className="brand" onClick={onHome} style={{ cursor: "pointer" }}>
        <span className="mark" />
        <span>Unlogo</span>
      </button>
      <div className="crumbs">
        <span className="sep">/</span>
        <span className={screen === "projects" ? "cur" : ""} onClick={onHome} style={{ cursor: "pointer" }}>
          Projects
        </span>
        {hasProject && projectName && (
          <>
            <span className="sep">/</span>
            <span className="cur">{projectName}</span>
          </>
        )}
        {hasProject && isLive && <span className="live-pill">LIVE</span>}
        {hasProject && isUrl && project?.platform && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "3px 8px", marginLeft: 4,
            background: "var(--bg-2)", border: "1px solid var(--line)",
            borderRadius: 999,
            fontSize: 11, color: "var(--ink-3)",
          }}>
            <PlatformIcon id={project.platform} size={11} />
            {PLATFORMS.find(p => p.id === project.platform)?.name}
          </span>
        )}
      </div>
      <div className="right">
        <div className="theme-toggle" title="Theme">
          <button
            className={theme === "night" ? "active" : ""}
            onClick={() => onToggleTheme("night")}
            title="Night theme"
          >
            <Icons.Moon size={13} />
          </button>
          <button
            className={theme === "day" ? "active" : ""}
            onClick={() => onToggleTheme("day")}
            title="Day theme"
          >
            <Icons.Sun size={13} />
          </button>
        </div>
        {screen === "editor" && isLive && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 11, fontFamily: "Geist Mono, monospace",
            color: "var(--ink-2)",
            padding: "5px 9px",
            background: "var(--bg-2)", border: "1px solid var(--line)",
            borderRadius: 6,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: "var(--accent)",
              animation: "pulse 1.4s ease-in-out infinite",
            }} />
            <span style={{ color: "var(--accent)" }}>164 ms</span>
            <span style={{ color: "var(--ink-4)" }}>·</span>
            <span>2.4 Mbps</span>
          </span>
        )}
        {screen === "editor" && !isLive && (
          <button className="btn ghost"><Icons.Cloud size={13} /> Saved · 4s ago</button>
        )}
        {screen === "editor" && (
          <button className="btn primary" onClick={onExport}>
            {isLive ? <><Icons.Record size={13} /> Record</> : <><Icons.Download size={13} /> Export</>}
          </button>
        )}
        {screen !== "editor" && screen !== "export" && (
          <button className="btn primary" onClick={onNew}>
            <Icons.Plus size={13} /> New project
          </button>
        )}
      </div>
    </div>
  );
};

/* ─── Projects screen ─────────────────────────────────── */

const SAMPLE_PROJECTS = [
  {
    id: "p1",
    name: "Conference Recording — Day 2",
    scene: "conference",
    duration: "12:48",
    status: "done",
    regions: 2,
    updated: "2 hours ago",
    thumbRegions: [
      { id: "tr1", type: "broadcaster", x: 3, y: 78, w: 14, h: 10, visible: true },
      { id: "tr2", type: "caption", x: 8, y: 80, w: 84, h: 14, visible: true },
    ],
  },
  {
    id: "p2",
    name: "Travel Vlog 014 — Tokyo Streets",
    scene: "tokyo",
    duration: "08:15",
    status: "processing",
    regions: 3,
    updated: "Yesterday",
    thumbRegions: [
      { id: "tr1", type: "logo", x: 80, y: 4, w: 17, h: 14, visible: true },
      { id: "tr2", type: "watermark", x: 35, y: 32, w: 28, h: 12, visible: true },
    ],
  },
  {
    id: "p3",
    name: "Tutorial intro — Captions burned in",
    scene: "tutorial",
    duration: "04:32",
    status: "draft",
    regions: 1,
    updated: "3 days ago",
    thumbRegions: [
      { id: "tr1", type: "caption", x: 8, y: 80, w: 84, h: 14, visible: true },
    ],
  },
  {
    id: "p4",
    name: "Mountain Pass — Sunset cut",
    scene: "nature",
    duration: "1:24:11",
    status: "done",
    regions: 1,
    updated: "Last week",
    source: "file",
    thumbRegions: [
      { id: "tr1", type: "watermark", x: 12, y: 12, w: 30, h: 13, visible: true },
    ],
  },
  {
    id: "p5",
    name: "Twitch · Restream live · 3h 12m",
    scene: "tokyo",
    duration: "LIVE",
    status: "live",
    regions: 2,
    updated: "Streaming now",
    source: "live",
    platform: "twitch",
    thumbRegions: [
      { id: "tr1", type: "logo", x: 80, y: 4, w: 17, h: 14, visible: true },
      { id: "tr2", type: "broadcaster", x: 3, y: 80, w: 14, h: 10, visible: true },
    ],
  },
];

const Projects = ({ onOpenProject, onNew }) => (
  <div className="projects-wrap">
    <div className="projects-head">
      <div>
        <h1>Projects</h1>
        <div className="sub">Pick up where you left off, or start a fresh clean-up.</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn ghost"><Icons.Folder size={13} /> Import folder</button>
        <button className="btn"><Icons.Settings size={13} /> Settings</button>
      </div>
    </div>

    <div className="proj-grid">
      <div className="proj new-card" onClick={onNew}>
        <div className="plus">+</div>
        <div className="label">New project</div>
        <div className="hint">Drag a video or click to upload</div>
      </div>
      {SAMPLE_PROJECTS.map((p) => (
        <div key={p.id} className="proj" onClick={() => onOpenProject(p)}>
          <div className="thumb">
            <MockScene
              scene={p.scene}
              regions={p.thumbRegions}
              cleaned={p.status === "done"}
              fontScale={0.6}
            />
            {p.status === "processing" && (
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(0,0,0,.55)",
                color: "var(--accent)",
                fontFamily: "Geist Mono, monospace", fontSize: 11, letterSpacing: ".05em",
                zIndex: 2,
              }}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                  background: "var(--accent)", marginRight: 6,
                  animation: "pulse 1.4s ease-in-out infinite",
                }} />
                CLEANING · 67%
              </div>
            )}
            {p.status === "live" && (
              <div style={{
                position: "absolute", top: 8, left: 8, zIndex: 2,
                display: "inline-flex", alignItems: "center", gap: 5,
                background: "rgba(15,17,22,.9)", backdropFilter: "blur(6px)",
                padding: "3px 7px", borderRadius: 4,
                fontFamily: "Geist Mono, monospace", fontSize: 10,
                color: "#ff8a87", border: "1px solid rgba(239,83,80,.4)",
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "var(--danger)",
                  animation: "live-pulse 1.4s ease-in-out infinite",
                }} />
                LIVE
              </div>
            )}
            <span className="duration" style={{
              zIndex: 2,
              ...(p.status === "live" ? { background: "rgba(239,83,80,.85)", color: "#fff", fontWeight: 600 } : {}),
            }}>{p.duration}</span>
            {p.status === "done" && (
              <span style={{
                position: "absolute", top: 8, left: 8, zIndex: 2,
                display: "inline-flex", alignItems: "center", gap: 5,
                background: "rgba(15,17,22,.85)", backdropFilter: "blur(6px)",
                padding: "3px 7px", borderRadius: 4,
                fontFamily: "Geist Mono, monospace", fontSize: 10,
                color: "var(--accent)", border: "1px solid rgba(110,231,168,.3)",
              }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                CLEANED
              </span>
            )}
          </div>
          <div className="body">
            <div className="name">{p.name}</div>
            <div className="meta">
              <span>{p.regions} region{p.regions === 1 ? "" : "s"}</span>
              <span style={{ color: "var(--ink-4)" }}>·</span>
              <span>{p.updated}</span>
              <span style={{ marginLeft: "auto" }}>
                {p.status === "done" && <span className="chip dot" style={{ fontSize: 10 }}>done</span>}
                {p.status === "draft" && <span className="chip warn dot" style={{ fontSize: 10 }}>draft</span>}
                {p.status === "live" && (
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    fontSize: 10, fontFamily: "Geist Mono, monospace",
                    color: "#ff8a87",
                  }}>
                    <span style={{
                      width: 5, height: 5, borderRadius: "50%",
                      background: "var(--danger)",
                      animation: "live-pulse 1.4s ease-in-out infinite",
                    }} />
                    streaming
                  </span>
                )}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>

    <style>{`@keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }`}</style>
  </div>
);

/* ─── Upload screen ───────────────────────────────────── */

// Platform detector — tells which embed source the URL looks like.
// Order matters: "direct" is checked first so a real .mp4/.m3u8 wins over any
// hostname rule. YuJa is split out from the original Kaltura row because UCSC
// MediaSpace (media.ucsc.edu/V/Video?v=…) actually runs on YuJa, not Kaltura,
// and the two platforms have different APIs.
const PLATFORMS = [
  { id: "direct",  name: "Direct video", re: /\.(mp4|m4v|mov|webm|ogg|m3u8|mpd)(\?.*)?$/i, sample: "https://example.com/video.mp4" },
  { id: "yuja",    name: "YuJa",     re: /(yuja\.com|media\.ucsc\.edu|\/V\/Video\?v=)/i, sample: "https://media.ucsc.edu/V/Video?v=15809927" },
  { id: "youtube", name: "YouTube",  re: /(?:youtube\.com|youtu\.be)/i,    sample: "https://youtube.com/watch?v=dQw4w9WgXcQ" },
  { id: "vimeo",   name: "Vimeo",    re: /vimeo\.com/i,                    sample: "https://vimeo.com/76979871" },
  // Kaltura covers Kaltura.com, MediaSpace instances, and KAF (Kaltura
  // Application Framework) — the institutional white-labels that actually
  // run Kaltura under the hood. UCSC is excluded; see the YuJa row above.
  { id: "kaltura", name: "Kaltura",  re: /(kaltura\.com|mediaspace|kaf\.|kalturas\.com|video\.[a-z-]+\.edu)/i, sample: "https://cdnapisec.kaltura.com/p/1234567/sp/123456700/playManifest/entryId/0_abcdefgh/format/applehttp/protocol/https/a.m3u8" },
  { id: "tiktok",  name: "TikTok",   re: /tiktok\.com/i,                   sample: "https://tiktok.com/@user/video/7" },
  { id: "twitch",  name: "Twitch",   re: /twitch\.tv/i,                    sample: "https://twitch.tv/videos/123" },
  { id: "x",       name: "X · Twitter", re: /(twitter|x)\.com/i,           sample: "https://x.com/i/status/123" },
  { id: "ig",      name: "Instagram",re: /instagram\.com/i,                sample: "https://instagram.com/p/abc" },
];

// True for URLs we can hand straight to a <video> element. Browser-side
// embeds (YouTube watch pages, YuJa player pages, etc.) still need a real
// manifest URL extracted via DevTools → Network.
const isDirectMedia = (url) => /\.(mp4|m4v|mov|webm|ogg|m3u8|mpd)(\?.*)?$/i.test(url);

const PlatformIcon = ({ id, size = 12 }) => {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "currentColor" };
  if (id === "youtube") return <svg {...common}><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2C0 8.2 0 12 0 12s0 3.8.5 5.8a3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1c.5-2 .5-5.8.5-5.8s0-3.8-.5-5.8zM9.6 15.6V8.4l6.2 3.6-6.2 3.6z"/></svg>;
  if (id === "vimeo") return <svg {...common}><path d="M23.98 6.5c-.1 2.4-1.78 5.7-5.04 9.86C15.6 20.74 12.74 22.9 10.4 22.9c-1.45 0-2.68-1.35-3.69-4.04l-2-7.4c-.75-2.69-1.55-4.04-2.4-4.04-.19 0-.84.4-1.95 1.18L.18 6.97C1.43 5.86 2.66 4.75 3.87 3.65c1.65-1.43 2.9-2.18 3.73-2.25 1.97-.2 3.19 1.16 3.64 4.04.5 3.13.84 5.07 1.03 5.83.55 2.51 1.16 3.76 1.83 3.76.52 0 1.3-.83 2.35-2.5 1.05-1.66 1.61-2.92 1.68-3.79.14-1.34-.39-2-1.59-2-.56 0-1.15.13-1.74.39 1.16-3.8 3.38-5.65 6.66-5.55 2.43.08 3.58 1.65 3.45 4.74z"/></svg>;
  if (id === "tiktok") return <svg {...common}><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.1z"/></svg>;
  if (id === "twitch") return <svg {...common}><path d="M11.64 5.93h1.43v4.28h-1.43m3.93-4.28H17v4.28h-1.43M7 2L3.43 5.57v12.86h4.28V22l3.58-3.57h2.85L20.57 12V2m-1.43 9.29l-2.85 2.85h-2.86l-2.5 2.5v-2.5H7.71V3.43h11.43z"/></svg>;
  if (id === "x") return <svg {...common}><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>;
  if (id === "ig") return <svg {...common}><path d="M12 2c2.7 0 3 0 4.1.1 1.04.05 1.74.22 2.36.46.65.25 1.2.6 1.74 1.14a4.8 4.8 0 0 1 1.14 1.74c.24.62.41 1.32.46 2.36C21.95 9 22 9.3 22 12s0 3-.1 4.1c-.05 1.04-.22 1.74-.46 2.36a4.8 4.8 0 0 1-1.14 1.74 4.8 4.8 0 0 1-1.74 1.14c-.62.24-1.32.41-2.36.46C15 21.95 14.7 22 12 22s-3 0-4.1-.1c-1.04-.05-1.74-.22-2.36-.46a4.8 4.8 0 0 1-1.74-1.14 4.8 4.8 0 0 1-1.14-1.74c-.24-.62-.41-1.32-.46-2.36C2.05 15 2 14.7 2 12s0-3 .1-4.1c.05-1.04.22-1.74.46-2.36A4.8 4.8 0 0 1 3.7 3.8 4.8 4.8 0 0 1 5.44 2.66c.62-.24 1.32-.41 2.36-.46C9 2.05 9.3 2 12 2zm0 5.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2zm5.86-.4a1.07 1.07 0 1 0-2.15 0 1.07 1.07 0 0 0 2.15 0zM12 9.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z"/></svg>;
  // Kaltura: stylized "k.altura" wordmark — approximated as a hexagonal "K"
  // glyph in their brand orange.
  if (id === "kaltura") return <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"><path d="M5 4v16M5 12l8-8M5 12l9 8" /><circle cx="19" cy="6" r="1.4" fill="currentColor" stroke="none" /></svg>;
  // YuJa: stylized "Y" — minimal mark approximated as a Y with a base dot.
  if (id === "yuja") return <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"><path d="M5 4l7 9 7-9M12 13v7" /></svg>;
  // Direct media URL: a generic film/play glyph.
  if (id === "direct") return <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" /></svg>;
  return null;
};

const detectPlatform = (url) => PLATFORMS.find((p) => p.re.test(url));

const Upload = ({ onStart }) => {
  const [tab, setTab] = useState("file");
  const [drag, setDrag] = useState(false);
  const [url, setUrl] = useState("");
  const fileInputRef = useRef(null);

  const detected = url ? detectPlatform(url) : null;
  const placeholder = "Paste a YouTube, Vimeo, TikTok, Twitch or X link…";

  // Read the first dropped/selected file as an Object URL and hand it to the
  // editor as a real videoSrc. The original prototype skipped this and just
  // shipped a hardcoded "Untitled.mp4" placeholder.
  const handleFile = (file) => {
    if (!file) return;
    if (!/^video\//i.test(file.type) && !/\.(mp4|m4v|mov|webm|mkv|ogg|avi)$/i.test(file.name)) {
      // Not obviously a video — still let it through but warn in the console.
      console.warn("[Unlogo] File type does not look like video:", file.type, file.name);
    }
    const objectUrl = URL.createObjectURL(file);
    onStart({
      source: "file",
      scene: "tokyo",
      name: file.name || "Untitled.mp4",
      videoSrc: objectUrl,
      fileSize: file.size,
    });
  };

  return (
    <div className="upload-wrap">
      <h1>Clean up your video. <span className="stripe">No watermarks.</span></h1>
      <p className="sub">
        Drop a video file, paste a link, or pipe a live stream — we'll find every logo, watermark and burned-in caption and remove them in seconds.
      </p>

      <div className="upload-tabs">
        <button className={tab === "file" ? "active" : ""} onClick={() => setTab("file")}>
          <Icons.Upload size={14} /> Upload file
        </button>
        <button className={tab === "url" ? "active" : ""} onClick={() => setTab("url")}>
          <Icons.Link size={14} /> Paste URL
        </button>
        <button className={tab === "live" ? "active live" : "live"} onClick={() => setTab("live")}>
          <span className="live-dot" /> Live stream
        </button>
      </div>

      {tab === "file" && (
        <div
          className={`dropzone ${drag ? "dragging" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Upload a video file. Click to browse, or drag and drop."
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer?.files?.[0]); }}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mp4,.m4v,.mov,.webm,.mkv,.ogg,.avi"
            style={{ display: "none" }}
            onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }}
          />
          <div className="icon-stack">
            <Icons.Upload size={28} />
          </div>
          <div className="big">Drop a video here</div>
          <div className="small">or click to browse — max 4 GB</div>
          <div className="formats">
            <span className="chip">MP4</span>
            <span className="chip">MOV</span>
            <span className="chip">MKV</span>
            <span className="chip">WebM</span>
            <span className="chip">AVI</span>
          </div>
        </div>
      )}

      {tab === "url" && (
        <div className="url-card">
          <div className="row">
            <Icons.Link size={16} style={{ color: "var(--ink-3)", flex: "none" }} />
            <input
              autoFocus
              placeholder={placeholder}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && detected) {
                  onStart({ source: "url", platform: detected.id, url, videoSrc: isDirectMedia(url) ? url : undefined, scene: "tokyo", name: "From " + detected.name });
                }
              }}
            />
            <button
              className="btn primary"
              disabled={!detected}
              onClick={() => detected && onStart({ source: "url", platform: detected.id, url, videoSrc: isDirectMedia(url) ? url : undefined, scene: "tokyo", name: "From " + detected.name })}
              style={{ opacity: detected ? 1 : 0.5 }}
            >
              <Icons.Sparkle size={13} />
              Import &amp; clean
            </button>
          </div>

          <div className="platforms">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                className={`plat ${detected?.id === p.id ? "detected" : ""}`}
                onClick={() => setUrl(p.sample)}
                title={`Try a ${p.name} URL`}
              >
                <PlatformIcon id={p.id} />
                {p.name}
              </button>
            ))}
          </div>

          {detected && (
            <div className="detected-preview">
              <div className="thumb">
                <MockScene scene="tokyo" regions={[
                  { id: "tr1", type: "logo", x: 80, y: 4, w: 17, h: 14, visible: true },
                  { id: "tr2", type: "watermark", x: 38, y: 30, w: 28, h: 12, visible: true },
                ]} fontScale={0.45} />
                <div style={{
                  position: "absolute", inset: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: "50%",
                    background: "rgba(255,255,255,.9)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Icons.Play size={14} style={{ color: "#000", marginLeft: 2 }} />
                  </div>
                </div>
              </div>
              <div className="info">
                <div className="title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <PlatformIcon id={detected.id} size={13} />
                  Detected · {detected.name} video
                </div>
                <div className="meta">
                  <span>1080p</span>
                  <span style={{ color: "var(--ink-4)" }}>·</span>
                  <span>3m 42s</span>
                  <span style={{ color: "var(--ink-4)" }}>·</span>
                  <span style={{ color: "var(--accent)" }}>2 burns expected</span>
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: 14, fontSize: 11, color: "var(--ink-4)", lineHeight: 1.5 }}>
            We stream the source, run delogo on the fly, and serve a clean playable URL. Nothing is re-uploaded.
          </div>
        </div>
      )}

      {tab === "live" && (
        <div className="live-card">
          <h3><span className="live-dot" /> Live stream &amp; clean in real time</h3>
          <div style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.55, marginTop: 6 }}>
            Pipe a stream into Unlogo and we'll strip logos, captions and watermarks frame-by-frame as it plays — under <b style={{ color: "var(--ink-2)" }}>180 ms</b> of added latency.
          </div>
          <div className="sources">
            <div className="src" onClick={() => onStart({ source: "live", liveKind: "rtmp", scene: "tokyo", name: "Live · RTMP" })}>
              <div className="glyph"><Icons.Cast size={16} /></div>
              <div className="name">RTMP / SRT</div>
              <div className="hint">OBS, Wirecast, hardware</div>
            </div>
            <div className="src" onClick={() => onStart({ source: "live", liveKind: "screen", scene: "tutorial", name: "Live · Screen" })}>
              <div className="glyph"><Icons.Screen size={16} /></div>
              <div className="name">Screen share</div>
              <div className="hint">Your tab or window</div>
            </div>
            <div className="src" onClick={() => onStart({ source: "live", liveKind: "twitch", scene: "tokyo", name: "Live · Twitch" })}>
              <div className="glyph"><Icons.Globe size={16} /></div>
              <div className="name">Twitch / YouTube Live</div>
              <div className="hint">By channel URL</div>
            </div>
          </div>
          <div style={{
            marginTop: 16, padding: "10px 12px",
            background: "rgba(239,83,80,.08)",
            border: "1px solid rgba(239,83,80,.25)",
            borderRadius: 8,
            display: "flex", gap: 10, alignItems: "flex-start",
            fontSize: 11, color: "#ff8a87",
          }}>
            <Icons.Drop size={14} style={{ flex: "none", marginTop: 1 }} />
            <div style={{ lineHeight: 1.5, color: "var(--ink-2)" }}>
              <b style={{ color: "#ff8a87" }}>Heads up:</b> live mode locks regions to the positions detected in the first 5 seconds. Move a region while streaming and the change applies from the next keyframe.
            </div>
          </div>
        </div>
      )}

      <div className="upload-features">
        <div className="feat">
          <div className="head"><Icons.Sparkle size={14} className="ic" /><span className="t">Auto-detect</span></div>
          <div className="d">We scan the video and find logos, captions and floating watermarks in seconds.</div>
        </div>
        <div className="feat">
          <div className="head"><Icons.Track size={14} className="ic" /><span className="t">Track motion</span></div>
          <div className="d">Watermarks that wander across the frame? The tracker follows them frame-by-frame.</div>
        </div>
        <div className="feat">
          <div className="head"><Icons.Cast size={14} className="ic" /><span className="t">Real-time pipe</span></div>
          <div className="d">Stream a source, clean it on the fly, and serve a clean playable URL with under 200&nbsp;ms latency.</div>
        </div>
      </div>
    </div>
  );
};

/* ─── Detection scanning ──────────────────────────────── */

const Detecting = ({ onDone, scene }) => {
  const [progress, setProgress] = useState(0);
  const [foundRegions, setFoundRegions] = useState([]);
  const [stage, setStage] = useState("Analyzing audio track…");
  const stages = [
    "Decoding video stream",
    "Sampling key frames",
    "Detecting static logos",
    "Detecting burned-in captions",
    "Tracing moving watermarks",
    "Cross-checking regions",
  ];

  useEffect(() => {
    const stageIv = setInterval(() => {
      setStage(stages[Math.floor(Math.random() * stages.length)]);
    }, 700);

    const progIv = setInterval(() => {
      setProgress((p) => {
        const np = Math.min(100, p + 1.5 + Math.random() * 1.5);
        // surface regions at certain progress milestones
        if (p < 25 && np >= 25) {
          setFoundRegions((r) => [...r, { id: "l", type: "logo", x: 80, y: 4, w: 17, h: 12, label: "STATIC LOGO · 97%", visible: true }]);
        }
        if (p < 55 && np >= 55) {
          setFoundRegions((r) => [...r, { id: "c", type: "caption", x: 8, y: 80, w: 84, h: 12, label: "CAPTION · 91%", visible: true }]);
        }
        if (p < 80 && np >= 80) {
          setFoundRegions((r) => [...r, { id: "w", type: "watermark", x: 35, y: 32, w: 30, h: 12, label: "MOVING WM · 84%", visible: true }]);
        }
        if (np >= 100) {
          clearInterval(progIv);
          clearInterval(stageIv);
          setTimeout(onDone, 500);
        }
        return np;
      });
    }, 80);

    return () => { clearInterval(stageIv); clearInterval(progIv); };
  }, []);

  return (
    <div className="detect-wrap">
      <div className="detect-stage">
        <div className="detect-frame">
          <MockScene
            scene={scene || "tokyo"}
            regions={foundRegions}
            fontScale={1.4}
          />
          <div className="scan-grid" />
          <div className="scan-line" />
          {foundRegions.map((r) => (
            <div key={r.id} className="detect-region-found" style={{
              left: r.x + "%", top: r.y + "%", width: r.w + "%", height: r.h + "%",
            }}>
              <div className="lbl">{r.label}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="detect-panel">
        <div className="panel-h">
          <h2>Analyzing your video</h2>
          <div className="sub">Looking for logos, captions and watermarks</div>
        </div>
        <div style={{ padding: "20px", flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, fontFamily: "Geist Mono, monospace" }}>
              <span style={{ color: "var(--ink-3)" }}>{stage}</span>
              <span style={{ color: "var(--accent)" }}>{Math.floor(progress)}%</span>
            </div>
            <div className="progress-bar">
              <div className="fill" style={{ width: progress + "%" }} />
            </div>
          </div>

          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 10 }}>
            Found so far · {foundRegions.length}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {foundRegions.map((r, i) => (
              <div key={i} style={{
                padding: "10px 12px",
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                fontFamily: "Geist Mono, monospace",
                fontSize: 11,
                color: "var(--ink-2)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                animation: "slideIn .3s ease-out",
              }}>
                <span style={{
                  display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                  background: "var(--accent)",
                }} />
                {r.label}
              </div>
            ))}
            {foundRegions.length === 0 && (
              <div style={{ color: "var(--ink-4)", fontSize: 12, fontStyle: "italic" }}>
                No regions found yet…
              </div>
            )}
          </div>

          <div style={{ marginTop: "auto", paddingTop: 20, borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
            <button className="btn ghost" style={{ flex: 1, justifyContent: "center" }}>Cancel</button>
            <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={onDone}>
              Skip to editor
            </button>
          </div>
        </div>
      </div>
      <style>{`@keyframes slideIn { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: translateX(0); } }`}</style>
    </div>
  );
};

/* ─── Export ──────────────────────────────────────────── */

const FFmpegPreview = ({ format, alpha, regions }) => {
  const delogoFilters = regions
    .filter((r) => r.method === "delogo")
    .map((r, i) => `delogo=x=${Math.round(r.x * 19.2)}:y=${Math.round(r.y * 10.8)}:w=${Math.round(r.w * 19.2)}:h=${Math.round(r.h * 10.8)}:show=0`)
    .join(",");
  const codec = format === "prores4444" ? "prores_ks -profile:v 4444" : format === "webm" ? "libvpx-vp9" : "libx264";
  const ext = format === "prores4444" ? "mov" : format === "webm" ? "webm" : "mp4";
  const pixfmt = alpha ? (format === "prores4444" ? "yuva444p10le" : "yuva420p") : "yuv420p";

  return (
    <div className="adv-body">
      <span className="tok-comment"># Generated for {regions.length} region{regions.length === 1 ? "" : "s"}</span>{"\n"}
      ffmpeg <span className="tok-flag">-i</span> <span className="tok-arg">input.mp4</span> \{"\n"}
      {"  "}<span className="tok-flag">-vf</span> <span className="tok-arg">"{delogoFilters || "null"}"</span> \{"\n"}
      {"  "}<span className="tok-flag">-c:v</span> <span className="tok-arg">{codec}</span> \{"\n"}
      {"  "}<span className="tok-flag">-pix_fmt</span> <span className="tok-arg">{pixfmt}</span> \{"\n"}
      {"  "}<span className="tok-flag">-c:a</span> <span className="tok-arg">copy</span> \{"\n"}
      {"  "}<span className="tok-arg">output.{ext}</span>{"\n\n"}
      {regions.some(r => r.motion === "tracked") && (
        <>
          <span className="tok-comment"># Per-keyframe delogo for moving watermark</span>{"\n"}
          <span className="tok-comment"># emitted as sendcmd filter ↓</span>{"\n"}
        </>
      )}
    </div>
  );
};

/* ─── Stream-record mode (URL/live sources) ────────────
 * The video is being streamed from a remote source (Kaltura, YouTube, RTMP).
 * Cleaning happens frame-by-frame while it plays; the cleaned output is
 * simultaneously recorded so the user gets a re-postable file at the end.
 */
const StreamRecord = ({ project, regions, scene, onBack, onDone }) => {
  // Three states: idle → recording → done
  const [state, setState] = useState("idle");
  const [tick, setTick] = useState(0);  // seconds since record started
  const [format, setFormat] = useState("mp4");
  const [showAdv, setShowAdv] = useState(false);

  const fps = 24;
  const totalSeconds = 300; // 5-minute source
  const currentFrame = state === "recording" ? Math.min(totalSeconds * fps, Math.round(tick * fps)) : 0;
  const sourceTime = currentFrame / fps;
  const t = sourceTime / totalSeconds; // 0..1
  const isDone = state === "recording" && sourceTime >= totalSeconds;

  useEffect(() => {
    if (state !== "recording") return;
    const iv = setInterval(() => {
      setTick((s) => {
        const next = s + 0.5;
        if (next * fps >= totalSeconds * fps) {
          clearInterval(iv);
          setState("done");
          return totalSeconds;
        }
        return next;
      });
    }, 100); // 5x realtime in the prototype
    return () => clearInterval(iv);
  }, [state]);

  // Which regions are active at this exact source frame
  const activeRegions = regions.map((r) => ({
    ...r,
    active: currentFrame >= (r.startFrame ?? 0) && currentFrame <= (r.endFrame ?? Infinity),
  }));
  const activeNow = activeRegions.filter((r) => r.active);

  // Watermark live position
  const watermarkPos = (() => {
    const wm = regions.find((r) => r.motion === "tracked" && r.keyframes);
    if (!wm) return null;
    if (t <= wm.keyframes[0].t) return { x: wm.keyframes[0].x + wm.w / 2, y: wm.keyframes[0].y + wm.h / 2 };
    if (t >= wm.keyframes[wm.keyframes.length - 1].t) {
      const k = wm.keyframes[wm.keyframes.length - 1];
      return { x: k.x + wm.w / 2, y: k.y + wm.h / 2 };
    }
    for (let i = 0; i < wm.keyframes.length - 1; i++) {
      const a = wm.keyframes[i], b = wm.keyframes[i + 1];
      if (t >= a.t && t <= b.t) {
        const p = (t - a.t) / (b.t - a.t);
        const e = p * p * (3 - 2 * p);
        return { x: a.x + (b.x - a.x) * e + wm.w / 2, y: a.y + (b.y - a.y) * e + wm.h / 2 };
      }
    }
    return null;
  })();

  const fmt = (s) => {
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    const ff = Math.floor((s % 1) * fps);
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
  };

  const isLive = project?.source === "live";

  return (
    <div className="export-wrap">
      <div className="export-preview">
        <div className="frame">
          <MockScene
            scene={scene || "tokyo"}
            regions={state === "idle" ? regions : activeRegions}
            cleaned={state !== "idle"}
            watermarkPos={watermarkPos}
            fontScale={1.6}
          />
          {/* Status badges */}
          <div style={{
            position: "absolute", top: 12, left: 12,
            display: "flex", gap: 6, zIndex: 5,
          }}>
            {state === "recording" && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: "rgba(239,83,80,.92)", color: "#fff",
                padding: "4px 10px", borderRadius: 4,
                fontFamily: "Geist Mono, monospace", fontSize: 11,
                fontWeight: 600,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: "#fff",
                  animation: "live-pulse 1.4s ease-in-out infinite",
                }} />
                REC {fmt(sourceTime)}
              </div>
            )}
            {project?.platform && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: "rgba(15,17,22,.85)", backdropFilter: "blur(6px)",
                padding: "4px 9px", borderRadius: 4,
                fontFamily: "Geist Mono, monospace", fontSize: 11,
                color: "var(--ink-2)", border: "1px solid var(--line-2)",
              }}>
                <PlatformIcon id={project.platform} size={11} />
                {PLATFORMS.find(p => p.id === project.platform)?.name}
              </div>
            )}
          </div>

          {/* Active-region indicators */}
          {state === "recording" && (
            <div style={{
              position: "absolute", bottom: 12, left: 12, right: 12,
              display: "flex", gap: 6, zIndex: 5,
              fontSize: 10, fontFamily: "Geist Mono, monospace",
            }}>
              {regions.map((r) => {
                const isActive = activeNow.find((a) => a.id === r.id);
                const startS = (r.startFrame ?? 0) / fps;
                const endS = (r.endFrame ?? totalSeconds * fps) / fps;
                return (
                  <div key={r.id} style={{
                    background: isActive ? "rgba(110,231,168,.18)" : "rgba(0,0,0,.6)",
                    border: `1px solid ${isActive ? "var(--accent)" : "var(--line-2)"}`,
                    color: isActive ? "var(--accent)" : "var(--ink-3)",
                    padding: "3px 8px", borderRadius: 4,
                    display: "flex", alignItems: "center", gap: 5,
                    backdropFilter: "blur(6px)",
                  }}>
                    <span style={{
                      width: 5, height: 5, borderRadius: "50%",
                      background: isActive ? "var(--accent)" : "var(--ink-4)",
                      ...(isActive ? { animation: "pulse 1.4s ease-in-out infinite" } : {}),
                    }} />
                    {r.name.split(" ").slice(0, 2).join(" ")}
                    <span style={{ color: "var(--ink-4)" }}>
                      {fmt(startS).slice(0, 5)}→{fmt(endS).slice(0, 5)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Progress bar — based on source position */}
        {state !== "idle" && (
          <div className="export-progress">
            <div className="progress-bar" style={{ position: "relative" }}>
              <div className="fill" style={{ width: (t * 100) + "%", background: "linear-gradient(90deg, #ef5350, #ff8a87)" }} />
              {/* Region range markers on the progress bar */}
              {regions.map((r) => {
                const left = ((r.startFrame ?? 0) / (totalSeconds * fps)) * 100;
                const width = (((r.endFrame ?? totalSeconds * fps) - (r.startFrame ?? 0)) / (totalSeconds * fps)) * 100;
                return (
                  <div key={r.id} style={{
                    position: "absolute",
                    top: -2, height: 8,
                    left: left + "%", width: width + "%",
                    background: "rgba(110,231,168,.3)",
                    border: "1px solid var(--accent)",
                    borderRadius: 1,
                    pointerEvents: "none",
                  }} />
                );
              })}
            </div>
            <div className="progress-stats" style={{ marginTop: 10 }}>
              <span>
                <span style={{ color: "var(--ink-4)" }}>source</span>
                {" "}{fmt(sourceTime)} / {fmt(totalSeconds)}
              </span>
              <span>
                <span style={{ color: "var(--ink-4)" }}>output</span>
                {" "}{fmt(sourceTime)}
                <span style={{ color: "var(--ink-4)" }}> · {(sourceTime * 0.45).toFixed(1)}MB · 0 dropped</span>
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="export-settings">
        <h2>{isLive ? "Stream + Record" : "Stream, edit, record"}</h2>
        <div className="sub" style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {project?.platform && <PlatformIcon id={project.platform} size={12} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{project?.name || "URL source"}</span>
          <span style={{ color: "var(--ink-4)", flex: "none" }}>· {regions.length} regions</span>
        </div>

        {/* Region status panel */}
        <div style={{
          marginTop: 10, marginBottom: 18,
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: 12,
        }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 8 }}>
            Region schedule
          </div>
          {regions.map((r) => {
            const startS = (r.startFrame ?? 0) / fps;
            const endS = (r.endFrame ?? totalSeconds * fps) / fps;
            const isActive = activeNow.find((a) => a.id === r.id);
            return (
              <div key={r.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                fontSize: 12, marginBottom: 6,
              }}>
                <span style={{
                  width: 3, height: 14,
                  background:
                    r.type === "watermark" ? "var(--pink)" :
                    r.type === "caption" ? "var(--warn)" :
                    r.type === "broadcaster" ? "var(--blue)" :
                    "var(--accent)",
                  borderRadius: 1, flex: "none",
                }} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontSize: 10, fontFamily: "Geist Mono, monospace", color: "var(--ink-3)", whiteSpace: "nowrap", flex: "none" }}>
                  {fmt(startS).slice(0, 5)} → {fmt(endS).slice(0, 5)}
                </span>
                {state === "recording" && (
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: isActive ? "var(--accent)" : "var(--ink-4)",
                    flex: "none",
                    ...(isActive ? { animation: "pulse 1.4s ease-in-out infinite" } : {}),
                  }} />
                )}
              </div>
            );
          })}
          <div style={{
            marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)",
            fontSize: 11, color: "var(--ink-3)", lineHeight: 1.45,
          }}>
            Edits apply only inside each region's range. The rest of the video records untouched.
          </div>
        </div>

        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 10 }}>Output</div>
        <div className={`opt-card ${format === "mp4" ? "active" : ""}`} onClick={() => setFormat("mp4")}>
          <div className="radio" />
          <div className="body">
            <div className="name"><span className="name-t">MP4 · H.264</span> <span className="chip" style={{ fontSize: 10 }}>universal</span></div>
            <div className="desc">Repostable to Kaltura, YouTube, anywhere. Removed regions are filled via delogo.</div>
          </div>
        </div>
        <div className={`opt-card ${format === "hls" ? "active" : ""}`} onClick={() => setFormat("hls")}>
          <div className="radio" />
          <div className="body">
            <div className="name"><span className="name-t">HLS · live URL</span> <span className="chip" style={{ fontSize: 10, color: "var(--accent)" }}>stream</span></div>
            <div className="desc">Clean playback URL you can embed instantly — no waiting for re-upload.</div>
          </div>
        </div>

        <button className="adv-toggle" onClick={() => setShowAdv(!showAdv)}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <Icons.Code size={13} /> Advanced — ffmpeg pipe
          </span>
          <Icons.Chevron size={13} style={{ transform: showAdv ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
        </button>
        {showAdv && (
          <div className="adv-body">
            <span className="tok-comment"># Stream input → time-gated delogo → record output</span>{"\n"}
            ffmpeg <span className="tok-flag">-i</span> <span className="tok-arg">"{project?.url || "https://media.../V/Video?v=..."}"</span> \{"\n"}
            {"  "}<span className="tok-flag">-vf</span> <span className="tok-arg">"sendcmd=f=delogo.cmd,delogo=show=0"</span> \{"\n"}
            {"  "}<span className="tok-flag">-c:v</span> <span className="tok-arg">{format === "hls" ? "h264_nvenc -hls_time 4" : "libx264"}</span> \{"\n"}
            {"  "}<span className="tok-flag">-c:a</span> <span className="tok-arg">copy</span> \{"\n"}
            {"  "}<span className="tok-arg">{format === "hls" ? "stream.m3u8" : "output.mp4"}</span>{"\n\n"}
            <span className="tok-comment"># delogo.cmd — time-gated per region</span>{"\n"}
            {regions.map((r, i) => `${((r.startFrame ?? 0) / fps).toFixed(1)}-${((r.endFrame ?? totalSeconds * fps) / fps).toFixed(1)} delogo x=${Math.round(r.x * 19.2)} y=${Math.round(r.y * 10.8)} w=${Math.round(r.w * 19.2)} h=${Math.round(r.h * 10.8)}`).join("\n")}
          </div>
        )}

        <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1, justifyContent: "center" }} onClick={onBack}>
            Back to editor
          </button>
          {state === "idle" && (
            <button className="btn primary" style={{ flex: 1.6, justifyContent: "center", background: "#ef5350", color: "#fff", borderColor: "rgba(0,0,0,.2)" }} onClick={() => setState("recording")}>
              <Icons.Record size={13} /> Start recording
            </button>
          )}
          {state === "recording" && (
            <button className="btn" style={{ flex: 1.6, justifyContent: "center", borderColor: "rgba(239,83,80,.5)", color: "#ff8a87" }} onClick={() => { setState("done"); setTick(totalSeconds); }}>
              <span style={{ width: 9, height: 9, background: "currentColor", borderRadius: 1, marginRight: 6 }} />
              Stop · {fmt(sourceTime)}
            </button>
          )}
          {state === "done" && (
            <button className="btn primary" style={{ flex: 1.6, justifyContent: "center" }} onClick={onDone}>
              <Icons.Download size={13} /> Save cleaned file
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const ExportFile = ({ onBack, onDone, regions, scene, project }) => {
  const [format, setFormat] = useState("prores4444");
  const [alpha, setAlpha] = useState(true);
  const [showAdv, setShowAdv] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [exporting, setExporting] = useState(false);
  const [done, setDone] = useState(false);
  const [outputBlob, setOutputBlob] = useState(null);
  const [outputFilename, setOutputFilename] = useState(null);
  const [exportError, setExportError] = useState(null);

  // Probe the source video for its real dimensions + duration. Required by
  // FFmpeg-WASM to scale region geometry (stored as percentages) to pixel
  // crop/overlay coordinates. Skipped when there's no real video (mock mode).
  const hasRealVideo = !!project?.videoSrc;
  const [videoMeta, setVideoMeta] = useState(null);
  useEffect(() => {
    if (!hasRealVideo) return;
    const v = document.createElement("video");
    v.preload = "metadata";
    v.crossOrigin = "anonymous";
    v.src = project.videoSrc;
    v.onloadedmetadata = () => {
      setVideoMeta({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    };
    v.onerror = () => {
      setExportError("Couldn't read video metadata. Source may be cross-origin without CORS.");
    };
  }, [hasRealVideo, project?.videoSrc]);

  // Mock progress path: used when there's no real video (the "tokyo" scene).
  // Kept so the rest of the prototype still walks through this screen.
  useEffect(() => {
    if (!exporting || hasRealVideo) return;
    const iv = setInterval(() => {
      setProgress((p) => {
        const np = Math.min(100, p + 0.6 + Math.random() * 0.8);
        if (np >= 100) { clearInterval(iv); setDone(true); }
        return np;
      });
    }, 100);
    return () => clearInterval(iv);
  }, [exporting, hasRealVideo]);

  // Real export path: when a real videoSrc is loaded, run FFmpeg-WASM.
  useEffect(() => {
    if (!exporting || !hasRealVideo) return;
    if (!videoMeta) return; // wait for metadata
    if (typeof window.runExport !== "function") {
      setExportError("Export module not loaded. Refresh the page and try again.");
      return;
    }
    setExportError(null);
    const fps = 24;
    window.runExport({
      videoSrc: project.videoSrc,
      regions,
      fps,
      videoWidth: videoMeta.width,
      videoHeight: videoMeta.height,
      durationSec: videoMeta.duration,
      onProgress: (p) => {
        setStatusMsg(p.message || "");
        if (typeof p.pct === "number") setProgress(p.pct);
      },
      onLog: (line) => {
        // Quiet logging — too chatty for the UI, useful in console.
        if (/error|fail|invalid/i.test(line)) console.warn("[ffmpeg]", line);
      },
    }).then(({ blob, filename }) => {
      setOutputBlob(blob);
      setOutputFilename(filename);
      setProgress(100);
      setDone(true);
    }).catch((err) => {
      setExportError(err.message || String(err));
      setExporting(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exporting, hasRealVideo, videoMeta]);

  // Trigger a real download once we have a blob.
  const downloadOutput = () => {
    if (!outputBlob || !outputFilename) { onDone?.(); return; }
    const url = URL.createObjectURL(outputBlob);
    const a = document.createElement("a");
    a.href = url; a.download = outputFilename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    onDone?.();
  };

  return (
    <div className="export-wrap">
      <div className="export-preview">
        <div className="frame">
          <MockScene
            scene={scene || "tokyo"}
            regions={regions}
            cleaned={true}
            fontScale={1.6}
          />
          {/* Cleanup indicator badge */}
          <div style={{
            position: "absolute", bottom: 12, left: 12,
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "Geist Mono, monospace", fontSize: 10,
            background: "rgba(0,0,0,.7)", padding: "4px 8px", borderRadius: 4,
            color: "var(--accent)",
            zIndex: 5,
            whiteSpace: "nowrap",
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><polyline points="20 6 9 17 4 12" /></svg>
            CLEANED · {format === "prores4444" || format === "webm" ? "alpha" : "filled"}
          </div>
        </div>

        {exporting && (
          <div className="export-progress">
            <div className="progress-bar">
              <div className="fill" style={{ width: progress + "%" }} />
            </div>
            <div className="progress-stats">
              <span>
                {hasRealVideo
                  ? (statusMsg || (done ? "Done" : "Encoding"))
                  : (done ? "Done" : "Encoding") + ` · frame ${Math.floor(progress * 72)} / 7200`}
              </span>
              <span>
                {Math.floor(progress)}%
                {!hasRealVideo && ` · ETA ${Math.max(0, Math.ceil((100 - progress) / 6))}s`}
              </span>
            </div>
            {exportError && (
              <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "rgba(239,83,80,.12)", border: "1px solid rgba(239,83,80,.4)", color: "var(--ink)", fontSize: 12 }}>
                <strong>Export failed.</strong> {exportError}
              </div>
            )}
          </div>
        )}
        {!exporting && exportError && (
          <div style={{ margin: "12px 0", padding: "8px 10px", borderRadius: 6, background: "rgba(239,83,80,.12)", border: "1px solid rgba(239,83,80,.4)", color: "var(--ink)", fontSize: 12 }}>
            <strong>Export failed.</strong> {exportError}
          </div>
        )}
        {hasRealVideo && !exporting && (
          <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 6, background: "var(--bg-2)", border: "1px solid var(--line)", fontSize: 11, lineHeight: 1.5, color: "var(--ink-3)" }}>
            <div style={{ color: "var(--ink-2)", marginBottom: 4 }}>What gets exported</div>
            Each visible region is burned in as a real boxblur in its time window. Audio descriptions are <strong style={{ color: "var(--ink-2)" }}>not</strong> included — they're text-only in this prototype. To include them you'd need recorded audio per note + a separate mixing pass.
          </div>
        )}
      </div>

      <div className="export-settings">
        <h2>Export</h2>
        <div className="sub">3 regions · 5 min 00 s · 24 fps</div>

        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 10 }}>Format</div>
        <div
          className={`opt-card ${format === "prores4444" ? "active" : ""}`}
          onClick={() => { setFormat("prores4444"); setAlpha(true); }}
        >
          <div className="radio" />
          <div className="body">
            <div className="name"><span className="name-t">ProRes 4444</span> <span className="chip dot" style={{ fontSize: 10 }}>alpha</span></div>
            <div className="desc">True transparency where logos used to be. Big files, perfect for re-compositing in After Effects, DaVinci or Premiere.</div>
          </div>
        </div>
        <div
          className={`opt-card ${format === "webm" ? "active" : ""}`}
          onClick={() => { setFormat("webm"); setAlpha(true); }}
        >
          <div className="radio" />
          <div className="body">
            <div className="name"><span className="name-t">WebM · VP9 + alpha</span> <span className="chip dot" style={{ fontSize: 10 }}>alpha</span></div>
            <div className="desc">Transparency, small file. Great for web overlays — note alpha isn't supported in Safari.</div>
          </div>
        </div>
        <div
          className={`opt-card ${format === "h264" ? "active" : ""}`}
          onClick={() => { setFormat("h264"); setAlpha(false); }}
        >
          <div className="radio" />
          <div className="body">
            <div className="name"><span className="name-t">MP4 · H.264</span> <span className="chip" style={{ fontSize: 10, color: "var(--ink-3)" }}>flat</span></div>
            <div className="desc">No alpha. The removed regions are filled in (delogo / inpaint). Universal compatibility.</div>
          </div>
        </div>

        <div style={{ marginTop: 18, fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-3)", marginBottom: 10 }}>
          Options
        </div>
        <div className="opt-card" style={{ cursor: "default" }}>
          <input type="checkbox" checked={alpha} disabled={format === "h264"} onChange={(e) => setAlpha(e.target.checked)}
            style={{ accentColor: "var(--accent)", marginTop: 2 }} />
          <div className="body">
            <div className="name"><span className="name-t">Render with alpha channel</span></div>
            <div className="desc">Removed regions become fully transparent in the output, with feathered edges per region opacity.</div>
          </div>
        </div>

        <button className="adv-toggle" onClick={() => setShowAdv(!showAdv)}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icons.Code size={13} /> Advanced — ffmpeg command
          </span>
          <Icons.Chevron size={13} style={{ transform: showAdv ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
        </button>
        {showAdv && <FFmpegPreview format={format} alpha={alpha} regions={regions} />}

        <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
          <button className="btn ghost" style={{ flex: 1, justifyContent: "center" }} onClick={onBack}>
            Back to editor
          </button>
          {!exporting ? (
            <button className="btn primary" style={{ flex: 1.4, justifyContent: "center" }} onClick={() => setExporting(true)}>
              <Icons.Download size={13} /> Start export
            </button>
          ) : done ? (
            <button className="btn primary" style={{ flex: 1.4, justifyContent: "center" }} onClick={hasRealVideo ? downloadOutput : onDone}>
              <Icons.Check size={13} /> {hasRealVideo ? `Download ${outputFilename || "MP4"}` : "Download"}
            </button>
          ) : (
            <button className="btn" style={{ flex: 1.4, justifyContent: "center" }} disabled>
              Encoding… {Math.floor(progress)}%
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ─── Tweaks ─────────────────────────────────────────── */

const Export = ({ onBack, onDone, regions, scene, project }) => {
  // Live streams use the recording flow. A "url" source that points at a
  // direct playable video file (mp4/webm/etc.) is treated as a file export
  // — the real FFmpeg-WASM pipe runs in ExportFile.
  const isLiveStream = project?.source === "live";
  if (isLiveStream) {
    return <StreamRecord project={project} regions={regions} scene={scene} onBack={onBack} onDone={onDone} />;
  }
  return <ExportFile regions={regions} scene={scene} onBack={onBack} onDone={onDone} project={project} />;
};

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#6ee7a8",
  "previewMode": "removed",
  "showMotionPath": true,
  "density": "comfortable"
}/*EDITMODE-END*/;

const TweaksLayer = () => {
  const [tweaks, setTweak] = useTweaks(DEFAULTS);

  // Apply tweaks to live CSS variables
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", tweaks.accent);
    document.documentElement.style.setProperty(
      "--accent-2",
      tweaks.accent === "#6ee7a8" ? "#34d399" : tweaks.accent
    );
  }, [tweaks.accent]);

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Accent">
        <div style={{ display: "flex", gap: 8 }}>
          {[
            ["#6ee7a8", "Spring green"],
            ["#7aa8ff", "Cobalt"],
            ["#f5709a", "Magenta"],
            ["#f5b14e", "Amber"],
          ].map(([c, name]) => (
            <button
              key={c}
              onClick={() => setTweak("accent", c)}
              title={name}
              style={{
                width: 28, height: 28, borderRadius: 6,
                background: c,
                border: tweaks.accent === c ? "2px solid #fff" : "2px solid rgba(255,255,255,.1)",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      </TweakSection>

      <TweakSection label="Preview style">
        <TweakRadio
          options={[
            { value: "removed",  label: "Transparent" },
            { value: "blurred",  label: "Blur" },
            { value: "none",     label: "Outline" },
          ]}
          value={tweaks.previewMode}
          onChange={(v) => setTweak("previewMode", v)}
        />
        <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginTop: 8, lineHeight: 1.4 }}>
          How removed regions look in the editor preview.
        </div>
      </TweakSection>

      <TweakSection label="Motion path">
        <TweakToggle
          label="Show keyframe trail"
          value={tweaks.showMotionPath}
          onChange={(v) => setTweak("showMotionPath", v)}
        />
      </TweakSection>
    </TweaksPanel>
  );
};

/* ─── Root app ──────────────────────────────────────────── */

const App = () => {
  const [screen, setScreen] = useState("projects");
  const [project, setProject] = useState(null);
  const [exportedRegions, setExportedRegions] = useState(DEFAULT_REGIONS);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("unlogo:theme") || "night"; }
    catch { return "night"; }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("unlogo:theme", theme); } catch {}
  }, [theme]);

  // Quick-launch entrypoint: `?video=URL` boots straight into the editor with
  // that URL as the <video> source. Useful for testing with a manifest pulled
  // from a YuJa/Kaltura/whatever page via DevTools → Network.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get("video");
      if (v) {
        const detected = PLATFORMS.find((p) => p.re.test(v));
        setProject({
          source: "url",
          platform: detected?.id || "url",
          url: v,
          videoSrc: v,
          scene: "tokyo",
          name: "From " + (detected?.name || "URL"),
        });
        setScreen("editor");
      }
    } catch {}
  }, []);

  return (
    <div className="app">
      <TopBar
        screen={screen}
        project={project}
        hasProject={!!project && (screen === "editor" || screen === "export")}
        onHome={() => { setScreen("projects"); }}
        onNew={() => setScreen("upload")}
        onExport={() => setScreen("export")}
        theme={theme}
        onToggleTheme={setTheme}
      />
      <div className="screen">
        {screen === "projects" && (
          <Projects
            onOpenProject={(p) => { setProject(p); setScreen("editor"); }}
            onNew={() => setScreen("upload")}
          />
        )}
        {screen === "upload" && (
          <Upload onStart={(meta) => { setProject(meta); setScreen("detect"); }} />
        )}
        {screen === "detect" && (
          <Detecting scene={project?.scene} onDone={() => setScreen("editor")} />
        )}
        {screen === "editor" && (
          <Editor
            project={project}
            onBack={() => setScreen("projects")}
            onExport={() => setScreen("export")}
          />
        )}
        {screen === "export" && (
          <Export
            regions={exportedRegions}
            scene={project?.scene}
            project={project}
            onBack={() => setScreen("editor")}
            onDone={() => setScreen("projects")}
          />
        )}
      </div>
      <TweaksLayer />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
