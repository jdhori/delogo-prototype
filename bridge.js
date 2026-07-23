/* bridge.js — AI chat bridge for the Delogo editor.
 *
 * Connects the page to the unlogo MCP server's local WebSocket
 * (ws://127.0.0.1:8772/editor) so a chat AI can drive the editor while the
 * user watches — and refines — every change in the UI. The MCP server owns
 * the socket; this side just executes commands against window.UnlogoAPI
 * (registered by editor.jsx while the editor screen is mounted).
 *
 * Protocol: one JSON object per message.
 *   in : { id, cmd, args }
 *   out: { id, ok: true, result } | { id, ok: false, error }
 *
 * Reconnects forever with backoff — the MCP server may start before or
 * after the page, in any order. Silent when no server is running.
 */

(function () {
  "use strict";

  const PORT = 8772;
  let retryMs = 1000;

  // Expose live bridge status so the Services panel knows if MCP is up
  // without a disruptive extra WebSocket probe (this IS the connection).
  window.__mcpBridgeConnected = false;
  function setBridgeStatus(connected) {
    if (window.__mcpBridgeConnected === connected) return;
    window.__mcpBridgeConnected = connected;
    try { window.dispatchEvent(new CustomEvent("unlogo:bridge", { detail: { connected } })); } catch (_) {}
  }

  function connect() {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/editor`);
    } catch (_) {
      schedule();
      return;
    }
    ws.onopen = () => { retryMs = 1000; setBridgeStatus(true); };
    ws.onclose = () => { setBridgeStatus(false); schedule(); };
    ws.onerror = () => { /* onclose fires next; keep the console quiet */ };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const { id, cmd, args } = msg || {};
      // App-level commands (e.g. importUrl) work from any screen; editor
      // commands need the editor mounted. Prefer the editor surface, fall
      // back to the app surface.
      const editorApi = window.UnlogoAPI;
      const appApi = window.UnlogoApp;
      const fn = (editorApi && typeof editorApi[cmd] === "function")
        ? editorApi[cmd]
        : (appApi && typeof appApi[cmd] === "function") ? appApi[cmd] : null;
      let payload;
      if (fn) {
        try {
          payload = { id, ok: true, result: (await fn(args || {})) ?? null };
        } catch (e) {
          payload = { id, ok: false, error: e?.message || String(e) };
        }
      } else if (!editorApi && !appApi) {
        payload = {
          id, ok: false,
          error: "Delogo isn't ready yet. Ask the user to make sure the Delogo page is open.",
        };
      } else if (!editorApi) {
        payload = {
          id, ok: false,
          error: `"${cmd}" needs the editor open. Ask the user to open or import a video first (import_url works from the start screen).`,
        };
      } else {
        payload = { id, ok: false, error: `Unknown command: ${cmd}` };
      }
      try { ws.send(JSON.stringify(payload)); } catch (_) {}
    };
  }

  function schedule() {
    setTimeout(connect, retryMs);
    retryMs = Math.min(15000, Math.round(retryMs * 1.6));
  }

  connect();
})();
