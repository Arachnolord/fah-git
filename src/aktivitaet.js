// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Was zuletzt passiert ist (Pushes, neue Projekte, Spiegel-Probleme) -- für die Übersicht. Höchstens 1000 Einträge.

const DATEI = 'aktivitaet.json';
const MAX = 1000;

export class Aktivitaet {
  /** @param {import('./speicher.js').Speicher} speicher */
  constructor(speicher) { this.speicher = speicher; }

  melden(eintrag) {
    const e = { zeit: new Date().toISOString(), ...eintrag };
    return this.speicher.aendern(DATEI, [], (liste) => {
      liste.unshift(e);
      if (liste.length > MAX) liste.length = MAX;
    }).catch(() => {});
  }

  async liste({ projekt, anzahl = 50 } = {}) {
    const alle = await this.speicher.lesen(DATEI, []);
    const passend = projekt ? alle.filter((e) => e.projekt === projekt || (e.projekt || '').startsWith(projekt + '/')) : alle;
    return passend.slice(0, Math.min(200, anzahl));
  }

  /** Nach Verschieben/Umbenennen: alte Einträge zeigen auf den neuen Pfad. */
  umbenennen(alt, neu) {
    return this.speicher.aendern(DATEI, [], (liste) => {
      for (const e of liste) if (e.projekt === alt || (e.projekt || '').startsWith(alt + '/')) e.projekt = neu + e.projekt.slice(alt.length);
    }).catch(() => {});
  }

  /** Nach dem Umbenennen eines Nutzers: seine Einträge (und damit sein Profilbild) gehören dem neuen Namen. */
  nutzerUmbenennen(alt, neu) {
    return this.speicher.aendern(DATEI, [], (liste) => { for (const e of liste) if (e.nutzer === alt) e.nutzer = neu; }).catch(() => {});
  }
}
