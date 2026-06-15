#!/usr/bin/env bash
# setup.sh — download the self-hosted FFmpeg-WASM bundle required by export.js.
#
# Total download: ~32 MB. Files end up in ./ffmpeg/ matching the layout
# export.js expects (worker.js + ffmpeg-core.wasm same-origin so the
# browser will spawn the Worker and instantiate WASM without CORS errors).

set -euo pipefail

cd "$(dirname "$0")"

FFMPEG_VERSION="0.12.10"
UTIL_VERSION="0.12.1"
CORE_VERSION="0.12.6"

mkdir -p ffmpeg/util
cd ffmpeg

echo "Downloading @ffmpeg/ffmpeg ${FFMPEG_VERSION}..."
curl -fsSL -o ffmpeg.js   "https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/index.js"
curl -fsSL -o classes.js  "https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/classes.js"
curl -fsSL -o const.js    "https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/const.js"
curl -fsSL -o utils.js    "https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/utils.js"
curl -fsSL -o errors.js   "https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/errors.js"
curl -fsSL -o worker.js   "https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/worker.js"

echo "Downloading @ffmpeg/util ${UTIL_VERSION}..."
curl -fsSL -o util/index.js  "https://unpkg.com/@ffmpeg/util@${UTIL_VERSION}/dist/esm/index.js"
curl -fsSL -o util/errors.js "https://unpkg.com/@ffmpeg/util@${UTIL_VERSION}/dist/esm/errors.js"
curl -fsSL -o util/const.js  "https://unpkg.com/@ffmpeg/util@${UTIL_VERSION}/dist/esm/const.js"

echo "Downloading @ffmpeg/core ${CORE_VERSION} (~31 MB)..."
curl -fsSL -o ffmpeg-core.js   "https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.js"
curl -fsSL -o ffmpeg-core.wasm "https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm"

echo
echo "Done. To run the prototype:"
echo "  python3 -m http.server 8090"
echo "  # then open http://localhost:8090/Delogo.html"
