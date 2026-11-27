// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Unterschreibt den Programmstand für den Fail-over-Selbstupdate (1.15.0): schreibt paket-manifest.txt und paket-signatur
// in den Projektordner (kommen in die Release-ZIP, nicht ins Git). Der private Schlüssel liegt NUR auf dem Bau-Rechner
// (Vorgabe ~/.config/fah-git/release-schluessel.pem, 0600) – nie im Repo, nie auf Haupt oder Ersatz. Der öffentliche
// Schlüssel steht in src/release-schluessel.txt und muss dazu passen (sonst Abbruch: alte Ersatz-Instanzen würden das
// Update ablehnen). Gibt es noch keinen Schlüssel, wird einer angelegt und src/release-schluessel.txt geschrieben.
//
// Aufruf: node tools/release_signieren.mjs [Schlüsseldatei]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dateienSammeln, manifest, manifestLesen, ordnerPruefen } from '../src/paket.js';

const PROJEKT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHLUESSEL = process.argv[2] || path.join(os.homedir(), '.config', 'fah-git', 'release-schluessel.pem');
const PUB_DATEI = path.join(PROJEKT, 'src', 'release-schluessel.txt');

let privat;
if (fs.existsSync(SCHLUESSEL)) privat = crypto.createPrivateKey(fs.readFileSync(SCHLUESSEL));
else {
  fs.mkdirSync(path.dirname(SCHLUESSEL), { recursive: true, mode: 0o700 });
  privat = crypto.generateKeyPairSync('ed25519').privateKey;
  fs.writeFileSync(SCHLUESSEL, privat.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  console.log(`Neuer Release-Schlüssel: ${SCHLUESSEL}`);
}
if (privat.asymmetricKeyType !== 'ed25519') throw new Error('Release-Schlüssel ist kein Ed25519-Schlüssel');
const pub = crypto.createPublicKey(privat).export({ type: 'spki', format: 'der' }).toString('base64');
const bisher = fs.existsSync(PUB_DATEI) ? fs.readFileSync(PUB_DATEI, 'utf8').trim() : '';
if (!bisher) { fs.writeFileSync(PUB_DATEI, `${pub}\n`); console.log('src/release-schluessel.txt angelegt'); }
else if (bisher !== pub) {
  console.error('ABBRUCH: Der Release-Schlüssel passt nicht zu src/release-schluessel.txt – laufende Ersatz-Instanzen würden das Update ablehnen.');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(PROJEKT, 'package.json'), 'utf8')).version;
const dateien = dateienSammeln(PROJEKT);
const text = manifest(version, dateien);
manifestLesen(text);
const signatur = crypto.sign(null, Buffer.from(text), privat).toString('base64');
fs.writeFileSync(path.join(PROJEKT, 'paket-manifest.txt'), text);
fs.writeFileSync(path.join(PROJEKT, 'paket-signatur'), `${signatur}\n`);

// Gegenprobe wie am Ersatz: Paket-Ablage im Scratch nachbauen und prüfen.
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'fahgit-release-'));
try {
  for (const d of dateien) { const z = path.join(probe, 'dateien', ...d.name.split('/')); fs.mkdirSync(path.dirname(z), { recursive: true }); fs.writeFileSync(z, d.inhalt); }
  fs.writeFileSync(path.join(probe, 'manifest.txt'), text);
  fs.writeFileSync(path.join(probe, 'signatur'), `${signatur}\n`);
  ordnerPruefen(probe, pub, version);
} finally { fs.rmSync(probe, { recursive: true, force: true }); }
console.log(`Release ${version} unterschrieben: ${dateien.length} Dateien`);
