#!/bin/sh
# Serve the app and open it in Chromium with Web Bluetooth enabled.
set -eu
cd "$(dirname "$0")"
python3 -m http.server 8765 >/tmp/qcy-web.log 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT INT TERM
sleep 0.5
exec chromium --enable-features=WebBluetooth --user-data-dir="${TMPDIR:-/tmp}/qcy-web-chromium" http://localhost:8765
