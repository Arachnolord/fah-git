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
//     Teilpfade (z. B. „lokale-stimme/“) sperren das Veröffentlichen.
//   - Öffentlich: eine ZIP (Inhalt geprüft) oder (1.13.0) eine andere Datei, z. B. eine Installer-ISO, NUR mit Prüfvermerk
//     des Bauskripts daneben (<datei>.pruefung.json mit Größe + SHA-256) – das Bauskript hat dort selbst bereinigt und
//     geprüft; FAH-Git rechnet die Prüfsumme vor dem Hochladen aus demselben Dateigriff nach.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

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
  // .env-Vorlagen dürfen mit (auch benannte wie .env.edeka.example, 1.15.3) – nur wenn der Name auf die Vorlagen-Endung
  // ENDET; .env, .env.production, .env.example.local bleiben gesperrt.
  /^\.env(?!(\.[^./]+)*\.(example|sample|dist|template|beispiel|vorlage|muster)$)(\..+)?$/i,
  /^\.env(rc|[~_-](?!(example|sample|dist|template|beispiel|vorlage|muster)$).*)$/i,   // .envrc, .env~, .env-prod, .env_local
  /^(\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(\.json)?)$/i,
  /^service[-_]?account.*\.json$/i,
  /\.(hex|key|p12|pfx|p8|jks|keystore|ppk|keychain|keychain-db)$/i,
  /^(?!(cacert|ca-bundle|ca-certificates)\.pem$).*\.pem$/i,      // Zertifikatsbündel (certifi) sind öffentlich
  /api\W*keys?|backup\W*codes?/i,
  /(^|[\W_])(passw(or)?(d|t)(e|er|oerter|örter)?s?|kennw(o|ö)rt(e|er)?|tokens?|secrets?|zugangsdaten)\.(txt|md|csv|json|ya?ml|ini|conf|cfg|env)$/i,
];
const INHALT_ARCHIV = /\.(zip|7z|rar|tar|tgz|gz|bz2|xz|dmg|iso)$/i;
const ZIP_VERZEICHNIS_MAX = 32 * 1024 * 1024;
export const VERMERK_ENDUNG = '.pruefung.json';
const ZIP_EINTRAEGE_MAX = 300000;
// Inhaltsprüfung beim Veröffentlichen (1.15.4): Einträge bis zu dieser Größe werden entpackt und als Text geprüft.
const ZIP_TEXT_MAX = 8 * 1024 * 1024;

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
  // Steuerzeichen (NUL, Zeilenumbruch …): Entpacker schneiden dort ab – „.env.local\0.example“ würde zu .env.local (Prüfung 1.15.3)
  if (/[\u0000-\u001f\u007f]/.test(n)) return 'Steuerzeichen im Namen';
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
      eintraege.push({ name: nameNorm(e.name), rel: r, ordner: false, groesse: st.size, zeit: st.mtime.toISOString(), gesperrt: this.gesperrt(r),
        vermerk: PRUEFBAR.test(e.name) ? null : await this.vermerkZustand(r, st.size) });
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
      return { rel: r, name, groesse: st.size, zeit: st.mtime.toISOString(), gesperrt: this.gesperrt(r), fehlt: false,
        vermerk: PRUEFBAR.test(name) ? null : await this.vermerkZustand(r, st.size) };
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
  async zipNamen(fh) { return (await this.zipEintraege(fh)).map((x) => x.name); }

  /** Wie zipNamen, aber je Eintrag mit Packart, Größen und Lage der Daten (für die Inhaltsprüfung, 1.15.4). */
  async zipEintraege(fh) {
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
      const flags = cd.readUInt16LE(o + 8); const methode = cd.readUInt16LE(o + 10);
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
      eintraege.push({ name: nameRoh.toString('utf8'), nameRoh, flags, methode, csize, usize, offset, zip64 });
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
      en.daten = pos + 30 + lnl + lel;
      pos += 30 + lnl + lel + en.csize;
      if (en.flags & 0x08) {                                                                       // Datenbeschreibung
        const sig = (await lies(4, pos)).readUInt32LE(0) === 0x08074b50 ? 4 : 0;
        pos += sig + (en.zip64 ? 20 : 12);
      }
      if (pos > cdStart) throw new AblageFehler('ZIP-Eintrag reicht ins Verzeichnis – nicht prüfbar', 409);
    }
    if (pos !== cdStart) throw new AblageFehler('ZIP enthält Daten außerhalb des Verzeichnisses – nicht prüfbar', 409);
    return eintraege.map(({ name, flags, methode, csize, usize, daten }) => ({ name, flags, methode, csize, usize, daten }));
  }

  /**
   * Text-Inhalte einer ZIP prüfen (1.15.4): jeder Eintrag bis ZIP_TEXT_MAX wird entpackt und – wenn er kein Binär ist –
   * mit `textPruefer(rel, text)` gegen die privaten Regeln des GitHub-Spiegels geprüft. Vorher prüfte das Veröffentlichen
   * einer ZIP nur die Namen; ein Quell-Kopfkommentar mit Wohnadresse ging so unbemerkt in ein öffentliches Release.
   * Was sich nicht lesen lässt (verschlüsselt, fremde Packart, kaputt), sperrt ebenfalls – ungeprüft geht nichts raus.
   */
  async zipTextFunde(fh, textPruefer) {
    const funde = [];
    const dazu = (t) => { if (funde.length < 8 && !funde.includes(t)) funde.push(t); };
    for (const e of await this.zipEintraege(fh)) {
      if (funde.length >= 8) break;
      const n = nameNorm(e.name);
      if (n.endsWith('/') || e.usize === 0) continue;
      if (e.flags & 0x01) { dazu(`${n} (verschlüsselt – nicht prüfbar)`); continue; }
      if (e.usize > ZIP_TEXT_MAX) continue;                                         // große Dateien sind Programme/Medien
      if (e.methode !== 0 && e.methode !== 8) { dazu(`${n} (unbekannte Packart – nicht prüfbar)`); continue; }
      if (e.csize > ZIP_TEXT_MAX + 1024 * 1024) { dazu(`${n} (Größenangaben unplausibel – nicht prüfbar)`); continue; }
      const roh = Buffer.alloc(e.csize);
      const { bytesRead } = await fh.read(roh, 0, e.csize, e.daten);
      if (bytesRead !== e.csize) { dazu(`${n} (unvollständig – nicht prüfbar)`); continue; }
      let buf;
      try { buf = e.methode === 0 ? roh : zlib.inflateRawSync(roh, { maxOutputLength: ZIP_TEXT_MAX }); } catch { dazu(`${n} (nicht entpackbar – nicht prüfbar)`); continue; }
      if (buf.subarray(0, 8192).includes(0)) continue;                              // Binär (wie bei der ISO)
      for (const t of textPruefer(n, buf.toString('utf8'))) dazu(`${n} (${t})`);
    }
    return funde;
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
  /** Prüfvermerk neben der Datei lesen (<rel>.pruefung.json) → {groesse, sha256, pruefungen} oder null. */
  async vermerkLesen(rel) {
    let fh;
    try {
      const r = this.rel(rel);
      const soll = await this.abs(`${r}${VERMERK_ENDUNG}`);
      fh = await fsp.open(soll, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const st = await fh.stat();
      if (!st.isFile() || st.size > 64 * 1024 || st.nlink > 1) return null;
      const b = Buffer.alloc(st.size);
      await fh.read(b, 0, st.size, 0);
      const d = JSON.parse(b.toString('utf8'));
      // Pflicht: Prüfsumme, Größe, Dateiname = diese Datei, Bauwerkzeug genannt
      if (!d || !/^[0-9a-f]{64}$/.test(String(d.sha256)) || !Number.isSafeInteger(d.groesse) || d.groesse <= 0) return null;
      if (String(d.datei || '') !== path.posix.basename(r) || !String(d.werkzeug || '').trim()) return null;
      return { groesse: d.groesse, sha256: d.sha256, werkzeug: String(d.werkzeug).slice(0, 200),
        pruefungen: Array.isArray(d.pruefungen) ? d.pruefungen.slice(0, 10).map((x) => String(x).slice(0, 200)) : [] };
    } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
  }

  /** Für die Anzeige: 'ok' (Vermerk da, Größe passt), 'abweichend' (Vermerk passt nicht) oder null (keiner). */
  async vermerkZustand(rel, groesse) {
    const v = await this.vermerkLesen(rel);
    return v ? (v.groesse === groesse ? 'ok' : 'abweichend') : null;
  }

  /** Nicht-ZIP vor dem Veröffentlichen: Vermerk muss da sein und Größe + SHA-256 (aus dem offenen Griff) stimmen. */
  async vermerkPruefen(f, fortschritt) {
    const v = await this.vermerkLesen(f.rel);
    if (!v) throw new AblageFehler('Diese Datei lässt sich nicht prüfen und hat keinen Prüfvermerk des Bauskripts – nicht veröffentlicht', 400);
    if (v.groesse !== f.groesse) throw new AblageFehler('Prüfvermerk passt nicht zur Datei (Größe) – die öffentliche Fassung neu bauen (Bauskript), nicht den Vermerk', 409);
    const h = crypto.createHash('sha256');
    let n = 0;
    for await (const teil of f.fh.createReadStream({ start: 0, end: f.groesse - 1, autoClose: false, highWaterMark: 1024 * 1024 })) {
      h.update(teil); n += teil.length; if (fortschritt) fortschritt(n);
    }
    if (h.digest('hex') !== v.sha256) throw new AblageFehler('Prüfvermerk passt nicht zur Datei (Prüfsumme) – die öffentliche Fassung neu bauen (Bauskript), nicht den Vermerk', 409);
    return v;
  }

  /**
   * ISO selbst prüfen (zusätzlich zum Vermerk – der beweist nur „unverändert“): alle Pfade (Schlüssel-Namen, je Projekt
   * Verbotenes), eigene Teile (/fahnas, /nocloud, GRUB-Menüs) als Text und darin liegende .tar.gz-Archive (entpackt: Namen +
   * Text). `textPruefer(rel, text)` liefert Funde (Texte) mit den privaten Regeln des GitHub-Spiegels.
   */
  async isoPruefen(f, { verboten = [], textPruefer = () => [] } = {}) {
    const regeln = verboten.map((v) => nameNorm(v).trim().toLowerCase()).filter(Boolean);
    const funde = [];
    const dazu = (t) => { if (funde.length < 8) funde.push(t); };
    const namePruefen = (n, pruefname = n) => {
      const g = inhaltGesperrt(pruefname, { archiv: false });
      if (g) return dazu(`${n} (${g})`);
      const v = regeln.find((x) => nameNorm(n).toLowerCase().includes(x));
      if (v) dazu(`${n} (für dieses Projekt verboten: ${v})`);
    };
    const textPruefen = (n, buf) => {
      if (buf.length > 2 * 1024 * 1024 || buf.subarray(0, 8192).includes(0)) return;
      for (const t of textPruefer(n, buf.toString('utf8'))) dazu(`${n} (${t})`);
    };
    const eintraege = await isoEintraege(f.fh, f.groesse);
    for (const e of eintraege) {
      namePruefen(e.pfad);
      const eigen = /^(fahnas|nocloud)\//i.test(e.pfad) || /^boot\/grub\/[^/]+\.cfg$/i.test(e.pfad);
      if (!eigen) continue;
      if (/\.(tar\.gz|tgz)$/i.test(e.pfad)) {
        if (e.groesse > 64 * 1024 * 1024) { dazu(`${e.pfad} (Archiv zu groß für die Prüfung)`); continue; }
        let tar;
        try { tar = zlib.gunzipSync(await isoLesen(f.fh, e), { maxOutputLength: 512 * 1024 * 1024 }); } catch { dazu(`${e.pfad} (Archiv nicht lesbar)`); continue; }
        // Name mit „/“ prüfen: mit „:“ wäre „app.tar.gz:.env“ ein einziger Dateiname und .env an der tar-Wurzel rutschte durch (1.15.3)
        for (const t of tarEintraege(tar)) { namePruefen(`${e.pfad}:${t.name}`, `${e.pfad}/${t.name}`); if (t.daten) textPruefen(`${e.pfad}:${t.name}`, t.daten); }
      } else if (e.groesse <= 2 * 1024 * 1024) textPruefen(e.pfad, await isoLesen(f.fh, e));
    }
    if (!eintraege.some((e) => /^fahnas\//i.test(e.pfad))) dazu('ISO ohne /fahnas – keine FAH-NAS-Installer-ISO?');
    return funde;
  }

  async oeffentlichPruefen(f, verboten = [], { textPruefer, fortschritt } = {}) {
    if (!PRUEFBAR.test(f.name)) {
      await this.vermerkPruefen(f, fortschritt);
      if (/\.iso$/i.test(f.name)) {
        const funde = await this.isoPruefen(f, { verboten, textPruefer });
        if (funde.length) throw new AblageFehler(`Nicht veröffentlicht – die ISO enthält: ${funde.join(' · ')}`, 409);
      }
      return;
    }
    const regeln = verboten.map((v) => nameNorm(v).trim().toLowerCase()).filter(Boolean);
    const funde = [];
    for (const roh of await this.zipNamen(f.fh)) {
      const n = nameNorm(roh); const klein = n.toLowerCase();
      const g = inhaltGesperrt(n);
      if (g) funde.push(`${n} (${g})`);
      else { const v = regeln.find((x) => klein.includes(x)); if (v) funde.push(`${n} (für dieses Projekt verboten: ${v})`); }
      if (funde.length >= 8) break;
    }
    if (!funde.length && textPruefer) funde.push(...await this.zipTextFunde(f.fh, textPruefer));
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

// --- ISO 9660 (mit Rock-Ridge-Namen) und tar lesen – nur so viel, wie die Prüfung braucht ---------------------------
const SEKTOR = 2048;
async function lesenAb(fh, laenge, pos) {
  const b = Buffer.alloc(laenge);
  const { bytesRead } = await fh.read(b, 0, laenge, pos);
  return b.subarray(0, bytesRead);
}
/** Dateien der ISO: [{pfad, lba, groesse}] (Ordner rekursiv, Rock-Ridge-Name wenn vorhanden, sonst ISO-Name ohne „;1“). */
export async function isoEintraege(fh, groesse) {
  const pvd = await lesenAb(fh, SEKTOR, 16 * SEKTOR);
  if (pvd.length < 190 || pvd[0] !== 1 || pvd.toString('latin1', 1, 6) !== 'CD001') throw new AblageFehler('Keine gültige ISO-Datei', 409);
  const aus = []; const besucht = new Set();
  const datensatz = (b, o) => {
    const len = b[o]; const nl = b[o + 32];
    const lba = b.readUInt32LE(o + 2); const size = b.readUInt32LE(o + 10); const ordner = (b[o + 25] & 2) !== 0;
    const roh = b.subarray(o + 33, o + 33 + nl);
    let name = roh.length === 1 && (roh[0] === 0 || roh[0] === 1) ? null : roh.toString('latin1').replace(/;\d+$/, '').replace(/\.$/, '');
    let su = o + 33 + nl + (nl % 2 === 0 ? 1 : 0); let rr = '';
    while (su + 4 <= o + len) {                                            // Rock Ridge „NM“ (alternativer Name)
      const sig = b.toString('latin1', su, su + 2); const l = b[su + 2];
      if (l < 4 || su + l > o + len) break;
      if (sig === 'NM') rr += b.toString('utf8', su + 5, su + l);
      su += l;
    }
    if (name !== null && rr) name = rr;
    return { len, lba, size, ordner, name };
  };
  async function ordnerLesen(lba, size, praefix, tiefe) {
    if (tiefe > 30 || besucht.has(lba) || aus.length > 300000) return;
    besucht.add(lba);
    if (size > 64 * 1024 * 1024 || (lba + 0) * SEKTOR + size > groesse) throw new AblageFehler('ISO-Verzeichnis unplausibel', 409);
    const b = await lesenAb(fh, size, lba * SEKTOR);
    for (let o = 0; o < b.length;) {
      if (b[o] === 0) { o = (Math.floor(o / SEKTOR) + 1) * SEKTOR; continue; }
      if (o + 34 > b.length || o + b[o] > b.length) break;
      const d = datensatz(b, o);
      o += d.len;
      if (d.name === null) continue;
      const pfad = praefix ? `${praefix}/${d.name}` : d.name;
      if (d.ordner) await ordnerLesen(d.lba, d.size, pfad, tiefe + 1);
      else aus.push({ pfad, lba: d.lba, groesse: d.size });
    }
  }
  const wurzel = datensatz(pvd, 156);
  await ordnerLesen(wurzel.lba, wurzel.size, '', 0);
  return aus;
}
export async function isoLesen(fh, e) { return lesenAb(fh, e.groesse, e.lba * SEKTOR); }

/** tar-Einträge (ustar, GNU-Langnamen, pax-Pfade): [{name, daten?}] – Daten nur für Dateien bis 2 MB. */
export function tarEintraege(buf) {
  const aus = []; let lang = null; let pax = null;
  for (let o = 0; o + 512 <= buf.length && aus.length < 200000;) {
    const kopf = buf.subarray(o, o + 512);
    if (kopf.every((x) => x === 0)) break;
    const feld = (a, l) => kopf.toString('utf8', a, a + l).replace(/\0.*$/s, '');
    const size = parseInt(feld(124, 12).trim() || '0', 8) || 0;
    const typ = String.fromCharCode(kopf[156] || 48);
    let name = feld(0, 100);
    if (kopf.toString('latin1', 257, 262) === 'ustar') { const pre = feld(345, 155); if (pre) name = `${pre}/${name}`; }
    const daten = buf.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (typ === 'L') { lang = daten.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (typ === 'x') { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(daten.toString('utf8')); pax = m ? m[1] : null; continue; }
    if (typ === 'g') continue;
    if (lang) { name = lang; lang = null; }
    if (pax) { name = pax; pax = null; }
    aus.push({ name: name.replace(/^\.\//, ''), daten: (typ === '0' || typ === '\0') && size <= 2 * 1024 * 1024 ? daten : null });
  }
  return aus;
}
