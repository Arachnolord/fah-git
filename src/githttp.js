// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Git über HTTP („smart HTTP“): Die Arbeit macht das mitgelieferte `git http-backend` (CGI). Hier nur Weg finden,
// anmelden, Anfrage durchreichen und nach einem Push melden, welche Zweige sich geändert haben.
// Rechte (1.4.0): klonen/holen (upload-pack) braucht Lesen, pushen (receive-pack) Schreiben; ein Schlüssel „Nur lesen“
// darf nie pushen.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { GIT_UMGEBUNG, refs } from './git.js';
import { recht, KEIN, LESEN, SCHREIBEN } from './rechte.js';

/** Erkennt Git-Anfragen: „/a/b.git/info/refs“, „/a/b/git-upload-pack“ … → {pfad, rest} oder null. */
export function gitAnfrage(url) {
  const u = new URL(url, 'http://x');
  const m = u.pathname.match(/^\/(.+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/.+)$/);
  if (!m) return null;
  if (m[2] === 'info/refs' && !/^git-(upload|receive)-pack$/.test(u.searchParams.get('service') || '')) return null;
  return { pfad: decodeURIComponent(m[1]), rest: m[2], dienst: m[2] === 'info/refs' ? u.searchParams.get('service') : m[2], query: u.search.slice(1) };
}

/** Absender: hinter dem FAH-Proxy steht die echte Adresse als letzter Eintrag in X-Forwarded-For (Caddy setzt ihn selbst). */
export function absender(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || '');
}

function basic(kopf) {
  const m = /^Basic\s+(.+)$/i.exec(String(kopf || ''));
  if (!m) return null;
  const t = Buffer.from(m[1], 'base64').toString('utf8');
  const i = t.indexOf(':');
  return i < 0 ? null : { name: t.slice(0, i), geheim: t.slice(i + 1) };
}

/**
 * @param {object} umgebung {baum, konten, nachPush(pfad, nutzer, aenderungen), nurLesen(pfad) → Text|null,
 *   zusatzAnmeldung(name, geheim, quelle) → Nutzer|null (Fail-over-Ersatz, nur lesen)}
 */
export function gitBearbeiter({ baum, konten, nachPush, nurLesen, zusatzAnmeldung = null }) {
  return async function bearbeite(req, res, anfrage) {
    const anmeldung = basic(req.headers.authorization);
    const quelle = absender(req);
    let nutzer = null;
    try {
      nutzer = anmeldung ? ((zusatzAnmeldung && zusatzAnmeldung(anmeldung.name, anmeldung.geheim, quelle)) || await konten.gitAnmeldung(anmeldung.name, anmeldung.geheim, quelle)) : null;
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(e.message);
    }
    if (!nutzer) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FAH-Git", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Anmeldung nötig: Benutzername und Kennwort oder Zugangsschlüssel');
    }
    let pfad;
    try { pfad = await baum.aufloesen(anfrage.pfad); } catch { pfad = null; }
    // Ohne Freigabe gibt es das Projekt für diesen Nutzer nicht (404 verrät nichts).
    const darf = pfad ? recht(nutzer, pfad) : KEIN;
    if (!pfad || darf < LESEN || !(await baum.istProjekt(pfad))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Projekt nicht gefunden');
    }
    const schreiben = anfrage.dienst === 'git-receive-pack';
    if (schreiben && darf < SCHREIBEN) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(nutzer.leseSchluessel
        ? 'Dieser Zugangsschlüssel darf nur lesen (klonen, holen). Zum Pushen einen Schlüssel „Lesen und schreiben“ verwenden.'
        : 'Für dieses Projekt hast du nur Leserecht – Pushen ist nicht erlaubt.');
    }
    if (schreiben) {
      const grund = await nurLesen(pfad);
      if (grund) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(grund);
      }
    }
    const repo = baum.repoPfad(pfad);
    const vorher = schreiben && anfrage.rest === 'git-receive-pack' ? await refs(repo).catch(() => new Map()) : null;
    const env = {
      ...process.env, ...GIT_UMGEBUNG,
      GIT_PROJECT_ROOT: path.dirname(repo),
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${path.basename(repo)}/${anfrage.rest}`,
      QUERY_STRING: anfrage.query,
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_USER: nutzer.name,
      REMOTE_ADDR: quelle,
      GIT_COMMITTER_NAME: nutzer.anzeige,
      GIT_COMMITTER_EMAIL: `${nutzer.name}@fah-git`,
    };
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    const kind = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let kopfFertig = false; let puffer = Buffer.alloc(0); let fehler = '';
    kind.stderr.on('data', (d) => { if (fehler.length < 8192) fehler += d.toString(); });
    kind.stdout.on('data', (d) => {
      if (kopfFertig) { res.write(d); return; }
      puffer = Buffer.concat([puffer, d]);
      let ende = puffer.indexOf('\r\n\r\n'); let sep = 4;
      if (ende < 0) { ende = puffer.indexOf('\n\n'); sep = 2; }
      if (ende < 0) return;
      const kopf = puffer.subarray(0, ende).toString('latin1');
      let status = 200; const koepfe = {};
      for (const zeile of kopf.split(/\r?\n/)) {
        const i = zeile.indexOf(':');
        if (i < 0) continue;
        const k = zeile.slice(0, i).trim(); const v = zeile.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200; else koepfe[k] = v;
      }
      res.writeHead(status, koepfe);
      kopfFertig = true;
      const rest = puffer.subarray(ende + sep);
      if (rest.length) res.write(rest);
    });
    kind.on('close', async (code) => {
      if (!kopfFertig) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`git http-backend: ${fehler.trim() || code}`);
      } else res.end();
      if (vorher) {
        const nachher = await refs(repo).catch(() => new Map());
        const aenderungen = [];
        for (const ref of new Set([...vorher.keys(), ...nachher.keys()])) {
          if (vorher.get(ref) !== nachher.get(ref)) aenderungen.push({ ref, alt: vorher.get(ref) || null, neu: nachher.get(ref) || null });
        }
        if (aenderungen.length) nachPush(pfad, nutzer, aenderungen);
      }
    });
    kind.on('error', () => { if (!kopfFertig) { res.writeHead(500); res.end('git fehlt'); } });
    req.pipe(kind.stdin);
    kind.stdin.on('error', () => {});
  };
}
