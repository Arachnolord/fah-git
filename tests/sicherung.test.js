// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sicherung: Export → Liste → Bestand löschen → Wiederherstellen. Prüft, dass wirklich ALLES zurückkommt
// (Repos, Konten, und vor allem geheim.key) und dass vorher eine Sicherheitskopie angelegt wird.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Speicher } from '../src/speicher.js';
import { Baum } from '../src/baum.js';
import { Konten } from '../src/konten.js';
import { Sicherung } from '../src/sicherung.js';

test('Sicherung: Round-Trip stellt den ganzen Datenordner wieder her', async () => {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-sich-'));
  const speicher = new Speicher(daten);
  const baum = new Baum(speicher);
  const konten = new Konten(speicher);
  const sicherung = new Sicherung({ speicher, baum, konten, einstellungen: async () => ({ sicherung: { auto: true, behalten: 14 } }), version: '9.9.9' });

  // Zustand: ein Admin-Konto, der Sitzungsschlüssel geheim.key und ein nacktes „Repo“ mit einer Datei.
  await konten.anlegen({ name: 'fabian', kennwort: 'geheim123', admin: true }, { nurWennLeer: true });
  speicher.geheimnis();
  const repo = path.join(speicher.repos, 'test.git');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'HEAD'), 'ref: refs/heads/main\n');
  const geheimVorher = fs.readFileSync(path.join(daten, 'geheim.key'));

  // Sichern
  const b = await sicherung.jetzt('test');
  assert.ok(b.name.endsWith('.tar.gz'), 'Dateiname endet auf .tar.gz');
  assert.equal(b.manifest.nutzer, 1, 'ein Konto im Manifest');
  assert.equal(b.manifest.werkzeug, 'fah-git');
  assert.equal((await sicherung.liste()).length, 1, 'eine Sicherung in der Liste');

  // Merken, was es gab, dann den ganzen Bestand (außer _backups) wegwerfen.
  const vorher = (await fsp.readdir(daten)).filter((n) => n !== '_backups').sort();
  for (const n of vorher) fs.rmSync(path.join(daten, n), { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(daten, 'geheim.key')), 'Schlüssel ist weg');
  assert.ok(!fs.existsSync(path.join(repo, 'HEAD')), 'Repo ist weg');

  // Wiederherstellen
  const m = await sicherung.einspielen(path.join(sicherung.ordner, b.name));
  assert.equal(m.werkzeug, 'fah-git');

  // Alles zurück?
  const nachher = (await fsp.readdir(daten)).filter((n) => n !== '_backups').sort();
  assert.deepEqual(nachher, vorher, 'dieselben Einträge wie vorher');
  assert.ok(fs.existsSync(path.join(repo, 'HEAD')), 'Repo-Datei wiederhergestellt');
  assert.deepEqual(fs.readFileSync(path.join(daten, 'geheim.key')), geheimVorher, 'geheim.key byte-gleich');
  // Vor dem Einspielen wurde eine Sicherheitskopie angelegt.
  assert.ok((await sicherung.liste()).some((x) => x.art === 'vor-wiederherstellung'), 'Sicherheitskopie vorhanden');

  fs.rmSync(daten, { recursive: true, force: true });
});

test('Sicherung: SMB-Zugang speichern verschlüsselt das Passwort', async () => {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-smb-'));
  const speicher = new Speicher(daten);
  const sicherung = new Sicherung({ speicher, baum: new Baum(speicher), konten: new Konten(speicher),
    einstellungen: () => speicher.lesen('einstellungen.json', {}), version: '9.9.9' });

  await sicherung.smbSpeichern({ aktiv: true, host: '192.168.1.23', freigabe: '/Backups/', ordner: 'fah-git', nutzer: 'fabian', port: 445, passwort: 'geheim123' });
  const cfg = await sicherung.smbKonfig();
  assert.equal(cfg.aktiv, true);
  assert.equal(cfg.host, '192.168.1.23');
  assert.equal(cfg.freigabe, 'Backups', 'Schrägstriche getrimmt');
  assert.ok(cfg.pass.startsWith('v1:'), 'Passwort verschlüsselt');
  assert.ok(!cfg.pass.includes('geheim123'), 'kein Klartext in der Konfig');
  assert.equal(speicher.entschluesseln(cfg.pass), 'geheim123', 'wieder entschlüsselbar');

  const oeff = sicherung._smbOeffentlich(cfg);
  assert.equal(oeff.hatPass, true);
  assert.equal(oeff.pass, undefined, 'öffentliche Sicht ohne Passwort');

  // Leeres Passwortfeld beim Ändern = unverändert (nicht gelöscht)
  await sicherung.smbSpeichern({ aktiv: true, host: '192.168.1.23', freigabe: 'Backups', ordner: 'anders', nutzer: 'fabian', port: 445, passwort: '' });
  assert.equal(speicher.entschluesseln((await sicherung.smbKonfig()).pass), 'geheim123', 'Passwort blieb erhalten');

  // aktiv ohne jemals ein Passwort -> Fehler
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-smb-')); const sp2 = new Speicher(d2);
  const s2 = new Sicherung({ speicher: sp2, baum: new Baum(sp2), konten: new Konten(sp2), einstellungen: () => sp2.lesen('einstellungen.json', {}), version: '1' });
  await assert.rejects(() => s2.smbSpeichern({ aktiv: true, host: 'x', freigabe: 'y', nutzer: 'z' }), /Passwort/);

  fs.rmSync(daten, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

/** Attrappe für rclone: meldet Stand-Zeilen wie das echte Werkzeug, scheitert auf Wunsch. */
function falschesRclone(ordner, { fehler = false } = {}) {
  const datei = path.join(ordner, 'rclone');
  fs.writeFileSync(datei, `#!/bin/sh
if [ "$1" = obscure ]; then echo verschleiert; exit 0; fi
echo '{"level":"notice","msg":"Stand","stats":{"bytes":10}}' >&2
${fehler ? `echo '{"level":"error","msg":"SMB nicht erreichbar"}' >&2; exit 3` : 'exit 0'}
`, { mode: 0o755 });
}

async function aufbau(smb) {
  const daten = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-lauf-'));
  const speicher = new Speicher(daten);
  const baum = new Baum(speicher);
  const konten = new Konten(speicher);
  const repo = path.join(speicher.repos, 'test.git');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'pack'), Buffer.alloc(300000, 7));
  const sicherung = new Sicherung({ speicher, baum, konten, version: '9.9.9',
    einstellungen: async () => ({ sicherung: { smb: smb ? { aktiv: true, host: 'nas', freigabe: 'Backups', nutzer: 'x', pass: speicher.verschluesseln('geheim') } : {} } }) });
  return { daten, sicherung };
}

test('Fortschritt: Packen zählt mit, es bleibt keine halbe Datei liegen', async () => {
  const { sicherung } = await aufbau(false);
  const b = await sicherung.jetzt('test');
  const f = sicherung.stand;
  assert.equal(f.laeuft, false);
  assert.deepEqual(f.schritte.map((s) => [s.id, s.zustand, s.prozent]), [['packen', 'fertig', 100]]);
  assert.ok(f.schritte[0].gesamt > 300000, 'Rohgröße ermittelt');
  assert.equal(f.ergebnis.name, b.name);
  assert.deepEqual((await fsp.readdir(sicherung.ordner)).filter((n) => n.startsWith('.')), []);
});

test('Fortschritt: NAS-Kopie meldet Bytes, ein Fehler trifft nur diesen Schritt', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-bin-'));
  const pfad = process.env.PATH;
  process.env.PATH = `${bin}:${pfad}`;
  try {
    falschesRclone(bin);
    const gut = await aufbau(true);
    const b = await gut.sicherung.jetzt('test');
    assert.equal(b.nas.ok, true);
    assert.deepEqual(gut.sicherung.stand.schritte.map((s) => [s.id, s.zustand]), [['packen', 'fertig'], ['nas', 'fertig']]);

    falschesRclone(bin, { fehler: true });
    const schlecht = await aufbau(true);
    const c = await schlecht.sicherung.jetzt('test');
    assert.equal(c.nas.ok, false);
    assert.match(c.nas.fehler, /SMB nicht erreichbar/);
    const [packen, nas] = schlecht.sicherung.stand.schritte;
    assert.equal(packen.zustand, 'fertig');
    assert.equal(nas.zustand, 'fehler');
    assert.match(nas.fehler, /SMB nicht erreichbar/);
    assert.equal((await schlecht.sicherung.liste()).length, 1, 'die lokale Sicherung bleibt');
  } finally { process.env.PATH = pfad; }
});

test('Hintergrund: Lauf antwortet sofort, ein zweiter wird abgelehnt', async () => {
  const { sicherung } = await aufbau(false);
  assert.deepEqual(sicherung.jetztImHintergrund('test'), { gestartet: true });
  assert.equal(sicherung.laeuft, true);
  assert.throws(() => sicherung.jetztImHintergrund('test'), /läuft gerade/);
  while (sicherung.laeuft) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sicherung.stand.ergebnis.manifest.werkzeug, 'fah-git');
});

