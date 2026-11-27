// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// FAH-Git: ein schlanker Git-Server mit Ordnerbaum. Ein Prozess, keine Datenbank: Weboberfläche, JSON-Schnittstelle
// und Git über HTTP auf demselben Port.
// Rechte (1.4.0): Admins alles; alle anderen nur, was ihnen freigegeben ist (rechte.js). Nicht Freigegebenes antwortet
// mit 404 (verrät nichts), nur Lesbares beim Schreiben mit 403.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Speicher } from './speicher.js';
import { Baum, BaumFehler, slug, teile } from './baum.js';
import { Konten } from './konten.js';
import { Aktivitaet } from './aktivitaet.js';
import { Spiegel, regelVerletzt, zweigListe } from './spiegel.js';
import { GitHub, neuNamePruefen, repoPruefen } from './github.js';
import { bereinigungPruefen, WEGLASSEN_VORGABE, textPruefen, ersetzenVorbereiten } from './bereinigung.js';
import { Sicherung } from './sicherung.js';
import { absender, gitAnfrage, gitBearbeiter } from './githttp.js';
import { uebernehmen } from './importer.js';
import * as repo from './repo.js';
import { gitText, GIT_UMGEBUNG } from './git.js';
import { recht, baumFiltern, LESEN, SCHREIBEN } from './rechte.js';
import { BILD_MAX, artAusTyp, bildArt } from './profilbild.js';
import { Ablage, versionAusZeit, downloadKopf, PRUEFBAR } from './ablage.js';
import { pipeline } from 'node:stream';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const OEFFENTLICH = path.join(HIER, '..', 'public');
export const VERSION = JSON.parse(fs.readFileSync(path.join(HIER, '..', 'package.json'), 'utf8')).version;
const COOKIE = 'fahgit_sitzung';
const KOERPER_MAX = 1024 * 1024;
const TYPEN = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const BILDTYPEN = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif' };

class HttpFehler extends Error {
  constructor(status, text) { super(text); this.status = status; }
}

function cookies(req) {
  const c = {};
  for (const teil of String(req.headers.cookie || '').split(';')) {
    const i = teil.indexOf('=');
    if (i > 0) c[teil.slice(0, i).trim()] = decodeURIComponent(teil.slice(i + 1).trim());
  }
  return c;
}

function json(res, status, daten, kopf = {}) {
  const t = JSON.stringify(daten);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...kopf });
  res.end(t);
}

function koerper(req) {
  return new Promise((resolve, reject) => {
    let laenge = 0; const teileB = [];
    req.on('data', (d) => {
      laenge += d.length;
      if (laenge > KOERPER_MAX) { reject(new HttpFehler(413, 'Anfrage zu groß')); req.destroy(); return; }
      teileB.push(d);
    });
    req.on('end', () => {
      if (!laenge) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(teileB).toString('utf8'))); } catch { reject(new HttpFehler(400, 'Ungültiges JSON')); }
    });
    req.on('error', reject);
  });
}

/** Rohen Körper lesen (Profilbild). Zu groß → 413; der Rest wird noch gelesen, damit die Antwort ankommt. */
function rohKoerper(req, max, text) {
  return new Promise((resolve, reject) => {
    let laenge = 0; let zuGross = false; const teileB = [];
    req.on('data', (d) => {
      laenge += d.length;
      if (laenge > max) { zuGross = true; if (laenge > max * 8) req.destroy(); return; }
      teileB.push(d);
    });
    req.on('end', () => (zuGross ? reject(new HttpFehler(413, text)) : resolve(Buffer.concat(teileB))));
    req.on('error', reject);
  });
}

/** http(s)-Adresse für Einstellungen: leer bleibt leer, sonst ohne Schrägstrich am Ende; Unsinn → 400. */
function httpAdresse(wert, was) {
  const roh = String(wert || '').trim().replace(/\/+$/, '');
  if (!roh) return '';
  let u;
  try { u = new URL(roh); } catch { throw new HttpFehler(400, `${was}: keine gültige Adresse`); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpFehler(400, `${was}: nur http- oder https-Adressen`);
  if (u.username || u.password) throw new HttpFehler(400, `${was}: bitte ohne Benutzer und Kennwort`);
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** Ohne git-http-backend gehen Klonen und Pushen nicht (Alpine packt es in „git-daemon“) – einmal prüfen und merken. */
let backendDa = null;
async function httpBackendDa() {
  if (backendDa !== null) return backendDa;
  try {
    const pfad = (await gitText(['--exec-path'])).trim();
    backendDa = fs.existsSync(path.join(pfad, 'git-http-backend'));
  } catch { backendDa = false; }
  return backendDa;
}

export function erstelleServer({ daten, oeffentlicheAdresse = '', github: githubOptionen = {}, ablage: ablageOrdner = process.env.FAHGIT_ABLAGE || '/ablage' }) {
  const speicher = new Speicher(daten);
  const baum = new Baum(speicher);
  const konten = new Konten(speicher);
  const aktivitaet = new Aktivitaet(speicher);
  const einstellungen = async () => ({ adresse: oeffentlicheAdresse, ziel_regeln: [], fahnas_adresse: '', sicherung: { auto: true, behalten: 14 }, ...(await speicher.lesen('einstellungen.json', {})) });
  const gh = new GitHub(githubOptionen);
  // Release-Ablage (1.12.0): fertige ZIPs/ISOs aus dem NAS-Ordner, nur lesend; je Projekt zugeordnet, eine davon „öffentlich“.
  const ablage = new Ablage(ablageOrdner);
  // GitHub-Zugang (1.8.0): EIN Token für alle GitHub-Spiegel, verschlüsselt mit geheim.key, nie ausgeliefert.
  const githubZugang = async () => { const g = (await einstellungen()).github; return g && g.geheim ? { benutzer: g.konto, name: g.name || g.konto, geheim: g.geheim, web: gh.web } : null; };
  // Bereinigung für den öffentlichen Stand (1.9.0): eigener Schlüssel, damit „GitHub trennen“ die Regeln nicht löscht.
  const bereinigungLesen = async () => (await einstellungen()).github_bereinigung || { ersetzen: [], verboten: [], weglassen: [...WEGLASSEN_VORGABE] };
  const githubToken = async () => {
    const g = await githubZugang();
    if (!g) throw new HttpFehler(400, 'GitHub-Zugang fehlt – unter Einstellungen → GitHub hinterlegen');
    return speicher.entschluesseln(g.geheim);
  };
  const spiegel = new Spiegel({ speicher, baum, aktivitaet, regeln: async () => (await einstellungen()).ziel_regeln || [], github: githubZugang, bereinigung: bereinigungLesen,
    githubInfo: async (r) => gh.repoInfo(await githubToken(), r) });
  const sicherung = new Sicherung({ speicher, baum, konten, einstellungen, version: VERSION });
  const auftraege = new Map();
  // Hochladen aus der Oberfläche (25.10.2026): je Vorgang eine Sitzung, Dateien einzeln als Datenstrom, am Ende EIN Commit.
  const uploads = new Map();
  const HOCHLADEN = { dateiMax: 200 * 1024 * 1024, summeMax: 2 * 1024 * 1024 * 1024, anzahlMax: 5000, frist: 3600_000 };

  async function klonAdresse(req, pfad) {
    const e = await einstellungen();
    const basis = (e.adresse || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/+$/, '');
    return `${basis}/${pfad}.git`;
  }

  async function nachPush(pfad, nutzer, aenderungen) {
    const r = baum.repoPfad(pfad);
    const zweige = [];
    for (const a of aenderungen.filter((x) => x.ref.startsWith('refs/heads/'))) {
      const name = a.ref.slice(11);
      if (!a.neu) { zweige.push({ name, art: 'geloescht' }); continue; }
      const anzahl = a.alt ? Number((await gitText(['rev-list', '--count', `${a.alt}..${a.neu}`], { cwd: r }).catch(() => '0')).trim()) : null;
      const betreff = (await gitText(['log', '-1', '--format=%s', a.neu], { cwd: r }).catch(() => '')).trim();
      zweige.push({ name, art: a.alt ? 'aktualisiert' : 'neu', anzahl, betreff, sha: a.neu });
    }
    const tags = aenderungen.filter((x) => x.ref.startsWith('refs/tags/') && x.neu).map((x) => x.ref.slice(10));
    aktivitaet.melden({ art: 'push', nutzer: nutzer.name, anzeige: nutzer.anzeige, projekt: pfad, zweige, tags });
    await baum.projektAendern(pfad, (p) => { p.zuletzt = new Date().toISOString(); }).catch(() => {});
    spiegel.nachPush(pfad);
  }

  async function nurLesen(pfad) {
    const q = (await baum.projektMeta(pfad)).quelle;
    return q ? `Dieses Projekt ist eine laufende Kopie von ${q.url} und nur lesbar. Änderungen bitte dort pushen.` : null;
  }

  const gitHttp = gitBearbeiter({ baum, konten, nachPush, nurLesen });

  async function angemeldet(req) {
    const auth = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(auth)) return konten.schluesselPruefen(auth.replace(/^Bearer\s+/i, '').trim());
    return konten.sitzungPruefen(cookies(req)[COOKIE]);
  }

  function sitzungsCookie(req, wert, tage) {
    const sicher = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    return `${COOKIE}=${wert}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${tage * 86400}${sicher}`;
  }

  async function projektPfad(p) {
    const pfad = await baum.aufloesen(p);
    if (!(await baum.istProjekt(pfad))) throw new HttpFehler(404, 'Projekt nicht gefunden');
    return pfad;
  }

  /** Freigaben aus der Benutzerverwaltung: Pfad muss es geben ('' = alles), Recht lesen|schreiben, je Pfad einmal. */
  async function freigabenPruefen(liste) {
    if (!Array.isArray(liste)) throw new HttpFehler(400, 'Freigaben als Liste');
    const neu = new Map();
    for (const f of liste.slice(0, 200)) {
      const pfad = teile((f && f.pfad) || '').join('/');
      const r = f && f.recht;
      if (r !== 'lesen' && r !== 'schreiben') throw new HttpFehler(400, 'Recht: „lesen“ oder „schreiben“');
      if (pfad && !(await baum.istOrdner(pfad)) && !(await baum.istProjekt(pfad))) throw new HttpFehler(400, `„${pfad}“ gibt es nicht`);
      neu.set(pfad, { pfad, recht: r });
    }
    return [...neu.values()];
  }

  async function projektDaten(req, pfad, ich) {
    const r = baum.repoPfad(pfad);
    const meta = await baum.projektMeta(pfad);
    const leer = await repo.istLeer(r);
    const standard = await baum.standardZweig(pfad);
    const [zw, tg] = leer ? [[], []] : await Promise.all([repo.zweige(r), repo.tags(r)]);
    return {
      pfad, slug: teile(pfad).at(-1), name: meta.name || teile(pfad).at(-1), beschreibung: meta.beschreibung || '', themen: meta.themen || [],
      erstellt: meta.erstellt || null, zuletzt: meta.zuletzt || null, herkunft: meta.herkunft || null,
      leer, standard, zweige: zw, tags: tg, klon: await klonAdresse(req, pfad), groesse: await repo.groesse(r),
      bereinigung: { weggelassen: ((meta.bereinigung || {}).weglassen || []).length, freigegeben: ((meta.bereinigung || {}).freigaben || []).length, nur: (meta.bereinigung || {}).nur || [] },
      // Zugänge der Weiterleitungen und Quellen sehen nur Administratoren.
      spiegel: (meta.spiegel || []).map((s) => {
        const o = spiegel.oeffentlich(s);
        if (!ich.admin) { delete o.benutzer; delete o.hat_geheim; if (o.zuletzt) o.zuletzt = { ...o.zuletzt, funde: undefined }; }
        return o;
      }),
      quelle: meta.quelle ? { url: meta.quelle.url, ...(ich.admin ? { benutzer: meta.quelle.benutzer, hat_geheim: !!meta.quelle.geheim } : {}),
        takt: meta.quelle.takt, zuletzt: meta.quelle.zuletzt } : null,
      releases: await releasesDaten(meta, ich),
    };
  }

  /**
   * Zugeordnete Release-Dateien des Projekts mit Größe/Stand (fehlt = nicht mehr in der Ablage). Nicht-Admins sehen keine
   * Pfade der Ablage und keine Sperrliste – nur Namen und die Nummer zum Herunterladen.
   */
  async function releasesDaten(meta, ich) {
    const r = meta.releases || {};
    const dateien = await Promise.all((r.dateien || []).map(async (d, nr) => {
      const i = await ablage.info(d).catch(() => ({ rel: d, name: path.posix.basename(d), fehlt: true }));
      return { nr, ...i, oeffentlich: r.oeffentlich === d, ...(ich.admin ? {} : { rel: undefined }) };
    }));
    return { ablage: await ablage.da(), dateien, oeffentlich: ich.admin ? r.oeffentlich || null : !!r.oeffentlich, verboten: ich.admin ? r.verboten || [] : [] };
  }

  /**
   * Release auf GitHub anlegen, Datei als Strom anhängen, danach ältere Releases + Tags entfernen (nur das neueste bleibt,
   * Betreiber 23.11.2026). Gemeinsam für „Release hochladen“ (Datei aus dem Browser) und „aus der Ablage“ (1.12.0).
   */
  async function releaseVeroeffentlichen(pfad, s, { tag, titel, text, datei, strom, groesse, ich, quelle, nachDemHochladen }) {
    const token = await githubToken();
    const zweig = Array.isArray(s.zweige) && s.zweige.length ? s.zweige[0] : await baum.standardZweig(pfad);
    const rel = await gh.releaseAnlegen(token, s.repo, { tag, name: String(titel || '').slice(0, 200) || tag, text: String(text || '').slice(0, 5000), zweig });
    let d;
    try {
      d = await gh.releaseDatei(token, rel.upload, datei, strom, groesse, /\.zip$/i.test(datei) ? 'application/zip' : 'application/octet-stream');
      if (nachDemHochladen) await nachDemHochladen();          // z. B. Datei während des Hochladens verändert → Release zurücknehmen
    } catch (e) { await gh.releaseLoeschen(token, s.repo, rel.id, tag); throw e; }
    let entfernt = { releases: [], tags: [], fehler: [] };
    try { entfernt = await gh.aeltereReleasesEntfernen(token, s.repo, tag); } catch (e) { entfernt.fehler.push(e.message); }
    await baum.projektAendern(pfad, (p) => {
      const x = (p.spiegel || []).find((y) => y.id === s.id);
      if (x) x.releases = [{ tag, datei, url: rel.url, zeit: new Date().toISOString(), ...(quelle ? { quelle } : {}) }];
    });
    const weg = entfernt.releases.length + entfernt.tags.length ? ` · entfernt: ${entfernt.releases.length} alte(s) Release(s), ${entfernt.tags.length} Tag(s)` : '';
    aktivitaet.melden({ art: 'spiegel', projekt: pfad, nutzer: ich.name, anzeige: ich.anzeige, ergebnis: entfernt.fehler.length ? 'teilweise' : 'ok',
      text: `GitHub ${s.repo}: Release ${tag} mit ${datei}${quelle ? ' (aus der Ablage)' : ''}${weg}${entfernt.fehler.length ? ` · nicht entfernt: ${entfernt.fehler.join('; ')}` : ''}` });
    return { url: rel.url, datei: d.url, entfernt };
  }

  /** GitHub-Spiegel für Releases: nur „Öffentlicher Stand“, schon einmal sauber übertragen. */
  async function releaseSpiegel(pfad, id) {
    const s = ((await baum.projektMeta(pfad)).spiegel || []).find((x) => x.id === id && x.art === 'github');
    if (!s) throw new HttpFehler(404, 'Spiegel fehlt');
    if (s.modus !== 'oeffentlich') throw new HttpFehler(400, 'Releases nur bei „Öffentlicher Stand (bereinigt)“');
    if (!(s.zuletzt && s.zuletzt.ergebnis === 'ok')) throw new HttpFehler(400, 'Erst einmal sauber übertragen („Jetzt zu GitHub“) – das Release braucht einen Stand auf GitHub');
    return s;
  }

  function auftragStarten(art, arbeit) {
    const id = crypto.randomBytes(6).toString('hex');
    const a = { id, art, status: 'laeuft', meldungen: [], ergebnis: null, fehler: null, start: new Date().toISOString() };
    auftraege.set(id, a);
    arbeit((t) => { a.meldungen.push(t); if (a.meldungen.length > 200) a.meldungen.shift(); })
      .then((e) => { a.status = 'fertig'; a.ergebnis = e; })
      .catch((e) => { a.status = 'fehler'; a.fehler = e.message; })
      .finally(() => { a.ende = new Date().toISOString(); setTimeout(() => auftraege.delete(id), 3600_000).unref?.(); });
    return a;
  }

  // --- Schnittstelle --------------------------------------------------------------------------------------------

  async function api(req, res, url) {
    const weg = url.pathname.slice(4);
    const m = req.method;
    const q = Object.fromEntries(url.searchParams);
    if (m !== 'GET' && m !== 'HEAD') {
      // Schutz gegen fremde Seiten: Nur unsere Oberfläche (eigener Kopf) oder Skripte mit Zugangsschlüssel.
      const bearer = /^Bearer\s/i.test(String(req.headers.authorization || ''));
      if (!bearer && req.headers['x-fahgit'] !== '1') throw new HttpFehler(403, 'Anfrage ohne Kennung der Oberfläche');
      const herkunft = req.headers.origin;
      if (herkunft && new URL(herkunft).host !== req.headers.host) throw new HttpFehler(403, 'Fremde Herkunft');
    }

    if (weg === '/gesundheit') {
      const ok = await httpBackendDa();
      return json(res, ok ? 200 : 503, { ok, version: VERSION, ...(ok ? {} : { fehler: 'git http-backend fehlt – Klonen und Pushen gehen nicht' }) });
    }
    if (weg === '/status' && m === 'GET') {
      const nutzer = await angemeldet(req);
      // FAH-NAS-Adresse (nur sie) brauchen alle Angemeldeten für den Knopf „Auf FAH-NAS bauen“.
      return json(res, 200, { version: VERSION, ersteinrichtung: await konten.ersteinrichtungNoetig(), nutzer,
        ...(nutzer ? { fahnas: (await einstellungen()).fahnas_adresse || '' } : {}) });
    }
    if (weg === '/ersteinrichtung' && m === 'POST') {
      const b = await koerper(req);
      const n = await konten.anlegen({ ...b, admin: true }, { nurWennLeer: true });
      return json(res, 200, { nutzer: n }, { 'Set-Cookie': sitzungsCookie(req, await konten.sitzungErzeugen(n.name), 30) });
    }
    if (weg === '/anmelden' && m === 'POST') {
      const b = await koerper(req);
      const n = await konten.pruefen(b.name, b.kennwort, absender(req));
      if (!n) throw new HttpFehler(401, 'Benutzername oder Kennwort falsch');
      return json(res, 200, { nutzer: n }, { 'Set-Cookie': sitzungsCookie(req, await konten.sitzungErzeugen(n.name), 30) });
    }
    if (weg === '/abmelden' && m === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': sitzungsCookie(req, '', 0) });

    const ich = await angemeldet(req);
    if (!ich) throw new HttpFehler(401, 'Bitte anmelden');
    if (ich.leseSchluessel && m !== 'GET' && m !== 'HEAD') {
      throw new HttpFehler(403, 'Dieser Zugangsschlüssel darf nur lesen (klonen, holen, abfragen). Zum Ändern einen Schlüssel „Lesen und schreiben“ verwenden.');
    }
    const nurAdmin = () => { if (!ich.admin) throw new HttpFehler(403, 'Nur für Administratoren'); };
    // Rechte je Pfad: nicht freigegeben → 404 wie „gibt es nicht“, nur lesbar → 403.
    const darfLesen = (pfad, text = 'Nicht gefunden') => { if (recht(ich, pfad) < LESEN) throw new HttpFehler(404, text); };
    const darfSchreiben = (pfad, text = 'Nicht gefunden') => {
      const r = recht(ich, pfad);
      if (r < LESEN) throw new HttpFehler(404, text);
      if (r < SCHREIBEN) throw new HttpFehler(403, ich.leseSchluessel ? 'Dieser Zugangsschlüssel darf nur lesen' : 'Hier hast du nur Leserecht');
    };
    const lesbar = async (p) => { const pfad = await projektPfad(p); darfLesen(pfad, 'Projekt nicht gefunden'); return pfad; };
    const beschreibbar = async (p) => { const pfad = await projektPfad(p); darfSchreiben(pfad, 'Projekt nicht gefunden'); return pfad; };
    // Aktivität: nur, was der Nutzer sehen darf; dazu der Stand des Profilbilds je Nutzer.
    const aktivitaetFuer = async (liste, anzahl) => {
      const sichtbar = ich.admin ? liste : liste.filter((e) => e.projekt && recht(ich, e.projekt) >= LESEN && (!e.alt || recht(ich, e.alt) >= LESEN));
      const bilder = await konten.bilder();
      return sichtbar.slice(0, anzahl).map((e) => (e.nutzer && bilder.has(e.nutzer) ? { ...e, bild: bilder.get(e.nutzer) } : e));
    };

    // Baum und Übersicht
    if (weg === '/baum' && m === 'GET') return json(res, 200, baumFiltern(await baum.liste(), ich));
    if (weg === '/uebersicht' && m === 'GET') {
      const b = baumFiltern(await baum.liste(), ich);
      const meta = await baum.meta();
      let projekte = 0; let ordner = 0;
      const zaehle = (k) => { projekte += k.projekte.length; ordner += k.ordner.length; k.ordner.forEach(zaehle); };
      zaehle(b);
      const spiegelListe = [];
      const sichtbar = Object.entries(meta.projekte).filter(([pfad]) => recht(ich, pfad) >= LESEN);
      for (const [pfad, p] of sichtbar) {
        for (const s of p.spiegel || []) spiegelListe.push({ projekt: pfad, name: p.name || pfad, art: 'weiter', url: s.url, aktiv: s.aktiv !== false,
          zuletzt: s.zuletzt ? { ...s.zuletzt, funde: undefined } : s.zuletzt, ...(s.art === 'github' ? { repo: s.repo } : {}) });
        if (p.quelle) spiegelListe.push({ projekt: pfad, name: p.name || pfad, art: 'quelle', url: p.quelle.url, aktiv: true, zuletzt: p.quelle.zuletzt });
      }
      const zuletzt = sichtbar.filter(([, p]) => p.zuletzt).sort((a, b2) => b2[1].zuletzt.localeCompare(a[1].zuletzt))
        .slice(0, 8).map(([pfad, p]) => ({ pfad, name: p.name || pfad, zuletzt: p.zuletzt }));
      const platz = await fsp.statfs(speicher.repos).catch(() => null);
      return json(res, 200, { projekte, ordner, nutzer: ich.admin ? (await konten.liste()).length : null, spiegel: spiegelListe, zuletzt,
        aktivitaet: await aktivitaetFuer(await aktivitaet.liste({ anzahl: ich.admin ? 25 : 200 }), 25),
        frei: platz ? platz.bavail * platz.bsize : null, version: VERSION,
        ...(ich.admin ? { sicherung: await sicherung.kurz().catch(() => null), github: await (async () => {
          const g = (await einstellungen()).github;
          const anzahl = Object.values(meta.projekte).filter((p) => (p.spiegel || []).some((s) => s.art === 'github')).length;
          return { eingerichtet: !!(g && g.geheim), konto: g ? g.konto : null, anzahl };
        })() } : {}) });
    }
    if (weg === '/aktivitaet' && m === 'GET') {
      const anzahl = Number(q.anzahl) || 50;
      return json(res, 200, await aktivitaetFuer(await aktivitaet.liste({ projekt: q.projekt, anzahl: ich.admin ? anzahl : 200 }), anzahl));
    }

    // Ordner: Unterordner mit Schreibrecht auf den Elternordner; ganz oben, Ändern, Löschen, Verschieben nur Admins.
    if (weg === '/ordner' && m === 'POST') {
      const b = await koerper(req);
      const eltern = teile(b.eltern || '').join('/');
      if (!eltern) nurAdmin(); else darfSchreiben(eltern, 'Übergeordneter Ordner fehlt');
      const pfad = await baum.ordnerAnlegen(eltern, b.name, { beschreibung: b.beschreibung || '' });
      aktivitaet.melden({ art: 'ordner', nutzer: ich.name, anzeige: ich.anzeige, projekt: pfad, text: 'Ordner angelegt' });
      return json(res, 200, { pfad });
    }
    if (weg === '/ordner' && m === 'PATCH') {
      nurAdmin(); const b = await koerper(req);
      await baum.ordnerAendern(b.pfad, b);
      return json(res, 200, { ok: true });
    }
    if (weg === '/ordner' && m === 'DELETE') {
      nurAdmin(); const pfad = teile(q.pfad).join('/');
      await baum.ordnerLoeschen(pfad); await konten.freigabenEntfernen(pfad);
      return json(res, 200, { ok: true });
    }
    if (weg === '/verschieben' && m === 'POST') {
      nurAdmin(); const b = await koerper(req);
      const alt = teile(b.pfad).join('/');
      const neu = await baum.verschieben(alt, b.ziel || '', b.slug ? slug(b.slug) : null);
      await aktivitaet.umbenennen(alt, neu);
      await konten.freigabenUmziehen(alt, neu);   // Freigaben wandern mit
      // Regeln „nur aus diesem Ordner“ wandern mit, wenn der Ordner selbst verschoben wird.
      await speicher.aendern('einstellungen.json', {}, (e) => {
        for (const x of e.ziel_regeln || []) if (x.ordner === alt || String(x.ordner).startsWith(`${alt}/`)) x.ordner = neu + x.ordner.slice(alt.length);
      });
      aktivitaet.melden({ art: 'verschoben', nutzer: ich.name, anzeige: ich.anzeige, projekt: neu, alt, ordner: !(await baum.istProjekt(neu)) });
      return json(res, 200, { pfad: neu });
    }

    // Projekte
    if (weg === '/projekte' && m === 'POST') {
      const b = await koerper(req);
      const ordner = teile(b.ordner || '').join('/');
      darfSchreiben(ordner, 'Ordner fehlt');
      const standard = String(b.standard || 'main');
      const pfad = await baum.projektAnlegen(ordner, b.name, { beschreibung: b.beschreibung || '', themen: b.themen || [], standard });
      if (b.readme) await repo.ersterStand(baum.repoPfad(pfad), { zweig: standard, titel: String(b.name || pfad), beschreibung: b.beschreibung || '', autor: ich });
      aktivitaet.melden({ art: 'projekt', nutzer: ich.name, anzeige: ich.anzeige, projekt: pfad, text: 'Projekt angelegt' });
      return json(res, 200, { pfad });
    }
    if (weg === '/projekt' && m === 'GET') return json(res, 200, await projektDaten(req, await lesbar(q.pfad), ich));
    if (weg === '/projekt' && m === 'PATCH') {
      const b = await koerper(req);
      const pfad = await beschreibbar(b.pfad);
      if (b.name != null && !ich.admin) {
        const jetzt = (await baum.projektMeta(pfad)).name || teile(pfad).at(-1);
        if ((String(b.name).trim().slice(0, 100) || jetzt) !== jetzt) throw new HttpFehler(403, 'Umbenennen dürfen nur Administratoren');
      }
      if (b.standard) await baum.standardZweigSetzen(pfad, String(b.standard));
      await baum.projektAendern(pfad, (p) => {
        if (b.name != null) p.name = String(b.name).trim().slice(0, 100) || p.name;
        if (b.beschreibung != null) p.beschreibung = String(b.beschreibung).slice(0, 2000);
        if (Array.isArray(b.themen)) p.themen = b.themen.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
      });
      return json(res, 200, { ok: true });
    }
    if (weg === '/projekt' && m === 'DELETE') {
      const pfad = await lesbar(q.pfad); nurAdmin();
      if (q.bestaetigung !== teile(pfad).at(-1)) throw new HttpFehler(400, 'Zum Löschen den Projektnamen genau eintippen');
      await baum.projektLoeschen(pfad);
      await konten.freigabenEntfernen(pfad);
      aktivitaet.melden({ art: 'geloescht', nutzer: ich.name, anzeige: ich.anzeige, projekt: pfad, text: 'Projekt gelöscht' });
      return json(res, 200, { ok: true });
    }
    if (weg === '/zweig' && m === 'DELETE') {
      const pfad = await beschreibbar(q.pfad);
      if ((await nurLesen(pfad))) throw new HttpFehler(403, 'Kopie eines fremden Gits – nur lesbar');
      const name = repo.refPruefen(q.name);
      if (name === await baum.standardZweig(pfad)) throw new HttpFehler(400, 'Den Standardzweig erst umstellen');
      await gitText(['update-ref', '-d', `refs/heads/${name}`], { cwd: baum.repoPfad(pfad) });
      aktivitaet.melden({ art: 'push', nutzer: ich.name, anzeige: ich.anzeige, projekt: pfad, zweige: [{ name, art: 'geloescht' }], tags: [] });
      return json(res, 200, { ok: true });
    }

    // Dateien und Ordner von der Festplatte hochladen (25.10.2026): start → je Datei PUT (roh) → fertig = ein Commit.
    if (weg === '/hochladen/start' && m === 'POST') {
      const b = await koerper(req); const pfad = await beschreibbar(b.pfad);
      const grund = await nurLesen(pfad);
      if (grund) throw new HttpFehler(403, grund);
      const zweig = repo.refPruefen(b.zweig || await baum.standardZweig(pfad));
      await repo.kopfOderLeer(baum.repoPfad(pfad), zweig);   // leeres Projekt: wird der erste Commit
      const ordner = repo.dateiPruefen(b.ordner || '');
      const id = crypto.randomBytes(12).toString('hex');
      const sitzung = { id, nutzer: ich.name, pfad, zweig, ordner, dateien: new Map(), summe: 0 };
      sitzung.uhr = setTimeout(() => uploads.delete(id), HOCHLADEN.frist); sitzung.uhr.unref?.();
      uploads.set(id, sitzung);
      return json(res, 200, { id, zweig, ordner, ...HOCHLADEN });
    }
    if (weg === '/hochladen/datei' && m === 'PUT') {
      const sitzung = uploads.get(String(q.id || ''));
      if (!sitzung || sitzung.nutzer !== ich.name) throw new HttpFehler(404, 'Hochladen abgelaufen – bitte neu beginnen');
      const rel = repo.hochladePfad(q.datei);
      const ziel = sitzung.ordner ? `${sitzung.ordner}/${rel}` : rel;
      const angesagt = Number(req.headers['content-length'] || 0);
      if (angesagt > HOCHLADEN.dateiMax) throw new HttpFehler(413, `Datei zu groß (höchstens ${HOCHLADEN.dateiMax / 1048576} MB): ${rel}`);
      if (sitzung.summe + angesagt > HOCHLADEN.summeMax) throw new HttpFehler(413, 'Zusammen zu groß (höchstens 2 GB je Hochladen)');
      if (!sitzung.dateien.has(ziel) && sitzung.dateien.size >= HOCHLADEN.anzahlMax) throw new HttpFehler(413, `Höchstens ${HOCHLADEN.anzahlMax} Dateien je Hochladen`);
      const blob = await repo.blobAusStrom(baum.repoPfad(sitzung.pfad), req, HOCHLADEN.dateiMax);
      sitzung.summe += blob.groesse - (sitzung.dateien.get(ziel)?.groesse || 0);
      sitzung.dateien.set(ziel, blob);
      return json(res, 200, { ok: true, datei: ziel, groesse: blob.groesse, anzahl: sitzung.dateien.size });
    }
    if (weg === '/hochladen/fertig' && m === 'POST') {
      const b = await koerper(req);
      const sitzung = uploads.get(String(b.id || ''));
      if (!sitzung || sitzung.nutzer !== ich.name) throw new HttpFehler(404, 'Hochladen abgelaufen – bitte neu beginnen');
      if (!sitzung.dateien.size) throw new HttpFehler(400, 'Keine Dateien hochgeladen');
      darfSchreiben(sitzung.pfad, 'Projekt nicht gefunden');   // Freigabe kann inzwischen entzogen sein
      if (await nurLesen(sitzung.pfad)) throw new HttpFehler(403, await nurLesen(sitzung.pfad));
      const r = baum.repoPfad(sitzung.pfad);
      const alt = await repo.kopfOderLeer(r, sitzung.zweig);
      const n = sitzung.dateien.size;
      const betreff = String(b.nachricht || '').trim().slice(0, 500) || `${n} Datei${n === 1 ? '' : 'en'} hochgeladen${sitzung.ordner ? ` nach ${sitzung.ordner}` : ''}`;
      const neu = await repo.einchecken(r, { zweig: sitzung.zweig, alt, autor: ich, betreff,
        eintraege: [...sitzung.dateien].map(([pfad2, d]) => ({ pfad: pfad2, sha: d.sha })) });
      clearTimeout(sitzung.uhr); uploads.delete(sitzung.id);
      await nachPush(sitzung.pfad, ich, [{ ref: `refs/heads/${sitzung.zweig}`, alt: alt || null, neu }]);
      return json(res, 200, { ok: true, anzahl: n, sha: neu, zweig: sitzung.zweig, ordner: sitzung.ordner });
    }
    if (weg === '/hochladen' && m === 'DELETE') {
      const sitzung = uploads.get(String(q.id || ''));
      if (sitzung && sitzung.nutzer === ich.name) { clearTimeout(sitzung.uhr); uploads.delete(sitzung.id); }
      return json(res, 200, { ok: true });
    }

    // Ordner im Projekt anlegen (25.10.2026): ein Commit mit .gitkeep auf dem gewählten Zweig – wie ein Push.
    if (weg === '/neuer-ordner' && m === 'POST') {
      const b = await koerper(req); const pfad = await beschreibbar(b.pfad);
      const grund = await nurLesen(pfad);
      if (grund) throw new HttpFehler(403, grund);
      const zweig = repo.refPruefen(b.zweig || await baum.standardZweig(pfad));
      const r = await repo.ordnerAnlegen(baum.repoPfad(pfad), { zweig, ordner: b.ordner || '', name: b.name, autor: ich, nachricht: b.nachricht });
      await nachPush(pfad, ich, [{ ref: `refs/heads/${zweig}`, alt: r.alt || null, neu: r.sha }]);
      return json(res, 200, { ok: true, pfad: r.pfad, sha: r.sha, zweig });
    }
    if (weg === '/loeschen' && m === 'POST') {
      const b = await koerper(req); const pfad = await beschreibbar(b.pfad);
      const grund = await nurLesen(pfad);
      if (grund) throw new HttpFehler(403, grund);
      const zweig = repo.refPruefen(b.zweig || await baum.standardZweig(pfad));
      const r = await repo.entfernen(baum.repoPfad(pfad), { zweig, pfade: b.dateien, autor: ich, nachricht: b.nachricht });
      await nachPush(pfad, ich, [{ ref: `refs/heads/${zweig}`, alt: r.alt, neu: r.sha }]);
      return json(res, 200, { ok: true, sha: r.sha, zweig, dateien: r.dateien, ordner: r.ordner });
    }
    if (weg === '/neue-datei' && m === 'POST') {
      const b = await koerper(req); const pfad = await beschreibbar(b.pfad);
      const grund = await nurLesen(pfad);
      if (grund) throw new HttpFehler(403, grund);
      const zweig = repo.refPruefen(b.zweig || await baum.standardZweig(pfad));
      const r = await repo.dateiAnlegen(baum.repoPfad(pfad), { zweig, ordner: b.ordner || '', name: b.name, inhalt: b.inhalt || '', autor: ich, nachricht: b.nachricht });
      await nachPush(pfad, ich, [{ ref: `refs/heads/${zweig}`, alt: r.alt || null, neu: r.sha }]);
      return json(res, 200, { ok: true, pfad: r.pfad, sha: r.sha, zweig });
    }
    // Vorhandene Textdatei bearbeiten (Oberfläche): überschreibt als ein Commit, mit Konfliktschutz über die Blob-Kennung.
    if (weg === '/datei-speichern' && m === 'POST') {
      const b = await koerper(req); const pfad = await beschreibbar(b.pfad);
      const grund = await nurLesen(pfad);
      if (grund) throw new HttpFehler(403, grund);
      const zweig = repo.refPruefen(b.zweig || await baum.standardZweig(pfad));
      const r = await repo.dateiSpeichern(baum.repoPfad(pfad), { zweig, datei: b.datei, inhalt: b.inhalt || '', basis: b.basis || '', autor: ich, nachricht: b.nachricht });
      await nachPush(pfad, ich, [{ ref: `refs/heads/${zweig}`, alt: r.alt, neu: r.sha }]);
      return json(res, 200, { ok: true, pfad: r.pfad, sha: r.sha, zweig });
    }

    // Inhalt lesen
    if (weg === '/dateien' && m === 'GET') {
      const pfad = await lesbar(q.pfad); const r = baum.repoPfad(pfad);
      const ref = q.ref || await baum.standardZweig(pfad);
      const [eintraege, letzter] = await Promise.all([repo.ordnerInhalt(r, ref, q.ordner || ''), repo.letzterCommit(r, ref, q.ordner || '')]);
      return json(res, 200, { ref, eintraege, letzter });
    }
    if (weg === '/datei' && m === 'GET') {
      const pfad = await lesbar(q.pfad); const r = baum.repoPfad(pfad);
      const ref = q.ref || await baum.standardZweig(pfad);
      const [d, letzter] = await Promise.all([repo.datei(r, ref, q.datei), repo.letzterCommit(r, ref, q.datei)]);
      return json(res, 200, { ref, ...d, letzter });
    }
    if (weg === '/roh' && m === 'GET') {
      const pfad = await lesbar(q.pfad);
      const daten2 = await repo.roh(baum.repoPfad(pfad), q.ref || await baum.standardZweig(pfad), q.datei);
      const name = path.basename(q.datei || 'datei').replace(/["\r\n]/g, '_');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Content-Length': daten2.length });
      return res.end(daten2);
    }
    if (weg === '/bild' && m === 'GET') {
      // Bilder aus dem Repo (README, Bildvorschau) mit passendem Typ; SVG nur abgeschottet.
      const typ = BILDTYPEN[path.extname(String(q.datei || '')).toLowerCase()];
      if (!typ) throw new HttpFehler(415, 'Kein Bildformat');
      const pfad = await lesbar(q.pfad);
      const daten2 = await repo.roh(baum.repoPfad(pfad), q.ref || await baum.standardZweig(pfad), q.datei);
      res.writeHead(200, { 'Content-Type': typ, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60', 'Content-Length': daten2.length });
      return res.end(daten2);
    }
    if (weg === '/verlauf' && m === 'GET') {
      const pfad = await lesbar(q.pfad);
      const ref = q.ref || await baum.standardZweig(pfad);
      return json(res, 200, { ref, ...(await repo.verlauf(baum.repoPfad(pfad), ref, { datei: q.datei || '', seite: Number(q.seite) || 0 })) });
    }
    if (weg === '/commit' && m === 'GET') {
      const pfad = await lesbar(q.pfad);
      return json(res, 200, await repo.commit(baum.repoPfad(pfad), q.sha));
    }
    if (weg === '/archiv' && m === 'GET') {
      const pfad = await lesbar(q.pfad);
      const ref = repo.refPruefen(q.ref || await baum.standardZweig(pfad));
      const s = teile(pfad).at(-1);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${s}-${ref.replace(/[^A-Za-z0-9._-]/g, '_')}.zip"` });
      const kind = spawn('git', ['archive', '--format=zip', `--prefix=${s}/`, ref], { cwd: baum.repoPfad(pfad), env: { ...process.env, ...GIT_UMGEBUNG } });
      kind.stdout.pipe(res);
      kind.on('error', () => res.end());
      return;
    }

    // Weiterleitungen und Quellen: nur Administratoren (die Zugänge darin sieht sonst niemand).
    // Release-Ablage (1.12.0): Ordner durchsehen + zuordnen nur Admins; Herunterladen mit Leserecht aufs Projekt.
    if (weg === '/ablage' && m === 'GET') { nurAdmin(); return json(res, 200, { da: await ablage.da(), ...(await ablage.liste(q.ordner || '')) }); }
    if (weg === '/releases' && m === 'PUT') {
      nurAdmin();
      const b = await koerper(req); const pfad = await projektPfad(b.pfad);
      if (!Array.isArray(b.dateien) || b.dateien.length > 50) throw new HttpFehler(400, 'Dateien als Liste (höchstens 50)');
      const dateien = [];
      for (const d of b.dateien) {
        const rel = ablage.rel(d);
        const grund = ablage.gesperrt(rel);
        if (grund) throw new HttpFehler(400, `${rel}: ${grund}`);
        // muss da sein, eine echte Datei der Ablage; ZIPs mit Schlüsseln/Zugangsdaten nie zuordnen (alle mit Leserecht laden sie)
        const f = await ablage.oeffnen(rel);
        try {
          if (PRUEFBAR.test(f.name)) { const funde = await ablage.schluesselFunde(f.fh); if (funde.length) throw new HttpFehler(400, `${rel} enthält ${funde.join(' · ')}`); }
        } finally { await f.fh.close().catch(() => {}); }
        if (!dateien.includes(rel)) dateien.push(rel);
      }
      const oeffentlich = b.oeffentlich ? ablage.rel(b.oeffentlich) : null;
      if (oeffentlich && !dateien.includes(oeffentlich)) throw new HttpFehler(400, 'Die öffentliche Datei muss zugeordnet sein');
      if (oeffentlich && !PRUEFBAR.test(oeffentlich) && (await ablage.vermerkZustand(oeffentlich, (await ablage.info(oeffentlich)).groesse)) !== 'ok') {
        throw new HttpFehler(400, 'Öffentlich kann nur eine ZIP sein oder eine Datei mit Prüfvermerk des Bauskripts (<datei>.pruefung.json)');
      }
      if (!Array.isArray(b.verboten || []) || (b.verboten || []).length > 20) throw new HttpFehler(400, 'Verboten: Liste mit höchstens 20 Einträgen');
      const verboten = (b.verboten || []).map((v) => String(v).trim().slice(0, 100)).filter(Boolean);
      await baum.projektAendern(pfad, (p) => { p.releases = { dateien, oeffentlich, verboten }; });
      aktivitaet.melden({ art: 'projekt', projekt: pfad, nutzer: ich.name, anzeige: ich.anzeige,
        text: `Releases: ${dateien.length} Datei(en) zugeordnet${oeffentlich ? `, öffentlich: ${path.posix.basename(oeffentlich)}` : ', keine öffentlich'}` });
      return json(res, 200, await releasesDaten({ releases: { dateien, oeffentlich, verboten } }, ich));
    }
    if (weg === '/release-datei' && m === 'GET') {
      // Herunterladen per Nummer der Zuordnung (Leser kennen keine Pfade der Ablage)
      const pfad = await lesbar(q.pfad);
      const r = (await baum.projektMeta(pfad)).releases || {};
      const nr = Number(q.nr);
      const rel = Number.isInteger(nr) && nr >= 0 ? (r.dateien || [])[nr] : undefined;
      if (!rel) throw new HttpFehler(404, 'Diese Datei gehört nicht zum Projekt');
      const f = await ablage.oeffnen(rel);
      res.writeHead(200, downloadKopf(f.name, f.groesse));
      // pipeline schließt Datei und Antwort auch bei Abbruch (sonst bleiben Griffe offen)
      return pipeline(f.fh.createReadStream({ start: 0, end: Math.max(0, f.groesse - 1), autoClose: true }), res, () => { f.fh.close().catch(() => {}); });
    }
    if ((weg === '/spiegel' || weg.startsWith('/spiegel/') || weg === '/quelle' || weg.startsWith('/quelle/')) && m !== 'GET') nurAdmin();
    if (weg === '/spiegel' && m === 'POST') {
      const b = await koerper(req); const pfad = await projektPfad(b.pfad);
      if (b.github || b.github_neu) {
        // GitHub: Repo wählen oder neu (privat) anlegen. Übertragen wird nur, wenn der Betreiber es will („jetzt“ oder später von Hand).
        const token = await githubToken();
        const name = b.github_neu ? neuNamePruefen(b.github_neu) : null;
        const modus = b.modus === 'oeffentlich' ? 'oeffentlich' : 'voll';
        // Erst alles prüfen, dann auf GitHub anlegen – sonst bliebe bei Regel-/Zweigfehlern ein verwaistes Repo zurück.
        zweigListe(b.zweige);
        const grund = regelVerletzt((await einstellungen()).ziel_regeln || [], pfad, `${gh.web}/x/y.git`);
        if (grund) throw new HttpFehler(403, grund);
        let repoName; let sichtbarkeit;
        if (name) { repoName = (await gh.anlegen(token, name, (await baum.projektMeta(pfad)).beschreibung || '')).repo; sichtbarkeit = 'privat'; }
        else {
          repoName = repoPruefen(b.github);
          sichtbarkeit = (await gh.repoInfo(token, repoName)).privat ? 'privat' : 'oeffentlich';
        }
        const s = await spiegel.githubAnlegen(pfad, { repo: repoName, url: gh.pushAdresse(repoName), auto: b.auto === true, zweige: b.zweige, modus, sichtbarkeit, neu: !!name });
        if (Array.isArray(b.nur)) await spiegel.befund(pfad, { aktion: 'nur', fps: b.nur });
        if (b.jetzt === true) spiegel.weiterleiten(pfad, s.id).catch(() => {});
        return json(res, 200, s);
      }
      const s = await spiegel.weiterleitenAnlegen(pfad, b);
      spiegel.weiterleiten(pfad, s.id).catch(() => {});
      return json(res, 200, s);
    }
    if (weg === '/spiegel' && m === 'PATCH') {
      const b = await koerper(req); const pfad = await projektPfad(b.pfad);
      if (b.modus === 'voll') {
        // Wechsel auf „voll“ nur, wenn das GitHub-Repo JETZT privat ist (live, nicht nur gemerkt)
        const s = ((await baum.projektMeta(pfad)).spiegel || []).find((x) => x.id === b.id);
        if (s && s.art === 'github' && !(await gh.repoInfo(await githubToken(), s.repo)).privat) {
          throw new HttpFehler(400, 'Dieses GitHub-Repo ist öffentlich – „Vollständig mit Verlauf“ würde alle alten Stände mitschicken.');
        }
      }
      await spiegel.weiterleitenAendern(pfad, b.id, b);
      if (Array.isArray(b.nur)) await spiegel.befund(pfad, { aktion: 'nur', fps: b.nur });
      return json(res, 200, { ok: true });
    }
    if (weg === '/spiegel' && m === 'DELETE') { await spiegel.weiterleitenLoeschen(await projektPfad(q.pfad), q.id); return json(res, 200, { ok: true }); }
    if (weg === '/spiegel/ueberschreiben' && m === 'POST') {
      const b = await koerper(req);
      return json(res, 200, await spiegel.ueberschreiben(await projektPfad(b.pfad), b.id, b.refs, ich));
    }
    if (weg === '/spiegel/probelauf' && m === 'POST') {
      const b = await koerper(req);
      return json(res, 200, await spiegel.probelauf(await projektPfad(b.pfad), String(b.id || '')));
    }
    if (weg === '/spiegel/befund' && m === 'POST') {
      const b = await koerper(req);
      await spiegel.befund(await projektPfad(b.pfad), b.aktion === 'nur' ? { aktion: 'nur', fps: b.liste } : b);
      return json(res, 200, { ok: true });
    }
    if (weg === '/spiegel/jetzt' && m === 'POST') {
      const b = await koerper(req);
      return json(res, 200, await spiegel.weiterleiten(await projektPfad(b.pfad), b.id || null));
    }
    if (weg === '/quelle' && m === 'PUT') {
      const b = await koerper(req); const pfad = await projektPfad(b.pfad);
      await spiegel.quelleSetzen(pfad, b);
      return json(res, 200, await spiegel.abgleichen(pfad));
    }
    if (weg === '/quelle' && m === 'DELETE') { await spiegel.quelleEntfernen(await projektPfad(q.pfad)); return json(res, 200, { ok: true }); }
    if (weg === '/quelle/jetzt' && m === 'POST') {
      const b = await koerper(req); return json(res, 200, await spiegel.abgleichen(await projektPfad(b.pfad)));
    }

    // Übernahme (nur Administratoren)
    if (weg === '/import' && m === 'POST') {
      nurAdmin(); const b = await koerper(req);
      if (!b.basis || !b.schluessel) throw new HttpFehler(400, 'Adresse und Zugangsschlüssel der Quelle fehlen');
      const a = auftragStarten('import', (melde) => uebernehmen({ ...b, baum, spiegel, aktivitaet, nutzer: ich.name }, melde));
      return json(res, 200, { auftrag: a.id });
    }
    if (weg === '/auftrag' && m === 'GET') {
      nurAdmin(); const a = auftraege.get(q.id);
      if (!a) throw new HttpFehler(404, 'Auftrag unbekannt');
      return json(res, 200, a);
    }

    // Konto
    if (weg === '/konto' && m === 'GET') return json(res, 200, { ...ich, schluessel: await konten.schluesselListe(ich.name) });
    if (weg === '/konto' && m === 'PATCH') { const b = await koerper(req); await konten.aendernNutzer(ich.name, { anzeige: b.anzeige }); return json(res, 200, { ok: true }); }
    if (weg === '/konto/kennwort' && m === 'POST') {
      const b = await koerper(req);
      if (!(await konten.pruefen(ich.name, b.alt, absender(req)))) throw new HttpFehler(400, 'Das bisherige Kennwort stimmt nicht');
      await konten.kennwortSetzen(ich.name, b.neu);
      return json(res, 200, { ok: true }, { 'Set-Cookie': sitzungsCookie(req, await konten.sitzungErzeugen(ich.name), 30) });
    }
    if (weg === '/konto/schluessel' && m === 'POST') { const b = await koerper(req); return json(res, 200, await konten.schluesselErzeugen(ich.name, b.name, b.recht)); }
    if (weg === '/konto/schluessel' && m === 'DELETE') { await konten.schluesselLoeschen(ich.name, q.id); return json(res, 200, { ok: true }); }
    // Profilbild: roh als PNG, JPEG oder WebP (der Browser liefert 256 × 256), höchstens 300 KB, Dateianfang muss passen.
    if (weg === '/konto/bild' && m === 'PUT') {
      if (!artAusTyp(req.headers['content-type'])) throw new HttpFehler(415, 'Nur PNG, JPEG oder WebP als Profilbild');
      const roh = await rohKoerper(req, BILD_MAX, `Profilbild zu groß (höchstens ${BILD_MAX / 1024} KB)`);
      const art = bildArt(roh, req.headers['content-type']);
      if (!art) throw new HttpFehler(415, 'Die Datei ist kein gültiges PNG-, JPEG- oder WebP-Bild');
      return json(res, 200, { ok: true, bild: await konten.bildSetzen(ich.name, roh, art) });
    }
    if (weg === '/konto/bild' && m === 'DELETE') { await konten.bildEntfernen(ich.name); return json(res, 200, { ok: true }); }
    if (weg === '/profilbild' && m === 'GET') {
      const b = await konten.bildHolen(String(q.name || ''));
      const st = b ? await fsp.stat(b.datei).catch(() => null) : null;
      if (!st) throw new HttpFehler(404, 'Kein Profilbild');
      // Immer nachfragen, ob es noch stimmt (ETag); die Oberfläche hängt den Stand an, damit ein neues Bild sofort erscheint.
      const etag = `"${b.stand}-${st.size}"`;
      const kopf = { ETag: etag, 'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };
      const gemerkt = String(req.headers['if-none-match'] || '').split(',').map((x) => x.trim().replace(/^W\//, ''));
      if (gemerkt.includes(etag)) { res.writeHead(304, kopf); return res.end(); }
      const daten2 = await fsp.readFile(b.datei);
      res.writeHead(200, { ...kopf, 'Content-Type': b.typ, 'Content-Length': daten2.length });
      return res.end(daten2);
    }

    // Benutzer (nur Administratoren)
    if (weg === '/nutzer' && m === 'GET') { nurAdmin(); return json(res, 200, await konten.liste()); }
    if (weg === '/nutzer' && m === 'POST') { nurAdmin(); return json(res, 200, await konten.anlegen(await koerper(req))); }
    if (weg === '/nutzer' && m === 'PATCH') {
      nurAdmin(); const b = await koerper(req);
      if (b.freigaben != null) b.freigaben = await freigabenPruefen(b.freigaben);
      await konten.aendernNutzer(b.name, b);
      if (b.kennwort) await konten.kennwortSetzen(b.name, b.kennwort);
      return json(res, 200, { ok: true });
    }
    if (weg === '/nutzer' && m === 'DELETE') {
      nurAdmin();
      if (q.name === ich.name) throw new HttpFehler(400, 'Das eigene Konto lässt sich hier nicht löschen');
      await konten.loeschen(q.name); return json(res, 200, { ok: true });
    }
    if (weg === '/nutzer/umbenennen' && m === 'POST') {
      nurAdmin(); const b = await koerper(req);
      const n = await konten.umbenennen(String(b.name || ''), b.neu);
      if (n.name !== b.name) await aktivitaet.nutzerUmbenennen(b.name, n.name);
      // Wer sich selbst umbenennt, bleibt angemeldet.
      return json(res, 200, { nutzer: n }, b.name === ich.name ? { 'Set-Cookie': sitzungsCookie(req, await konten.sitzungErzeugen(n.name), 30) } : {});
    }
    // GitHub-Zugang (nur Administratoren). Der Token geht nur hinein, nie heraus.
    if (weg === '/github' || weg.startsWith('/github/')) nurAdmin();
    if (weg === '/github' && m === 'GET') {
      const g = (await einstellungen()).github;
      const meta = await baum.meta();
      const liste = [];
      for (const [pfad, p] of Object.entries(meta.projekte)) {
        for (const s of p.spiegel || []) if (s.art === 'github') liste.push({ projekt: pfad, name: p.name || pfad, ...spiegel.oeffentlich(s) });
      }
      liste.sort((x, y) => x.name.localeCompare(y.name, 'de'));
      return json(res, 200, { eingerichtet: !!(g && g.geheim), konto: g ? g.konto : null, geprueft: g ? g.geprueft : null, spiegel: liste,
        bereinigung: await bereinigungLesen(), weglassen_vorgabe: WEGLASSEN_VORGABE });
    }
    if (weg === '/github' && m === 'PUT') {
      const b = await koerper(req);
      const token = String(b.token || '').trim();
      if (token.length < 10 || token.length > 400 || /\s/.test(token)) throw new HttpFehler(400, 'Bitte den ganzen GitHub-Token einfügen');
      const { login, name } = await gh.konto(token);
      const geprueft = new Date().toISOString();
      await speicher.aendern('einstellungen.json', {}, (e) => { e.github = { konto: login, name, geheim: speicher.verschluesseln(token), geprueft }; });
      return json(res, 200, { eingerichtet: true, konto: login, geprueft });
    }
    if (weg === '/github' && m === 'DELETE') {
      await speicher.aendern('einstellungen.json', {}, (e) => { delete e.github; });
      return json(res, 200, { ok: true });
    }
    if (weg === '/github/pruefen' && m === 'POST') {
      const { login, name } = await gh.konto(await githubToken());
      const geprueft = new Date().toISOString();
      await speicher.aendern('einstellungen.json', {}, (e) => { if (e.github) { e.github.konto = login; e.github.name = name; e.github.geprueft = geprueft; } });
      return json(res, 200, { eingerichtet: true, konto: login, geprueft });
    }
    if (weg === '/github/repos' && m === 'GET') return json(res, 200, await gh.repos(await githubToken()));
    if (weg === '/github/bereinigung' && m === 'PUT') {
      const neu = bereinigungPruefen(await koerper(req));
      await speicher.aendern('einstellungen.json', {}, (e) => { e.github_bereinigung = neu; });
      return json(res, 200, neu);
    }
    if (weg === '/github/release' && m === 'PUT') {
      // Fertige Datei (z. B. Mac-App als ZIP) als GitHub-Release – Rohdaten im Körper, Angaben in der Adresse.
      const pfad = await projektPfad(q.pfad);
      const s = await releaseSpiegel(pfad, q.id);
      const tag = String(q.version || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(tag)) throw new HttpFehler(400, 'Version: Buchstaben, Ziffern, Punkt, Minus (z. B. 2026.11.20 oder v1.2.0)');
      const datei = String(q.datei || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,150}$/.test(datei)) throw new HttpFehler(400, 'Dateiname: Buchstaben, Ziffern, Leerzeichen, Punkt, Minus, Klammern');
      const groesse = Number(req.headers['content-length']);
      if (!Number.isFinite(groesse) || groesse <= 0) throw new HttpFehler(411, 'Größe der Datei fehlt');
      if (groesse > 2 * 1024 * 1024 * 1024 - 1) throw new HttpFehler(413, 'GitHub nimmt je Release-Datei höchstens 2 GB');
      return json(res, 200, await releaseVeroeffentlichen(pfad, s, { tag, titel: q.titel, text: q.text, datei, strom: req, groesse, ich }));
    }
    if (weg === '/github/release-ablage' && m === 'POST') {
      // 1.12.0: die als „öffentlich“ gewählte Datei aus der Ablage veröffentlichen – ohne Hochladen. Vorher ZIP-Inhalt prüfen.
      const b = await koerper(req); const pfad = await projektPfad(b.pfad);
      const s = await releaseSpiegel(pfad, b.id);
      const r = (await baum.projektMeta(pfad)).releases || {};
      if (!r.oeffentlich) throw new HttpFehler(400, 'Noch keine Datei als „öffentlich“ gewählt (Reiter Releases)');
      // EIN Griff auf die Datei: geprüft und hochgeladen wird genau dasselbe, auch wenn die Ablage sich dazwischen ändert
      const f = await ablage.oeffnen(r.oeffentlich);
      let strom = null;
      try {
        // Private Regeln des GitHub-Spiegels auch auf die Inhalte einer ISO anwenden (Begriffe selbst nie ausgeben)
        const bg = await bereinigungLesen();
        const verbotenAlle = [...new Set([...(bg.verboten || []), ...ersetzenVorbereiten(bg.ersetzen || []).filter((x) => x.klartext && x.klartext.trim().length >= 4).map((x) => x.klartext.trim())])];
        const textPruefer = (rel, text) => textPruefen(text, rel, verbotenAlle).filter((x) => ['privat', 'schluessel', 'token'].includes(x.art))
          .map((x) => `${x.art === 'privat' ? 'privater Begriff laut Bereinigung' : x.text}, Zeile ${x.zeile}`);
        await ablage.oeffentlichPruefen(f, r.verboten || [], { textPruefer });
        const vorher = await f.fh.stat();
        if (f.groesse > 2 * 1024 * 1024 * 1024 - 1) throw new HttpFehler(413, 'GitHub nimmt je Release-Datei höchstens 2 GB');
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,150}$/.test(f.name)) throw new HttpFehler(400, 'Dateiname: Buchstaben, Ziffern, Leerzeichen, Punkt, Minus, Klammern');
        const tag = String(b.version || '').trim() || versionAusZeit(f.zeit);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(tag)) throw new HttpFehler(400, 'Version: Buchstaben, Ziffern, Punkt, Minus (z. B. 2026.11.20 oder v1.2.0)');
        strom = f.fh.createReadStream({ start: 0, end: f.groesse - 1, autoClose: false, highWaterMark: 1024 * 1024 });
        const nachDemHochladen = async () => {
          const n = await f.fh.stat();
          if (n.size !== vorher.size || n.mtimeMs !== vorher.mtimeMs || n.ctimeMs !== vorher.ctimeMs) throw new HttpFehler(409, 'Die Datei wurde während des Hochladens verändert – Release zurückgenommen');
        };
        return json(res, 200, await releaseVeroeffentlichen(pfad, s, { tag, titel: b.titel, text: b.text, datei: f.name, strom, groesse: f.groesse, ich, quelle: r.oeffentlich, nachDemHochladen }));
      } finally { if (strom) strom.destroy(); await f.fh.close().catch(() => {}); }
    }
    if (weg === '/github/sichtbarkeit' && m === 'POST') {
      // Öffentlich nur für bereinigte Spiegel, die schon sauber übertragen haben; zurück auf privat geht immer.
      const b = await koerper(req); const pfad = await projektPfad(b.pfad);
      const s = ((await baum.projektMeta(pfad)).spiegel || []).find((x) => x.id === b.id && x.art === 'github');
      if (!s) throw new HttpFehler(404, 'Spiegel fehlt');
      const oeffentlich = b.oeffentlich === true;
      if (oeffentlich && s.modus !== 'oeffentlich') throw new HttpFehler(400, 'Öffentlich stellen geht nur bei „Öffentlicher Stand (bereinigt)“ – ein Vollspiegel trägt den ganzen Verlauf');
      if (oeffentlich && !(s.neu && !s.belastet)) throw new HttpFehler(400, 'Öffentlich stellen geht nur bei Repos, die FAH-Git selbst neu angelegt hat und die nie einen vollen Verlauf bekommen haben – ein vorhandenes Repo kann alte Stände enthalten (GitHub liefert alte Commits noch über ihre Kennung). Für die Veröffentlichung „Zu GitHub“ mit „Neues privates Repo anlegen“.');
      if (oeffentlich && !(s.zuletzt && s.zuletzt.ergebnis === 'ok')) throw new HttpFehler(400, 'Erst einmal sauber übertragen („Jetzt zu GitHub“), dann öffentlich stellen');
      if (oeffentlich) await spiegel.veroeffentlichungPruefen(pfad, s);
      const r = await gh.sichtbarkeitSetzen(await githubToken(), s.repo, oeffentlich);
      const wert = r.privat ? 'privat' : 'oeffentlich';
      await spiegel.sichtbarkeitMerken(pfad, s.id, wert);
      aktivitaet.melden({ art: 'spiegel', projekt: pfad, nutzer: ich.name, anzeige: ich.anzeige, ergebnis: 'ok', text: `GitHub ${s.repo} ist jetzt ${wert === 'privat' ? 'privat' : 'öffentlich'}` });
      return json(res, 200, { sichtbarkeit: wert });
    }

    if (weg === '/einstellungen' && m === 'GET') {
      nurAdmin();
      const e = await einstellungen();
      return json(res, 200, { ...e, github: e.github ? { konto: e.github.konto, eingerichtet: !!e.github.geheim, geprueft: e.github.geprueft } : null });
    }
    if (weg === '/einstellungen' && m === 'PUT') {
      nurAdmin(); const b = await koerper(req);
      const adresse = b.adresse !== undefined ? httpAdresse(b.adresse, 'Adresse für Klon-Links') : null;
      const fahnas = b.fahnas_adresse !== undefined ? httpAdresse(b.fahnas_adresse, 'FAH-NAS-Adresse') : null;
      let regeln = null;
      if (Array.isArray(b.ziel_regeln)) {
        regeln = [];
        for (const x of b.ziel_regeln.slice(0, 50)) {
          const host = String(x.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new HttpFehler(400, `Ungültiger Server: „${x.host}“`);
          const ordner = teile(x.ordner || '').join('/');
          if (!ordner || !(await baum.istOrdner(ordner))) throw new HttpFehler(400, `Ordner „${x.ordner}“ gibt es nicht`);
          regeln.push({ host, ordner });
        }
      }
      await speicher.aendern('einstellungen.json', {}, (e) => {
        if (adresse != null) e.adresse = adresse;
        if (fahnas != null) e.fahnas_adresse = fahnas;
        if (regeln) e.ziel_regeln = regeln;
      });
      return json(res, 200, { ok: true });
    }
    // Sicherung (nur Administratoren): der ganze Datenbestand – Repos + Konten/Rechte/Schlüssel/Weiterleitungen – als eine Datei.
    if (weg === '/sicherung' && m === 'GET') { nurAdmin(); return json(res, 200, await sicherung.uebersicht()); }
    if (weg === '/sicherung/export' && m === 'GET') { nurAdmin(); return sicherung.herunterladen(res); }
    if (weg === '/sicherung/fortschritt' && m === 'GET') { nurAdmin(); return json(res, 200, sicherung.stand || { laeuft: false, schritte: [] }); }
    if (weg === '/sicherung/jetzt' && m === 'POST') { nurAdmin(); const b = await koerper(req); return json(res, 200, b.hintergrund ? sicherung.jetztImHintergrund('von Hand') : await sicherung.jetzt('von Hand')); }
    if (weg === '/sicherung/smb' && m === 'PUT') { nurAdmin(); return json(res, 200, await sicherung.smbSpeichern(await koerper(req))); }
    if (weg === '/sicherung/smb/pruefen' && m === 'POST') { nurAdmin(); return json(res, 200, await sicherung.smbPruefen()); }
    if (weg === '/sicherung/smb/blaettern' && m === 'POST') { nurAdmin(); return json(res, 200, await sicherung.smbBlaettern(await koerper(req))); }
    if (weg === '/sicherung/kopieren' && m === 'POST') { nurAdmin(); const b = await koerper(req); return json(res, 200, b.hintergrund ? await sicherung.kopieImHintergrund(b.name) : await sicherung.smbKopieren(b.name)); }
    if (weg === '/sicherung/auto' && m === 'PUT') {
      nurAdmin(); const b = await koerper(req);
      const behalten = Math.max(1, Math.min(90, Number(b.behalten) || 14));
      await speicher.aendern('einstellungen.json', {}, (e) => { e.sicherung = { auto: b.auto !== false, behalten }; });
      return json(res, 200, { ok: true });
    }
    if (weg === '/sicherung' && m === 'DELETE') { nurAdmin(); await sicherung.loeschen(q.name); return json(res, 200, { ok: true }); }
    if (weg === '/sicherung/einspielen' && m === 'PUT') {
      nurAdmin();
      const manifest = await sicherung.hochladenUndEinspielen(req);
      // Nach erfolgreichem Einspielen den Dienst neu starten, damit alles frisch aus dem wiederhergestellten Ordner lädt
      // (Container läuft mit restart:unless-stopped und kommt von selbst zurück).
      json(res, 200, { ok: true, manifest, neustart: true });
      setTimeout(() => process.exit(0), 1500).unref?.();
      return;
    }
    throw new HttpFehler(404, 'Unbekannter Aufruf');
  }

  // --- Dateien der Oberfläche ---------------------------------------------------------------------------------------

  async function statisch(req, res, url) {
    let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/static\//, '');
    if (!url.pathname.startsWith('/static/') && url.pathname !== '/') rel = 'index.html';
    const datei = path.join(OEFFENTLICH, rel);
    if (!datei.startsWith(OEFFENTLICH + path.sep)) throw new HttpFehler(404, 'Nicht gefunden');
    let inhalt;
    try { inhalt = await fsp.readFile(datei); } catch { throw new HttpFehler(404, 'Nicht gefunden'); }
    res.writeHead(200, {
      'Content-Type': TYPEN[path.extname(datei)] || 'application/octet-stream',
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    });
    res.end(inhalt);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const g = gitAnfrage(req.url);
      if (g) return await gitHttp(req, res, g);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpFehler(405, 'Methode nicht erlaubt');
      return await statisch(req, res, url);
    } catch (e) {
      const status = e.status || (e instanceof BaumFehler ? 400 : 500);
      if (status >= 500) console.error(e);
      if (!res.headersSent) json(res, status, { fehler: e.message || 'Fehler' });
      else res.end();
    }
  });
  server.requestTimeout = 0; // große Pushes dürfen dauern
  server.headersTimeout = 60_000;
  return { server, speicher, baum, konten, spiegel, aktivitaet, sicherung };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3300);
  const { server, spiegel, sicherung } = erstelleServer({ daten: process.env.FAHGIT_DATEN || '/daten', oeffentlicheAdresse: process.env.FAHGIT_ADRESSE || '' });
  spiegel.starten();
  sicherung.starten();
  server.listen(port, () => console.log(`FAH-Git ${VERSION} hört auf Port ${port}`));
  const ende = () => { spiegel.stoppen(); sicherung.stoppen(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', ende); process.on('SIGINT', ende);
}
