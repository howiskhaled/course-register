#!/bin/bash
# Builds release/KFUPM Planner.app (macOS). Usage: ./build_mac.sh
set -euo pipefail
cd "$(dirname "$0")"

PY=.venv/bin/python
[ -x "$PY" ] || { python3 -m venv .venv; }
echo "→ Python dependencies"
$PY -m pip install -q --disable-pip-version-check -r requirements.txt pywebview pyinstaller pillow

echo "→ UI"
(cd frontend && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build)

echo "→ Course data snapshot (bundled so the first launch is instant)"
[ -f data/terms.json ] || $PY scraper.py --all-open

echo "→ Icon"
mkdir -p build/icon.iconset
$PY packaging/make_icon.py build/icon-1024.png >/dev/null
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon-1024.png --out "build/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d build/icon-1024.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns

echo "→ App bundle"
$PY -m PyInstaller --noconfirm --clean --log-level WARN \
  --distpath release --workpath build/pyinstaller packaging/kfupm_planner.spec

echo
echo "✓ Built: release/KFUPM Planner.app"
echo "  Open it with:  open \"release/KFUPM Planner.app\"   (or drag it to /Applications)"
