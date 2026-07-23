/* inpaint.js — browser client for the self-hosted local inpainting backend.
 *
 * The backend (see server/) does high-quality region removal (ProPainter) on a
 * local GPU. This module is the opt-in bridge: it uploads the source clip + a
 * JobSpec, streams progress, and resolves with the cleaned video as a blob URL.
 *
 * Exposes: window.runServerInpaint(videoSrc, spec, opts) → Promise<{ url, blob }>
 *
 *   videoSrc        the source video URL/blob: URL to upload.
 *   spec            JobSpec — { fps, width, height, timeRange?, regions[] }.
 *                   Geometry in regions is PERCENT of frame (0..100), matching
 *                   the editor's region model. See server/README.md.
 *   opts.endpoint   backend base URL, default "http://127.0.0.1:8770".
 *   opts.onProgress ({ stage, message, pct }) callback.
 *   opts.signal     optional AbortSignal to cancel the upload/poll.
 *
 * Lazy-loaded like ocr.js / transcribe.js: attaches a global and is injected on
 * demand, so the editor pays no cost unless the user opts into server cleanup.
 */

(function (global) {
  "use strict";

  const DEFAULT_ENDPOINT = "http://127.0.0.1:8770";

  // Settings dialog can override the backend address (unlogo:endpoint);
  // an explicit opts.endpoint from the caller still wins.
  function resolveEndpoint(explicit) {
    if (explicit) return explicit.replace(/\/$/, "");
    try {
      const saved = (localStorage.getItem("unlogo:endpoint") || "").trim();
      if (saved) return saved.replace(/\/$/, "");
    } catch (_) {}
    return DEFAULT_ENDPOINT;
  }

  function report(onProgress, stage, pct, message) {
    if (typeof onProgress === "function") {
      onProgress({ stage, pct, message });
    }
  }

  // Poll fallback used when EventSource is unavailable or errors out.
  async function pollUntilDone(endpoint, jobId, onProgress, signal) {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const res = await fetch(`${endpoint}/api/jobs/${jobId}`, { signal });
      if (!res.ok) throw new Error(`status poll failed (HTTP ${res.status})`);
      const snap = await res.json();
      report(onProgress, snap.stage, snap.pct, snap.message);
      if (snap.status === "done") return;
      if (snap.status === "error") {
        throw new Error(snap.error || "server reported an error");
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  // Prefer the SSE stream; fall back to polling on any failure.
  function followProgress(endpoint, jobId, onProgress, signal) {
    if (typeof global.EventSource === "undefined") {
      return pollUntilDone(endpoint, jobId, onProgress, signal);
    }
    return new Promise((resolve, reject) => {
      const es = new global.EventSource(`${endpoint}/api/jobs/${jobId}/events`);
      let settled = false;

      const cleanup = () => {
        es.close();
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort);
      }

      es.onmessage = (ev) => {
        let snap;
        try {
          snap = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        report(onProgress, snap.stage, snap.pct, snap.message);
        if (snap.status === "done") {
          settled = true;
          cleanup();
          resolve();
        } else if (snap.status === "error") {
          settled = true;
          cleanup();
          reject(new Error(snap.error || "server reported an error"));
        }
      };
      es.onerror = () => {
        if (settled) return;
        // SSE dropped — fall back to polling rather than failing the job.
        settled = true;
        es.close();
        pollUntilDone(endpoint, jobId, onProgress, signal).then(resolve, reject);
      };
    });
  }

  async function submitJob(videoSrc, spec, opts) {
    opts = opts || {};
    const endpoint = resolveEndpoint(opts.endpoint);
    const onProgress = opts.onProgress;
    const signal = opts.signal;

    report(onProgress, "uploading", 2, "Reading source clip");
    const videoBlob = await (await fetch(videoSrc, { signal })).blob();

    const form = new FormData();
    form.append("spec", JSON.stringify(spec));
    form.append("video", videoBlob, "input");

    report(onProgress, "uploading", 8, "Uploading to local backend");
    let submitRes;
    try {
      submitRes = await fetch(`${endpoint}/api/jobs`, {
        method: "POST",
        body: form,
        signal,
      });
    } catch (err) {
      throw new Error(
        `Could not reach the local backend at ${endpoint}. ` +
          `Is it running? (cd server && uvicorn app:app --port 8770) — ${err.message}`
      );
    }
    if (!submitRes.ok) {
      const detail = await submitRes.text().catch(() => "");
      throw new Error(`Job submit failed (HTTP ${submitRes.status}): ${detail}`);
    }
    const { jobId } = await submitRes.json();

    report(onProgress, "queued", 10, "Queued on the local GPU");
    await followProgress(endpoint, jobId, onProgress, signal);

    report(onProgress, "downloading", 99, "Fetching cleaned video");
    const resultRes = await fetch(`${endpoint}/api/jobs/${jobId}/result`, { signal });
    if (!resultRes.ok) {
      throw new Error(`Result download failed (HTTP ${resultRes.status})`);
    }
    const blob = await resultRes.blob();
    const url = URL.createObjectURL(blob);
    report(onProgress, "done", 100, "Cleaned video ready");

    // Best-effort cleanup of server scratch files; ignore failures.
    fetch(`${endpoint}/api/jobs/${jobId}`, { method: "DELETE" }).catch(() => {});

    return { url, blob, jobId };
  }

  // Fetch a remote video (YouTube/Vimeo/YuJa/Kaltura/direct URL) via the
  // local backend's yt-dlp and return it as a blob URL the editor can open.
  // The browser can't load a watch page into <video>; the server resolves
  // the real stream, downloads it, and hands the file back.
  async function fetchRemoteVideo(url, opts) {
    opts = opts || {};
    const endpoint = resolveEndpoint(opts.endpoint);
    const onProgress = opts.onProgress;
    const signal = opts.signal;
    if (!url) throw new Error("fetchRemoteVideo: missing url");

    report(onProgress, "queued", 2, "Contacting local backend");
    let submitRes;
    try {
      submitRes = await fetch(`${endpoint}/api/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal,
      });
    } catch (err) {
      throw new Error(
        `Could not reach the local backend at ${endpoint}. ` +
          `URL import needs the server running (cd server && uvicorn app:app --port 8770) ` +
          `with yt-dlp installed — ${err.message}`
      );
    }
    if (!submitRes.ok) {
      const detail = await submitRes.text().catch(() => "");
      throw new Error(`Fetch request rejected (HTTP ${submitRes.status}): ${detail}`);
    }
    const { jobId } = await submitRes.json();

    await followProgress(endpoint, jobId, onProgress, signal);

    report(onProgress, "downloading", 99, "Loading fetched video");
    const resultRes = await fetch(`${endpoint}/api/jobs/${jobId}/result`, { signal });
    if (!resultRes.ok) {
      throw new Error(`Fetched video download failed (HTTP ${resultRes.status})`);
    }
    const blob = await resultRes.blob();
    const url2 = URL.createObjectURL(blob);
    report(onProgress, "done", 100, "Video ready");
    fetch(`${endpoint}/api/jobs/${jobId}`, { method: "DELETE" }).catch(() => {});
    return { url: url2, blob, jobId };
  }

  async function runServerInpaint(videoSrc, spec, opts) {
    if (!videoSrc) throw new Error("runServerInpaint: missing videoSrc");
    if (!spec || !Array.isArray(spec.regions) || spec.regions.length === 0) {
      throw new Error("runServerInpaint: spec.regions must be non-empty");
    }
    return submitJob(videoSrc, spec, opts);
  }

  // Audio-description job: notes = [{ startSec, text, mode? }]. The server
  // synthesizes each note (Piper → espeak-ng → test tone), ducks the original
  // audio under it, and returns an MKV with a second, user-selectable
  // "Audio Description" track (flagged visual_impaired for players).
  async function runServerDescribe(videoSrc, notes, opts) {
    if (!videoSrc) throw new Error("runServerDescribe: missing videoSrc");
    const clean = (notes || []).filter((n) => (n.text || "").trim());
    if (clean.length === 0) {
      throw new Error("runServerDescribe: needs at least one note with text");
    }
    return submitJob(videoSrc, { task: "describe", notes: clean }, opts);
  }

  // Upscale job: { scale } (2/3/4) or { targetHeight } (e.g. 1080, 2160).
  // Real-ESRGAN super-resolution when the server has it; Lanczos otherwise.
  async function runServerUpscale(videoSrc, params, opts) {
    if (!videoSrc) throw new Error("runServerUpscale: missing videoSrc");
    const scale = params?.scale, targetHeight = params?.targetHeight;
    if (!scale && !targetHeight) {
      throw new Error("runServerUpscale: needs scale (2/3/4) or targetHeight");
    }
    return submitJob(videoSrc, {
      task: "upscale",
      scale, targetHeight,
      sharpen: !!params?.sharpen,
    }, opts);
  }

  // Report the status of the local services the editor depends on, plus the
  // exact command to start each. Backend status = health probe; MCP status =
  // the live bridge connection (bridge.js) or the backend's own report; the
  // page host is trivially up (you're reading this from it).
  async function checkServices(opts) {
    opts = opts || {};
    const endpoint = resolveEndpoint(opts.endpoint);
    const svcDir = "cd server && ";
    const out = {
      backend: { name: "Processing backend", running: false, port: 8770, startable: false,
        command: svcDir + "uvicorn app:app --port 8770" },
      mcp: { name: "AI chat bridge (MCP)", running: !!window.__mcpBridgeConnected, port: 8772, startable: false,
        command: svcDir + "python mcp_server.py" },
      page: { name: "Editor (web server)", running: true, port: Number(location.port) || 80,
        command: svcDir + "../ && npx http-server -p 8090 --cors", startable: false },
    };
    try {
      const res = await fetch(`${endpoint}/api/services`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const data = await res.json();
        out.backend.running = !!data.backend?.running;
        // Backend can confirm/deny MCP even before the page's own bridge connects.
        out.mcp.running = out.mcp.running || !!data.mcp?.running;
        out.mcp.startable = out.backend.running; // backend can spawn the MCP server
      }
    } catch (_) {
      out.backend.running = false; // couldn't reach it
    }
    return out;
  }

  // Ask the (running) backend to start the MCP server.
  async function startMcpService(opts) {
    opts = opts || {};
    const endpoint = resolveEndpoint(opts.endpoint);
    const res = await fetch(`${endpoint}/api/services/mcp/start`, { method: "POST" });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Start failed (HTTP ${res.status}): ${detail}`);
    }
    return res.json();
  }

  global.runServerInpaint = runServerInpaint;
  global.runServerDescribe = runServerDescribe;
  global.runServerUpscale = runServerUpscale;
  global.fetchRemoteVideo = fetchRemoteVideo;
  global.checkServices = checkServices;
  global.startMcpService = startMcpService;
})(window);
