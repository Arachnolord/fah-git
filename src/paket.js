// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Update-Paket für den Fail-over-Ersatz (1.15.0). Unterschrieben wird BEIM ZIP-BAU auf dem Entwicklungsrechner
// (tools/release_signieren.mjs, Ed25519, privater Schlüssel nur dort in ~/.config/fah-git/). Die ZIP enthält
// paket-manifest.txt + paket-signatur; der Haupt reicht beides nur durch und kann selbst nichts unterschreiben – wer den
// Haupt übernimmt, kommt damit nicht auf den Rechner des Ersatzes. Den öffentlichen Schlüssel trägt jede Fassung in
// src/release-schluessel.txt; geprüft wird immer mit dem Schlüssel der BEREITS INSTALLIERTEN Fassung.
//
// Ablage eines Pakets: <ordner>/manifest.txt, <ordner>/signatur (base64), <ordner>/dateien/<name>.
// Aufruf auf der Kommandozeile: node src/paket.js pruefen <ordner> <öffentlicher Schlüssel base64> [erwartete Version]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const OBEN = ['package.json', 'Dockerfile', 'docker-compose.yml', 'manage.sh', 'README.md'];
const NAME = /^(package\.json|Dockerfile|docker-compose\.yml|manage\.sh|README\.md|(src|public)(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,8})$/;
const KOPF = 'fah-git-paket v1';
const MAX_DATEIEN = 2000;
const MAX_GROESSE = 32 * 1024 * 1024;

export const nameGueltig = (n) => NAME.test(String(n || ''));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Programmstand eines App-Ordners einsammeln (ohne Verstecktes). */
export function dateienSammeln(app) {
  const liste = [];
  for (const n of OBEN) { const p = path.join(app, n); if (fs.existsSync(p)) liste.push({ name: n, inhalt: fs.readFileSync(p) }); }
  const geh = (rel) => {
    for (const e of fs.readdirSync(path.join(app, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) geh(r);
      else if (e.isFile() && nameGueltig(r)) liste.push({ name: r, inhalt: fs.readFileSync(path.join(app, r)) });
    }
  };
  for (const d of ['src', 'public']) if (fs.existsSync(path.join(app, d))) geh(d);
  return liste.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Kanonisches Manifest: Kopf, Version, je Datei „sha256 größe name“ (sortiert). */
export function manifest(version, dateien) {
  return [KOPF, String(version), ...dateien.map((d) => `${sha(d.inhalt)} ${d.inhalt.length} ${d.name}`).sort((a, b) => (a.split(' ')[2] < b.split(' ')[2] ? -1 : 1))].join('\n') + '\n';
}

/** Schlüssel laden oder beim ersten Mal anlegen → { privat, oeffentlich (base64 SPKI/DER) }. */
export function schluesselLaden(datei) {
  let privat;
  try { privat = crypto.createPrivateKey(fs.readFileSync(datei)); } catch {
    fs.mkdirSync(path.dirname(datei), { recursive: true, mode: 0o700 });
    const paar = crypto.generateKeyPairSync('ed25519');
    try { fs.writeFileSync(datei, paar.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' }); privat = paar.privateKey; } catch {
      privat = crypto.createPrivateKey(fs.readFileSync(datei)); // gleichzeitig angelegt
    }
  }
  return { privat, oeffentlich: crypto.createPublicKey(privat).export({ type: 'spki', format: 'der' }).toString('base64') };
}

export function unterschreiben(privat, text) { return crypto.sign(null, Buffer.from(text), privat).toString('base64'); }

export function signaturGueltig(pub, text, signatur) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(String(pub), 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ed25519' && crypto.verify(null, Buffer.from(text), k, Buffer.from(String(signatur), 'base64'));
  } catch { return false; }
}

/** Manifest lesen → { version, eintraege: [{sha, groesse, name}] }; wirft bei falschem Aufbau. */
export function manifestLesen(text) {
  const z = String(text).split('\n');
  if (z[0] !== KOPF || !/^\d+\.\d+\.\d+$/.test(z[1] || '') || z.at(-1) !== '') throw new Error('Manifest hat einen falschen Aufbau');
  const eintraege = z.slice(2, -1).map((l) => {
    const m = /^([0-9a-f]{64}) (\d{1,9}) (.+)$/.exec(l);
    if (!m || !nameGueltig(m[3])) throw new Error(`Manifest-Zeile ungültig: ${l.slice(0, 80)}`);
    return { sha: m[1], groesse: Number(m[2]), name: m[3] };
  });
  if (!eintraege.length || eintraege.length > MAX_DATEIEN) throw new Error('Manifest leer oder zu groß');
  if (new Set(eintraege.map((e) => e.name)).size !== eintraege.length) throw new Error('Manifest nennt eine Datei doppelt');
  for (const n of ['package.json', 'Dockerfile', 'docker-compose.yml', 'manage.sh']) if (!eintraege.some((e) => e.name === n)) throw new Error(`Paket ohne ${n}`);
  return { version: z[1], eintraege };
}

/**
 * Abgelegtes Paket prüfen: Unterschrift über das Manifest, jede Datei (Größe + SHA-256), keine Datei zu viel, keine
 * Verweise. → Version; wirft mit verständlichem Text.
 */
export function ordnerPruefen(ordner, pub, erwartet) {
  // Keine Verweise an den festen Stellen (sonst prüft man etwas anderes, als später eingespielt wird).
  const art = (p, soll) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || (soll === 'd' ? !st.isDirectory() : !st.isFile())) throw new Error(`${path.basename(p)} ist kein ${soll === 'd' ? 'Ordner' : 'Datei'} (Verweis?)`);
    return st;
  };
  art(ordner, 'd'); art(path.join(ordner, 'dateien'), 'd');
  if (art(path.join(ordner, 'manifest.txt'), 'f').size > 1024 * 1024 || art(path.join(ordner, 'signatur'), 'f').size > 1024) throw new Error('Manifest oder Signatur zu groß');
  const text = fs.readFileSync(path.join(ordner, 'manifest.txt'), 'utf8');
  const signatur = fs.readFileSync(path.join(ordner, 'signatur'), 'utf8').trim();
  if (!signaturGueltig(pub, text, signatur)) throw new Error('Unterschrift des Pakets passt nicht zum Release-Schlüssel der installierten Fassung');
  const m = manifestLesen(text);
  if (erwartet && m.version !== erwartet) throw new Error(`Paket hat Version ${m.version}, erwartet ${erwartet}`);
  const basis = path.join(ordner, 'dateien');
  const soll = new Map(m.eintraege.map((e) => [e.name, e]));
  let summe = 0;
  const geh = (rel) => {
    for (const e of fs.readdirSync(path.join(basis, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`Verweis im Paket: ${r}`);
      if (e.isDirectory()) { geh(r); continue; }
      const s = soll.get(r);
      if (!s || !e.isFile()) throw new Error(`Datei nicht im Manifest: ${r.replace(/[^A-Za-z0-9._\/-]/g, '?').slice(0, 120)}`);
      if (fs.lstatSync(path.join(basis, r)).size !== s.groesse) throw new Error(`Größe weicht ab: ${r}`);
      const inhalt = fs.readFileSync(path.join(basis, r));
      summe += inhalt.length;
      if (summe > MAX_GROESSE) throw new Error('Paket zu groß');
      if (inhalt.length !== s.groesse || sha(inhalt) !== s.sha) throw new Error(`Inhalt weicht ab: ${r}`);
      soll.delete(r);
    }
  };
  geh('');
  if (soll.size) throw new Error(`Datei fehlt: ${[...soll.keys()][0]}`);
  return m.version;
}

/** Programmstand eines App-Ordners gegen ein Manifest prüfen und als Dateiliste liefern (Haupt reicht so sein Release weiter). */
export function nachManifest(app, text) {
  const m = manifestLesen(text);
  return { version: m.version, dateien: m.eintraege.map((e) => {
    const inhalt = fs.readFileSync(path.join(app, ...e.name.split('/')));
    if (inhalt.length !== e.groesse || sha(inhalt) !== e.sha) throw new Error(`Programmstand weicht vom unterschriebenen Release ab: ${e.name}`);
    return { name: e.name, inhalt };
  }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , befehl, ordner, pub, erwartet] = process.argv;
  if (befehl !== 'pruefen' || !ordner || !pub) { console.error('Aufruf: node src/paket.js pruefen <ordner> <öffentlicher Schlüssel> [Version]'); process.exit(2); }
  try { console.log(ordnerPruefen(ordner, pub, erwartet)); } catch (e) { console.error(e.message); process.exit(1); }
}
