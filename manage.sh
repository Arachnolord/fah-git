#!/usr/bin/env bash
# =============================================================================
# manage.sh — FAH-Git als ZIP-App auf FAH-NAS
#
#   ./manage.sh update [<zip>]  Erstinstallation und Update: ZIP einspielen (ohne
#                               Pfad die neueste fah-git*.zip im Ordner), Abbild
#                               bauen, starten, warten bis FAH-Git antwortet.
#   ./manage.sh start|stop|neustart|status|logs|url
#   ./manage.sh auto-update     Nur Fail-over-Ersatz (ROLLE=ersatz): ein vom Haupt
#                               bereitgelegtes, unterschriebenes Update prüfen und
#                               einspielen. Startet alle 2 Minuten der Compose-Dienst
#                               „updater“ (legt „update“ auf einem Ersatz mit an;
#                               „zeitplan“ richtet nur ihn neu ein).
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
# Auf dem Fail-over-Ersatz gehört der Dienst „updater“ dazu (Profil), mit dem Pfad dieses Ordners.
compose() {
  if [ -f "$ROOT/.env" ] && grep -qi '^ROLLE=ersatz' "$ROOT/.env"; then COMPOSE_PROFILES=ersatz FAHGIT_ROOT="$ROOT" docker compose --ansi never "$@"
  else FAHGIT_ROOT="$ROOT" docker compose --ansi never "$@"; fi
}

port_frei() { [ -z "$(ss -ltnH "( sport = :$1 )" 2>/dev/null)" ]; }
erster_freier_port() { local p=$1; while ! port_frei "$p"; do p=$((p + 1)); done; printf '%s' "$p"; }

env_anlegen() {
  [ -f .env ] && return 0
  local port
  port="$(erster_freier_port 3300)"
  umask 077
  printf '# Von manage.sh angelegt. Wird bei Updates nie überschrieben.\nPORT=%s\nADRESSE=\n# Release-Ablage (nur lesend), z. B. ein Ordner der NAS-Freigabe mit fertigen ZIPs\nABLAGE=\n# Fail-over: ROLLE=ersatz = nur lesende Kopie eines Haupts (Koppeln in der Oberfläche)\nROLLE=\n' "$port" >.env
  info "Erste Einrichtung: .env angelegt (Port $port)."
}

zip_waehlen() {
  if [ -n "${1:-}" ]; then [ -f "$1" ] || fehler "ZIP nicht gefunden: $1"; printf '%s' "$1"; return; fi
  ls -t -- fah-git*.zip 2>/dev/null | head -n 1 || true
}

zip_einspielen() {
  local zip=$1 tmp quelle
  tmp="$(mktemp -d)"
  # Manche NAS haben kein unzip (UGREEN): dann Python oder 7z.
  if command -v unzip >/dev/null 2>&1; then unzip -o -q "$zip" -d "$tmp"
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$tmp"
  elif command -v 7z >/dev/null 2>&1; then 7z x -y -bd -o"$tmp" "$zip" >/dev/null
  else fehler "Zum Entpacken fehlt unzip, python3 oder 7z"; fi
  quelle="$tmp"
  if [ ! -f "$tmp/manage.sh" ] && [ "$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then
    quelle="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  fi
  ordner_einspielen "$quelle"
  rm -rf "$tmp"
  info "ZIP eingespielt: $(basename "$zip")"
}

ordner_einspielen() { ordner_kopieren "$1" || fehler "Programmstand aus $1 ließ sich nicht einspielen"; }

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

bauen_und_starten() {
  env_anlegen
  mkdir -p daten
  chown 1000:1000 daten 2>/dev/null || true
  info "Baue das Abbild für FAH-Git $(version) …"
  FAHGIT_VERSION="$(version)" compose build --quiet fah-git
  if ist_ersatz; then updater_abbild; altlast_updater; fi
  FAHGIT_VERSION="$(version)" compose up -d --remove-orphans
  warten_bis_bereit
}

update() {
  local zip
  exec 9>"$ROOT/.update.lock"
  flock 9
  zip="$(zip_waehlen "${1:-}")"
  if [ -n "$zip" ]; then zip_einspielen "$zip"; fi
  bauen_und_starten
  # Nach einem Update von Hand liegt diese ZIP vorn – ältere fah-git*.zip weg, damit ein „update“ ohne Pfad nie zurückstuft.
  if [ -n "$zip" ]; then ls -t -- fah-git*.zip 2>/dev/null | tail -n +2 | while read -r z; do rm -f -- "$z"; done || true; fi
}

# --- Fail-over-Ersatz: Updates vom Haupt (1.15.0) ---------------------------------------------------------------
# Sicherheitsregel: Dieses Skript (läuft als Mitglied der docker-Gruppe) fasst den Datenordner des Containers NIE selbst
# an – der Container könnte dort Verweise auslegen. Lesen, Kopieren und Melden geschehen in Wegwerf-Containern aus dem
# laufenden Abbild (ohne Netz, ohne Rechte); geprüft und eingespielt wird eine Kopie in einem Ordner, den nur dieser
# Rechner sieht – mit dem Prüfcode und dem Release-Schlüssel der BEREITS installierten Fassung.

ist_ersatz() { [ -f .env ] && grep -qi '^ROLLE=ersatz' .env; }

# Updater-Abbild (Dienst „updater“ in docker-compose.yml, nur auf dem Ersatz): alpine + docker-cli, startet alle 2 Minuten
# „manage.sh auto-update“. Ein Container statt cron, weil manche NAS (UGREEN) Nutzern keinen crontab erlauben – und er
# übersteht Neustarts und System-Updates.
UPDATER_DOCKERFILE='FROM alpine:3.20
RUN apk add --no-cache bash docker-cli docker-cli-compose coreutils util-linux findutils
ENTRYPOINT ["/bin/sh", "-c", "while true; do bash \"$FAHGIT_ROOT/manage.sh\" auto-update >>\"$FAHGIT_ROOT/auto-update.log\" 2>&1; sleep 120; done"]'
updater_abbild() {
  : >>"$ROOT/.update.lock" 2>/dev/null || true
  printf '%s\n' "$UPDATER_DOCKERFILE" | docker build -q -t fah-git-updater:lokal - >/dev/null || fehler "Updater-Abbild ließ sich nicht bauen"
}
# Einzeln gestarteter Updater aus 1.15.0/1.15.1 (vor dem Compose-Dienst) weg.
altlast_updater() {
  if docker inspect fah-git-updater >/dev/null 2>&1 && [ -z "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' fah-git-updater 2>/dev/null)" ]; then
    docker rm -f fah-git-updater >/dev/null 2>&1 || true
  fi
  docker images fah-git-updater --format '{{.Tag}}' | grep -vx lokal | while read -r t; do docker image rm "fah-git-updater:$t" >/dev/null 2>&1 || true; done || true
}
# Von Hand: Updater (neu) einrichten, ohne FAH-Git selbst anzufassen.
zeitplan() {
  ist_ersatz || fehler "Nur auf dem Fail-over-Ersatz (ROLLE=ersatz in der .env)"
  updater_abbild; altlast_updater
  compose up -d updater
  info "Updater läuft: Updates vom Haupt werden alle 2 Minuten geprüft und eingespielt (Log: auto-update.log)."
}

# Version der laufenden Instanz – über den Container gefragt (der Updater hat selbst kein Netz).
laufende_version() {
  local c
  c="$(compose ps -q "$DIENST" 2>/dev/null | head -n 1 || true)"
  [ -n "$c" ] || return 0
  docker exec "$c" wget -qO- -T 5 http://127.0.0.1:3300/api/gesundheit 2>/dev/null | grep -o '"version":"[0-9]*\.[0-9]*\.[0-9]*"' | grep -o '[0-9][0-9.]*' || true
}

version_abwarten() {
  local soll=$1 start=$SECONDS
  while [ $((SECONDS - start)) -lt "$WARTEN_MAX_S" ]; do
    [ "$(laufende_version)" = "$soll" ] && return 0
    sleep 3
  done
  return 1
}

# Ist Version $1 neuer als $2?
neuer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }

# Wegwerf-Container aus dem laufenden Abbild: ohne Netz, ohne Rechte, Wurzel nur lesend.
helfer() { docker run --rm --pull never --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 512m "$@"; }

# Ergebnis für die Oberfläche: im Container selbst geschrieben (dessen Verweise wirken nur dort), Text über stdin.
melden() {
  local ok=$1 version=$2 text=$3 c
  info "$(printf '%s' "$text" | tr -d '\000-\010\013-\037\177')"
  c="$(compose ps -q "$DIENST" 2>/dev/null | head -n 1 || true)"
  [ -n "$c" ] || return 0
  printf '%s' "$text" | docker exec -i -e OK="$ok" -e V="$version" "$c" node -e '
    const fs = require("fs"); let t = ""; process.stdin.on("data", (d) => { t += d; }).on("end", () => {
      const ziel = "/daten/_failover/paket/ergebnis.json";
      fs.mkdirSync("/daten/_failover/paket", { recursive: true });
      fs.writeFileSync(ziel + ".tmp", JSON.stringify({ ok: process.env.OK === "true", version: process.env.V, text: t.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300), zeit: new Date().toISOString() }));
      fs.renameSync(ziel + ".tmp", ziel); });' >/dev/null 2>&1 || true
}

# Programmstand aus einem Ordner übernehmen; liefert Fehler statt abzubrechen (für den Rückfall).
ordner_kopieren() {
  local q=$1 d
  [ -f "$q/manage.sh" ] && [ -d "$q/src" ] && [ -d "$q/public" ] || return 1
  rm -rf "$ROOT/.src.neu" "$ROOT/.public.neu"
  cp -a "$q/src" "$ROOT/.src.neu" || return 1
  cp -a "$q/public" "$ROOT/.public.neu" || return 1
  rm -rf "$ROOT/src" "$ROOT/public" || return 1
  mv "$ROOT/.src.neu" "$ROOT/src" && mv "$ROOT/.public.neu" "$ROOT/public" || return 1
  for d in manage.sh docker-compose.yml Dockerfile package.json README.md paket-manifest.txt paket-signatur; do
    if [ -f "$q/$d" ]; then cp -f "$q/$d" "$ROOT/$d" || return 1; fi
  done
  chmod 755 "$ROOT/manage.sh"
}

# Neues Abbild zuerst bauen, dann Dateien tauschen und starten; wird die neue Fassung nicht gesund: alles zurück.
einspielen_mit_rueckfall() {
  local quelle=$1 alt=$2 neu=$3 sicher d
  docker build -q -t "fah-git:$neu" "$quelle" >/dev/null || return 1
  sicher="$(mktemp -d "$ROOT/.vorher.XXXXXX")" || return 1
  cp -a "$ROOT/src" "$ROOT/public" "$sicher/" || { rm -rf "$sicher"; return 1; }
  for d in manage.sh docker-compose.yml Dockerfile package.json README.md paket-manifest.txt paket-signatur; do
    if [ -f "$ROOT/$d" ]; then cp -p "$ROOT/$d" "$sicher/$d" || { rm -rf "$sicher"; return 1; }; fi
  done
  # Nur den Dienst fah-git anfassen – der Updater führt dieses Skript gerade selbst aus.
  if ordner_kopieren "$quelle" && FAHGIT_VERSION="$neu" compose up -d --no-deps "$DIENST" && version_abwarten "$neu"; then
    rm -rf "$sicher"; return 0
  fi
  info "Neue Fassung $neu läuft nicht – zurück auf $alt."
  ordner_kopieren "$sicher" || true
  FAHGIT_VERSION="$alt" compose up -d --no-deps "$DIENST" || true
  version_abwarten "$alt" || true
  rm -rf "$sicher"
  return 1
}

auto_update() {
  local c img neu alt pub stage hash pruef
  ist_ersatz || return 0
  exec 9>"$ROOT/.update.lock"
  flock -n 9 || return 0
  c="$(compose ps -q "$DIENST" 2>/dev/null | head -n 1 || true)"
  [ -n "$c" ] || return 0
  neu="$(docker exec "$c" cat /daten/_failover/paket/bereit.json 2>/dev/null | grep -o '"version":"[0-9]*\.[0-9]*\.[0-9]*"' | head -n 1 | grep -o '[0-9][0-9.]*' || true)"
  [ -n "$neu" ] || return 0
  alt="$(laufende_version)"
  [ -n "$alt" ] || return 0
  neuer "$neu" "$alt" || return 0          # nur vorwärts; zurück geht es nur von Hand
  pub="$(head -n 1 "$ROOT/src/release-schluessel.txt" 2>/dev/null | tr -d '\r' || true)"
  if ! printf '%s' "$pub" | grep -qE '^[A-Za-z0-9+/]{40,120}={0,2}$'; then
    melden false "$neu" "Installierte Fassung kennt keinen Release-Schlüssel – einmal von Hand aktualisieren"; return 0
  fi
  img="$(docker inspect -f '{{.Image}}' "$c")"
  stage="$(mktemp -d "$ROOT/.update.XXXXXX")"
  chown 1000:1000 "$stage" 2>/dev/null || true   # der Kopier-Helfer läuft als 1000
  # 1. Kopie in einen Ordner, den nur dieser Rechner sieht (Verweise bleiben Verweise und fallen unten auf).
  if ! helfer -v "$ROOT/daten:/daten:ro" -v "$stage:/aus" --entrypoint cp "$img" -RP /daten/_failover/paket/aktuell/. /aus/ >/dev/null 2>&1; then
    rm -rf "$stage"; melden false "$neu" "Update-Paket ließ sich nicht übernehmen"; return 0
  fi
  if [ -n "$(find "$stage" ! -type f ! -type d -print -quit)" ]; then
    rm -rf "$stage"; melden false "$neu" "Update-Paket enthält Verweise oder Sonderdateien – abgelehnt"; return 0
  fi
  hash="$(sha256sum "$stage/manifest.txt" 2>/dev/null | cut -c1-64 || true)"
  if [ -n "$hash" ] && grep -qx "$hash" "$ROOT/.update-abgelehnt" 2>/dev/null; then rm -rf "$stage"; return 0; fi
  # 2. Prüfen: Unterschrift (Schlüssel der installierten Fassung), jede Datei, nichts zu viel.
  if ! pruef="$(helfer -v "$stage:/paket:ro" -v "$ROOT/src:/pruef:ro" --entrypoint node "$img" /pruef/paket.js pruefen /paket "$pub" "$neu" 2>&1)"; then
    [ -n "$hash" ] && printf '%s\n' "$hash" >>"$ROOT/.update-abgelehnt"
    rm -rf "$stage"; melden false "$neu" "Update auf $neu abgelehnt: $pruef"; return 0
  fi
  # 3. Einspielen: Manifest/Signatur mitnehmen (der neue Haupt-Teil braucht sie), Abbild bauen, tauschen, starten.
  cp "$stage/manifest.txt" "$stage/dateien/paket-manifest.txt" && cp "$stage/signatur" "$stage/dateien/paket-signatur"
  info "Automatisches Update vom Haupt: $alt → $neu"
  if einspielen_mit_rueckfall "$stage/dateien" "$alt" "$neu"; then
    melden true "$neu" "Update von $alt auf $neu eingespielt"
    ls -- "$ROOT"/fah-git*.zip >/dev/null 2>&1 && rm -f -- "$ROOT"/fah-git*.zip   # veraltete ZIPs nie wieder einspielen
    docker images fah-git --format '{{.Tag}}' | grep -vx -e "$neu" -e "$alt" -e lokal | while read -r t; do docker image rm "fah-git:$t" >/dev/null 2>&1 || true; done || true
  else
    [ -n "$hash" ] && printf '%s\n' "$hash" >>"$ROOT/.update-abgelehnt"
    melden false "$neu" "Update auf $neu ließ sich nicht starten – zurück auf $alt (Log: auto-update.log)"
  fi
  rm -rf "$stage"
}

case "${1:-}" in
  update)   update "${2:-}" ;;
  auto-update) auto_update ;;
  zeitplan) zeitplan ;;
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
