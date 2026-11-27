// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fail-over (1.14.0): Eine zweite FAH-Git-Instanz (der Ersatz) hält sich laufend auf dem Stand des Haupts.
//
// Haupt: Ein Admin erzeugt einen Kopplungscode; in einstellungen.json liegt nur dessen SHA-256. Er dient als HMAC-Schlüssel:
// Jede Anfrage des Ersatzes trägt eine Unterschrift (Zeit, Einmalwert, Methode, Weg, Bericht), der Code geht nie über das
// Netz. Wer einstellungen.json besitzt (z. B. aus einer Sicherung), kann den Stand ebenfalls abrufen – wie mit der
// Sicherung selbst. Antworten sind mit AES-256-GCM verschlüsselt und an den Einmalwert gebunden (keine alten Antworten
// unterschiebbar). Für git gibt der Haupt kurzlebige Nur-Lese-Zugänge aus (nur im Speicher, 15 Minuten, nur für die
// Adresse, von der die unterschriebene Anfrage kam).
//
// Ersatz: fragt alle 15 Sekunden den Stand ab – je Repo ein Fingerabdruck aus dem Inhalt aller Refs und HEAD (ohne git zu
// starten), über die Zustandsdateien aus Größe + Zeit. Geholt wird nur, was sich geändert hat: Repos per `git fetch` (alle
// Refs, mit Löschen) und danach gegen den Fingerabdruck geprüft; Konten/Ordner/Einstellungen/Aktivität/Profilbilder/
// geheim.key als Dateien. Was es am Haupt nicht mehr gibt, wandert 7 Tage in _failover/papierkorb. Liest der Haupt etwas
// nicht, antwortet er mit Fehler statt mit einer Teilliste – der Ersatz löscht dann nichts.
// Der Ersatz nimmt keine Änderungen an (423), leitet nichts weiter und sichert nicht. Fällt der Haupt aus, kann ein
// Admin den Ersatz auf Knopfdruck zum Haupt machen („übernehmen“, gemerkt in _failover/rolle.json).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, gitText } from './git.js';
import { SEGMENT } from './baum.js';

export const ORDNER = '_failover';
const CODE_PRAEFIX = 'fgfo_';
const GIT_NAME = 'fail-over';
const TAKT_MS = 15_000;
const TAKT_FEHLER_MS = 60_000;
const AKTUELL_MS = 2 * 60_000;
const VOLL_MS = 6 * 3600_000;
const ZEITFENSTER_MS = 120_000;
const GIT_GUELTIG_MS = 15 * 60_000;
const GIT_ERNEUERN_MS = 5 * 60_000;
const DATEIEN_MAX = 16 * 1024 * 1024;
const ANTWORT_MAX = 64 * 1024 * 1024;
const PAPIERKORB_TAGE = 7;
const ABWEICHUNG_MELDEN = 3;
const ZUSTAND_NAME = /^[a-z0-9][a-z0-9._-]{0,99}\.json$/i;
const BILD_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
/** Ohne diese Dateien ist eine Instanz unbrauchbar – der Ersatz löscht sie nie und nimmt keine Liste ohne sie an. */
const PFLICHT = ['nutzer.json'];
const NIE_LOESCHEN = new Set([...PFLICHT, 'meta.json', 'einstellungen.json', 'geheim.key']);
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export class FailoverFehler extends Error {
  constructor(text, status = 400) { super(text); this.status = status; }
}

const sha256 = (t) => crypto.createHash('sha256').update(t).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
const fehlt = (e) => e && e.code === 'ENOENT';

/** Gültiger Standardzweig wie bei `git check-ref-format` (vereinfacht; git prüft beim Setzen noch einmal selbst). */
export function headGueltig(ref) {
  const r = String(ref || '');
  if (!r.startsWith('refs/heads/') || r.length > 250 || r.endsWith('/') || r.endsWith('.')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(r) || r.includes('..') || r.includes('@{') || r.includes('//')) return false;
  return r.split('/').every((s) => s && !s.startsWith('.') && !s.endsWith('.lock'));
}

/** Unterschrift einer Ersatz-Anfrage. Alles, was der Haupt auswertet, ist darin enthalten. */
export function unterschrift(schluessel, zeit, einmal, methode, weg, bericht = '') {
  return crypto.createHmac('sha256', schluessel).update([zeit, einmal, methode.toUpperCase(), weg, bericht].join('\n')).digest('base64url');
}

function antwortSchluessel(schluessel) {
  return Buffer.from(crypto.hkdfSync('sha256', schluessel, 'fah-git-failover', 'antwort', 32));
}

/** Antwort verschlüsseln, gebunden an den Einmalwert der Anfrage. */
export function verpacken(schluessel, einmal, wert) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', antwortSchluessel(schluessel), iv);
  c.setAAD(Buffer.from(einmal));
  const daten = Buffer.concat([c.update(JSON.stringify(wert), 'utf8'), c.final()]);
  return { v: 1, iv: b64u(iv), tag: b64u(c.getAuthTag()), daten: b64u(daten) };
}

export function entpacken(schluessel, einmal, paket) {
  if (!paket || paket.v !== 1) throw new FailoverFehler('Antwort des Haupts hat ein unbekanntes Format', 502);
  const d = crypto.createDecipheriv('aes-256-gcm', antwortSchluessel(schluessel), Buffer.from(paket.iv, 'base64url'));
  d.setAAD(Buffer.from(einmal));
  d.setAuthTag(Buffer.from(paket.tag, 'base64url'));
  try {
    return JSON.parse(Buffer.concat([d.update(Buffer.from(paket.daten, 'base64url')), d.final()]).toString('utf8'));
  } catch { throw new FailoverFehler('Antwort des Haupts ließ sich nicht entschlüsseln – Kopplungscode stimmt nicht', 502); }
}

function gleich(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Projekt- oder Ordnerpfad aus dem Netz prüfen: nur bekannte Segmente, kein „..“, nichts Verstecktes. */
export function pfadGueltig(pfad) {
  const t = String(pfad || '').split('/');
  return t.length >= 1 && t.length <= 10 && t.every((s) => SEGMENT.test(s) && !s.endsWith('.git'));
}

/**
 * Rolle beim Start: übernommen (rolle.json) schlägt die Vorgabe aus der Umgebung (FAHGIT_ROLLE=ersatz). Ist rolle.json da,
 * aber nicht lesbar, gilt sie trotzdem als „übernommen“ – lieber einmal zu viel Haupt als still wieder nur lesend.
 */
export function rolleLesen(daten, env = process.env) {
  const vorgabe = String(env.FAHGIT_ROLLE || '').trim().toLowerCase() === 'ersatz' ? 'ersatz' : 'haupt';
  const datei = path.join(daten, ORDNER, 'rolle.json');
  let inhalt = null; let da = false;
  try { da = fs.existsSync(datei); inhalt = JSON.parse(fs.readFileSync(datei, 'utf8')); } catch { /* fehlt oder kaputt */ }
  const rolle = da && (!inhalt || inhalt.rolle === 'haupt') ? 'haupt' : vorgabe;
  return { rolle, vorgabe, uebernommen: vorgabe === 'ersatz' && rolle === 'haupt', seit: inhalt ? inhalt.seit : null };
}

/**
 * Reste eines abgebrochenen Abgleichs wegräumen (beim Start, bevor git läuft): halbe Neuzugänge `.failover-neu-*` und
 * verwaiste Sperrdateien in den Repos (ein beim Beenden abgeschossenes `git fetch` hinterlässt sie, danach scheitern Pushes).
 */
export function aufraeumen(wurzel) {
  const sperren = (repo) => {
    for (const n of ['HEAD.lock', 'packed-refs.lock', 'config.lock', 'shallow.lock']) fs.rmSync(path.join(repo, n), { force: true });
    const geh = (d) => {
      let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of e) {
        if (x.isDirectory()) geh(path.join(d, x.name));
        else if (x.name.endsWith('.lock')) fs.rmSync(path.join(d, x.name), { force: true });
      }
    };
    geh(path.join(repo, 'refs'));
  };
  const geh = (d, tiefe) => {
    if (tiefe > 11) return;
    let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      if (!x.isDirectory()) continue;
      const p = path.join(d, x.name);
      if (x.name.startsWith('.failover-neu-')) fs.rmSync(p, { recursive: true, force: true });
      else if (x.name.endsWith('.git')) sperren(p);
      else if (!x.name.startsWith('.')) geh(p, tiefe + 1);
    }
  };
  geh(wurzel, 0);
}

// --- gemeinsamer Stand (Fingerabdrücke) ----------------------------------------------------------------------------

/** Alle Refs eines nackten Repos als Liste „ref sha“ – aus packed-refs und den Ref-Dateien, ohne git zu starten. */
async function refListe(repo) {
  if (fs.existsSync(path.join(repo, 'reftable'))) {
    // Repos im reftable-Format haben keine Ref-Dateien: dann fragt git selbst.
    const out = await gitText(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: repo });
    return out.split('\n').filter(Boolean).sort();
  }
  const karte = new Map();
  try {
    for (const z of (await fsp.readFile(path.join(repo, 'packed-refs'), 'utf8')).split('\n')) {
      if (!z || z[0] === '#' || z[0] === '^') continue;
      const i = z.indexOf(' ');
      if (SHA.test(z.slice(0, i))) karte.set(z.slice(i + 1), z.slice(0, i));
    }
  } catch (e) { if (!fehlt(e)) throw e; }
  const geh = async (rel) => {
    let eintraege;
    try { eintraege = await fsp.readdir(path.join(repo, rel), { withFileTypes: true }); } catch (e) { if (fehlt(e)) return; throw e; }
    for (const e of eintraege) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { await geh(r); continue; }
      if (e.name.endsWith('.lock')) continue;
      let inhalt;
      try { inhalt = (await fsp.readFile(path.join(repo, r), 'utf8')).trim(); } catch (f) { if (fehlt(f)) continue; throw f; }
      if (SHA.test(inhalt)) karte.set(r, inhalt); // symbolische Refs (ref: …) überträgt fetch nicht als solche
    }
  };
  await geh('refs');
  return [...karte].map(([r, s]) => `${r} ${s}`).sort();
}

/** Fingerabdruck eines Repos aus dem Inhalt aller Refs und HEAD – Haupt und Ersatz rechnen ihn gleich. */
async function repoAbdruck(repo) {
  let head = '';
  try { head = (await fsp.readFile(path.join(repo, 'HEAD'), 'utf8')).trim().replace(/^ref:\s*/, ''); } catch (e) { if (!fehlt(e)) throw e; }
  const refs = await refListe(repo);
  return { fp: b64u(sha256(`${head}\n${refs.join('\n')}`)).slice(0, 32), head: headGueltig(head) ? head : null };
}

/** Alle Ordner und Repos unter repos/ (ohne Verstecktes). Lesefehler (außer „gibt es nicht“) werden weitergereicht. */
async function baumAufzaehlen(wurzel) {
  const ordner = []; const repos = [];
  const geh = async (rel, tiefe) => {
    if (tiefe > 10) return;
    let eintraege;
    try { eintraege = await fsp.readdir(path.join(wurzel, ...rel), { withFileTypes: true }); } catch (e) { if (fehlt(e)) return; throw e; }
    for (const e of eintraege) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (e.name.endsWith('.git')) {
        const slug = e.name.slice(0, -4);
        if (SEGMENT.test(slug)) repos.push([...rel, slug].join('/'));
      } else if (SEGMENT.test(e.name)) {
        ordner.push([...rel, e.name].join('/'));
        await geh([...rel, e.name], tiefe + 1);
      }
    }
  };
  await geh([], 0);
  return { ordner: ordner.sort(), repos: repos.sort() };
}

/** Zustandsdateien: alle *.json oben im Datenordner, geheim.key und die Profilbilder. */
async function zustandsDateien(daten) {
  const liste = [];
  for (const e of await fsp.readdir(daten, { withFileTypes: true })) {
    if (e.isFile() && (ZUSTAND_NAME.test(e.name) || e.name === 'geheim.key')) liste.push(e.name);
  }
  let bilder = [];
  try { bilder = await fsp.readdir(path.join(daten, 'avatare'), { withFileTypes: true }); } catch (e) { if (!fehlt(e)) throw e; }
  for (const e of bilder) {
    if (e.isFile() && BILD_NAME.test(e.name) && !e.name.endsWith('.tmp')) liste.push(`avatare/${e.name}`);
  }
  return liste.sort();
}

const repoOrdner = (wurzel, pfad) => { const t = pfad.split('/'); return path.join(wurzel, ...t.slice(0, -1), `${t.at(-1)}.git`); };

// --- Haupt ---------------------------------------------------------------------------------------------------------

export class FailoverHaupt {
  /** @param {{speicher: import('./speicher.js').Speicher, version: string}} o */
  constructor({ speicher, version }) {
    this.speicher = speicher;
    this.version = version;
    this.einmal = new Map();
    this.gitZugaenge = new Map();
    this.ersatz = null;
    this._stand = null;
  }

  async kopplung() { return (await this.speicher.lesen('einstellungen.json', {})).failover || null; }

  async codeErzeugen() {
    const code = CODE_PRAEFIX + crypto.randomBytes(32).toString('base64url');
    const eintrag = { schluessel: sha256(code).toString('hex'), anfang: code.slice(0, 10), erstellt: new Date().toISOString() };
    await this.speicher.aendern('einstellungen.json', {}, (e) => { e.failover = eintrag; });
    this.ersatz = null; this.gitZugaenge.clear(); this.einmal.clear();
    return { code, anfang: eintrag.anfang, erstellt: eintrag.erstellt };
  }

  async loesen() {
    await this.speicher.aendern('einstellungen.json', {}, (e) => { delete e.failover; });
    this.ersatz = null; this.gitZugaenge.clear(); this.einmal.clear();
  }

  /** Unterschrift einer Ersatz-Anfrage prüfen → Schlüssel und Einmalwert, sonst Fehler (401/404). */
  async pruefen(req, quelle) {
    const k = await this.kopplung();
    if (!k || !k.schluessel) throw new FailoverFehler('Hier ist kein Fail-over eingerichtet', 404);
    const m = /^(\d{10,14})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(String(req.headers['x-fahgit-failover'] || ''));
    if (!m) throw new FailoverFehler('Unterschrift fehlt', 401);
    const [, zeit, einmal, sig] = m;
    const bericht = String(req.headers['x-fahgit-ersatz'] || '').slice(0, 4096);
    const schluessel = Buffer.from(k.schluessel, 'hex');
    if (!gleich(unterschrift(schluessel, zeit, einmal, req.method, req.url, bericht), sig)) {
      throw new FailoverFehler('Unterschrift ungültig – der Kopplungscode stimmt nicht (am Haupt neu erzeugt?)', 401);
    }
    if (Math.abs(Date.now() - Number(zeit)) > ZEITFENSTER_MS) throw new FailoverFehler('Uhrzeit von Haupt und Ersatz weicht mehr als 2 Minuten ab', 401);
    const jetzt = Date.now();
    for (const [w, t] of this.einmal) if (jetzt - t > 2 * ZEITFENSTER_MS) this.einmal.delete(w);
    if (this.einmal.has(einmal)) throw new FailoverFehler('Anfrage wiederholt', 401);
    if (this.einmal.size > 10_000) this.einmal.clear();
    this.einmal.set(einmal, jetzt);
    let b = {};
    try { b = JSON.parse(Buffer.from(bericht, 'base64url').toString('utf8')) || {}; } catch { /* ohne Bericht */ }
    const text = (v, n) => (v == null ? null : String(v).slice(0, n));
    this.ersatz = { quelle: text(quelle, 64), zeit: new Date().toISOString(), version: text(b.version, 20), gesamt: text(b.gesamt, 64),
      zuletzt: text(b.zuletzt, 40), fehler: text(b.fehler, 400), adresse: text(b.adresse, 200) };
    return { schluessel, einmal };
  }

  /** Kurzlebiger Nur-Lese-Zugang für git fetch – nur für `quelle` (alle 5 Minuten ein neuer, je 15 Minuten gültig). */
  gitZugang(quelle) {
    const jetzt = Date.now();
    for (const [t, z] of this.gitZugaenge) if (z.bis <= jetzt) this.gitZugaenge.delete(t);
    let bester = null;
    for (const [t, z] of this.gitZugaenge) if (z.quelle === quelle && (!bester || z.bis > bester[1].bis)) bester = [t, z];
    if (!bester || bester[1].bis - jetzt < GIT_GUELTIG_MS - GIT_ERNEUERN_MS) {
      bester = [`fgtk_${crypto.randomBytes(24).toString('base64url')}`, { bis: jetzt + GIT_GUELTIG_MS, quelle }];
      this.gitZugaenge.set(...bester);
    }
    return bester[0];
  }

  /** Für githttp: Zugang des Ersatzes → Nutzer, der alles lesen und nichts schreiben darf. */
  gitPruefen(name, geheim, quelle) {
    if (name !== GIT_NAME || !String(geheim || '').startsWith('fgtk_')) return null;
    const z = this.gitZugaenge.get(geheim);
    if (!z || z.bis <= Date.now() || z.quelle !== quelle) return null;
    return { name: GIT_NAME, anzeige: 'Fail-over', admin: true, freigaben: [], leseSchluessel: true, failover: true };
  }

  async stand() {
    if (this._stand && Date.now() - this._stand.zeit < 2000) return this._stand.wert;
    const daten = this.speicher.ordner;
    const namen = await zustandsDateien(daten);
    for (const p of PFLICHT) if (!namen.includes(p)) throw new FailoverFehler(`Am Haupt fehlt ${p} – kein Abgleich, damit der Ersatz nichts verliert`, 503);
    const dateien = [];
    for (const n of namen) {
      try { const s = await fsp.stat(path.join(daten, n)); dateien.push(`${n}|${s.size}|${s.mtimeMs}`); } catch (e) { if (!fehlt(e)) throw e; }
    }
    const { ordner, repos } = await baumAufzaehlen(this.speicher.repos);
    const liste = [];
    for (const pfad of repos) liste.push({ pfad, ...(await repoAbdruck(repoOrdner(this.speicher.repos, pfad))) });
    const dateienFp = b64u(sha256(dateien.join('\n'))).slice(0, 32);
    const gesamt = b64u(sha256(JSON.stringify([dateienFp, ordner, liste]))).slice(0, 32);
    const wert = { version: this.version, dateien: dateienFp, ordner, repos: liste, gesamt };
    this._stand = { zeit: Date.now(), wert };
    return wert;
  }

  async dateien() {
    const daten = this.speicher.ordner;
    const liste = []; let summe = 0; const abdruck = [];
    for (const n of await zustandsDateien(daten)) {
      let inhalt; let s;
      try { s = await fsp.stat(path.join(daten, n)); inhalt = await fsp.readFile(path.join(daten, n)); } catch (e) { if (fehlt(e)) continue; throw e; }
      summe += inhalt.length;
      if (summe > DATEIEN_MAX) throw new FailoverFehler('Zustandsdateien zu groß für den Abgleich', 507);
      liste.push({ name: n, inhalt: inhalt.toString('base64') });
      abdruck.push(`${n}|${s.size}|${s.mtimeMs}`);
    }
    for (const p of PFLICHT) if (!liste.some((d) => d.name === p)) throw new FailoverFehler(`Am Haupt fehlt ${p}`, 503);
    return { dateien: liste, fp: b64u(sha256(abdruck.join('\n'))).slice(0, 32) };
  }

  /** Für die Oberfläche (nur Admins): Kopplung und was der Ersatz zuletzt gemeldet hat. Nie der Schlüssel. */
  async status() {
    const k = await this.kopplung();
    const s = k ? await this.stand().catch(() => null) : null;
    const e = this.ersatz;
    return { rolle: 'haupt', eingerichtet: !!k, anfang: k ? k.anfang : null, erstellt: k ? k.erstellt : null, version: this.version,
      ersatz: e ? { ...e, gesamt: undefined, aktuell: !!(s && e.gesamt && e.gesamt === s.gesamt) } : null };
  }
}

// --- Ersatz --------------------------------------------------------------------------------------------------------

export class FailoverErsatz {
  /** @param {{speicher: import('./speicher.js').Speicher, baum: import('./baum.js').Baum, version: string, env?: object}} o */
  constructor({ speicher, baum, version, env = process.env }) {
    this.speicher = speicher;
    this.baum = baum;
    this.version = version;
    this.ordner = path.join(speicher.ordner, ORDNER);
    this.papierkorb = path.join(this.ordner, 'papierkorb');
    fs.mkdirSync(this.ordner, { recursive: true, mode: 0o700 });
    this.env = { haupt: String(env.FAHGIT_HAUPT || '').trim(), code: String(env.FAHGIT_KOPPLUNG || '').trim(), adresse: String(env.FAHGIT_ADRESSE || '').trim() };
    this.letzter = this._json('stand.json', { dateien: null, repos: {}, gesamt: null, voll: 0 });
    this.zustand = { laeuft: false, zuletzt: this.letzter.zuletzt || null, versucht: null, fehler: null, repoFehler: [], gesamt: null, fertig: null };
    this.abweichung = new Map();
    this.uhr = null;
    this.lauf = null;
    this.jetztGewuenscht = false;
  }

  _json(name, vorgabe) { try { return { ...vorgabe, ...JSON.parse(fs.readFileSync(path.join(this.ordner, name), 'utf8')) }; } catch { return structuredClone(vorgabe); } }

  async _schreiben(name, wert) {
    const ziel = path.join(this.ordner, name);
    const tmp = `${ziel}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(wert), { mode: 0o600 });
    await fsp.rename(tmp, ziel);
  }

  /** Kopplung: aus der Umgebung (FAHGIT_HAUPT + FAHGIT_KOPPLUNG) oder aus der Oberfläche (_failover/kopplung.json). */
  kopplung() {
    if (this.env.haupt && this.env.code) return { haupt: this.env.haupt.replace(/\/+$/, ''), schluessel: sha256(this.env.code), quelle: 'umgebung' };
    const k = this._json('kopplung.json', {});
    return k.haupt && k.schluessel ? { haupt: k.haupt, schluessel: Buffer.from(k.schluessel, 'hex'), quelle: 'oberflaeche', seit: k.seit } : null;
  }

  static adressePruefen(wert) {
    let u;
    try { u = new URL(String(wert || '').trim()); } catch { throw new FailoverFehler('Adresse des Haupts ungültig (z. B. http://192.168.1.10:3300)'); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
      throw new FailoverFehler('Adresse des Haupts: nur http(s)://rechner[:port], ohne Pfad');
    }
    return `${u.protocol}//${u.host}`;
  }

  /** Mit einem Haupt koppeln: Verbindung und Code sofort prüfen, erst dann merken. Fehlertexte bewusst knapp. */
  async koppeln(haupt, code) {
    if (this.env.haupt && this.env.code) throw new FailoverFehler('Die Kopplung steht in der .env (HAUPT/KOPPLUNG) und lässt sich nur dort ändern', 409);
    const adresse = FailoverErsatz.adressePruefen(haupt);
    code = String(code || '').trim();
    if (!code.startsWith(CODE_PRAEFIX) || code.length < 40) throw new FailoverFehler('Kopplungscode ungültig – er beginnt mit „fgfo_“ und steht am Haupt unter Einstellungen → Fail-over');
    const k = { haupt: adresse, schluessel: sha256(code) };
    let s;
    try { s = await this.anfrage(k, '/api/failover/stand'); } catch (e) {
      if (e.status === 401) throw new FailoverFehler('Der Haupt lehnt den Kopplungscode ab (neu erzeugt oder vertippt?)', 401);
      if (e.status === 503) throw e;
      throw new FailoverFehler(`Unter ${adresse} antwortet kein FAH-Git mit eingerichtetem Fail-over`, 502);
    }
    await this._schreiben('kopplung.json', { haupt: adresse, schluessel: k.schluessel.toString('hex'), seit: new Date().toISOString() });
    this.letzter = { dateien: null, repos: {}, gesamt: null, voll: 0 };
    await this._schreiben('stand.json', this.letzter);
    this.zustand.fehler = null;
    if (this.gestartet) this.anstossen();
    return { haupt: adresse, version: s.version, repos: s.repos.length };
  }

  async anfrage(k, weg) {
    const zeit = String(Date.now());
    const einmal = crypto.randomBytes(18).toString('base64url');
    const bericht = b64u(JSON.stringify({ version: this.version, gesamt: this.letzter.gesamt, zuletzt: this.zustand.zuletzt,
      fehler: this.zustand.fehler || (this.zustand.repoFehler.length ? `${this.zustand.repoFehler.length} Projekt(e) nicht geholt` : null), adresse: this.env.adresse || null }));
    let r;
    try {
      r = await fetch(k.haupt + weg, { headers: { 'x-fahgit-failover': `${zeit}.${einmal}.${unterschrift(k.schluessel, zeit, einmal, 'GET', weg, bericht)}`, 'x-fahgit-ersatz': bericht },
        signal: AbortSignal.timeout(60_000), redirect: 'error' });
    } catch (e) { throw new FailoverFehler(`Haupt ${k.haupt} nicht erreichbar (${e.cause?.code || e.name || e.message})`, 502); }
    if (Number(r.headers.get('content-length') || 0) > ANTWORT_MAX) { r.body?.cancel().catch(() => {}); throw new FailoverFehler('Antwort des Haupts zu groß', 502); }
    const t = await r.json().catch(() => null);
    if (!r.ok) throw new FailoverFehler(`Haupt antwortet ${r.status}: ${(t && t.fehler) || 'Fehler'}`.slice(0, 300), r.status === 401 || r.status === 503 ? r.status : 502);
    return entpacken(k.schluessel, einmal, t);
  }

  /** Eine Abgleich-Runde. Wirft nur bei Problemen mit dem Haupt; Fehler einzelner Repos landen in repoFehler. */
  async runde() {
    const k = this.kopplung();
    if (!k) return { gekoppelt: false };
    this.zustand.versucht = new Date().toISOString();
    const s = await this.anfrage(k, '/api/failover/stand');
    if (!s || !Array.isArray(s.repos) || !Array.isArray(s.ordner) || typeof s.git !== 'string') throw new FailoverFehler('Stand des Haupts unvollständig', 502);
    const repos = s.repos.filter((r) => r && pfadGueltig(r.pfad) && typeof r.fp === 'string');
    const ordner = s.ordner.filter(pfadGueltig);
    const fehler = [];

    // 1. Zustandsdateien zuerst, damit Anmelden schon während des ersten großen Abgleichs geht.
    if (s.dateien !== this.letzter.dateien) {
      const d = await this.anfrage(k, '/api/failover/dateien');
      await this.dateienSchreiben(d.dateien);
      this.letzter.dateien = d.fp || s.dateien;
      await this._schreiben('stand.json', this.letzter);
    }

    // 2. Ordner und Repos.
    for (const o of ordner) await fsp.mkdir(path.join(this.speicher.repos, ...o.split('/')), { recursive: true });
    const voll = Date.now() - (this.letzter.voll || 0) > VOLL_MS;
    this.zustand.gesamt = repos.length; this.zustand.fertig = 0;
    for (const r of repos) {
      const ziel = this.baum.repoPfad(r.pfad);
      const da = fs.existsSync(path.join(ziel, 'HEAD'));
      if (da && !voll && this.letzter.repos[r.pfad] === r.fp) { this.zustand.fertig++; continue; }
      try {
        await this.repoHolen(k, r, s.git);
        // Nachprüfen: Hat der Ersatz jetzt genau den Stand, den der (verschlüsselte) Stand nennt?
        const ist = await repoAbdruck(ziel);
        if (ist.fp === r.fp) {
          this.abweichung.delete(r.pfad);
          this.letzter.repos[r.pfad] = r.fp;
          await this._schreiben('stand.json', this.letzter);
        } else {
          // Meist ein Push zwischen Stand und Holen – die nächste Runde holt nach. Erst bei Wiederholung melden.
          const n = (this.abweichung.get(r.pfad) || 0) + 1;
          this.abweichung.set(r.pfad, n);
          delete this.letzter.repos[r.pfad];
          if (n >= ABWEICHUNG_MELDEN) fehler.push({ pfad: r.pfad, fehler: 'Stand weicht nach dem Holen vom Haupt ab' });
          else fehler.push({ pfad: r.pfad, fehler: 'wird gerade geändert', still: true });
        }
      } catch (e) { fehler.push({ pfad: r.pfad, fehler: String(e.message || e).slice(0, 300) }); delete this.letzter.repos[r.pfad]; }
      this.zustand.fertig++;
    }

    // 3. Was es am Haupt nicht mehr gibt: Repos in den Papierkorb, dann leere Ordner (tiefste zuerst).
    const lokal = await baumAufzaehlen(this.speicher.repos);
    const sollRepos = new Set(repos.map((r) => r.pfad));
    const weg = lokal.repos.filter((p) => !sollRepos.has(p));
    if (weg.length && !repos.length) {
      fehler.push({ pfad: '', fehler: `Haupt meldet keine Projekte – aus Vorsicht ${weg.length} hier behalten` });
    } else {
      const stempel = new Date().toISOString().replace(/[:.]/g, '-');
      for (const p of weg) {
        const ziel = path.join(this.papierkorb, stempel, ...p.split('/').slice(0, -1), `${p.split('/').at(-1)}.git`);
        await fsp.mkdir(path.dirname(ziel), { recursive: true });
        await fsp.rename(this.baum.repoPfad(p), ziel);
        delete this.letzter.repos[p];
      }
      const sollOrdner = new Set(ordner);
      for (const o of lokal.ordner.slice().sort((a, b) => b.split('/').length - a.split('/').length)) {
        if (sollOrdner.has(o)) continue;
        const rest = await baumAufzaehlen(path.join(this.speicher.repos, ...o.split('/')));
        if (!rest.repos.length) await fsp.rm(path.join(this.speicher.repos, ...o.split('/')), { recursive: true, force: true });
      }
    }
    for (const p of Object.keys(this.letzter.repos)) if (!sollRepos.has(p)) delete this.letzter.repos[p];
    await this.papierkorbLeeren();

    const echt = fehler.filter((f) => !f.still);
    if (voll && !fehler.length) this.letzter.voll = Date.now();
    this.letzter.gesamt = fehler.length ? null : s.gesamt;
    this.zustand.repoFehler = echt.map(({ pfad, fehler: f }) => ({ pfad, fehler: f }));
    this.zustand.zuletzt = new Date().toISOString();
    this.letzter.zuletzt = this.zustand.zuletzt;
    this.letzter.haupt_version = s.version;
    await this._schreiben('stand.json', this.letzter);
    return { gekoppelt: true, repos: repos.length, fehler: echt };
  }

  async papierkorbLeeren() {
    let namen = [];
    try { namen = await fsp.readdir(this.papierkorb); } catch (e) { if (fehlt(e)) return; throw e; }
    for (const n of namen) {
      const p = path.join(this.papierkorb, n);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > PAPIERKORB_TAGE * 86400_000) await fsp.rm(p, { recursive: true, force: true });
    }
  }

  async repoHolen(k, r, zugang) {
    const ziel = this.baum.repoPfad(r.pfad);
    const neu = !fs.existsSync(path.join(ziel, 'HEAD'));
    const arbeit = neu ? path.join(path.dirname(ziel), `.failover-neu-${crypto.randomBytes(4).toString('hex')}.git`) : ziel;
    const url = `${k.haupt}/${r.pfad.split('/').map(encodeURIComponent).join('/')}.git`;
    // Zugang über die Umgebung statt als Argument (in der Prozessliste unsichtbar). Hängt die Leitung (unter 1 KB/s über
    // 60 Sekunden), bricht git ab statt bis zum Zeitdeckel zu warten.
    const konfig = [['http.extraHeader', `Authorization: Basic ${Buffer.from(`${GIT_NAME}:${zugang}`).toString('base64')}`], ['credential.helper', ''],
      ['http.lowSpeedLimit', '1000'], ['http.lowSpeedTime', '60']];
    const env = { GIT_CONFIG_COUNT: String(konfig.length) };
    konfig.forEach(([key, wert], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = wert; });
    try {
      if (neu) {
        await fsp.mkdir(path.dirname(ziel), { recursive: true });
        await git(['init', '--bare', '-q', arbeit], { cwd: this.speicher.ordner });
      }
      await git(['fetch', '--prune', '--force', '--no-write-fetch-head', '--quiet', url, '+refs/*:refs/*'], { cwd: arbeit, env, zeitlimitMs: 60 * 60_000, ausgabeMax: 1024 * 1024 });
      if (r.head && headGueltig(r.head)) await git(['symbolic-ref', 'HEAD', r.head], { cwd: arbeit });
      if (neu) { await fsp.rm(ziel, { recursive: true, force: true }); await fsp.rename(arbeit, ziel); }
    } catch (e) {
      if (neu) await fsp.rm(arbeit, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  /** Zustandsdateien des Haupts übernehmen (je Datei atomar, in der Schreib-Reihenfolge des Speichers). */
  async dateienSchreiben(liste) {
    if (!Array.isArray(liste)) throw new FailoverFehler('Dateiliste des Haupts fehlt', 502);
    for (const p of PFLICHT) if (!liste.some((d) => d && d.name === p)) throw new FailoverFehler(`Dateiliste des Haupts ohne ${p} – nichts übernommen`, 502);
    const daten = this.speicher.ordner;
    const soll = new Set();
    for (const d of liste) {
      const name = String(d && d.name || '');
      const bild = name.startsWith('avatare/') ? name.slice(8) : null;
      if (!(ZUSTAND_NAME.test(name) || name === 'geheim.key' || (bild && BILD_NAME.test(bild)))) continue;
      soll.add(name);
      if (bild) await fsp.mkdir(path.join(daten, 'avatare'), { recursive: true });
      await this.speicher.ersetzen(name, Buffer.from(String(d.inhalt || ''), 'base64'));
    }
    for (const n of await zustandsDateien(daten)) {
      if (!soll.has(n) && !NIE_LOESCHEN.has(n)) await this.speicher.entfernen(n);
    }
    if (soll.has('geheim.key')) this.speicher.geheimnisVergessen();
  }

  status() {
    const k = this.kopplung();
    const frisch = !!this.zustand.zuletzt && Date.now() - Date.parse(this.zustand.zuletzt) < AKTUELL_MS;
    return { rolle: 'ersatz', gekoppelt: !!k, haupt: k ? k.haupt : null, quelle: k ? k.quelle : null, version: this.version,
      haupt_version: this.letzter.haupt_version || null, laeuft: this.zustand.laeuft, zuletzt: this.zustand.zuletzt, versucht: this.zustand.versucht,
      fehler: this.zustand.fehler, repoFehler: this.zustand.repoFehler, gesamt: this.zustand.gesamt, fertig: this.zustand.fertig,
      aktuell: frisch && !!this.letzter.gesamt && !this.zustand.fehler && !this.zustand.repoFehler.length };
  }

  /** Sofort eine Runde (z. B. Knopf „Jetzt abgleichen“); läuft schon eine, folgt direkt danach die nächste. */
  anstossen() {
    if (this.gestoppt) return;
    if (this.zustand.laeuft) { this.jetztGewuenscht = true; return; }
    clearTimeout(this.uhr);
    this.uhr = setTimeout(() => { this.lauf = this._lauf(); }, 10);
    this.uhr.unref?.();
  }

  async _lauf() {
    this.zustand.laeuft = true;
    let warten = TAKT_MS;
    try {
      await this.runde();
      this.zustand.fehler = null;
    } catch (e) {
      const text = String(e.message || e).slice(0, 400);
      if (text !== this.zustand.fehler) console.error(`Fail-over: ${text}`);
      this.zustand.fehler = text;
      warten = TAKT_FEHLER_MS;
    } finally {
      this.zustand.laeuft = false;
    }
    if (this.gestoppt) return;
    if (this.jetztGewuenscht) { this.jetztGewuenscht = false; warten = 10; }
    this.uhr = setTimeout(() => { this.lauf = this._lauf(); }, warten);
    this.uhr.unref?.();
  }

  starten() { this.gestartet = true; this.gestoppt = false; this.anstossen(); }
  stoppen() { this.gestoppt = true; clearTimeout(this.uhr); }

  /** Anhalten und eine laufende Runde abwarten (höchstens `maxMs`), damit kein git mitten im Schreiben abgeschossen wird. */
  async anhalten(maxMs = 60_000) {
    this.stoppen();
    if (this.zustand.laeuft && this.lauf) await Promise.race([this.lauf.catch(() => {}), new Promise((r) => setTimeout(r, maxMs).unref?.())]);
  }

  /** Ersatz wird Haupt (Haupt ist ausgefallen). Gemerkt in _failover/rolle.json; der Aufrufer startet neu. */
  async uebernehmen(wer) {
    await this._schreiben('rolle.json', { rolle: 'haupt', seit: new Date().toISOString(), von: wer, vorher: this.kopplung()?.haupt || null });
  }
}

/** Übernommene Instanz wieder zum Ersatz machen (rolle.json weg; der Aufrufer startet neu). */
export async function wiederErsatz(daten) {
  await fsp.rm(path.join(daten, ORDNER, 'rolle.json'), { force: true });
  // Der nächste Abgleich soll alles prüfen, nicht nur Geändertes.
  await fsp.rm(path.join(daten, ORDNER, 'stand.json'), { force: true });
}
