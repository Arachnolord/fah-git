#!/usr/bin/env bash
# =============================================================================
# manage.sh — FAH-Git als ZIP-App auf FAH-NAS
#
#   ./manage.sh update [<zip>]  Erstinstallation und Update: ZIP einspielen (ohne
#                               Pfad die neueste fah-git*.zip im Ordner), Abbild
#                               bauen, starten, warten bis FAH-Git antwortet.
#   ./manage.sh start|stop|neustart|status|logs|url
#
# Daten:  daten/ (Repos, Konten, Einstellungen) und .env fasst ein Update nie an.
# Einrichten (erstes Konto, Import) geschieht in der Weboberfläche.
# =============================================================================
{   # Ganze Datei vorab einlesen: Ein Update überschreibt diese manage.sh, während sie läuft.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
DIENST="fah-git"
WARTEN_MAX_S=300

info()   { printf '[fah-git] %s\n' "$*"; }
fehler() { printf '[fah-git] FEHLER: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --ansi never "$@"; }

port_frei() { [ -z "$(ss -ltnH "( sport = :$1 )" 2>/dev/null)" ]; }
erster_freier_port() { local p=$1; while ! port_frei "$p"; do p=$((p + 1)); done; printf '%s' "$p"; }

env_anlegen() {
  [ -f .env ] && return 0
  local port
  port="$(erster_freier_port 3300)"
  umask 077
  printf '# Von manage.sh angelegt. Wird bei Updates nie überschrieben.\nPORT=%s\nADRESSE=\n' "$port" >.env
  info "Erste Einrichtung: .env angelegt (Port $port)."
}

zip_waehlen() {
  if [ -n "${1:-}" ]; then [ -f "$1" ] || fehler "ZIP nicht gefunden: $1"; printf '%s' "$1"; return; fi
  ls -t -- fah-git*.zip 2>/dev/null | head -n 1 || true
}

zip_einspielen() {
  local zip=$1 tmp quelle
  tmp="$(mktemp -d)"
  unzip -o -q "$zip" -d "$tmp"
  quelle="$tmp"
  if [ ! -f "$tmp/manage.sh" ] && [ "$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then
    quelle="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  fi
  rm -rf "$ROOT/src" "$ROOT/public"
  cp -a "$quelle/src" "$quelle/public" "$ROOT/"
  for datei in manage.sh docker-compose.yml Dockerfile package.json README.md; do
    [ -f "$quelle/$datei" ] && cp -f "$quelle/$datei" "$ROOT/$datei"
  done
  chmod 755 "$ROOT/manage.sh"
  rm -rf "$tmp"
  info "ZIP eingespielt: $(basename "$zip")"
}

version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1; }

warten_bis_bereit() {
  local start=$SECONDS port
  port="$(sed -n 's/^PORT=//p' .env)"
  while [ $((SECONDS - start)) -lt "$WARTEN_MAX_S" ]; do
    if curl -fsS -m 5 "http://127.0.0.1:${port:-3300}/api/gesundheit" >/dev/null 2>&1; then
      info "FAH-Git $(version) läuft: http://$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'):${port}/"
      return 0
    fi
    sleep 3
  done
  compose logs --tail 40 "$DIENST" || true
  fehler "FAH-Git antwortet nach $((WARTEN_MAX_S / 60)) Minuten nicht"
}

update() {
  local zip
  zip="$(zip_waehlen "${1:-}")"
  [ -n "$zip" ] && zip_einspielen "$zip"
  env_anlegen
  mkdir -p daten
  chown 1000:1000 daten 2>/dev/null || true
  info "Baue das Abbild für FAH-Git $(version) …"
  FAHGIT_VERSION="$(version)" compose build --quiet
  FAHGIT_VERSION="$(version)" compose up -d --remove-orphans
  warten_bis_bereit
}

case "${1:-}" in
  update)   update "${2:-}" ;;
  start)    env_anlegen; FAHGIT_VERSION="$(version)" compose up -d ;;
  stop)     compose stop ;;
  neustart) compose restart ;;
  status)   compose ps ;;
  logs)     compose logs --tail "${2:-200}" -f "$DIENST" ;;
  url)      printf 'http://127.0.0.1:%s/\n' "$(sed -n 's/^PORT=//p' .env)" ;;
  *)        sed -n '3,12p' "$0"; exit 1 ;;
esac
exit 0
}
