// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Öffentlicher Stand (1.9.0, Betreiber 20.11.2026: „die meisten [Projekte allen zur Verfügung stellen] … wäre super wenn fah-git
// das im spiegel dann selbst löst“). Baut aus dem aktuellen Stand eines Zweigs einen BEREINIGTEN Baum:
//   Weglassen  – Dateien nach Glob-Liste (echte .env, Schlüsseldateien, RouterOS-Exporte …)
//   Ersetzen   – Text oder `re:`-Muster (Wohnadresse im Kopf, Heimnetz, Domain …) – nur in Textdateien
//   Prüfen     – was danach noch nach Geheimnis aussieht oder einen verbotenen Begriff enthält, ist ein „Fund“ und sperrt
// Persönliche Angaben stehen NIE hier im Code, sondern in den Einstellungen (einstellungen.json → github.bereinigung).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { git, gitText, GIT_UMGEBUNG } from './git.js';

/** Vorgabe „Weglassen“: allgemeine Geheimnis-Dateien. `!` = Ausnahme (Vorlagen bleiben). */
export const WEGLASSEN_VORGABE = [
  '**/.env', '**/.env.*', '!**/*.example', '!**/*.beispiel', '!**/*.sample', '!**/*.vorlage', '!**/*.template',
  '**/*.pw', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.kdbx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*',
  '**/*.rsc', '**/users.json', '**/RustDesk*.toml', '**/.DS_Store',
  // Review 1.9.0: übliche Zugangs-/Daten-Dateien
  '**/.npmrc', '**/.pypirc', '**/.netrc', '**/.git-credentials', '**/.docker/config.json', '**/.kube/**', '**/kubeconfig*',
  '**/*.ovpn', '**/wg*.conf', '**/.ssh/**', '**/*.tfstate', '**/*.tfstate.*', '**/*.tfvars', '**/.htpasswd', '**/*.ppk', '**/*.jks',
  '**/*.keystore', '**/*.sqlite', '**/*.sqlite3', '**/*.db', '**/*.log',
];

const TEXT_MAX = 8 * 1024 * 1024;        // größere Textdateien lassen sich nicht sicher umschreiben → Fund „ungeprüft“
const LESEN_MAX = 25 * 1024 * 1024;      // größere Dateien werden nicht gelesen → Fund „ungeprüft“ (freigeben je Inhalt)
export const GROSS_MAX = 95 * 1024 * 1024; // GitHub nimmt nichts über 100 MB
const FUNDE_MAX = 300;

// --- Regeln ---------------------------------------------------------------------------------------------------------

/** Glob → RegExp. `**​/` = beliebig viele Ordner (auch keiner), `*` = innerhalb eines Ordners, `?` = ein Zeichen. */
export function globZuRegex(glob) {
  // Wie .gitignore: ohne „/“ gilt das Muster in jedem Ordner; ein führendes „/“ verankert im Hauptordner („/README.md“)
  const verankert = /^\s*\//.test(String(glob));
  let g = String(glob).trim().replace(/^\/+/, '');
  if (!verankert && !g.includes('/')) g = `**/${g}`;
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { if (g[i + 2] === '/') { r += '(?:.*/)?'; i += 2; } else { r += '.*'; i += 1; } }
    else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${r}$`, 'i');
}

/** Liste „Weglassen“ (Globs, `!` = Ausnahme; spätere Zeilen gewinnen wie bei .gitignore) → Prüffunktion. */
export function weglassenPruefer(liste) {
  const regeln = (liste || []).map((x) => String(x).trim()).filter((x) => x && !x.startsWith('#'))
    .map((x) => (x.startsWith('!') ? { aus: true, re: globZuRegex(x.slice(1)) } : { aus: false, re: globZuRegex(x) }));
  return (pfad) => {
    let weg = false;
    for (const r of regeln) if (r.re.test(pfad)) weg = !r.aus;
    return weg;
  };
}

// Verschachtelte Wiederholung wie (a+)+ oder (\w*)* kann eine RegExp minutenlang laufen lassen (Server stünde) → abweisen.
const GEFAEHRLICH = /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d*,?\d*\})/;

/** Ersetzen-Regeln prüfen und vorbereiten: [{suchen, durch}] – `suchen` mit Vorsatz „re:“ ist ein Muster (global). */
export function ersetzenVorbereiten(liste) {
  return (liste || []).filter((x) => x && String(x.suchen || '').trim()).map((x) => {
    const suchen = String(x.suchen);
    const durch = String(x.durch ?? '');
    if (suchen.startsWith('re:')) {
      const muster = suchen.slice(3);
      if (muster.length > 300) throw Object.assign(new Error('Muster zu lang (höchstens 300 Zeichen)'), { status: 400 });
      if (GEFAEHRLICH.test(muster)) throw Object.assign(new Error(`Muster „${muster}“ hat eine verschachtelte Wiederholung – bitte vereinfachen`), { status: 400 });
      let re;
      try { re = new RegExp(muster, 'g'); } catch (e) { throw Object.assign(new Error(`Ungültiges Muster „${muster}“: ${e.message}`), { status: 400 }); }
      if (re.test('')) throw Object.assign(new Error(`Muster „${muster}“ passt auf leeren Text`), { status: 400 });
      re.lastIndex = 0;
      return { re, durch, klartext: null };
    }
    // Klartext: ohne Rücksicht auf Groß-/Kleinschreibung (Beispiel.ORG = beispiel.org); „$“ im Ersatz bleibt wörtlich
    return { re: new RegExp(suchen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), durch: durch.replace(/\$/g, '$$$$'), klartext: suchen };
  });
}

/** Ersatz mit $&, $1…$99, $$ selbst einsetzen (für den Rückruf, der leere Treffer überspringt). */
function einsetzen(durch, treffer, gruppen) {
  return durch.replace(/\$(\$|&|\d{1,2})/g, (_, x) => (x === '$' ? '$' : x === '&' ? treffer : (gruppen[Number(x) - 1] ?? '')));
}

/** Einstellungen → geprüfte, gespeicherte Form (wirft bei Fehlern mit status 400). */
/** Liste „Nur diese Dateien“ prüfen (Globs, `!` = Ausnahme). */
export function nurPruefen(liste) {
  const l = (Array.isArray(liste) ? liste : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 100).map((x) => x.slice(0, 300));
  for (const w of l) globZuRegex(w.replace(/^!/, ''));
  return l;
}

export function bereinigungPruefen(b) {
  const ersetzen = (Array.isArray(b && b.ersetzen) ? b.ersetzen : []).slice(0, 200)
    .map((x) => ({ suchen: String((x && x.suchen) || '').slice(0, 500), durch: String((x && x.durch) ?? '').slice(0, 500) }))
    .filter((x) => x.suchen.trim());
  ersetzenVorbereiten(ersetzen);
  const liste = (v, max) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, 300));
  const verboten = liste(b && b.verboten, 200).filter((x) => x.length >= 3);
  const weglassen = b && Array.isArray(b.weglassen) ? liste(b.weglassen, 300) : [...WEGLASSEN_VORGABE];
  for (const w of weglassen) globZuRegex(w.replace(/^!/, ''));
  return { ersetzen, verboten, weglassen };
}

// --- Prüfen ---------------------------------------------------------------------------------------------------------

// Attrappen: bei Tokens großzügig (echte Tokens enthalten solche Wörter praktisch nie), bei Kennwörtern NUR klare Platzhalter –
// „Geheim2024!“ oder „Test1234!“ können echte Kennwörter sein (Review 1.9.0).
const ATTRAPPE = /(x{4,}|test|fake|dummy|beispiel|example|sample|abcd|0000|1234|aaaa|geheim|falsch|zzzz|1111|change|bitte|please|replace|ersetzen|todo|demo|aendern|ändern|platzhalter|placeholder|your|dein|<|\$\{|\{\{|\.\.\.|…|redacted|geschwärzt|\*\*\*)/i;
const PLATZHALTER = /(x{4,}|changeme|change[-_]?me|change[-_]?this|placeholder|platzhalter|beispiel|example|sample|dummy|fake|your[-_]|dein[-_]|bitte[-_]?(ae|ä)ndern|replace[-_]?me|<|\$\{|\{\{|\.\.\.|…|redacted|geschwärzt|\*\*\*)/i;
const vielfalt = (w) => new Set(w).size;
export function istAttrappe(wert, mindestVielfalt = 8) {
  return ATTRAPPE.test(wert) || vielfalt(wert) < mindestVielfalt;
}

const TEST_PFAD = /(^|\/)(tests?|spec|specs|__tests__|testdata|fixtures?|e2e)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$/i;
export const istTestPfad = (p) => TEST_PFAD.test(p);

const TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|fgit_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|sk_[0-9a-f]{40,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|\d{8,10}:AA[A-Za-z0-9_-]{33}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
// Jeder private Schlüssel mit Inhalt ist ein Fund – OHNE Attrappen-Prüfung (OpenSSH-Köpfe enthalten „AAAA“, Review 1.9.0)
const SCHLUESSEL = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----([\s\S]{0,16000}?)-----END \1PRIVATE KEY-----/g;
// Zugangsdaten in Adressen: https://nutzer:kennwort@server
const URL_ZUGANG = /\b[a-z][a-z0-9+.-]{1,15}:\/\/([^/\s:@'"`]{1,100}):([^/\s@'"`]{4,200})@[A-Za-z0-9.-]/gi;
// Zuweisung mit Anführungszeichen: password: "…", kennwort = '…', apiKey: "…"
const ZUWEISUNG = /\b([A-Za-z_]*(?:passwor[dt]|kennwort|passwd|secret|api_?key|apikey|access_?token|auth_?token|token|psk|passphrase)[A-Za-z_]*)["']?\s*[:=]\s*["']([^"'\s]{8,200})["']/gi;
// Zeilen wie in .env/.ini/.toml/RouterOS: PASSWORD=…, secret=…, password = '…'
// (auch YAML/Compose: „POSTGRES_PASSWORD: …“, „- X_PASSWORD=…“; WireGuard „PrivateKey = …“)
const ZEILE = /(^|[\s;])((?:[A-Za-z_-]*(?:PASS(?:WOR[DT])?|PASSWD|SECRET|TOKEN|API_?KEY|PSK|PASSPHRASE|PRE[-_]?SHARED[-_]?KEY|PRIVATE[-_]?KEY|AUTH|SALT|CREDENTIALS?)[A-Za-z_-]*))\s*[:=]\s*["']?([^\s"'#;]{8,200})/gim;

const KONFIG_DATEI = /(^|\/)\.env[^/]*$|\.(env|ini|cfg|conf|config|toml|properties|rsc|txt|sh|bash|zsh|ps1|bat|cmd|ya?ml|xml|service|plist)$|(^|\/)[^/.]+$/i;
/**
 * Sieht der Wert wie ein echtes Kennwort aus? Nein bei Pfaden/Adressen/Verweisen ($VAR, process.env…), Bezeichnern und Wörtern:
 * verlangt eine Ziffer oder mindestens drei Zeichenarten (klein/groß/Ziffer/Sonderzeichen).
 */
function wieKennwort(w) {
  if (PLATZHALTER.test(w) || vielfalt(w) < 6 || /^[./~$`(]/.test(w) || /:\/\//.test(w) || /[()[\]{}]/.test(w) || /^[A-Z0-9_]+$/.test(w)) return false;
  if (/^(process|os|env|config|settings|self|this|window|document)\./i.test(w) || /:$/.test(w)) return false;
  if (/^(true|false|none|null|undefined|yes|no|ja|nein)$/i.test(w)) return false;
  const arten = [/[a-zäöüß]/, /[A-ZÄÖÜ]/, /[0-9]/, /[^A-Za-z0-9äöüßÄÖÜ]/].filter((r) => r.test(w)).length;
  return /[0-9]/.test(w) ? arten >= 2 : arten >= 3 && !/^[A-Za-zÄÖÜäöüß]+([_ -][A-Za-zÄÖÜäöüß]+)+$/.test(w);
}

const zeileVon = (text, index) => { let n = 1; for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++; return n; };
const maske = (w) => `${w.slice(0, 2)}… (${w.length} Zeichen)`;
export const fingerabdruck = (datei, art, wert) => crypto.createHash('sha256').update(`${datei}\0${art}\0${wert}`).digest('hex').slice(0, 16);

/**
 * Text prüfen → Funde [{datei, zeile, art, text, auszug, fp}]. In Testdateien zählen nur harte Treffer (Schlüssel mit Inhalt,
 * echt aussehende Tokens) – dort stehen Test-Kennwörter mit Absicht.
 */
export function textPruefen(text, datei, verboten = []) {
  const funde = [];
  const dazu = (art, beschreibung, wert, index) => funde.push({ datei, zeile: zeileVon(text, index), art, text: beschreibung, auszug: maske(wert), fp: fingerabdruck(datei, art, wert) });
  for (const m of text.matchAll(SCHLUESSEL)) {
    const inhalt = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
    // Fingerabdruck über den GANZEN Inhalt – sonst gäbe eine Freigabe jeden Schlüssel gleichen Typs frei
    if (inhalt.length >= 40) funde.push({ datei, zeile: zeileVon(text, m.index), art: 'schluessel', text: `Privater Schlüssel (${(m[1] || '').trim() || 'PKCS8'})`, auszug: `${inhalt.length} Zeichen`, fp: fingerabdruck(datei, 'schluessel', inhalt) });
  }
  for (const m of text.matchAll(TOKEN)) {
    if (!istAttrappe(m[1], 12)) dazu('token', 'Zugangs-Token', m[1], m.index);
  }
  if (!istTestPfad(datei)) {
    for (const m of text.matchAll(URL_ZUGANG)) {
      if (!wieKennwort(m[2])) continue;
      dazu('kennwort', `Zugangsdaten in einer Adresse (${m[1]}:…@)`, m[2], m.index);
    }
    for (const m of text.matchAll(ZUWEISUNG)) {
      const w = m[2];
      if (!wieKennwort(w)) continue;
      dazu('kennwort', `Kennwort/Schlüssel in „${m[1]}“`, w, m.index);
    }
    // Zeilen ohne Anführungszeichen nur in Konfigurations-/Skriptdateien – im Programmcode wäre das „passwort = eingabe.value“
    for (const m of KONFIG_DATEI.test(datei) ? text.matchAll(ZEILE) : []) {
      const w = m[3];
      if (!wieKennwort(w)) continue;
      dazu('kennwort', `Kennwort/Schlüssel in „${m[2]}“`, w, m.index + m[1].length);
    }
  }
  const klein = text.toLowerCase();
  for (const b of verboten) {
    const such = b.toLowerCase();
    for (let i = klein.indexOf(such), n = 0; i >= 0 && n < 50; i = klein.indexOf(such, i + such.length), n++) {
      // Fingerabdruck mit Zeileninhalt: eine Freigabe gilt nur für genau diese Stelle, nicht für künftige
      const anfang = text.lastIndexOf('\n', i) + 1; const ende = text.indexOf('\n', i);
      const zeile = text.slice(anfang, ende < 0 ? undefined : ende).trim();
      funde.push({ datei, zeile: zeileVon(text, i), art: 'privat', text: `Verbotener Begriff „${b}“`, auszug: b, fp: fingerabdruck(datei, 'privat', `${such}\0${zeile}`) });
    }
  }
  // je Zeile und Art nur einmal
  const gesehen = new Set();
  return funde.filter((f) => { const k = `${f.zeile}\0${f.art}\0${f.fp}`; if (gesehen.has(k)) return false; gesehen.add(k); return true; });
}

/**
 * Binärdatei auf verbotene Begriffe prüfen (ohne Umschreiben – Binärdateien bleiben unverändert oder fallen weg).
 * Sucht als latin1 (ohne Groß/klein), als UTF-8- und als UTF-16-Bytes. Fingerabdruck je Inhalt (Blob-SHA).
 */
export function binaerPruefen(buf, datei, verboten = [], sha = '') {
  if (!verboten.length) return [];
  const latin = buf.toString('latin1').toLowerCase();
  return verboten.filter((b) => latin.includes(b.toLowerCase()) || buf.includes(Buffer.from(b, 'utf8')) || buf.includes(Buffer.from(b, 'utf16le')))
    .map((b) => ({ datei, zeile: 0, art: 'privat', text: `Verbotener Begriff „${b}“ in einer Binärdatei (lässt sich nicht ersetzen)`, auszug: b, fp: fingerabdruck(datei, 'privat', `${b.toLowerCase()}\0${sha}`) }));
}

/** Text ersetzen; UTF-8, wenn die Datei sauber UTF-8 ist, sonst byte-treu über latin1. Leere Treffer werden übersprungen. */
export function textErsetzen(buf, regeln) {
  let kodierung = 'utf8';
  let text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) { kodierung = 'latin1'; text = buf.toString('latin1'); }
  let anzahl = 0;
  for (const r of regeln) {
    r.re.lastIndex = 0;
    if (!r.re.test(text)) continue;
    r.re.lastIndex = 0;
    text = text.replace(r.re, (...a) => {
      const treffer = a[0];
      if (!treffer) return '';                        // \b, (?=…) usw.: nichts einfügen
      anzahl++;
      const gruppen = a.slice(1, a.findIndex((x, i) => i > 0 && typeof x === 'number'));
      return r.klartext != null ? r.durch.replace(/\$\$/g, '$') : einsetzen(r.durch, treffer, gruppen);
    });
  }
  return { text, anzahl, kodierung };
}

const istBinaer = (buf) => buf.subarray(0, 8000).includes(0);
const istUtf16le = (buf) => buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
// Dateien, in denen Text versteckt sein kann, den FAH-Git nicht lesen/ersetzen kann (Archive, Office, PDF, Datenbanken, Fotos mit EXIF)
function unpruefbar(buf, pfad) {
  const kopf = buf.subarray(0, 16);
  if (kopf.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'latin1'))) return 'Archiv/Office-Datei (ZIP-Format)';
  if (kopf.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  if (kopf.subarray(0, 15).toString('latin1') === 'SQLite format 3') return 'Datenbank';
  if (kopf[0] === 0x1f && kopf[1] === 0x8b) return 'gepacktes Archiv (gzip)';
  if (kopf.subarray(0, 6).toString('latin1') === '7z\xbc\xaf\x27\x1c' || kopf.subarray(0, 4).toString('latin1') === 'Rar!') return 'Archiv';
  if (/\.(jpe?g|tiff?|heic|heif|dng|cr2|nef|arw)$/i.test(pfad) && buf.subarray(0, 65536).includes(Buffer.from('Exif\0\0', 'latin1'))) return 'Foto mit EXIF-Daten (Ort/Kamera möglich)';
  return null;
}

// --- Git: Blobs lesen, Schnappschuss bauen ----------------------------------------------------------------------------

/** Blobs per `git cat-file --batch` als Strom lesen; ruft beiBlob(sha, Buffer) für jeden Blob in Reihenfolge auf. */
export function blobsLesen(repo, shas, beiBlob) {
  return new Promise((resolve, reject) => {
    if (!shas.length) return resolve();
    const kind = spawn('git', ['cat-file', '--batch'], { cwd: repo, env: { ...process.env, ...GIT_UMGEBUNG }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stuecke = []; let laenge = 0; let kopf = null; let fehler = null; let stderr = '';
    const zusammen = () => { const b = stuecke.length === 1 ? stuecke[0] : Buffer.concat(stuecke, laenge); stuecke = [b]; return b; };
    kind.stdout.on('data', (d) => {
      stuecke.push(d); laenge += d.length;
      for (;;) {
        if (fehler) return;
        if (!kopf) {
          const b = zusammen();
          const nl = b.indexOf(10);
          if (nl < 0) return;
          const t = b.subarray(0, nl).toString('utf8').split(' ');
          const rest = b.subarray(nl + 1); stuecke = [rest]; laenge = rest.length;
          if (t[1] === 'missing') continue;
          kopf = { sha: t[0], groesse: Number(t[2]) };
        }
        if (laenge < kopf.groesse + 1) return;
        const b = zusammen();
        const inhalt = Buffer.from(b.subarray(0, kopf.groesse));
        const rest = b.subarray(kopf.groesse + 1); stuecke = [rest]; laenge = rest.length;
        try { beiBlob(kopf.sha, inhalt); } catch (e) { fehler = e; kind.kill('SIGKILL'); return; }
        kopf = null;
      }
    });
    kind.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    kind.on('error', reject);
    kind.on('close', (code) => (fehler ? reject(fehler) : code === 0 ? resolve() : reject(new Error(`git cat-file: ${stderr.trim() || code}`))));
    kind.stdin.on('error', () => {});
    kind.stdin.end(shas.join('\n') + '\n');
  });
}

/**
 * Bereinigten Stand eines Commits bauen.
 * @param {string} repo nacktes Repo
 * @param {string} commit Quell-Commit (Zweigspitze)
 * @param {object} o {bereinigung, weglassenExtra: string[], nur: string[] (leer = alle Dateien; sonst nur passende, z. B. die fertige
 *   Mac-App), freigaben: [{datei, fp}], schreiben: boolean}
 * @returns {Promise<{baum: string|null, bericht: {dateien, ersetzt: [{datei, anzahl}], weggelassen: string[], funde: object[], funde_gesamt: number}}>}
 *   baum = SHA des bereinigten Baums (nur mit schreiben:true und ohne offene Funde)
 */
export async function standBauen(repo, commit, { bereinigung, weglassenExtra = [], nur = [], freigaben = [], schreiben = true } = {}) {
  const b = bereinigung || { ersetzen: [], verboten: [], weglassen: WEGLASSEN_VORGABE };
  const regeln = ersetzenVorbereiten(b.ersetzen);
  // Klartext-Suchbegriffe aus „Ersetzen“ gelten zusätzlich als verboten (z. B. in Binärdateien, die nicht ersetzt werden können)
  const verboten = [...new Set([...(b.verboten || []), ...regeln.filter((r) => r.klartext && r.klartext.trim().length >= 4).map((r) => r.klartext.trim())])];
  const weg = weglassenPruefer(b.weglassen || WEGLASSEN_VORGABE);
  const extra = new Set(weglassenExtra);
  const gewaehlt = nur && nur.length ? weglassenPruefer(nur) : null;   // gleiche Glob-Regeln, hier als „nur diese“
  const frei = new Set(freigaben.map((f) => `${f.datei}\0${f.fp}`));

  const ls = (await git(['ls-tree', '-r', '-z', '-l', '--full-tree', commit], { cwd: repo, ausgabeMax: 256 * 1024 * 1024 })).stdout.toString('utf8');
  const eintraege = [];
  for (const z of ls.split('\0')) {
    if (!z) continue;
    const tab = z.indexOf('\t');
    const [modus, art, sha, groesse] = z.slice(0, tab).trim().split(/\s+/);
    eintraege.push({ modus, art, sha, groesse: groesse === '-' ? 0 : Number(groesse), pfad: z.slice(tab + 1) });
  }
  const bericht = { dateien: 0, ersetzt: [], weggelassen: [], funde: [], funde_gesamt: 0, nicht_gewaehlt: 0 };
  const behalten = [];
  for (const e of eintraege) {
    if (gewaehlt && !gewaehlt(e.pfad)) { bericht.nicht_gewaehlt++; continue; }
    if (e.art !== 'blob') { behalten.push(e); continue; }          // Untermodule bleiben als Verweis
    if (extra.has(e.pfad) || weg(e.pfad)) { bericht.weggelassen.push(e.pfad); continue; }
    behalten.push(e);
  }
  const fund = (f) => { if (frei.has(`${f.datei}\0${f.fp}`)) return; bericht.funde_gesamt++; if (bericht.funde.length < FUNDE_MAX) bericht.funde.push(f); };
  for (const e of behalten) {
    if (e.art !== 'blob') continue;
    if (e.groesse > GROSS_MAX) fund({ datei: e.pfad, zeile: 0, art: 'gross', text: `Datei zu groß für GitHub (${Math.round(e.groesse / 1048576)} MB)`, auszug: '', fp: fingerabdruck(e.pfad, 'gross', e.sha) });
    else if (e.groesse > LESEN_MAX) fund({ datei: e.pfad, zeile: 0, art: 'ungeprueft', text: `Zu groß zum Prüfen (${Math.round(e.groesse / 1048576)} MB) – weglassen oder nach eigener Sichtung freigeben`, auszug: '', fp: fingerabdruck(e.pfad, 'ungeprueft', e.sha) });
  }

  // Inhalte lesen (Symlinks sind Blobs mit Modus 120000 – ihr Ziel wird wie Text behandelt)
  const lesen = behalten.filter((e) => e.art === 'blob' && e.groesse <= LESEN_MAX);
  const nachSha = new Map();
  for (const e of lesen) { if (!nachSha.has(e.sha)) nachSha.set(e.sha, []); nachSha.get(e.sha).push(e); }
  const tmp = schreiben ? await fs.mkdtemp(path.join(os.tmpdir(), 'fahgit-stand-')) : null;
  const neu = [];   // {e, datei: tmpPfad}
  try {
    let nr = 0;
    await blobsLesen(repo, [...nachSha.keys()], (sha, buf) => {
      for (const e of nachSha.get(sha) || []) {
        bericht.dateien++;
        const ungeprueft = (grund) => fund({ datei: e.pfad, zeile: 0, art: 'ungeprueft', text: `${grund} – Inhalt nicht prüfbar: weglassen oder nach eigener Sichtung freigeben`, auszug: '', fp: fingerabdruck(e.pfad, 'ungeprueft', sha) });
        if (e.modus === '120000') { for (const f of textPruefen(buf.toString('utf8'), e.pfad, verboten)) fund(f); continue; }   // Symlink-Ziel nur prüfen
        if (istUtf16le(buf)) {
          // UTF-16 (z. B. Windows-.reg/.ps1): als Text behandeln und so wieder schreiben
          const { text, anzahl } = textErsetzen(Buffer.from(buf.subarray(2).toString('utf16le'), 'utf8'), regeln);
          for (const f of textPruefen(text, e.pfad, verboten)) fund(f);
          if (anzahl) {
            bericht.ersetzt.push({ datei: e.pfad, anzahl });
            if (tmp) { const d = path.join(tmp, String(nr++)); writeFileSync(d, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])); neu.push({ e, datei: d }); }
          }
          continue;
        }
        if (istBinaer(buf)) {
          for (const f of binaerPruefen(buf, e.pfad, verboten, sha)) fund(f);
          const grund = unpruefbar(buf, e.pfad);
          if (grund) ungeprueft(grund);
          continue;
        }
        if (buf.length > TEXT_MAX) { for (const f of binaerPruefen(buf, e.pfad, verboten, sha)) fund(f); ungeprueft(`Textdatei über ${TEXT_MAX / 1048576} MB`); continue; }
        const { text, anzahl, kodierung } = textErsetzen(buf, regeln);
        for (const f of textPruefen(text, e.pfad, verboten)) fund(f);
        if (anzahl) {
          bericht.ersetzt.push({ datei: e.pfad, anzahl });
          if (tmp) { const d = path.join(tmp, String(nr++)); writeFileSync(d, Buffer.from(text, kodierung)); neu.push({ e, datei: d }); }
        }
      }
    });
    if (!schreiben || bericht.funde_gesamt) return { baum: null, bericht };

    // Geänderte Inhalte als Blobs ablegen (ein Aufruf), dann Baum über einen Zwischen-Index
    if (neu.length) {
      const shas = (await gitText(['hash-object', '-w', '--stdin-paths', '--no-filters'], { cwd: repo, eingabe: neu.map((x) => x.datei).join('\n') + '\n' })).trim().split('\n');
      neu.forEach((x, i) => { x.e.sha = shas[i]; });
    }
    const index = path.join(tmp, 'index');
    const mitIndex = { GIT_INDEX_FILE: index };
    await git(['read-tree', '--empty'], { cwd: repo, env: mitIndex });
    const zeilen = behalten.map((e) => `${e.modus} ${e.sha}\t${e.pfad}`).join('\0');
    if (zeilen) await git(['update-index', '--add', '-z', '--index-info'], { cwd: repo, env: mitIndex, eingabe: zeilen + '\0' });
    const baum = (await gitText(['write-tree'], { cwd: repo, env: mitIndex })).trim();
    return { baum, bericht };
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Commit für den öffentlichen Stand: Eltern = letzter veröffentlichter Stand (eigene Kette), Autor = GitHub-noreply.
 * Liefert {commit, gleich} – gleich=true, wenn der Baum dem letzten Stand entspricht (dann kein neuer Commit).
 */
export async function standCommit(repo, { baum, eltern, autor, quelle }) {
  if (eltern) {
    const alt = (await gitText(['rev-parse', `${eltern}^{tree}`], { cwd: repo }).catch(() => '')).trim();
    if (alt === baum) return { commit: eltern, gleich: true };
  }
  const jetzt = new Date();
  const datum = jetzt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const zeit = `${Math.floor(jetzt.getTime() / 1000)} +0000`;   // UTC: verrät keine Zeitzone
  const env = { GIT_AUTHOR_NAME: autor.name, GIT_AUTHOR_EMAIL: autor.mail, GIT_COMMITTER_NAME: autor.name, GIT_COMMITTER_EMAIL: autor.mail, GIT_AUTHOR_DATE: zeit, GIT_COMMITTER_DATE: zeit };
  const commit = (await gitText(['commit-tree', baum, ...(eltern ? ['-p', eltern] : []), '-m', `Stand vom ${datum} (FAH-Git ${String(quelle).slice(0, 10)})`], { cwd: repo, env })).trim();
  return { commit, gleich: false };
}
