// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Release-Ablage (1.12.0): FAH-Git liest einen Ordner mit fertigen Release-Dateien (ZIP, ISO, PDF …) NUR LESEND –
// im Container unter /ablage (Compose: ${ABLAGE}:/ablage:ro). Je Projekt werden Dateien ausdrücklich zugeordnet; eine
// ZIP davon kann „öffentlich“ sein und geht per Knopf als GitHub-Release raus – ohne erneutes Hochladen.
// Schutz, weil dort auch Privates liegt (Pakete mit Schlüsseln, Notizen mit Zugangsdaten):
//   - nur Release-Dateien (Endung), keine versteckten Teile, keine Verweise (Symlinks) und keine harten Links im Pfad;
//     jede Datei wird EINMAL geöffnet (O_NOFOLLOW) und Prüfen, Herunterladen und Hochladen lesen aus diesem Griff
//   - Namen, die nach Schlüssel/Privatem klingen, sind GESPERRT: nicht zuordenbar, nicht herunterladbar, nie öffentlich
//   - ZIPs: Inhaltsverzeichnis UND lokale Dateiköpfe werden lückenlos abgeglichen (keine versteckten Einträge);
//     Schlüssel-/Zugangsdateien, .git-Ordner und verschachtelte Archive sperren die Zuordnung, je Projekt verbotene
//     Teilpfade (z. B. „lokale-stimme/“) sperren das Veröffentlichen. Öffentlich kann nur eine ZIP sein (nur die ist prüfbar).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const RELEASE_ENDUNG = /\.(zip|iso|dmg|pkg|tar\.gz|tgz|7z|pdf|apk|exe|msi|img)$/i;
export const PRUEFBAR = /\.(zip|apk|jar)$/i;
// Dateien/Ordner der Ablage, die nie zugeordnet werden dürfen (Sicherheitsprüfung 27.11.: auch „Nur-fuer-dich“, „privat“ …)
export const GESPERRT_NAME = new RegExp([
  'nicht\\W*(zum\\W*)?verteilen', 'do\\W*not\\W*distribute', '(^|[\\W_])privat', '(^|[\\W_])intern([\\W_]|$)', 'nur\\W*f(ue|ü)r',
  'geheim', 'secret', 'schl(ue|ü)ssel', 'zugangsdaten', 'credentials?', 'passw(or)?(d|t)(e|er|oerter|örter)?s?(?![a-zäöüß])',
  'kennw(o|ö)rt(e|er)?(?![a-zäöüß])', 'api\\W*keys?', '(^|[\\W_])keys?([\\W_]|$)', 'backup\\W*codes?', '(^|[\\W_])tokens?([\\W_]|$)',
  '\\.env(\\.|$)', '\\.(pem|key|hex|p12|pfx|p8|jks|keystore|ppk)$', 'id_(rsa|dsa|ecdsa|ed25519)',
].join('|'), 'i');
// Einträge IN einer ZIP
const INHALT_ORDNER = /^(schl(ue|ü)ssel|secrets?|credentials|zugangsdaten|\.ssh|\.aws|\.gnupg|\.git|\.docker)$/i;
const INHALT_DATEI = [
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.env(\.(?!(example|sample|dist|template|beispiel|vorlage|muster)$).+)?$/i,
  /^(\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(\.json)?)$/i,
  /^service[-_]?account.*\.json$/i,
  /\.(hex|key|p12|pfx|p8|jks|keystore|ppk|keychain|keychain-db)$/i,
  /^(?!(cacert|ca-bundle|ca-certificates)\.pem$).*\.pem$/i,      // Zertifikatsbündel (certifi) sind öffentlich
  /api\W*keys?|backup\W*codes?/i,
  /(^|[\W_])(passw(or)?(d|t)(e|er|oerter|örter)?s?|kennw(o|ö)rt(e|er)?|tokens?|secrets?|zugangsdaten)\.(txt|md|csv|json|ya?ml|ini|conf|cfg|env)$/i,
];
const INHALT_ARCHIV = /\.(zip|7z|rar|tar|tgz|gz|bz2|xz|dmg|iso)$/i;
const ZIP_VERZEICHNIS_MAX = 32 * 1024 * 1024;
const ZIP_EINTRAEGE_MAX = 300000;

export class AblageFehler extends Error {
  constructor(text, status = 400) { super(text); this.status = status; }
}

/** Name vereinheitlichen: Windows-Trenner → „/“, Umlaute in einer Schreibweise (NFC). */
export const nameNorm = (n) => String(n).replace(/\\/g, '/').normalize('NFC');

/**
 * Grund, warum ein Eintrag IN einer ZIP nicht raus darf (Schlüssel, Zugangsdaten, Verlauf) – oder null. `archiv`: auch
 * verschachtelte Archive sperren (nur fürs Veröffentlichen – Programme bringen oft harmlose .gz-Testdaten mit).
 */
export function inhaltGesperrt(roh, { archiv = true } = {}) {
  const n = nameNorm(roh);
  const teile = n.split('/').filter((t) => t && t !== '.');
  if (!teile.length) return null;
  const istOrdner = n.endsWith('/');
  for (const t of istOrdner ? teile : teile.slice(0, -1)) if (INHALT_ORDNER.test(t)) return 'Ordner mit Schlüsseln, Zugangsdaten oder Git-Verlauf';
  if (istOrdner) return null;
  const datei = teile.at(-1);
  if (INHALT_DATEI.some((r) => r.test(datei))) return 'Schlüssel- oder Zugangsdatei';
  if (archiv && INHALT_ARCHIV.test(datei)) return 'verschachteltes Archiv – Inhalt nicht prüfbar';
  return null;
}

export class Ablage {
  /** @param {string} wurzel Ordner der Ablage im Container (z. B. /ablage) */
  constructor(wurzel) { this.wurzel = wurzel; }

  async da() {
    try { return (await fsp.stat(this.wurzel)).isDirectory() && (await fsp.readdir(this.wurzel)).length > 0; } catch { return false; }
  }

  /** Relativen Pfad säubern: Schrägstriche, NFC, keine Punkte-Teile, keine versteckten Teile, nicht zu tief/lang. */
  rel(eingabe) {
    const roh = nameNorm(eingabe == null ? '' : eingabe);
    if (roh.length > 500 || roh.includes('\0')) throw new AblageFehler('Pfad zu lang oder ungültig');
    const teile = roh.split('/').filter((t) => t && t !== '.');
    if (teile.some((t) => t === '..' || t.startsWith('.'))) throw new AblageFehler('Pfad nicht erlaubt');
    if (teile.length > 12) throw new AblageFehler('Pfad zu tief');
    return teile.join('/');
  }

  /** Grund, warum eine Datei nie verwendet werden darf – oder null. */
  gesperrt(rel) {
    if (GESPERRT_NAME.test(nameNorm(rel))) return 'Name deutet auf Schlüssel oder Privates – gesperrt';
    if (!RELEASE_ENDUNG.test(rel)) return 'Keine Release-Datei (ZIP, ISO, DMG, PDF …)';
    return null;
  }

  async wurzelEcht() { return fsp.realpath(this.wurzel).catch(() => { throw new AblageFehler('Ablage nicht eingebunden', 404); }); }

  /** Absoluter Pfad – muss genau so in der Ablage liegen (kein Verweis irgendwo im Pfad). */
  async abs(rel) {
    const r = this.rel(rel);
    const wurzel = await this.wurzelEcht();
    const soll = r ? path.join(wurzel, r) : wurzel;
    const echt = await fsp.realpath(soll).catch(() => { throw new AblageFehler('Nicht in der Ablage gefunden', 404); });
    if (echt !== soll) throw new AblageFehler('Verweise (Symlinks) in der Ablage werden nicht verwendet', 400);
    return echt;
  }

  /** Inhalt eines Ordners zum Zuordnen: Unterordner + Release-Dateien (gesperrte mit Grund), ohne Verstecktes/Verweise. */
  async liste(ordner = '') {
    const rel = this.rel(ordner);
    const abs = await this.abs(rel);
    const eintraege = [];
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${nameNorm(e.name)}` : nameNorm(e.name);
      if (e.isDirectory()) { eintraege.push({ name: nameNorm(e.name), rel: r, ordner: true }); continue; }
      if (!e.isFile() || !RELEASE_ENDUNG.test(e.name)) continue;
      const st = await fsp.lstat(path.join(abs, e.name)).catch(() => null);
      if (!st) continue;
      eintraege.push({ name: nameNorm(e.name), rel: r, ordner: false, groesse: st.size, zeit: st.mtime.toISOString(), gesperrt: this.gesperrt(r) });
    }
    eintraege.sort((a, b) => (a.ordner === b.ordner ? a.name.localeCompare(b.name, 'de') : a.ordner ? -1 : 1));
    return { ordner: rel, eintraege };
  }

  /** Angaben zu einer zugeordneten Datei (fehlt: Datei ist aus der Ablage verschwunden). */
  async info(rel) {
    const r = this.rel(rel);
    const name = path.posix.basename(r);
    try {
      const st = await fsp.lstat(await this.abs(r));
      if (!st.isFile()) throw new Error('keine Datei');
      return { rel: r, name, groesse: st.size, zeit: st.mtime.toISOString(), gesperrt: this.gesperrt(r), fehlt: false };
    } catch { return { rel: r, name, groesse: null, zeit: null, gesperrt: this.gesperrt(r), fehlt: true }; }
  }

  /**
   * Datei EINMAL öffnen (ohne Verweis zu folgen) und prüfen, dass genau diese Datei offen ist. Alles Weitere liest aus
   * dem Griff – ein Tausch im NAS-Ordner zwischen Prüfen und Lesen greift so nicht. Aufrufer schließt `fh`.
   * @returns {Promise<{fh: import('node:fs/promises').FileHandle, groesse:number, zeit:Date, name:string, rel:string}>}
   */
  async oeffnen(rel) {
    const r = this.rel(rel);
    const grund = this.gesperrt(r);
    if (grund) throw new AblageFehler(grund, 403);
    const soll = await this.abs(r);
    let fh;
    try { fh = await fsp.open(soll, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch { throw new AblageFehler('Datei nicht lesbar', 404); }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new AblageFehler('Keine Datei', 400);
      if (st.nlink > 1) throw new AblageFehler('Harte Links in der Ablage werden nicht verwendet', 400);
      const offen = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);   // Linux: welcher Pfad ist WIRKLICH offen?
      if (offen !== null && offen !== soll) throw new AblageFehler('Datei wurde während des Öffnens ausgetauscht', 409);
      return { fh, groesse: st.size, zeit: st.mtime, name: path.posix.basename(r), rel: r };
    } catch (e) { await fh.close().catch(() => {}); throw e; }
  }

  /**
   * Einträge einer ZIP (auch ZIP64), ohne zu entpacken. Zentralverzeichnis vollständig (Anzahl + Länge stimmen) UND jeder
   * lokale Kopf passt dazu, lückenlos von 0 bis zum Verzeichnis – sonst könnten Einträge an der Prüfung vorbei stecken.
   */
  async zipNamen(fh) {
    const lies = async (laenge, pos) => {
      const b = Buffer.alloc(laenge);
      const { bytesRead } = await fh.read(b, 0, laenge, pos);
      if (bytesRead !== laenge) throw new AblageFehler('ZIP unvollständig', 409);
      return b;
    };
    const { size } = await fh.stat();
    if (size < 22) throw new AblageFehler('Keine gültige ZIP-Datei', 409);
    const n = Math.min(size, 65535 + 22);
    const b = await lies(n, size - n);
    let e = -1;
    for (let i = n - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new AblageFehler('Keine gültige ZIP-Datei', 409);
    let anzahl = b.readUInt16LE(e + 10); let cdGroesse = b.readUInt32LE(e + 12); let cdStart = b.readUInt32LE(e + 16);
    const gross = (v) => { if (v > BigInt(size)) throw new AblageFehler('ZIP-Angaben unplausibel', 409); return Number(v); };
    if (anzahl === 0xffff || cdGroesse === 0xffffffff || cdStart === 0xffffffff) {              // ZIP64
      const l = e - 20;
      if (l < 0 || b.readUInt32LE(l) !== 0x07064b50) throw new AblageFehler('ZIP64 ohne Verweis aufs Verzeichnis', 409);
      const z = await lies(56, gross(b.readBigUInt64LE(l + 8)));
      if (z.readUInt32LE(0) !== 0x06064b50) throw new AblageFehler('ZIP64-Verzeichnisende fehlt', 409);
      anzahl = gross(z.readBigUInt64LE(32)); cdGroesse = gross(z.readBigUInt64LE(40)); cdStart = gross(z.readBigUInt64LE(48));
    }
    if (anzahl > ZIP_EINTRAEGE_MAX) throw new AblageFehler('ZIP hat zu viele Einträge für die Prüfung', 409);
    if (cdGroesse > ZIP_VERZEICHNIS_MAX || cdStart + cdGroesse > size) throw new AblageFehler('ZIP-Verzeichnis unplausibel', 409);
    const cd = await lies(cdGroesse, cdStart);
    const eintraege = [];
    let o = 0;
    while (o < cd.length) {
      if (o + 46 > cd.length || cd.readUInt32LE(o) !== 0x02014b50) throw new AblageFehler('ZIP-Verzeichnis beschädigt', 409);
      const flags = cd.readUInt16LE(o + 8);
      let csize = cd.readUInt32LE(o + 20); let usize = cd.readUInt32LE(o + 24);
      const nl = cd.readUInt16LE(o + 28); const el = cd.readUInt16LE(o + 30); const kl = cd.readUInt16LE(o + 32);
      let offset = cd.readUInt32LE(o + 42);
      if (o + 46 + nl + el + kl > cd.length) throw new AblageFehler('ZIP-Verzeichnis beschädigt', 409);
      const nameRoh = cd.subarray(o + 46, o + 46 + nl);
      let zip64 = false;
      for (let x = o + 46 + nl; x + 4 <= o + 46 + nl + el;) {                                    // ZIP64-Zusatzfeld
        const id = cd.readUInt16LE(x); const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          zip64 = true; let p = x + 4; const ende = x + 4 + len;
          if (usize === 0xffffffff && p + 8 <= ende) { usize = gross(cd.readBigUInt64LE(p)); p += 8; }
          if (csize === 0xffffffff && p + 8 <= ende) { csize = gross(cd.readBigUInt64LE(p)); p += 8; }
          if (offset === 0xffffffff && p + 8 <= ende) { offset = gross(cd.readBigUInt64LE(p)); p += 8; }
        }
        x += 4 + len;
      }
      eintraege.push({ name: nameRoh.toString('utf8'), nameRoh, flags, csize, offset, zip64 });
      if (eintraege.length > anzahl) break;
      o += 46 + nl + el + kl;
    }
    if (eintraege.length !== anzahl || o !== cdGroesse) throw new AblageFehler('ZIP-Verzeichnis passt nicht zur angegebenen Anzahl – nicht prüfbar', 409);
    // Lokale Köpfe: lückenlos von 0 bis zum Verzeichnis, gleiche Namen
    let pos = 0;
    for (const en of [...eintraege].sort((a, c) => a.offset - c.offset)) {
      if (en.offset !== pos) throw new AblageFehler('ZIP enthält Daten außerhalb des Verzeichnisses – nicht prüfbar', 409);
      const k = await lies(30, pos);
      if (k.readUInt32LE(0) !== 0x04034b50) throw new AblageFehler('ZIP-Eintrag beschädigt', 409);
      const lnl = k.readUInt16LE(26); const lel = k.readUInt16LE(28);
      const lname = await lies(lnl, pos + 30);
      if (!lname.equals(en.nameRoh)) throw new AblageFehler('ZIP-Eintrag heißt im Kopf anders als im Verzeichnis – nicht prüfbar', 409);
      pos += 30 + lnl + lel + en.csize;
      if (en.flags & 0x08) {                                                                       // Datenbeschreibung
        const sig = (await lies(4, pos)).readUInt32LE(0) === 0x08074b50 ? 4 : 0;
        pos += sig + (en.zip64 ? 20 : 12);
      }
      if (pos > cdStart) throw new AblageFehler('ZIP-Eintrag reicht ins Verzeichnis – nicht prüfbar', 409);
    }
    if (pos !== cdStart) throw new AblageFehler('ZIP enthält Daten außerhalb des Verzeichnisses – nicht prüfbar', 409);
    return eintraege.map((x) => x.name);
  }

  /** Schlüssel/Zugangsdaten in einer ZIP suchen (für JEDE zugeordnete ZIP). → Liste der Funde (höchstens 8). */
  async schluesselFunde(fh) {
    const funde = [];
    for (const n of await this.zipNamen(fh)) {
      const g = inhaltGesperrt(n, { archiv: false });
      if (g) funde.push(`${nameNorm(n)} (${g})`);
      if (funde.length >= 8) break;
    }
    return funde;
  }

  /**
   * Vor dem Veröffentlichen: nur eine ZIP, keine Schlüssel und nichts für dieses Projekt Verbotenes darin.
   * @param {object} f geöffnete Datei aus oeffnen()
   * @param {string[]} verboten Teilpfade, die in der ZIP nicht vorkommen dürfen (je Projekt, z. B. „lokale-stimme/“)
   */
  async oeffentlichPruefen(f, verboten = []) {
    if (!PRUEFBAR.test(f.name)) throw new AblageFehler('Öffentlich kann nur eine ZIP sein – nur deren Inhalt lässt sich vorher prüfen', 400);
    const regeln = verboten.map((v) => nameNorm(v).trim().toLowerCase()).filter(Boolean);
    const funde = [];
    for (const roh of await this.zipNamen(f.fh)) {
      const n = nameNorm(roh); const klein = n.toLowerCase();
      const g = inhaltGesperrt(n);
      if (g) funde.push(`${n} (${g})`);
      else { const v = regeln.find((x) => klein.includes(x)); if (v) funde.push(`${n} (für dieses Projekt verboten: ${v})`); }
      if (funde.length >= 8) break;
    }
    if (funde.length) throw new AblageFehler(`Nicht veröffentlicht – die ZIP enthält: ${funde.join(' · ')}`, 409);
  }
}

/** Version aus dem Zeitpunkt der Datei: 2026.11.27-0928 (deutsche Zeit). */
export function versionAusZeit(zeit) {
  const t = Object.fromEntries(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(zeit)).map((p) => [p.type, p.value]));
  return `${t.year}.${t.month}.${t.day}-${t.hour}${t.minute}`;
}

/** Download-Kopf: ASCII-Ersatzname + UTF-8-Name, nie zwischenspeichern. */
export function downloadKopf(name, groesse) {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return { 'Content-Type': 'application/octet-stream', 'Content-Length': groesse,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };
}
