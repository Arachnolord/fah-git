// Fail-over (1.14.0): Haupt und Ersatz als echte Server im selben Prozess, echte git-Aufrufe über HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { erstelleServer } from '../src/server.js';
import { rolleLesen, unterschrift } from '../src/failover.js';

const execFileP = promisify(execFile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-fo-'));
let a; let b; let code = '';
const kekse = { a: '', b: '' };

function starte(name, umgebung) {
  const s = erstelleServer({ daten: path.join(tmp, name), umgebung });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => r({ ...s, basis: `http://127.0.0.1:${s.server.address().port}`, name })));
}

async function rufe(s, methode, weg, daten) {
  const r = await fetch(s.basis + weg, { method: methode, headers: { 'Content-Type': 'application/json', 'X-FAHGIT': '1', ...(kekse[s.name] ? { Cookie: kekse[s.name] } : {}) },
    body: daten ? JSON.stringify(daten) : undefined });
  const t = await r.text();
  const neu = r.headers.get('set-cookie');
  if (neu) kekse[s.name] = neu.split(';')[0];
  return { status: r.status, daten: t ? JSON.parse(t) : null };
}

const gitAus = async (args, cwd) => (await execFileP('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t', HOME: tmp } })).stdout;
const mitKennwort = (s, pfad) => s.basis.replace('http://', 'http://fabian:geheim1234@') + `/${pfad}.git`;
const refsVon = (s, pfad) => gitAus(['for-each-ref', '--format=%(refname) %(objectname)'], s.baum.repoPfad(pfad));
const PROJEKT = 'eigene/demo';

before(async () => {
  a = await starte('a', {});
  b = await starte('b', { FAHGIT_ROLLE: 'ersatz' });
});
after(() => { a.server.close(); b.server.close(); b.ersatz.stoppen(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Haupt einrichten: Konto, Ordner, Projekt mit Zweig und Tag, leerer Ordner', async () => {
  assert.equal(a.rolle.rolle, 'haupt'); assert.equal(b.rolle.rolle, 'ersatz');
  assert.equal((await rufe(a, 'POST', '/api/ersteinrichtung', { name: 'fabian', anzeige: 'Fabian', kennwort: 'geheim1234' })).status, 200);
  assert.equal((await rufe(a, 'POST', '/api/ordner', { eltern: '', name: 'Eigene' })).status, 200);
  assert.equal((await rufe(a, 'POST', '/api/ordner', { eltern: 'eigene', name: 'Leer' })).status, 200);
  assert.equal((await rufe(a, 'POST', '/api/projekte', { ordner: 'eigene', name: 'Demo', readme: true })).status, 200);
  const klon = path.join(tmp, 'klon');
  await gitAus(['clone', '-q', mitKennwort(a, PROJEKT), klon]);
  await gitAus(['checkout', '-q', '-b', 'zweig2'], klon);
  fs.writeFileSync(path.join(klon, 'x.txt'), 'x');
  await gitAus(['add', '.'], klon); await gitAus(['commit', '-qm', 'zwei'], klon); await gitAus(['tag', 'v1'], klon);
  await gitAus(['push', '-q', 'origin', 'zweig2', 'v1'], klon);
});

test('Ersatz: ohne Kopplung nur lesend, Ersteinrichtung gesperrt', async () => {
  let r = await rufe(b, 'GET', '/api/status');
  assert.equal(r.daten.failover.rolle, 'ersatz'); assert.equal(r.daten.failover.gekoppelt, false);
  r = await rufe(b, 'POST', '/api/ersteinrichtung', { name: 'boese', kennwort: 'geheim1234' });
  assert.equal(r.status, 423);
});

test('Kopplungscode nur für Admins, Schlüssel nie in den Einstellungen', async () => {
  const r = await rufe(a, 'POST', '/api/failover/code');
  assert.equal(r.status, 200); assert.match(r.daten.code, /^fgfo_/);
  code = r.daten.code;
  const e = await rufe(a, 'GET', '/api/einstellungen');
  assert.equal(JSON.stringify(e.daten).includes(crypto.createHash('sha256').update(code).digest('hex')), false);
  assert.equal(e.daten.failover.anfang, code.slice(0, 10));
});

test('Unterschrift: ohne, falsch und wiederholt → 401', async () => {
  assert.equal((await fetch(`${a.basis}/api/failover/stand`)).status, 401);
  const zeit = String(Date.now()); const einmal = crypto.randomBytes(18).toString('base64url');
  const falsch = unterschrift(crypto.createHash('sha256').update('fgfo_falsch').digest(), zeit, einmal, 'GET', '/api/failover/stand');
  assert.equal((await fetch(`${a.basis}/api/failover/stand`, { headers: { 'x-fahgit-failover': `${zeit}.${einmal}.${falsch}` } })).status, 401);
  const richtig = unterschrift(crypto.createHash('sha256').update(code).digest(), zeit, einmal, 'GET', '/api/failover/stand');
  const kopf = { 'x-fahgit-failover': `${zeit}.${einmal}.${richtig}` };
  const r1 = await fetch(`${a.basis}/api/failover/stand`, { headers: kopf });
  assert.equal(r1.status, 200);
  const paket = await r1.json();
  assert.equal(JSON.stringify(paket).includes('eigene/demo'), false, 'Antwort ist verschlüsselt');
  assert.equal((await fetch(`${a.basis}/api/failover/stand`, { headers: kopf })).status, 401, 'Wiederholung abgewiesen');
  const alt = String(Date.now() - 10 * 60_000); const e2 = crypto.randomBytes(18).toString('base64url');
  const s2 = unterschrift(crypto.createHash('sha256').update(code).digest(), alt, e2, 'GET', '/api/failover/stand');
  assert.equal((await fetch(`${a.basis}/api/failover/stand`, { headers: { 'x-fahgit-failover': `${alt}.${e2}.${s2}` } })).status, 401, 'zu alt');
  const g = await fetch(`${a.basis}/${PROJEKT}.git/info/refs?service=git-upload-pack`, { headers: { Authorization: `Basic ${Buffer.from('fail-over:fgtk_erfunden').toString('base64')}` } });
  assert.equal(g.status, 401, 'erfundener git-Zugang');
});

test('Koppeln mit falschem Code scheitert, mit richtigem klappt; erste Runde holt alles', async () => {
  let r = await rufe(b, 'POST', '/api/failover/koppeln', { haupt: a.basis, code: `fgfo_${'x'.repeat(43)}` });
  assert.equal(r.status, 401);
  r = await rufe(b, 'POST', '/api/failover/koppeln', { haupt: `${a.basis}/pfad`, code });
  assert.equal(r.status, 400);
  r = await rufe(b, 'POST', '/api/failover/koppeln', { haupt: a.basis, code });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  const e = await b.ersatz.runde();
  assert.deepEqual(e.fehler, []);
  assert.equal(await refsVon(b, PROJEKT), await refsVon(a, PROJEKT));
  assert.equal(fs.readFileSync(path.join(b.baum.repoPfad(PROJEKT), 'HEAD'), 'utf8').trim(), 'ref: refs/heads/main');
  assert.ok(fs.statSync(path.join(b.speicher.repos, 'eigene', 'leer')).isDirectory(), 'leerer Ordner');
  assert.deepEqual(fs.readFileSync(path.join(b.speicher.ordner, 'nutzer.json')), fs.readFileSync(path.join(a.speicher.ordner, 'nutzer.json')));
  assert.deepEqual(fs.readFileSync(path.join(b.speicher.ordner, 'geheim.key')), fs.readFileSync(path.join(a.speicher.ordner, 'geheim.key')));
  const h = await rufe(a, 'GET', '/api/failover/status');
  assert.equal(h.daten.ersatz.aktuell, false, 'Bericht kommt erst mit der nächsten Anfrage');
});

test('Am Ersatz anmelden, lesen, klonen – aber nichts ändern und nicht pushen', async () => {
  let r = await rufe(b, 'POST', '/api/anmelden', { name: 'fabian', kennwort: 'geheim1234' });
  assert.equal(r.status, 200);
  r = await rufe(b, 'GET', '/api/baum');
  assert.equal(r.daten.ordner[0].projekte[0].name, 'Demo');
  r = await rufe(b, 'POST', '/api/ordner', { eltern: '', name: 'Neu' });
  assert.equal(r.status, 423);
  r = await rufe(b, 'PUT', '/api/einstellungen', { adresse: '' });
  assert.equal(r.status, 423);
  r = await rufe(b, 'GET', '/api/failover/status');
  assert.equal(r.daten.rolle, 'ersatz'); assert.equal(r.daten.aktuell, true);
  const klon = path.join(tmp, 'klon-b');
  await gitAus(['clone', '-q', mitKennwort(b, PROJEKT), klon]);
  fs.writeFileSync(path.join(klon, 'y.txt'), 'y');
  await gitAus(['add', '.'], klon); await gitAus(['commit', '-qm', 'darf nicht'], klon);
  await assert.rejects(gitAus(['push', '-q', 'origin', 'main'], klon), /Fail-over/);
});

test('Neuerungen am Haupt kommen an, Gelöschtes verschwindet', async () => {
  const klon = path.join(tmp, 'klon');
  await gitAus(['checkout', '-q', 'main'], klon); await gitAus(['pull', '-q', 'origin', 'main'], klon);
  fs.writeFileSync(path.join(klon, 'z.txt'), 'z');
  await gitAus(['add', '.'], klon); await gitAus(['commit', '-qm', 'drei'], klon);
  await gitAus(['push', '-q', 'origin', 'main'], klon);
  await gitAus(['push', '-q', 'origin', '--delete', 'zweig2'], klon);
  await new Promise((r) => setTimeout(r, 2100)); // Zwischenspeicher des Stands
  await b.ersatz.runde();
  assert.equal(await refsVon(b, PROJEKT), await refsVon(a, PROJEKT));
  assert.equal((await refsVon(b, PROJEKT)).includes('zweig2'), false);
  // Haupt sieht den Ersatz als aktuell (Bericht der letzten Runde)
  await b.ersatz.runde();
  const h = await rufe(a, 'GET', '/api/failover/status');
  assert.equal(h.daten.ersatz.aktuell, true);
  assert.equal(h.daten.ersatz.schluessel, undefined);
  // Projekt und Ordner am Haupt löschen (ein zweites Projekt bleibt – ganz ohne Repos löscht der Ersatz aus Vorsicht nichts)
  let r = await rufe(a, 'POST', '/api/projekte', { ordner: 'eigene', name: 'Bleibt', readme: true });
  assert.equal(r.status, 200);
  r = await rufe(a, 'DELETE', `/api/projekt?pfad=${encodeURIComponent(PROJEKT)}&bestaetigung=demo`);
  assert.equal(r.status, 200);
  r = await rufe(a, 'DELETE', '/api/ordner?pfad=eigene%2Fleer');
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 2100));
  await b.ersatz.runde();
  assert.equal(fs.existsSync(b.baum.repoPfad(PROJEKT)), false);
  const korb = path.join(b.speicher.ordner, '_failover', 'papierkorb');
  assert.ok(fs.readdirSync(korb).some((t) => fs.existsSync(path.join(korb, t, 'eigene', 'demo.git', 'HEAD'))), 'Gelöschtes liegt im Papierkorb');
  assert.equal(fs.existsSync(path.join(b.speicher.repos, 'eigene', 'leer')), false);
  assert.equal(await refsVon(b, 'eigene/bleibt'), await refsVon(a, 'eigene/bleibt'));
});

test('Lesefehler am Haupt → Fehler statt Teilliste, der Ersatz löscht nichts', async () => {
  const ordner = path.join(a.speicher.repos, 'eigene');
  fs.chmodSync(ordner, 0o000);
  try {
    await new Promise((res) => setTimeout(res, 2100));
    await assert.rejects(b.ersatz.runde(), /500|nicht/);
  } finally { fs.chmodSync(ordner, 0o755); }
  assert.ok(fs.existsSync(path.join(b.baum.repoPfad('eigene/bleibt'), 'HEAD')), 'Repo am Ersatz noch da');
  // Eine Dateiliste ohne nutzer.json wird nicht übernommen.
  await assert.rejects(b.ersatz.dateienSchreiben([{ name: 'meta.json', inhalt: Buffer.from('{}').toString('base64') }]), /nutzer\.json/);
  assert.ok(fs.existsSync(path.join(b.speicher.ordner, 'nutzer.json')));
});

test('git-Zugang gilt nur für die Adresse des Ersatzes; Sicherung am Ersatz gesperrt', async () => {
  const t = a.failoverHaupt.gitZugang('10.9.9.9');
  assert.ok(a.failoverHaupt.gitPruefen('fail-over', t, '10.9.9.9'));
  assert.equal(a.failoverHaupt.gitPruefen('fail-over', t, '10.9.9.8'), null);
  assert.equal(a.failoverHaupt.gitPruefen('fabian', t, '10.9.9.9'), null);
  assert.equal((await rufe(b, 'GET', '/api/sicherung/export')).status, 423);
});

test('Kopplung lösen → Ersatz bekommt 404; Übernehmen merkt sich die Rolle', async () => {
  assert.equal((await rufe(a, 'DELETE', '/api/failover/code')).status, 200);
  await assert.rejects(b.ersatz.runde(), /404/);
  await b.ersatz.uebernehmen('fabian');
  const r = rolleLesen(b.speicher.ordner, { FAHGIT_ROLLE: 'ersatz' });
  assert.equal(r.rolle, 'haupt'); assert.equal(r.uebernommen, true);
});
