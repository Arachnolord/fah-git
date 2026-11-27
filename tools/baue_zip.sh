#!/usr/bin/env bash
# Baut fah-git_release.zip (alles im obersten Ordner der ZIP) und legt eine Kopie in „NEUE ZIPs/Docker Projekte“.
set -euo pipefail
cd "$(dirname "$0")/.."
bash -n manage.sh
for f in src/*.js public/js/*.js; do node --check "$f"; done
# Jede ausgelieferte Datei muss ins unterschriebene Manifest passen (Namen ohne Leer-/Sonderzeichen) – sonst fehlte sie
# beim Selbst-Update des Fail-over-Ersatzes.
falsch="$(find src public -type f ! -name '.DS_Store' | grep -vE '^(src|public)(/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,8}$' || true)"
[ -z "$falsch" ] || { echo "Dateinamen passen nicht ins Release-Manifest: $falsch" >&2; exit 1; }
node tools/release_signieren.mjs
rm -f fah-git_release.zip
zip -q -r -X fah-git_release.zip manage.sh docker-compose.yml Dockerfile package.json README.md paket-manifest.txt paket-signatur src public -x '*.DS_Store'
cp fah-git_release.zip "$HOME/claude/NEUE ZIPs/Docker Projekte/fah-git_release.zip"   # Ablage-Struktur seit 16.11.2026
unzip -l fah-git_release.zip | tail -1
