"""Remote video fetcher — resolves a URL to a local MP4 with yt-dlp.

The browser can't load a YouTube/Vimeo/YuJa/Kaltura *watch page* into a
<video> element (those are HTML, not media, and the underlying CDN streams
are CORS-blocked). This module runs server-side: yt-dlp resolves the real
stream, downloads + remuxes to MP4 on the local machine, and the backend
serves that file back for the editor to open as a normal video.

Only the user's own local backend calls this, over the 127.0.0.1 CORS
allowlist. The user is responsible for having the right to download the
content (institutional lecture recordings, their own uploads, accessibility
remediation of material they're licensed to modify, etc.).

Entry point: fetch(url, dest_dir, on_progress) -> Path
"""

from __future__ import annotations

import ipaddress
import os
import socket
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlparse

OnProgress = Callable[[str, int, str], None]

MAX_FETCH_BYTES = int(os.environ.get("DELOGO_MAX_FETCH_MB", "4096")) * 1024 * 1024


def _allow_private() -> bool:
    """Institutional media servers (some Kaltura/YuJa instances) live on
    private/LAN hosts. DELOGO_ALLOW_PRIVATE_FETCH=1 opts into fetching them,
    keeping only the http/https scheme check. Off by default (SSRF-safe)."""
    return os.environ.get("DELOGO_ALLOW_PRIVATE_FETCH", "").strip() in ("1", "true", "yes")


def _is_safe_url(url: str) -> tuple[bool, str]:
    """Reject non-http(s) and (unless opted out) any host that resolves to a
    private/loopback/link-local address — basic SSRF hardening so a pasted
    (or injected) URL can't make the local server hit internal services or
    cloud metadata endpoints.
    """
    try:
        parsed = urlparse(url)
    except Exception:  # noqa: BLE001
        return False, "URL could not be parsed"
    if parsed.scheme not in ("http", "https"):
        return False, f"only http/https URLs are allowed (got {parsed.scheme!r})"
    host = parsed.hostname
    if not host:
        return False, "URL has no host"
    if _allow_private():
        return True, ""
    # Resolve every address the host maps to; reject if ANY is non-public.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False, f"could not resolve host {host!r}"
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split("%")[0])
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False, (
                f"host {host!r} resolves to a non-public address ({addr}); refused. "
                "Set DELOGO_ALLOW_PRIVATE_FETCH=1 if this is a trusted internal media server."
            )
    return True, ""


def fetch(url: str, dest_dir: Path, on_progress: OnProgress) -> Path:
    """Download `url` into `dest_dir` and return the resulting MP4 path."""
    import yt_dlp

    ok, why = _is_safe_url(url)
    if not ok:
        raise ValueError(f"refusing to fetch this URL: {why}")

    dest_dir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(dest_dir / "source.%(ext)s")

    def hook(d: dict) -> None:
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total and done > total * 0 and total > MAX_FETCH_BYTES:
                raise ValueError("source exceeds DELOGO_MAX_FETCH_MB")
            pct = int(done / total * 90) if total else 30
            mb = done / (1024 * 1024)
            on_progress("downloading", max(5, min(90, pct)), f"Downloading… {mb:.1f} MB")
        elif status == "finished":
            on_progress("remuxing", 92, "Remuxing to MP4")

    ydl_opts = {
        # Prefer a single progressive MP4; fall back to best video+audio
        # merged to MP4. ffmpeg (already required) does the merge/remux.
        "format": "best[ext=mp4]/bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
        "outtmpl": out_tmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "retries": 3,
        "socket_timeout": 30,
        # Postprocess to mp4 container so the browser <video> can always play it.
        "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
    }

    on_progress("resolving", 3, "Resolving source URL")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    # yt-dlp may have produced source.mp4 (remux) or source.<ext>; prefer mp4.
    mp4 = dest_dir / "source.mp4"
    if mp4.exists():
        result = mp4
    else:
        candidates = sorted(dest_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
        if not candidates:
            raise RuntimeError("yt-dlp finished but no output file was produced")
        result = candidates[0]

    title = (info or {}).get("title") or "video"
    on_progress("done", 100, f"Fetched: {title}")
    return result
