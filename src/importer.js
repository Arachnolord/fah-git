// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Übernahme aus GitLab oder Gitea per Weboberfläche: Projekte samt Ordnerstruktur (Gruppen → Ordner), Beschreibung,
// Themen, allen Zweigen und Tags und dem Standardzweig. Wahlweise einmalig oder als laufende Kopie (Quelle).

import { git, gitText } from './git.js';
import { slug, teile } from './baum.js';
import { adressePruefen } from './spiegel.js';

async function holeJson(url, kopf) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...kopf }, signal: AbortSignal.timeout(30_000) });
  if (r.status === 401 || r.status === 403) {
    const text = await r.text().catch(() => '');
    throw Object.assign(new Error('Der Zugangsschlüssel wurde abgelehnt'), { status: 400, abgelehnt: true, text });
  }
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).pathname}: HTTP ${r.status}`), { status: 400 });
  return { daten: await r.json(), naechste: r.headers.get('x-next-page') };
}

/** Welche Art Server? → 'gitlab' | 'gitea' */
export async function erkennen(basis, schluessel) {
  try { await holeJson(`${basis}/api/v4/version`, { 'PRIVATE-TOKEN': schluessel }); return 'gitlab'; } catch (e) {
    // GitLab antwortet bei falschem Schlüssel mit {"message":"401 Unauthorized"}; andere Server sagen nur „nicht hier“.
    if (e.abgelehnt && /"message"\s*:\s*"40[13]/.test(e.text || '')) throw e;
  }
  try { await holeJson(`${basis}/api/v1/version`, { Authorization: `token ${schluessel}` }); return 'gitea'; } catch { /* weiter */ }
  throw Object.assign(new Error('Unter dieser Adresse antwortet weder GitLab noch Gitea'), { status: 400 });
}

/**
 * Projekte der Quelle als einheitliche Liste: {pfad (relativ zum Bereich), ordnerNamen[], name, beschreibung, themen,
 * standard, klon}.
 */
export async function auflisten(basis, schluessel, art, bereich = '') {
  const vorne = teile(bereich.toLowerCase()).join('/');
  const projekte = [];
  if (art === 'gitlab') {
    const k = { 'PRIVATE-TOKEN': schluessel };
    const gruppen = new Map();
    for (let seite = 1; seite; ) {
      const { daten, naechste } = await holeJson(`${basis}/api/v4/groups?all_available=true&per_page=100&page=${seite}`, k);
      for (const g of daten) gruppen.set(g.full_path.toLowerCase(), g.name);
      seite = naechste ? Number(naechste) : 0;
    }
    for (let seite = 1; seite; ) {
      const { daten, naechste } = await holeJson(`${basis}/api/v4/projects?membership=true&archived=false&per_page=100&page=${seite}&order_by=path&sort=asc`, k);
      for (const p of daten) {
        const voll = p.path_with_namespace.toLowerCase();
        if (vorne && !voll.startsWith(vorne + '/')) continue;
        const rel = (vorne ? voll.slice(vorne.length + 1) : voll).split('/');
        const ordnerNamen = rel.slice(0, -1).map((_, i) => gruppen.get([...(vorne ? vorne.split('/') : []), ...rel.slice(0, i + 1)].join('/')) || rel[i]);
        projekte.push({ quelle: p.path_with_namespace, pfad: rel.map(slug).join('/'), ordnerNamen, name: p.name, beschreibung: p.description || '',
          themen: p.topics || p.tag_list || [], standard: p.default_branch || 'main', klon: p.http_url_to_repo, leer: !p.default_branch });
      }
      seite = naechste ? Number(naechste) : 0;
    }
  } else {
    const k = { Authorization: `token ${schluessel}` };
    for (let seite = 1; seite < 100; seite++) {
      const { daten } = await holeJson(`${basis}/api/v1/repos/search?limit=50&page=${seite}`, k);
      const liste = daten.data || [];
      for (const r of liste) {
        const voll = r.full_name.toLowerCase();
        if (vorne && !voll.startsWith(vorne + '/')) continue;
        const rel = (vorne ? voll.slice(vorne.length + 1) : voll).split('/');
        projekte.push({ quelle: r.full_name, pfad: rel.map(slug).join('/'), ordnerNamen: rel.length > 1 ? [r.owner.full_name || r.owner.login] : [],
          name: r.name, beschreibung: r.description || '', themen: r.topics || [], standard: r.default_branch || 'main', klon: r.clone_url, leer: r.empty });
      }
      if (liste.length < 50) break;
    }
  }
  return projekte;
}

/**
 * Übernahme als Auftrag. `melde(text)` gibt Fortschritt weiter.
 * @param {object} o {baum, spiegel, aktivitaet, nutzer, basis, schluessel, benutzer, bereich, ziel, laufend, takt}
 */
export async function uebernehmen(o, melde) {
  const basis = adressePruefen(o.basis).replace(/\/+$/, '');
  const art = await erkennen(basis, o.schluessel);
  melde(`${art === 'gitlab' ? 'GitLab' : 'Gitea'} erkannt – lese die Projektliste …`);
  const liste = await auflisten(basis, o.schluessel, art, o.bereich || '');
  if (!liste.length) throw Object.assign(new Error('Keine Projekte gefunden (Bereich und Rechte des Schlüssels prüfen)'), { status: 400 });
  const ziel = teile(o.ziel || '');
  const ergebnis = { neu: [], vorhanden: [], fehler: [] };
  const env = { GIT_ASKPASS: o.spiegel.askpass, FAHGIT_BENUTZER: o.benutzer || (art === 'gitlab' ? 'oauth2' : 'git'), FAHGIT_GEHEIM: o.schluessel };
  let nr = 0;
  for (const p of liste) {
    nr += 1;
    const teilePfad = [...ziel, ...p.pfad.split('/')];
    const pfad = teilePfad.join('/');
    melde(`${nr}/${liste.length}: ${p.quelle}`);
    try {
      if (await o.baum.istProjekt(pfad)) { ergebnis.vorhanden.push(pfad); continue; }
      const ordner = await o.baum.ordnerKette(teilePfad.slice(0, -1), [...ziel.map(() => null), ...p.ordnerNamen]);
      await o.baum.projektAnlegen(ordner, p.name, { slugWert: teilePfad.at(-1), beschreibung: p.beschreibung, themen: p.themen, standard: p.standard });
      const repo = o.baum.repoPfad(pfad);
      if (!p.leer) {
        await git(['-c', 'credential.helper=', 'fetch', '--quiet', p.klon, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
          { cwd: repo, env, zeitlimitMs: 60 * 60_000 });
        await o.baum.standardZweigSetzen(pfad, p.standard).catch(() => {});
        const zweige = (await gitText(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: repo })).split('\n').filter(Boolean);
        if (zweige.length && !zweige.includes(p.standard)) await o.baum.standardZweigSetzen(pfad, zweige[0]);
      }
      if (o.laufend) {
        const u = new URL(p.klon);
        await o.spiegel.quelleSetzen(pfad, { url: u.toString(), benutzer: env.FAHGIT_BENUTZER, geheim: o.schluessel, takt: o.takt });
        await o.baum.projektAendern(pfad, (m) => { m.quelle.zuletzt = { zeit: new Date().toISOString(), ergebnis: 'ok', text: 'Stand übernommen' }; });
      }
      await o.baum.projektAendern(pfad, (m) => { m.zuletzt = new Date().toISOString(); m.herkunft = `${basis}/${p.quelle}`; });
      ergebnis.neu.push(pfad);
    } catch (e) {
      ergebnis.fehler.push({ pfad, text: String(e.stderr || e.message).trim().split('\n').pop().slice(0, 300) });
    }
  }
  o.aktivitaet.melden({ art: 'import', nutzer: o.nutzer, projekt: ziel.join('/') || null,
    text: `Übernahme aus ${basis}: ${ergebnis.neu.length} neu, ${ergebnis.vorhanden.length} schon vorhanden, ${ergebnis.fehler.length} Fehler` });
  return ergebnis;
}
