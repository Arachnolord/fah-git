// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zustand ohne Datenbank: kleine JSON-Dateien im Datenordner, atomar geschrieben (Zwischendatei + Umbenennen) und je
// Datei hintereinander geändert. Die Repos selbst liegen als normale Git-Ordner daneben (siehe baum.js).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Speicher {
  /** @param {string} ordner Datenordner (z. B. /daten) */
  constructor(ordner) {
    this.ordner = ordner;
    this.repos = path.join(ordner, 'repos');
    this.ketten = new Map();
    fsSync.mkdirSync(this.repos, { recursive: true });
  }

  datei(name) { return path.join(this.ordner, name); }

  /** JSON lesen; fehlt die Datei, gilt `vorgabe`. */
  async lesen(name, vorgabe) {
    try { return JSON.parse(await fs.readFile(this.datei(name), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return structuredClone(vorgabe);
      throw e;
    }
  }

  async schreiben(name, wert) {
    const ziel = this.datei(name);
    const tmp = `${ziel}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(wert, null, 1), { mode: 0o600 });
    await fs.rename(tmp, ziel);
  }

  /**
   * Datei lesen, mit `aendern(wert)` verändern und zurückschreiben -- je Datei streng nacheinander, damit sich zwei
   * gleichzeitige Anfragen nicht gegenseitig überschreiben. Gibt das Ergebnis von `aendern` zurück.
   */
  aendern(name, vorgabe, aendern) {
    const vorher = this.ketten.get(name) || Promise.resolve();
    const lauf = vorher.catch(() => {}).then(async () => {
      const wert = await this.lesen(name, vorgabe);
      const ergebnis = await aendern(wert);
      await this.schreiben(name, wert);
      return ergebnis;
    });
    this.ketten.set(name, lauf.catch(() => {}));
    return lauf;
  }

  /** Geheimer Schlüssel (32 Byte) für Sitzungen und verschlüsselte Zugangsdaten; beim ersten Start erzeugt. */
  geheimnis() {
    if (this._geheimnis) return this._geheimnis;
    const datei = this.datei('geheim.key');
    try { this._geheimnis = fsSync.readFileSync(datei); } catch {
      this._geheimnis = crypto.randomBytes(32);
      fsSync.writeFileSync(datei, this._geheimnis, { mode: 0o600, flag: 'wx' });
    }
    return this._geheimnis;
  }

  /** Zugangsdaten für Spiegel verschlüsseln (AES-256-GCM). */
  verschluesseln(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.geheimnis(), iv);
    const daten = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${daten.toString('base64')}`;
  }

  entschluesseln(wert) {
    if (!wert) return '';
    const [v, iv, tag, daten] = String(wert).split(':');
    if (v !== 'v1') throw new Error('Unbekanntes Schlüsselformat');
    const d = crypto.createDecipheriv('aes-256-gcm', this.geheimnis(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(daten, 'base64')), d.final()]).toString('utf8');
  }
}
