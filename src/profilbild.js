// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Profilbilder (Betreiber 26.10.2026: „ein User-Bild als Profilbild hinterlegen“). Der Browser schneidet quadratisch zu
// und verkleinert auf 256 × 256; hier nur Typ und Signatur prüfen und als Datei ablegen: daten/avatare/<nutzer>.<art>
// (nicht im Git, nicht in nutzer.json – dort steht nur Art und Stand).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const BILD_MAX = 300 * 1024;
export const ORDNER = 'avatare';
const ARTEN = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const TYP = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

const SIGNATUR = {
  png: (d) => d.length > 8 && d.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (d) => d.length > 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff,
  webp: (d) => d.length > 12 && d.toString('latin1', 0, 4) === 'RIFF' && d.toString('latin1', 8, 12) === 'WEBP',
};

/** Angesagter Typ (Content-Type) → Art, wenn erlaubt; sonst null. */
export function artAusTyp(typ) { return ARTEN[String(typ || '').split(';')[0].trim().toLowerCase()] || null; }

/** Stimmen angesagter Typ und Dateianfang überein? → Art (png|jpg|webp) oder null. */
export function bildArt(daten, typ) {
  const art = artAusTyp(typ);
  return art && SIGNATUR[art](daten) ? art : null;
}

export const datei = (ordner, name, art) => path.join(ordner, `${name}.${art}`);

/** Atomar schreiben; ein älteres Bild mit anderer Endung verschwindet. */
export async function schreiben(ordner, name, art, daten) {
  await fs.mkdir(ordner, { recursive: true, mode: 0o700 });
  const ziel = datei(ordner, name, art);
  const tmp = `${ziel}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, daten, { mode: 0o600 });
  await fs.rename(tmp, ziel);
  for (const a of Object.values(ARTEN)) if (a !== art) await fs.rm(datei(ordner, name, a), { force: true });
}

export async function entfernen(ordner, name) {
  for (const a of Object.values(ARTEN)) await fs.rm(datei(ordner, name, a), { force: true });
}

/** Beim Umbenennen des Nutzers wandert das Bild mit. */
export async function umbenennen(ordner, alt, neu) {
  for (const a of Object.values(ARTEN)) {
    try { await fs.rename(datei(ordner, alt, a), datei(ordner, neu, a)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
