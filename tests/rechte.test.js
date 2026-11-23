// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rechte je Ordner/Projekt (1.4.0): echter Server, echte git-Aufrufe. Ein Nicht-Admin sieht nur Freigegebenes (sonst 404),
// liest mit „lesen“, schreibt mit „schreiben“; Verwaltung bleibt Admins vorbehalten.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { erstelleServer } from '../src/server.js';

const execFileP = promisify(execFile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-rechte-'));
let s; let basis; let chef = ''; let gast = ''; let gastSchluessel = '';

async function rufe(methode, weg, daten, k) {
  const r = await fetch(basis + weg, { method: methode, headers: { 'Content-Type': 'application/json', 'X-FAHGIT': '1', ...(k ? { Cookie: k } : {}) },
    body: daten ? JSON.stringify(daten) : undefined });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { status: r.status, daten: d, kopf: r.headers };
}
const alsChef = (m, w, d) => rufe(m, w, d, chef);
const alsGast = (m, w, d) => rufe(m, w, d, gast);
const anmelden = async (name, kennwort) => (await rufe('POST', '/api/anmelden', { name, kennwort })).kopf.get('set-cookie').split(';')[0];
const gitAus = async (args, cwd) => (await execFileP('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Gast', GIT_AUTHOR_EMAIL: 'g@g', GIT_COMMITTER_NAME: 'Gast', GIT_COMMITTER_EMAIL: 'g@g', HOME: tmp } })).stdout;
const adresse = (pfad, geheim = gastSchluessel) => basis.replace('http://', `http://gast:${geheim}@`) + `/${pfad}.git`;
/** Alle Projektpfade eines Baums (so sucht die Oberfläche). */
const projektPfade = (k) => [...k.projekte.map((p) => p.pfad), ...k.ordner.flatMap(projektPfade)];
const freigeben = (freigaben) => alsChef('PATCH', '/api/nutzer', { name: 'gast', freigaben });

before(async () => {
  s = erstelleServer({ daten: path.join(tmp, 'daten') });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${s.server.address().port}`;
  chef = (await rufe('POST', '/api/ersteinrichtung', { name: 'chef', kennwort: 'chef12345' })).kopf.get('set-cookie').split(';')[0];
  for (const [eltern, name] of [['', 'Privat'], ['', 'Team'], ['team', 'Web']]) await alsChef('POST', '/api/ordner', { eltern, name, beschreibung: `Beschreibung ${name}` });
  for (const [ordner, name] of [['privat', 'Mikrotik'], ['team', 'Doku'], ['team/web', 'Seite']]) await alsChef('POST', '/api/projekte', { ordner, name, readme: true });
  assert.equal((await alsChef('POST', '/api/nutzer', { name: 'gast', kennwort: 'gast12345' })).status, 200);
  gast = await anmelden('gast', 'gast12345');
  gastSchluessel = (await alsGast('POST', '/api/konto/schluessel', { name: 'Gast-Mac' })).daten.geheim;
});
after(() => { s.server.close(); s.spiegel.stoppen(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Ohne Freigabe sieht ein Nicht-Admin nichts und bekommt 404', async () => {
  assert.deepEqual((await alsGast('GET', '/api/status')).daten.nutzer.freigaben, []);
  assert.deepEqual((await alsGast('GET', '/api/baum')).daten, { ordner: [], projekte: [] });
  const u = (await alsGast('GET', '/api/uebersicht')).daten;
  assert.equal(u.projekte, 0); assert.equal(u.ordner, 0); assert.deepEqual(u.aktivitaet, []); assert.deepEqual(u.zuletzt, []); assert.equal(u.nutzer, null);
  for (const weg of ['/api/projekt?pfad=privat/mikrotik', '/api/dateien?pfad=privat/mikrotik', '/api/datei?pfad=privat/mikrotik&datei=README.md',
    '/api/roh?pfad=privat/mikrotik&datei=README.md', '/api/verlauf?pfad=privat/mikrotik', '/api/archiv?pfad=privat/mikrotik', '/api/bild?pfad=privat/mikrotik&datei=a.png',
    '/api/projekt?pfad=gibt/es/nicht']) {
    const r = await alsGast('GET', weg);
    assert.equal(r.status, 404, weg); assert.equal(r.daten.fehler, 'Projekt nicht gefunden', 'gleiche Antwort wie „gibt es nicht“');
  }
  assert.equal((await alsGast('POST', '/api/projekte', { ordner: 'team', name: 'x' })).status, 404);
  assert.equal((await alsGast('POST', '/api/neue-datei', { pfad: 'privat/mikrotik', zweig: 'main', name: 'x', inhalt: 'x' })).status, 404);
  assert.equal((await alsGast('POST', '/api/ordner', { eltern: '', name: 'x' })).status, 403);
  await assert.rejects(gitAus(['clone', '-q', adresse('privat/mikrotik'), path.join(tmp, 'nix')], tmp), /nicht gefunden|not found|404/);
  // Schlüssel des Gasts per Schnittstelle: dieselben Rechte
  const b = await fetch(`${basis}/api/baum`, { headers: { Authorization: `Bearer ${gastSchluessel}` } });
  assert.deepEqual(await b.json(), { ordner: [], projekte: [] });
});

test('Freigaben prüft der Server: nur vorhandene Pfade, nur lesen/schreiben, nur Admins', async () => {
  assert.equal((await freigeben([{ pfad: 'gibt/es/nicht', recht: 'lesen' }])).status, 400);
  assert.equal((await freigeben([{ pfad: 'team', recht: 'alles' }])).status, 400);
  assert.equal((await alsGast('PATCH', '/api/nutzer', { name: 'gast', freigaben: [{ pfad: '', recht: 'schreiben' }] })).status, 403);
  assert.equal((await freigeben([{ pfad: 'team/web', recht: 'lesen' }, { pfad: 'team/web/', recht: 'lesen' }])).status, 200);
  assert.deepEqual((await alsChef('GET', '/api/nutzer')).daten.find((n) => n.name === 'gast').freigaben, [{ pfad: 'team/web', recht: 'lesen' }]);
});

test('„lesen“ auf einem Ordner: sieht nur ihn (Eltern nur als Weg), liest und klont, schreibt nicht', async () => {
  const b = (await alsGast('GET', '/api/baum')).daten;
  assert.deepEqual(b.ordner.map((o) => o.pfad), ['team'], 'Privat bleibt unsichtbar');
  assert.equal(b.ordner[0].weg, true); assert.equal(b.ordner[0].beschreibung, '', 'Weg nur mit Namen');
  assert.deepEqual(b.ordner[0].projekte, [], 'Geschwister (Doku) unsichtbar');
  assert.equal(b.ordner[0].ordner[0].pfad, 'team/web'); assert.equal(b.ordner[0].ordner[0].beschreibung, 'Beschreibung Web');
  assert.deepEqual(projektPfade(b), ['team/web/seite'], 'Suche findet nur Freigegebenes');
  const u = (await alsGast('GET', '/api/uebersicht')).daten;
  assert.equal(u.projekte, 1); assert.ok(u.zuletzt.every((x) => x.pfad.startsWith('team/web/')));
  assert.ok(u.aktivitaet.length && u.aktivitaet.every((e) => e.projekt.startsWith('team/web')), JSON.stringify(u.aktivitaet));
  assert.deepEqual((await alsGast('GET', '/api/aktivitaet?projekt=privat/mikrotik')).daten, []);
  // lesen
  for (const weg of ['/api/projekt?pfad=team/web/seite', '/api/dateien?pfad=team/web/seite', '/api/datei?pfad=team/web/seite&datei=README.md',
    '/api/verlauf?pfad=team/web/seite', '/api/archiv?pfad=team/web/seite']) assert.equal((await alsGast('GET', weg)).status, 200, weg);
  assert.equal((await alsGast('GET', '/api/projekt?pfad=team/doku')).status, 404);
  const klon = path.join(tmp, 'seite');
  await gitAus(['clone', '-q', adresse('team/web/seite'), klon]);
  assert.ok(fs.existsSync(path.join(klon, 'README.md')));
  await assert.rejects(gitAus(['clone', '-q', adresse('team/doku'), path.join(tmp, 'doku')], tmp), /nicht gefunden|not found|404/);
  // schreiben: 403 (sichtbar, aber nur lesbar)
  const pr = 'team/web/seite';
  for (const [m, w, d] of [['POST', '/api/neue-datei', { pfad: pr, zweig: 'main', name: 'x.txt', inhalt: 'x' }], ['POST', '/api/neuer-ordner', { pfad: pr, zweig: 'main', name: 'x' }],
    ['POST', '/api/loeschen', { pfad: pr, zweig: 'main', dateien: ['README.md'] }], ['POST', '/api/hochladen/start', { pfad: pr, zweig: 'main' }],
    ['DELETE', `/api/zweig?pfad=${pr}&name=x`], ['PATCH', '/api/projekt', { pfad: pr, beschreibung: 'neu' }],
    ['POST', '/api/projekte', { ordner: 'team/web', name: 'neu' }], ['POST', '/api/ordner', { eltern: 'team/web', name: 'neu' }]]) {
    const r = await alsGast(m, w, d);
    assert.equal(r.status, 403, `${m} ${w}: ${JSON.stringify(r.daten)}`); assert.match(r.daten.fehler, /Leserecht/);
  }
  fs.writeFileSync(path.join(klon, 'neu.txt'), 'n\n');
  await gitAus(['add', '.'], klon); await gitAus(['commit', '-q', '-m', 'darf nicht'], klon);
  await assert.rejects(gitAus(['push', '-q', 'origin', 'main'], klon), /Leserecht|403/);
});

test('Verwaltung bleibt Admins vorbehalten (Weiterleitungen, Quellen, Verschieben, Einstellungen …)', async () => {
  const pr = 'team/web/seite';
  for (const [m, w, d] of [['POST', '/api/verschieben', { pfad: pr, ziel: 'team' }], ['PATCH', '/api/ordner', { pfad: 'team/web', name: 'x' }],
    ['DELETE', '/api/ordner?pfad=team/web'], ['DELETE', `/api/projekt?pfad=${pr}&bestaetigung=seite`],
    ['POST', '/api/spiegel', { pfad: pr, url: 'http://git.example/x.git' }], ['PATCH', '/api/spiegel', { pfad: pr, id: 'x' }], ['DELETE', `/api/spiegel?pfad=${pr}&id=x`],
    ['POST', '/api/spiegel/jetzt', { pfad: pr }], ['POST', '/api/spiegel/ueberschreiben', { pfad: pr, id: 'x', refs: [] }],
    ['PUT', '/api/quelle', { pfad: pr, url: 'http://git.example/x.git' }], ['DELETE', `/api/quelle?pfad=${pr}`], ['POST', '/api/quelle/jetzt', { pfad: pr }],
    ['POST', '/api/import', { basis: 'http://git.example', schluessel: 'x' }], ['GET', '/api/auftrag?id=x'],
    ['GET', '/api/einstellungen'], ['PUT', '/api/einstellungen', { adresse: '' }], ['GET', '/api/nutzer'], ['POST', '/api/nutzer/umbenennen', { name: 'gast', neu: 'g' }]]) {
    assert.equal((await alsGast(m, w, d)).status, 403, `${m} ${w}`);
  }
});

test('„schreiben“: pushen, hochladen, anlegen im Ordner – aber nicht umbenennen, verschieben, ganz oben anlegen', async () => {
  assert.equal((await freigeben([{ pfad: 'team/web', recht: 'schreiben' }, { pfad: 'privat/mikrotik', recht: 'lesen' }])).status, 200);
  const pr = 'team/web/seite';
  const klon = path.join(tmp, 'seite');
  await gitAus(['push', '-q', 'origin', 'main'], klon);
  assert.equal((await alsGast('GET', `/api/datei?pfad=${pr}&datei=neu.txt`)).daten.text, 'n\n');
  let r = await alsGast('POST', '/api/neue-datei', { pfad: pr, zweig: 'main', name: 'notiz.md', inhalt: '# N\n' });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  const st = (await alsGast('POST', '/api/hochladen/start', { pfad: pr, zweig: 'main' })).daten;
  const put = await fetch(`${basis}/api/hochladen/datei?id=${st.id}&datei=hoch.txt`, { method: 'PUT', headers: { 'X-FAHGIT': '1', Cookie: gast }, body: 'h\n' });
  assert.equal(put.status, 200);
  assert.equal((await alsGast('POST', '/api/hochladen/fertig', { id: st.id })).status, 200);
  assert.equal((await alsGast('POST', '/api/projekte', { ordner: 'team/web', name: 'Neu', readme: true })).status, 200);
  assert.equal((await alsGast('POST', '/api/ordner', { eltern: 'team/web', name: 'Unter' })).status, 200);
  assert.equal((await alsGast('PATCH', '/api/projekt', { pfad: pr, beschreibung: 'vom Gast', name: 'Seite' })).status, 200, 'gleicher Name = kein Umbenennen');
  assert.equal((await alsGast('PATCH', '/api/projekt', { pfad: pr, name: 'Anders' })).status, 403);
  assert.equal((await alsGast('POST', '/api/projekte', { ordner: '', name: 'oben' })).status, 404, 'ganz oben nicht freigegeben');
  assert.equal((await alsGast('POST', '/api/ordner', { eltern: '', name: 'oben' })).status, 403);
  assert.equal((await alsGast('POST', '/api/projekte', { ordner: 'team', name: 'daneben' })).status, 404, 'Weg-Ordner ist nicht beschreibbar');
  assert.equal((await alsGast('POST', '/api/verschieben', { pfad: pr, ziel: 'team' })).status, 403);
  // „lesen“ auf ein zweites Projekt: lesen ja, pushen nein
  assert.equal((await alsGast('GET', '/api/projekt?pfad=privat/mikrotik')).status, 200);
  assert.equal((await alsGast('POST', '/api/neue-datei', { pfad: 'privat/mikrotik', zweig: 'main', name: 'x', inhalt: 'x' })).status, 403);
  // Zugänge der Weiterleitungen sieht nur der Admin
  assert.equal((await alsChef('POST', '/api/spiegel', { pfad: pr, url: 'http://127.0.0.1:9/ziel.git', benutzer: 'geheimnutzer', geheim: 'x' })).status, 200);
  await alsChef('POST', '/api/spiegel/jetzt', { pfad: pr });   // wartet, bis der erste (scheiternde) Abgleich durch ist
  const sicht = await alsGast('GET', `/api/projekt?pfad=${pr}`);
  assert.equal(sicht.daten.spiegel.length, 1);
  assert.ok(!('benutzer' in sicht.daten.spiegel[0]) && !('hat_geheim' in sicht.daten.spiegel[0]));
  assert.ok(!JSON.stringify(sicht.daten).includes('geheimnutzer'));
  assert.equal((await alsChef('GET', `/api/projekt?pfad=${pr}`)).daten.spiegel[0].benutzer, 'geheimnutzer');
});

test('Freigaben wandern beim Verschieben mit und verschwinden mit dem Projekt', async () => {
  let r = await alsChef('POST', '/api/verschieben', { pfad: 'team/web', ziel: '', slug: 'web' });
  assert.equal(r.daten.pfad, 'web');
  const f = (await alsChef('GET', '/api/nutzer')).daten.find((n) => n.name === 'gast').freigaben;
  assert.deepEqual(f.map((x) => x.pfad).sort(), ['privat/mikrotik', 'web']);
  assert.equal((await alsGast('GET', '/api/projekt?pfad=web/seite')).status, 200);
  assert.deepEqual((await alsGast('GET', '/api/baum')).daten.ordner.map((o) => o.pfad).sort(), ['privat', 'web']);
  await gitAus(['fetch', '-q', 'origin'], path.join(tmp, 'seite'));   // alte Adresse über die Umleitung
  r = await alsChef('DELETE', '/api/projekt?pfad=privat/mikrotik&bestaetigung=mikrotik');
  assert.equal(r.status, 200);
  assert.deepEqual((await alsChef('GET', '/api/nutzer')).daten.find((n) => n.name === 'gast').freigaben.map((x) => x.pfad), ['web']);
  // ein neues Projekt am selben Ort erbt die alte Freigabe nicht
  await alsChef('POST', '/api/projekte', { ordner: 'privat', name: 'Mikrotik' });
  assert.equal((await alsGast('GET', '/api/projekt?pfad=privat/mikrotik')).status, 404);
});
