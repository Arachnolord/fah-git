// Ende-zu-Ende: echter Server auf einem freien Port, echte git-Aufrufe über HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { erstelleServer } from '../src/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-'));
let a; let b; let basisA; let basisB; let keks = ''; let schluessel = ''; let schluesselB = '';

function starte(name) {
  const s = erstelleServer({ daten: path.join(tmp, name) });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => r({ ...s, basis: `http://127.0.0.1:${s.server.address().port}` })));
}

async function rufe(basis, methode, weg, daten, k = keks) {
  const r = await fetch(basis + weg, { method: methode, headers: { 'Content-Type': 'application/json', 'X-FAHGIT': '1', ...(k ? { Cookie: k } : {}) },
    body: daten ? JSON.stringify(daten) : undefined });
  const t = await r.text();
  const neu = r.headers.get('set-cookie');
  if (neu && k === keks) keks = neu.split(';')[0];
  return { status: r.status, daten: t ? JSON.parse(t) : null };
}

// Asynchron: Der Server läuft im selben Prozess und muss antworten können, während git wartet.
const gitAus = async (args, cwd) => (await execFileP('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t', HOME: tmp } })).stdout;
const mitSchluessel = (basis, pfad, s = schluessel) => basis.replace('http://', `http://fabian:${s}@`) + `/${pfad}.git`;

before(async () => {
  a = await starte('a'); basisA = a.basis;
  b = await starte('b'); basisB = b.basis;
});
after(() => { a.server.close(); b.server.close(); a.spiegel.stoppen(); b.spiegel.stoppen(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Ersteinrichtung legt den ersten Administrator an und nur einmal', async () => {
  let r = await rufe(basisA, 'GET', '/api/status');
  assert.equal(r.daten.ersteinrichtung, true);
  r = await rufe(basisA, 'POST', '/api/ersteinrichtung', { name: 'fabian', anzeige: 'Fabian', kennwort: 'geheim1234' });
  assert.equal(r.status, 200); assert.equal(r.daten.nutzer.admin, true);
  r = await rufe(basisA, 'POST', '/api/ersteinrichtung', { name: 'boese', kennwort: 'geheim1234' }, '');
  assert.equal(r.status, 409);
  r = await rufe(basisA, 'GET', '/api/status');
  assert.equal(r.daten.nutzer.name, 'fabian');
});

test('Schreibende Aufrufe ohne Oberflächen-Kopf werden abgewiesen', async () => {
  const r = await fetch(basisA + '/api/ordner', { method: 'POST', headers: { Cookie: keks, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(r.status, 403);
});

test('Ordner, Unterordner und Projekt mit README', async () => {
  let r = await rufe(basisA, 'POST', '/api/ordner', { eltern: '', name: 'Eigene Projekte' });
  assert.equal(r.daten.pfad, 'eigene-projekte');
  r = await rufe(basisA, 'POST', '/api/ordner', { eltern: 'eigene-projekte', name: 'FX-Git (Beispiel)' });
  assert.equal(r.daten.pfad, 'eigene-projekte/fx-git-beispiel');
  r = await rufe(basisA, 'POST', '/api/projekte', { ordner: 'eigene-projekte/fx-git-beispiel', name: 'QR-WiFi', beschreibung: 'Test', readme: true });
  assert.equal(r.daten.pfad, 'eigene-projekte/fx-git-beispiel/qr-wifi');
  r = await rufe(basisA, 'GET', '/api/projekt?pfad=eigene-projekte/fx-git-beispiel/qr-wifi');
  assert.equal(r.daten.leer, false); assert.equal(r.daten.standard, 'main'); assert.equal(r.daten.name, 'QR-WiFi');
  r = await rufe(basisA, 'GET', '/api/baum');
  assert.equal(r.daten.ordner[0].name, 'Eigene Projekte');
  assert.equal(r.daten.ordner[0].ordner[0].projekte[0].name, 'QR-WiFi');
  r = await rufe(basisA, 'POST', '/api/projekte', { ordner: 'eigene-projekte', name: 'FX-Git (Beispiel)' });
  assert.equal(r.status, 409, 'Projekt darf nicht wie ein Ordner heißen');
});

test('git ohne Anmeldung: 401; mit Zugangsschlüssel: klonen, pushen, Aktivität', async () => {
  const r = await rufe(basisA, 'POST', '/api/konto/schluessel', { name: 'Mac' });
  schluessel = r.daten.geheim;
  assert.match(schluessel, /^fgit_/);
  const anon = await fetch(`${basisA}/eigene-projekte/fx-git-beispiel/qr-wifi.git/info/refs?service=git-upload-pack`);
  assert.equal(anon.status, 401);
  const klon = path.join(tmp, 'klon');
  await gitAus(['clone', '-q', mitSchluessel(basisA, 'eigene-projekte/fx-git-beispiel/qr-wifi'), klon]);
  assert.ok(fs.existsSync(path.join(klon, 'README.md')));
  fs.writeFileSync(path.join(klon, 'app.py'), 'print("hallo")\n');
  await gitAus(['add', '.'], klon); await gitAus(['commit', '-q', '-m', 'App dazu'], klon);
  await gitAus(['push', '-q', 'origin', 'main'], klon);
  await gitAus(['push', '-q', 'origin', 'main:feature/x'], klon);
  await new Promise((r2) => setTimeout(r2, 300));
  const akt = await rufe(basisA, 'GET', '/api/aktivitaet?projekt=eigene-projekte/fx-git-beispiel/qr-wifi');
  const push = akt.daten.find((e) => e.art === 'push' && e.zweige.some((z) => z.name === 'main'));
  assert.ok(push, 'Push in der Aktivität');
  assert.equal(push.zweige[0].anzahl, 1); assert.equal(push.zweige[0].betreff, 'App dazu');
  const d = await rufe(basisA, 'GET', '/api/datei?pfad=eigene-projekte/fx-git-beispiel/qr-wifi&datei=app.py');
  assert.equal(d.daten.text, 'print("hallo")\n');
  const v = await rufe(basisA, 'GET', '/api/verlauf?pfad=eigene-projekte/fx-git-beispiel/qr-wifi');
  assert.equal(v.daten.commits.length, 2);
  const c = await rufe(basisA, 'GET', `/api/commit?pfad=eigene-projekte/fx-git-beispiel/qr-wifi&sha=${v.daten.commits[0].sha}`);
  assert.equal(c.daten.dateien[0].pfad, 'app.py'); assert.match(c.daten.patch, /\+print\("hallo"\)/);
});

test('Neuer Ordner im Projekt: Commit mit .gitkeep, verschachtelt, sauber abgelehnt', async () => {
  const pr = 'eigene-projekte/fx-git-beispiel/qr-wifi';
  let r = await rufe(basisA, 'POST', '/api/neuer-ordner', { pfad: pr, zweig: 'main', ordner: '', name: 'docs', nachricht: 'Doku-Ordner' });
  assert.equal(r.status, 200, JSON.stringify(r.daten)); assert.equal(r.daten.pfad, 'docs');
  r = await rufe(basisA, 'POST', '/api/neuer-ordner', { pfad: pr, zweig: 'main', ordner: 'docs', name: 'bilder' });
  assert.equal(r.daten.pfad, 'docs/bilder');
  let d = await rufe(basisA, 'GET', `/api/dateien?pfad=${pr}&ref=main&ordner=docs`);
  assert.deepEqual(d.daten.eintraege.map((e) => [e.name, e.art]), [['bilder', 'ordner'], ['.gitkeep', 'datei']]);
  assert.equal(d.daten.letzter.betreff, 'Ordner docs/bilder angelegt');
  for (const [b, status] of [[{ name: 'docs' }, 409], [{ name: 'a/b' }, 400], [{ name: '..' }, 400], [{ name: 'x', ordner: 'fehlt' }, 404],
    [{ name: 'x', zweig: 'gibtsnicht' }, 400]]) {
    r = await rufe(basisA, 'POST', '/api/neuer-ordner', { pfad: pr, zweig: 'main', ordner: '', ...b });
    assert.equal(r.status, status, JSON.stringify(b));
  }
  const akt = await rufe(basisA, 'GET', `/api/aktivitaet?projekt=${pr}`);
  assert.ok(akt.daten.some((e) => e.art === 'push' && e.zweige.some((z) => z.betreff === 'Doku-Ordner')), 'wie ein Push in der Aktivität');
  const klon = path.join(tmp, 'klon');
  await gitAus(['pull', '-q', 'origin', 'main'], klon);
  assert.ok(fs.existsSync(path.join(klon, 'docs', 'bilder', '.gitkeep')), 'im Klon angekommen');
});

async function roh(basis, weg, daten) {
  const r = await fetch(basis + weg, { method: 'PUT', headers: { 'X-FAHGIT': '1', 'Content-Type': 'application/octet-stream', Cookie: keks }, body: daten });
  const t = await r.text();
  return { status: r.status, daten: t ? JSON.parse(t) : null };
}

test('Neue Datei, Hochladen (ein Commit) und leeres Projekt aus der Oberfläche füllen', async () => {
  const pr = 'eigene-projekte/fx-git-beispiel/qr-wifi';
  let r = await rufe(basisA, 'POST', '/api/neue-datei', { pfad: pr, zweig: 'main', ordner: 'docs', name: 'neu/notiz.md', inhalt: '# Notiz\n' });
  assert.equal(r.status, 200, JSON.stringify(r.daten)); assert.equal(r.daten.pfad, 'docs/neu/notiz.md');
  r = await rufe(basisA, 'POST', '/api/neue-datei', { pfad: pr, zweig: 'main', ordner: 'docs', name: 'neu/notiz.md', inhalt: 'x' });
  assert.equal(r.status, 409, 'vorhandene Datei bleibt');
  for (const name of ['../x', '.git/config', 'a/.GIT/b', '']) {
    r = await rufe(basisA, 'POST', '/api/neue-datei', { pfad: pr, zweig: 'main', name, inhalt: 'x' });
    assert.equal(r.status, 400, name);
  }
  // Hochladen: drei Dateien inkl. Unterordner, ersetzt app.py, ein Commit
  const s = await rufe(basisA, 'POST', '/api/hochladen/start', { pfad: pr, zweig: 'main', ordner: 'upload' });
  assert.equal(s.status, 200);
  assert.equal((await roh(basisA, `/api/hochladen/datei?id=${s.daten.id}&datei=projekt/a.txt`, 'A\n')).status, 200);
  assert.equal((await roh(basisA, `/api/hochladen/datei?id=${s.daten.id}&datei=projekt/sub/b.bin`, Buffer.from([0, 1, 2, 255]))).status, 200);
  assert.equal((await roh(basisA, `/api/hochladen/datei?id=${s.daten.id}&datei=../böse`, 'x')).status, 400);
  assert.equal((await roh(basisA, `/api/hochladen/datei?id=falsch&datei=a`, 'x')).status, 404);
  const vorher = (await rufe(basisA, 'GET', `/api/verlauf?pfad=${pr}`)).daten.commits.length;
  r = await rufe(basisA, 'POST', '/api/hochladen/fertig', { id: s.daten.id, nachricht: 'Ordner hochgeladen' });
  assert.equal(r.status, 200, JSON.stringify(r.daten)); assert.equal(r.daten.anzahl, 2);
  const v = (await rufe(basisA, 'GET', `/api/verlauf?pfad=${pr}`)).daten.commits;
  assert.equal(v.length, vorher + 1); assert.equal(v[0].betreff, 'Ordner hochgeladen');
  const d = await rufe(basisA, 'GET', `/api/datei?pfad=${pr}&datei=upload/projekt/a.txt`);
  assert.equal(d.daten.text, 'A\n');
  assert.equal((await rufe(basisA, 'POST', '/api/hochladen/fertig', { id: s.daten.id })).status, 404, 'Sitzung ist verbraucht');
  // Leeres Projekt: erster Commit über die Oberfläche
  await rufe(basisA, 'POST', '/api/projekte', { ordner: 'eigene-projekte', name: 'leer' });
  assert.equal((await rufe(basisA, 'GET', '/api/projekt?pfad=eigene-projekte/leer')).daten.leer, true);
  r = await rufe(basisA, 'POST', '/api/neuer-ordner', { pfad: 'eigene-projekte/leer', zweig: 'main', name: 'docs' });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  const leer = (await rufe(basisA, 'GET', '/api/projekt?pfad=eigene-projekte/leer')).daten;
  assert.equal(leer.leer, false); assert.deepEqual(leer.zweige.map((z) => z.name), ['main']);
  r = await rufe(basisA, 'POST', '/api/neuer-ordner', { pfad: 'eigene-projekte/leer', zweig: 'anderer', name: 'x' });
  assert.equal(r.status, 400, 'fremder Zweig entsteht nicht nebenbei');
  const klon = path.join(tmp, 'klon');
  await gitAus(['pull', '-q', 'origin', 'main'], klon);
  assert.deepEqual([...fs.readFileSync(path.join(klon, 'upload', 'projekt', 'sub', 'b.bin'))], [0, 1, 2, 255]);
});

test('Bearbeiten: vorhandene Datei überschreiben, Konflikt über die Blob-Kennung abgewiesen', async () => {
  const pr = 'eigene-projekte/fx-git-beispiel/qr-wifi';
  let r = await rufe(basisA, 'POST', '/api/neue-datei', { pfad: pr, zweig: 'main', name: 'bearbeiten.md', inhalt: 'eins\n' });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  let d = (await rufe(basisA, 'GET', `/api/datei?pfad=${pr}&datei=bearbeiten.md`)).daten;
  assert.equal(d.text, 'eins\n'); assert.ok(d.sha, 'Lesen liefert die Blob-Kennung mit');
  const basis = d.sha;
  const vorher = (await rufe(basisA, 'GET', `/api/verlauf?pfad=${pr}`)).daten.commits.length;
  r = await rufe(basisA, 'POST', '/api/datei-speichern', { pfad: pr, zweig: 'main', datei: 'bearbeiten.md', basis, inhalt: 'zwei\n', nachricht: 'zwei' });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  d = (await rufe(basisA, 'GET', `/api/datei?pfad=${pr}&datei=bearbeiten.md`)).daten;
  assert.equal(d.text, 'zwei\n', 'neuer Inhalt');
  const v = (await rufe(basisA, 'GET', `/api/verlauf?pfad=${pr}`)).daten.commits;
  assert.equal(v.length, vorher + 1); assert.equal(v[0].betreff, 'zwei');
  assert.equal((await rufe(basisA, 'GET', `/api/datei?pfad=${pr}&ref=${v[1].sha}&datei=bearbeiten.md`)).daten.text, 'eins\n', 'alte Fassung bleibt im Verlauf');
  // Veraltete Basis (zeigt noch auf „eins“) → 409, der gespeicherte Stand bleibt unberührt
  r = await rufe(basisA, 'POST', '/api/datei-speichern', { pfad: pr, zweig: 'main', datei: 'bearbeiten.md', basis, inhalt: 'drei\n' });
  assert.equal(r.status, 409, 'veralteter Stand wird nicht überschrieben');
  assert.equal((await rufe(basisA, 'GET', `/api/datei?pfad=${pr}&datei=bearbeiten.md`)).daten.text, 'zwei\n');
  // Identischer Inhalt → 400; fehlende Datei → 404; fehlender Zweig → 400
  assert.equal((await rufe(basisA, 'POST', '/api/datei-speichern', { pfad: pr, zweig: 'main', datei: 'bearbeiten.md', inhalt: 'zwei\n' })).status, 400);
  assert.equal((await rufe(basisA, 'POST', '/api/datei-speichern', { pfad: pr, zweig: 'main', datei: 'gibt-es-nicht.md', inhalt: 'x' })).status, 404);
  assert.equal((await rufe(basisA, 'POST', '/api/datei-speichern', { pfad: pr, zweig: 'fehlt', datei: 'bearbeiten.md', inhalt: 'x' })).status, 400);
});

test('Löschen: Datei und ganzer Ordner als je ein Commit, Verlauf bleibt', async () => {
  const pr = 'eigene-projekte/fx-git-beispiel/qr-wifi';
  const commits = async () => (await rufe(basisA, 'GET', `/api/verlauf?pfad=${pr}`)).daten.commits;
  const vorher = (await commits()).length;
  let r = await rufe(basisA, 'POST', '/api/loeschen', { pfad: pr, zweig: 'main', dateien: ['upload/projekt/a.txt'] });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.equal(r.daten.dateien, 1); assert.equal(r.daten.ordner, 'upload/projekt', 'Ordner gibt es noch (sub/b.bin)');
  assert.equal((await rufe(basisA, 'GET', `/api/datei?pfad=${pr}&datei=upload/projekt/a.txt`)).status, 404);
  const v = await commits();
  assert.equal(v.length, vorher + 1); assert.equal(v[0].betreff, 'upload/projekt/a.txt gelöscht');
  assert.equal((await rufe(basisA, 'GET', `/api/datei?pfad=${pr}&ref=${v[1].sha}&datei=upload/projekt/a.txt`)).daten.text, 'A\n', 'alter Stand bleibt lesbar');
  // ganzer Ordner mit Unterordnern; danach ist auch „upload“ leer und weg → zurück auf oberste Ebene
  r = await rufe(basisA, 'POST', '/api/loeschen', { pfad: pr, zweig: 'main', dateien: ['upload'], nachricht: 'Upload weg' });
  assert.equal(r.status, 200, JSON.stringify(r.daten)); assert.equal(r.daten.dateien, 1); assert.equal(r.daten.ordner, '');
  assert.equal((await commits())[0].betreff, 'Upload weg');
  const wurzel = (await rufe(basisA, 'GET', `/api/dateien?pfad=${pr}&ordner=`)).daten.eintraege.map((e) => e.name);
  assert.ok(!wurzel.includes('upload'), wurzel.join(','));
  // Fehlerfälle
  assert.equal((await rufe(basisA, 'POST', '/api/loeschen', { pfad: pr, zweig: 'main', dateien: ['gibt/es/nicht.txt'] })).status, 404);
  for (const x of ['../x', '']) assert.equal((await rufe(basisA, 'POST', '/api/loeschen', { pfad: pr, zweig: 'main', dateien: [x] })).status, 400, x);
  assert.equal((await rufe(basisA, 'POST', '/api/loeschen', { pfad: pr, zweig: 'fehlt', dateien: ['docs'] })).status, 400, 'nur auf vorhandenen Zweigen');
  // das Löschen kommt beim Klon an
  const klon = path.join(tmp, 'klon');
  await gitAus(['pull', '-q', 'origin', 'main'], klon);
  assert.ok(!fs.existsSync(path.join(klon, 'upload')));
});

test('Verschieben: alte Klon-Adresse funktioniert weiter', async () => {
  let r = await rufe(basisA, 'POST', '/api/verschieben', { pfad: 'eigene-projekte/fx-git-beispiel', ziel: '', slug: 'fx-git' });
  assert.equal(r.daten.pfad, 'fx-git');
  r = await rufe(basisA, 'GET', '/api/projekt?pfad=fx-git/qr-wifi');
  assert.equal(r.status, 200);
  const klon = path.join(tmp, 'klon');
  await gitAus(['fetch', '-q', 'origin'], klon); // alte Adresse eigene-projekte/fx-git-beispiel/qr-wifi
  r = await rufe(basisA, 'POST', '/api/verschieben', { pfad: 'fx-git', ziel: 'eigene-projekte' });
  assert.equal(r.daten.pfad, 'eigene-projekte/fx-git');
  await gitAus(['fetch', '-q', 'origin'], klon);
  r = await rufe(basisA, 'GET', '/api/projekt?pfad=fx-git/qr-wifi');
  assert.equal(r.status, 200, 'Umleitung folgt auch der zweiten Verschiebung');
});

test('Spiegel überschreibt am Ziel nie fremde Arbeit', async () => {
  // Ziel: zweite FAH-Git-Instanz mit gleichem Projekt
  await rufe(basisB, 'POST', '/api/ersteinrichtung', { name: 'fabian', kennwort: 'geheim1234' }, '');
  const kb = (await fetch(basisB + '/api/anmelden', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FAHGIT': '1' }, body: JSON.stringify({ name: 'fabian', kennwort: 'geheim1234' }) })).headers.get('set-cookie').split(';')[0];
  await rufe(basisB, 'POST', '/api/projekte', { ordner: '', name: 'ziel' }, kb);
  schluesselB = (await rufe(basisB, 'POST', '/api/konto/schluessel', { name: 'Spiegel' }, kb)).daten.geheim;
  const quelle = 'eigene-projekte/fx-git/qr-wifi';
  let r = await rufe(basisA, 'POST', '/api/spiegel', { pfad: quelle, url: `${basisB}/ziel.git`, benutzer: 'fabian', geheim: schluesselB });
  assert.equal(r.status, 200);
  r = await rufe(basisA, 'POST', '/api/spiegel/jetzt', { pfad: quelle });
  assert.equal(r.daten[0].ergebnis, 'ok', JSON.stringify(r.daten));
  const zielKlon = path.join(tmp, 'zielklon');
  await gitAus(['clone', '-q', mitSchluessel(basisB, 'ziel', schluesselB), zielKlon]);
  // Kollege pusht direkt aufs Ziel
  fs.writeFileSync(path.join(zielKlon, 'kollege.txt'), 'wichtig\n');
  await gitAus(['add', '.'], zielKlon); await gitAus(['commit', '-q', '-m', 'Arbeit des Kollegen'], zielKlon); await gitAus(['push', '-q', 'origin', 'main'], zielKlon);
  const kollegenStand = (await gitAus(['rev-parse', 'HEAD'], zielKlon)).trim();
  // Quelle bekommt einen anderen Stand
  const klon = path.join(tmp, 'klon');
  await gitAus(['pull', '-q', 'origin', 'main'], klon);
  fs.writeFileSync(path.join(klon, 'anders.txt'), 'x\n');
  await gitAus(['add', '.'], klon); await gitAus(['commit', '-q', '-m', 'anders'], klon); await gitAus(['push', '-q', 'origin', 'main'], klon);
  r = await rufe(basisA, 'POST', '/api/spiegel/jetzt', { pfad: quelle });
  assert.equal(r.daten[0].ergebnis, 'teilweise');
  assert.ok(r.daten[0].abweichend.some((x) => x.ref === 'refs/heads/main'));
  const zielMain = (await gitAus(['ls-remote', mitSchluessel(basisB, 'ziel', schluesselB), 'refs/heads/main'], tmp)).split('\t')[0];
  assert.equal(zielMain, kollegenStand, 'Arbeit des Kollegen ist unversehrt');
  const p = await rufe(basisA, 'GET', `/api/projekt?pfad=${quelle}`);
  assert.equal(p.daten.spiegel[0].hat_geheim, true);
  assert.equal(JSON.stringify(p.daten).includes(schluesselB), false, 'Schlüssel wird nie ausgeliefert');
});

test('Abweichung lässt sich bewusst mit dem FAH-Git-Stand überschreiben', async () => {
  const quelle = 'eigene-projekte/fx-git/qr-wifi';
  const p = (await rufe(basisA, 'GET', `/api/projekt?pfad=${quelle}`)).daten;
  const s = p.spiegel[0];
  assert.equal(s.zuletzt.ergebnis, 'teilweise');
  let r = await rufe(basisA, 'POST', '/api/spiegel/ueberschreiben', { pfad: quelle, id: s.id, refs: ['refs/heads/gibtsnicht'] });
  assert.equal(r.status, 400);
  r = await rufe(basisA, 'POST', '/api/spiegel/ueberschreiben', { pfad: quelle, id: s.id, refs: s.zuletzt.abweichend.map((x) => x.ref) });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.deepEqual(r.daten.ueberschrieben, ['refs/heads/main']);
  assert.equal(r.daten.zustand.ergebnis, 'ok');
  const hier = (await gitAus(['ls-remote', mitSchluessel(basisA, quelle), 'refs/heads/main'], tmp)).split('\t')[0];
  const dort = (await gitAus(['ls-remote', mitSchluessel(basisB, 'ziel', schluesselB), 'refs/heads/main'], tmp)).split('\t')[0];
  assert.equal(dort, hier, 'Ziel hat jetzt den FAH-Git-Stand');
});

test('Regel: an diesen Server nur aus einem Ordner – auch nach dem Verschieben', async () => {
  const host = new URL(basisB).host;
  let r = await rufe(basisA, 'PUT', '/api/einstellungen', { adresse: '', ziel_regeln: [{ host, ordner: 'eigene-projekte/fx-git' }] });
  assert.equal(r.status, 200);
  await rufe(basisA, 'POST', '/api/projekte', { ordner: 'eigene-projekte', name: 'aussen', readme: true });
  r = await rufe(basisA, 'POST', '/api/spiegel', { pfad: 'eigene-projekte/aussen', url: `${basisB}/ziel.git`, benutzer: 'fabian', geheim: schluesselB });
  assert.equal(r.status, 403); assert.match(r.daten.fehler, /nur weitergeleitet werden, was im Ordner/);
  // Ordner verschieben: Regel wandert mit, Spiegel läuft weiter
  r = await rufe(basisA, 'POST', '/api/ordner', { eltern: '', name: 'Arbeit' });
  r = await rufe(basisA, 'POST', '/api/verschieben', { pfad: 'eigene-projekte/fx-git', ziel: 'arbeit' });
  assert.equal(r.daten.pfad, 'arbeit/fx-git');
  assert.equal((await rufe(basisA, 'GET', '/api/einstellungen')).daten.ziel_regeln[0].ordner, 'arbeit/fx-git');
  r = await rufe(basisA, 'POST', '/api/spiegel/jetzt', { pfad: 'arbeit/fx-git/qr-wifi' });
  assert.equal(r.daten[0].ergebnis, 'ok', JSON.stringify(r.daten));
  // Projekt aus dem Ordner herausschieben: Weiterleitung verweigert
  r = await rufe(basisA, 'POST', '/api/verschieben', { pfad: 'arbeit/fx-git/qr-wifi', ziel: 'arbeit' });
  r = await rufe(basisA, 'POST', '/api/spiegel/jetzt', { pfad: 'arbeit/qr-wifi' });
  assert.equal(r.daten[0].ergebnis, 'fehler'); assert.match(r.daten[0].text, /nur weitergeleitet werden/);
  // zurück, Regel wieder aus (die folgenden Tests nutzen den Spiegel nicht)
  await rufe(basisA, 'POST', '/api/verschieben', { pfad: 'arbeit/qr-wifi', ziel: 'arbeit/fx-git' });
  await rufe(basisA, 'PUT', '/api/einstellungen', { adresse: '', ziel_regeln: [] });
});

test('Kopie eines fremden Gits (Quelle) ist nur lesbar und zieht nach', async () => {
  let r = await rufe(basisA, 'POST', '/api/projekte', { ordner: '', name: 'kopie' });
  r = await rufe(basisA, 'PUT', '/api/quelle', { pfad: 'kopie', url: `${basisB}/ziel.git`, benutzer: 'fabian', geheim: schluesselB, takt: 15 });
  assert.equal(r.daten.ergebnis, 'ok', JSON.stringify(r.daten));
  const kopie = path.join(tmp, 'kopieklon');
  await gitAus(['clone', '-q', mitSchluessel(basisA, 'kopie'), kopie]);
  assert.ok(fs.existsSync(path.join(kopie, 'anders.txt')), 'Stand der Quelle übernommen');
  fs.writeFileSync(path.join(kopie, 'y.txt'), 'y\n');
  await gitAus(['add', '.'], kopie); await gitAus(['commit', '-q', '-m', 'y'], kopie);
  await assert.rejects(gitAus(['push', '-q', 'origin', 'main'], kopie), /nur lesbar|403/);
  r = await rufe(basisA, 'POST', '/api/neuer-ordner', { pfad: 'kopie', zweig: 'main', name: 'neu' });
  assert.equal(r.status, 403, 'auch kein Ordner über die Oberfläche');
  r = await rufe(basisA, 'POST', '/api/loeschen', { pfad: 'kopie', zweig: 'main', dateien: ['anders.txt'] });
  assert.equal(r.status, 403, 'und nichts löschen');
});

test('Import aus einer Gitea-/GitLab-fremden Adresse meldet verständlich', async () => {
  const r = await rufe(basisA, 'POST', '/api/import', { basis: basisB, schluessel: 'falsch', ziel: '' });
  const id = r.daten.auftrag;
  let a2;
  for (let i = 0; i < 50; i++) { a2 = (await rufe(basisA, 'GET', `/api/auftrag?id=${id}`)).daten; if (a2.status !== 'laeuft') break; await new Promise((x) => setTimeout(x, 100)); }
  assert.equal(a2.status, 'fehler');
  assert.match(a2.fehler, /weder GitLab noch Gitea/);
});

test('Projekt löschen nur mit eingetipptem Namen', async () => {
  let r = await rufe(basisA, 'DELETE', '/api/projekt?pfad=kopie&bestaetigung=falsch');
  assert.equal(r.status, 400);
  r = await rufe(basisA, 'DELETE', '/api/projekt?pfad=kopie&bestaetigung=kopie');
  assert.equal(r.status, 200);
});

// --- 1.4.0: Schlüssel „Nur lesen“, Profilbild, FAH-NAS-Adresse --------------------------------------------------------

const anmeldenAls = async (basis, name, kennwort) => (await fetch(`${basis}/api/anmelden`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-FAHGIT': '1' }, body: JSON.stringify({ name, kennwort }) })).headers.get('set-cookie').split(';')[0];

test('Zugangsschlüssel „Nur lesen“: abfragen und klonen ja, ändern und pushen nein', async () => {
  const pr = 'eigene-projekte/aussen';
  let r = await rufe(basisA, 'POST', '/api/konto/schluessel', { name: 'FAH-NAS', recht: 'lesen' });
  assert.equal(r.status, 200); assert.equal(r.daten.recht, 'lesen');
  const lese = r.daten.geheim;
  assert.equal((await rufe(basisA, 'POST', '/api/konto/schluessel', { name: 'x', recht: 'alles' })).status, 400);
  const liste = (await rufe(basisA, 'GET', '/api/konto')).daten.schluessel;
  assert.equal(liste.find((s) => s.name === 'FAH-NAS').recht, 'lesen');
  assert.equal(liste.find((s) => s.name === 'Mac').recht, 'schreiben', 'ohne Angabe: lesen und schreiben');
  const bearer = (methode, weg, daten, s = lese, typ = 'application/json') => fetch(basisA + weg, { method: methode,
    headers: { Authorization: `Bearer ${s}`, ...(daten ? { 'Content-Type': typ } : {}) }, body: daten ? (typ === 'application/json' ? JSON.stringify(daten) : daten) : undefined });
  // genau die Aufrufe, die FAH-NAS braucht
  assert.equal((await bearer('GET', '/api/baum')).status, 200);
  assert.equal((await bearer('GET', `/api/projekt?pfad=${pr}`)).status, 200);
  assert.equal((await bearer('GET', `/api/verlauf?pfad=${pr}&ref=main`)).status, 200);
  const zip = await bearer('GET', `/api/archiv?pfad=${pr}&ref=main`);
  assert.equal(zip.status, 200); assert.equal(zip.headers.get('content-type'), 'application/zip'); await zip.arrayBuffer();
  // jede ändernde Anfrage: 403 mit verständlicher Meldung
  let a2 = await bearer('POST', '/api/ordner', { eltern: '', name: 'boese' });
  assert.equal(a2.status, 403); assert.match((await a2.json()).fehler, /nur lesen/);
  assert.equal((await bearer('POST', '/api/neue-datei', { pfad: pr, zweig: 'main', name: 'x.txt', inhalt: 'x' })).status, 403);
  assert.equal((await bearer('DELETE', `/api/konto/schluessel?id=${liste[0].id}`)).status, 403);
  assert.equal((await bearer('POST', '/api/konto/schluessel', { name: 'mehr' })).status, 403, 'keinen stärkeren Schlüssel erzeugen');
  assert.equal((await bearer('PUT', '/api/konto/bild', Buffer.from('x'), lese, 'image/png')).status, 403);
  // derselbe Aufruf mit „Lesen und schreiben“ geht
  a2 = await bearer('POST', '/api/neue-datei', { pfad: pr, zweig: 'main', name: 'rw.txt', inhalt: 'rw\n' }, schluessel);
  assert.equal(a2.status, 200, await a2.text());
  // git: klonen und holen ja, pushen nein
  const klon = path.join(tmp, 'leseklon');
  await gitAus(['clone', '-q', mitSchluessel(basisA, pr, lese), klon]);
  assert.ok(fs.existsSync(path.join(klon, 'rw.txt')));
  fs.writeFileSync(path.join(klon, 'neu.txt'), 'n\n');
  await gitAus(['add', '.'], klon); await gitAus(['commit', '-q', '-m', 'darf nicht'], klon);
  await assert.rejects(gitAus(['push', '-q', 'origin', 'main'], klon), /nur lesen|403/);
  await gitAus(['fetch', '-q', 'origin'], klon);
  // Schlüssel von vor 1.4.0 (ohne Recht) = lesen und schreiben
  await a.konten.aendern((d) => { delete d.schluessel.find((s) => s.name === 'Mac').recht; });
  assert.equal((await rufe(basisA, 'GET', '/api/konto')).daten.schluessel.find((s) => s.name === 'Mac').recht, 'schreiben');
  await gitAus(['push', '-q', mitSchluessel(basisA, pr), 'main'], klon);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
async function bildHoch(daten, typ, k = keks) {
  const r = await fetch(`${basisA}/api/konto/bild`, { method: 'PUT', headers: { 'X-FAHGIT': '1', 'Content-Type': typ, Cookie: k }, body: daten });
  return { status: r.status, daten: await r.json() };
}
const bildHolen = (name, kopf = {}) => fetch(`${basisA}/api/profilbild?name=${name}`, { headers: { Cookie: keks, ...kopf } });
const avatar = (datei) => fs.existsSync(path.join(tmp, 'a', 'avatare', datei));

test('Profilbild: hochladen, abrufen (ETag), falscher Typ abgelehnt, Umbenennen und Löschen', async () => {
  assert.equal((await bildHoch(Buffer.from('GIF89a\0\0\0\0\0\0\0\0'), 'image/gif')).status, 415);
  assert.equal((await bildHoch(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status, 415);
  assert.equal((await bildHoch(Buffer.from('GIF89a\0\0\0\0\0\0\0\0'), 'image/png')).status, 415, 'Dateianfang muss zum Typ passen');
  assert.equal((await bildHoch(Buffer.concat([PNG, Buffer.alloc(301 * 1024)]), 'image/png')).status, 413);
  let r = await bildHoch(PNG, 'image/png');
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  const stand = r.daten.bild;
  assert.equal((await rufe(basisA, 'GET', '/api/status')).daten.nutzer.bild, stand);
  assert.ok(avatar('fabian.png'));
  let g = await bildHolen('fabian');
  assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), PNG);
  const etag = g.headers.get('etag');
  assert.ok(etag); assert.match(g.headers.get('cache-control'), /no-cache/);
  assert.equal((await bildHolen('fabian', { 'If-None-Match': etag })).status, 304);
  assert.equal((await fetch(`${basisA}/api/profilbild?name=fabian`)).status, 401, 'nur für Angemeldete');
  const akt = (await rufe(basisA, 'GET', '/api/aktivitaet?anzahl=5')).daten;
  assert.ok(akt.some((e) => e.nutzer === 'fabian' && e.bild === stand), 'Aktivität kennt das Bild');
  // WebP ersetzt das PNG
  r = await bildHoch(WEBP, 'image/webp');
  assert.equal(r.status, 200); assert.notEqual(r.daten.bild, stand);
  assert.ok(avatar('fabian.webp') && !avatar('fabian.png'));
  assert.notEqual((await bildHolen('fabian', { 'If-None-Match': etag })).status, 304, 'neues Bild, neuer ETag');
  // Kollege: Bild hochladen, umbenennen (Bild wandert mit), löschen (Bild verschwindet)
  assert.equal((await rufe(basisA, 'POST', '/api/nutzer', { name: 'kollege', kennwort: 'kollege1234' })).status, 200);
  const kk = await anmeldenAls(basisA, 'kollege', 'kollege1234');
  assert.equal((await bildHoch(PNG, 'image/png', kk)).status, 200);
  assert.ok((await rufe(basisA, 'GET', '/api/nutzer')).daten.find((n) => n.name === 'kollege').bild);
  assert.equal((await rufe(basisA, 'POST', '/api/nutzer/umbenennen', { name: 'kollege', neu: 'fabian' })).status, 409);
  assert.equal((await rufe(basisA, 'POST', '/api/nutzer/umbenennen', { name: 'kollege', neu: 'Böse/Name' })).status, 400);
  r = await rufe(basisA, 'POST', '/api/nutzer/umbenennen', { name: 'kollege', neu: 'kollegin' });
  assert.equal(r.status, 200, JSON.stringify(r.daten)); assert.equal(r.daten.nutzer.name, 'kollegin'); assert.ok(r.daten.nutzer.bild);
  assert.ok(avatar('kollegin.png') && !avatar('kollege.png'));
  assert.equal((await bildHolen('kollegin')).status, 200);
  assert.equal((await bildHolen('kollege')).status, 404);
  assert.equal((await rufe(basisA, 'GET', '/api/status', undefined, kk)).daten.nutzer, null, 'alte Sitzung endet');
  assert.equal((await rufe(basisA, 'DELETE', '/api/nutzer?name=kollegin')).status, 200);
  assert.ok(!avatar('kollegin.png'));
  assert.equal((await bildHolen('kollegin')).status, 404);
  // eigenes Bild entfernen → wieder Anfangsbuchstabe
  assert.equal((await rufe(basisA, 'DELETE', '/api/konto/bild')).status, 200);
  assert.equal((await rufe(basisA, 'GET', '/api/status')).daten.nutzer.bild, null);
  assert.equal((await bildHolen('fabian')).status, 404);
  assert.ok(!avatar('fabian.webp'));
});

test('FAH-NAS-Adresse: setzt nur ein Admin, alle Angemeldeten lesen sie im Status', async () => {
  let r = await rufe(basisA, 'PUT', '/api/einstellungen', { fahnas_adresse: 'https://nas.example:8443/' });
  assert.equal(r.status, 200, JSON.stringify(r.daten));
  assert.equal((await rufe(basisA, 'GET', '/api/status')).daten.fahnas, 'https://nas.example:8443');
  assert.equal((await rufe(basisA, 'PUT', '/api/einstellungen', { fahnas_adresse: 'ftp://nas.example' })).status, 400);
  assert.equal((await rufe(basisA, 'PUT', '/api/einstellungen', { fahnas_adresse: 'kein Link' })).status, 400);
  await rufe(basisA, 'PUT', '/api/einstellungen', { ziel_regeln: [] });
  assert.equal((await rufe(basisA, 'GET', '/api/einstellungen')).daten.fahnas_adresse, 'https://nas.example:8443', 'Regeln speichern lässt sie stehen');
  assert.equal((await rufe(basisA, 'POST', '/api/nutzer', { name: 'leser', kennwort: 'leser12345' })).status, 200);
  const kl = await anmeldenAls(basisA, 'leser', 'leser12345');
  assert.equal((await rufe(basisA, 'GET', '/api/status', undefined, kl)).daten.fahnas, 'https://nas.example:8443');
  assert.equal((await rufe(basisA, 'PUT', '/api/einstellungen', { fahnas_adresse: '' }, kl)).status, 403);
  assert.equal((await rufe(basisA, 'GET', '/api/einstellungen', undefined, kl)).status, 403, 'übrige Einstellungen nur für Admins');
  assert.equal((await rufe(basisA, 'GET', '/api/status', undefined, '')).daten.fahnas, undefined, 'nicht ohne Anmeldung');
  await rufe(basisA, 'PUT', '/api/einstellungen', { fahnas_adresse: '' });
  assert.equal((await rufe(basisA, 'GET', '/api/status')).daten.fahnas, '');
});
