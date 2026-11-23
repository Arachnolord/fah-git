#!/usr/bin/env bash
# Baut fah-git_release.zip (alles im obersten Ordner der ZIP) und legt eine Kopie in „NEUE ZIPs/Docker Projekte“.
set -euo pipefail
cd "$(dirname "$0")/.."
bash -n manage.sh
for f in src/*.js public/js/*.js; do node --check "$f"; done
rm -f fah-git_release.zip
zip -q -r -X fah-git_release.zip manage.sh docker-compose.yml Dockerfile package.json README.md src public -x '*.DS_Store'
cp fah-git_release.zip "$HOME/claude/NEUE ZIPs/Docker Projekte/fah-git_release.zip"   # Ablage-Struktur seit 16.11.2026
unzip -l fah-git_release.zip | tail -1
