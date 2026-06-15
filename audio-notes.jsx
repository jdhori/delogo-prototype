/* global React, Icons */
// audio-notes.jsx — audio description bookmarks: pseudo-audio model,
// waveform backdrop, timeline track, stage overlay, recorder modal.
// Exposes: NotesTrack, WaveformBackdrop, AudioDescOverlay, NoteRecorderModal,
// DEFAULT_NOTES, mockAudioLevel, audioActiveAt.

const { useState, useEffect, useRef, useMemo } = React;

/* ─── Mocked source-audio model ───────────────────────
 * The source video is 5 minutes; we mock its audio as five "phrases" with
 * quiet gaps. A note that fires inside a phrase wants to PAUSE the video
 * (so the description doesn't fight with on-camera speech). A note that
 * fires inside a gap overlays the silence.
 */
const PHRASES = [
  [0.03, 0.20, 0.72],
  [0.24, 0.40, 0.86],
  [0.46, 0.58, 0.62],
  [0.62, 0.76, 0.92],
  [0.80, 0.96, 0.58],
];

function mockAudioLevel(t /* 0..1 */) {
  let amp = 0;
  for (const [a, b, m] of PHRASES) {
    if (t >= a && t <= b) {
      const env = Math.sin(((t - a) / (b - a)) * Math.PI);
      amp = m * (0.55 + env * 0.45);
      break;
    }
  }
  if (amp === 0) return 0.04 + 0.025 * Math.abs(Math.sin(t * 220));
  const wob = (Math.sin(t * 540) * 0.5 + 0.5);
  return Math.max(0.05, Math.min(1, amp * (0.45 + wob * 0.55)));
}

function audioActiveAt(t) { return mockAudioLevel(t) > 0.22; }

function sampleWaveform(samples) {
  const out = [];
  for (let i = 0; i < samples; i++) out.push(mockAudioLevel(i / (samples - 1)));
  return out;
}
const WAVE_SAMPLES = sampleWaveform(280);

const WaveformBackdrop = () => (
  <svg className="tl-waveform" viewBox={`0 0 ${WAVE_SAMPLES.length} 100`} preserveAspectRatio="none">
    {WAVE_SAMPLES.map((v, i) => {
      const h = Math.max(1.6, v * 78);
      return (
        <rect
          key={i}
          x={i + 0.15}
          y={50 - h / 2}
          width={0.7}
          height={h}
          fill="var(--ink-2)"
        />
      );
    })}
  </svg>
);

/* ─── Default sample notes ────────────────────────────
 * Numbers assume 24fps and a 5-minute clip (7200 frames).
 */
const DEFAULT_NOTES = [
  {
    id: "n1", frame: 432, durationFrames: 96, // 0:18, ~4s description
    text: "Network logo appears in the top-right of the frame.",
    mode: "overlay",
  },
  {
    id: "n2", frame: 2280, durationFrames: 144, // 1:35, ~6s
    text: "Burned-in subtitle introduces the speaker. Their name and title appear on the lower third.",
    mode: "pause",
  },
  {
    id: "n3", frame: 4080, durationFrames: 120, // 2:50, ~5s
    text: "The floating watermark drifts across the centre as the camera pans right.",
    mode: "pause",
  },
];

/* ─── Timeline marker ─────────────────────────────────── */

const NoteMarker = ({ note, totalFrames, selected, firing, firingProgress, onSelect, onEdit, onChange, onDelete }) => {
  const startPct = (note.frame / totalFrames) * 100;
  const widthPct = (note.durationFrames / totalFrames) * 100;

  const drag = (edge) => (e) => {
    e.stopPropagation();
    const tlInner = e.currentTarget.closest(".tl-inner");
    if (!tlInner) return;
    const tl = tlInner.getBoundingClientRect();
    const startX = e.clientX;
    let moved = false;
    const orig = { frame: note.frame, durationFrames: note.durationFrames };
    const move = (ev) => {
      const dFrac = (ev.clientX - startX) / tl.width;
      const dFrames = Math.round(dFrac * totalFrames);
      if (Math.abs(dFrames) > 2) moved = true;
      let next = { ...orig };
      if (edge === "body") {
        next.frame = Math.max(0, Math.min(totalFrames - orig.durationFrames, orig.frame + dFrames));
      } else if (edge === "l") {
        const nf = Math.max(0, Math.min(orig.frame + orig.durationFrames - 24, orig.frame + dFrames));
        const delta = nf - orig.frame;
        next.frame = nf;
        next.durationFrames = orig.durationFrames - delta;
      } else if (edge === "r") {
        next.durationFrames = Math.max(24, Math.min(totalFrames - orig.frame, orig.durationFrames + dFrames));
      }
      onChange({ ...note, ...next });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved && edge === "body") onSelect(note.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={`tl-note ${note.mode} ${selected ? "selected" : ""}`}
      style={{ left: startPct + "%", width: Math.max(0.6, widthPct) + "%" }}
      onPointerDown={drag("body")}
      onDoubleClick={(e) => { e.stopPropagation(); onEdit(note); }}
      title={note.text + (note.mode === "pause" ? " — pauses video" : " — overlays audio")}
    >
      <Icons.Speaker className="glyph" size={9} sw={2} />
      <span className="lbl">{note.text}</span>
      <div className="tl-note-handle l" onPointerDown={drag("l")} />
      <div className="tl-note-handle r" onPointerDown={drag("r")} />
      {/* Quick-delete: hover the pip to surface an X. Confirms inline so a
          stray click doesn't nuke a note. Right-click also deletes for
          users who prefer that path. */}
      {onDelete && (
        <button
          type="button"
          className="tl-note-delete"
          aria-label={`Delete audio note: ${note.text.slice(0, 40)}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`Delete this audio note?\n\n"${note.text.slice(0, 80)}${note.text.length > 80 ? "…" : ""}"`)) {
              onDelete(note.id);
            }
          }}
          title="Delete audio note"
        >×</button>
      )}
      {firing && <div className="firing-bar" style={{ width: (firingProgress * 100) + "%" }} />}
    </div>
  );
};

const NotesTrack = ({ notes, totalFrames, selectedId, onSelect, onEdit, onChange, onDelete, firingNote, firingProgress }) => (
  <div className="tl-notes-row">
    <div className="rname">
      <Icons.Speaker size={11} sw={2} />
      Audio notes · {notes.length}
    </div>
    {notes.map((n) => (
      <NoteMarker
        key={n.id}
        note={n}
        totalFrames={totalFrames}
        selected={n.id === selectedId}
        firing={firingNote?.id === n.id}
        firingProgress={firingNote?.id === n.id ? firingProgress : 0}
        onSelect={onSelect}
        onDelete={onDelete}
        onEdit={onEdit}
        onChange={onChange}
      />
    ))}
  </div>
);

/* ─── Stage overlay ──────────────────────────────────── */

const AudioDescOverlay = ({ note, progress, onSkip }) => (
  <div className={`ad-overlay ${note.mode}`}>
    <div className="ic-circle">
      {note.mode === "pause"
        ? <Icons.Headphones size={18} sw={1.8} />
        : <Icons.Speaker size={18} sw={1.8} />}
    </div>
    <div className="mid">
      <div className="tag">
        <Icons.Pin size={9} sw={2} /> AUDIO DESCRIPTION
        <span className="pill">{note.mode === "pause" ? "VIDEO PAUSED" : "NARRATIVE OVERLAY"}</span>
      </div>
      <div className="text">{note.text}</div>
      <div className="progress"><div className="fill" style={{ width: (progress * 100) + "%" }} /></div>
    </div>
    <div className="wave" aria-hidden="true">
      {Array.from({ length: 7 }).map((_, i) => (
        <span key={i} style={{ animationDelay: (i * 90) + "ms" }} />
      ))}
    </div>
    <button className="btn ghost skip" onClick={onSkip} title="Skip description">
      <Icons.X size={13} /> Skip
    </button>
  </div>
);

/* ─── Recorder modal ─────────────────────────────────── */

const NoteRecorderModal = ({ playheadFrame, fps, totalFrames, editing, onSave, onClose, onDelete }) => {
  const frame = editing?.frame ?? playheadFrame;
  const t = frame / Math.max(1, totalFrames);
  const auto = audioActiveAt(t) ? "pause" : "overlay";

  const [recState, setRecState] = useState(editing ? "recorded" : "idle");
  const [secs, setSecs] = useState(editing ? editing.durationFrames / fps : 0);
  const [text, setText] = useState(editing?.text || "");
  const [mode, setMode] = useState(editing?.mode || null);
  const [bars, setBars] = useState(Array.from({ length: 32 }, () => 4));

  const effectiveMode = mode || auto;

  useEffect(() => {
    if (recState !== "recording") return;
    const iv = setInterval(() => {
      setSecs((s) => s + 0.1);
      setBars(() => Array.from({ length: 32 }, () => 4 + Math.random() * 32));
    }, 100);
    return () => clearInterval(iv);
  }, [recState]);

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    const tenths = Math.floor((s * 10) % 10);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${tenths}`;
  };

  const tcShort = (f) => {
    const s = Math.floor(f / fps);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const save = () => {
    const dur = Math.max(0.8, secs) * fps;
    onSave({
      id: editing?.id || ("n" + Date.now()),
      frame,
      durationFrames: Math.round(dur),
      text: text.trim() || "Untitled audio description",
      mode: effectiveMode,
    });
    onClose();
  };

  return (
    <div className="rec-backdrop" onClick={onClose}>
      <div className="rec-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? "Edit audio description" : "Record audio description"}</h3>
        <div className="rec-sub">
          Pinned at <span style={{ fontFamily: "Geist Mono, monospace", color: "var(--ink-2)" }}>{tcShort(frame)}</span>
          {" "}· the description will trigger here on playback.
        </div>

        <div className={`rec-mic ${recState === "recording" ? "active" : ""}`}>
          <div className="dot">
            <Icons.Mic size={20} sw={1.8} />
          </div>
          <div className="live-wave">
            {bars.map((h, i) => (
              <span key={i} style={{ height: (recState === "idle" ? 4 : recState === "recorded" ? 8 + (i % 7) * 3 : h) + "px" }} />
            ))}
          </div>
          <div className="tc">{fmt(secs)}</div>
        </div>

        <div className="rec-detect">
          <Icons.Sparkle size={13} style={{ color: "var(--accent)", flex: "none" }} />
          <span>
            Source audio here:&nbsp;
            <b style={{ color: "var(--ink)" }}>{audioActiveAt(t) ? "active speech" : "silent passage"}</b>
          </span>
          <div className="seg-mini">
            <button
              className={effectiveMode === "pause" ? "active" : ""}
              onClick={() => setMode("pause")}
            >Pause</button>
            <button
              className={effectiveMode === "overlay" ? "active" : ""}
              onClick={() => setMode("overlay")}
            >Overlay</button>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5, margin: "-6px 0 14px", paddingLeft: 2 }}>
          {effectiveMode === "pause"
            ? "Video will pause and the description plays in the foreground."
            : "Video keeps playing — description rides on top of the source audio."}
          {!mode && (
            <span style={{ color: "var(--accent)" }}> · auto-selected from source audio</span>
          )}
        </div>

        <div className="rec-field">
          <label>Transcript</label>
          <textarea
            rows={3}
            placeholder="e.g. Network logo appears in the top-right corner."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <div className="rec-actions">
          {editing && (
            <button className="btn danger" onClick={() => { onDelete(editing.id); onClose(); }} title="Delete">
              <Icons.Trash size={13} />
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {recState === "idle" && (
            <button
              className="btn"
              style={{ borderColor: "rgba(220,38,38,.5)", color: "#ff8a87" }}
              onClick={() => { setRecState("recording"); setSecs(0); }}
            >
              <Icons.Record size={13} /> Record
            </button>
          )}
          {recState === "recording" && (
            <button className="btn" onClick={() => setRecState("recorded")}>
              <span style={{ width: 9, height: 9, background: "currentColor", borderRadius: 1, marginRight: 6 }} />
              Stop
            </button>
          )}
          <button
            className="btn primary"
            onClick={save}
            disabled={recState === "recording" || (recState === "idle" && !editing)}
          >
            <Icons.Check size={13} /> {editing ? "Save" : "Add note"}
          </button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, {
  NotesTrack, WaveformBackdrop, AudioDescOverlay, NoteRecorderModal,
  DEFAULT_NOTES, mockAudioLevel, audioActiveAt,
});
