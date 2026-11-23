// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Konten, Kennwörter (scrypt), Zugangsschlüssel für git (nur als SHA-256 gespeichert) und Sitzungen (signiertes Cookie).
// Seit 1.4.0: Schlüssel „Nur lesen“, Freigaben je Ordner/Projekt (siehe rechte.js), Profilbild, Umbenennen.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as profilbild from './profilbild.js';
import { liegtIn, freigabenUmziehen } from './rechte.js';

const scrypt = promisify(crypto.scrypt);
const DATEI = 'nutzer.json';
const VORGABE = { nutzer: [], schluessel: [] };
export const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const KENNWORT_MIN = 8;
export const SITZUNG_TAGE = 30;
export const SCHLUESSEL_PRAEFIX = 'fgit_';
export const SCHLUESSEL_RECHTE = ['schreiben', 'lesen'];
const SCRYPT = { N: 16384, r: 8, p: 1 };

export class KontoFehler extends Error {
  constructor(text, status = 400) { super(text); this.status = status; }
}

async function hashen(kennwort) {
  const salz = crypto.randomBytes(16);
  const h = await scrypt(String(kennwort), salz, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salz.toString('base64')}$${h.toString('base64')}`;
}

async function vergleichen(kennwort, gespeichert) {
  const [art, n, r, p, salz, hash] = String(gespeichert || '').split('$');
  if (art !== 'scrypt') return false;
  const soll = Buffer.from(hash, 'base64');
  const ist = await scrypt(String(kennwort), Buffer.from(salz, 'base64'), soll.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(ist, soll);
}

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const oeffentlich = (n) => ({ name: n.name, anzeige: n.anzeige || n.name, admin: !!n.admin, erstellt: n.erstellt,
  bild: n.bild ? n.bild.stand : null, freigaben: (n.freigaben || []).map((f) => ({ pfad: f.pfad, recht: f.recht })) });

export class Konten {
  /** @param {import('./speicher.js').Speicher} speicher */
  constructor(speicher) {
    this.speicher = speicher;
    this.fehlversuche = new Map();
    this.bildOrdner = speicher.datei(profilbild.ORDNER);
  }

  daten() { return this.speicher.lesen(DATEI, VORGABE); }
  aendern(f) { return this.speicher.aendern(DATEI, VORGABE, f); }

  async ersteinrichtungNoetig() { return (await this.daten()).nutzer.length === 0; }

  async liste() { return (await this.daten()).nutzer.map(oeffentlich); }

  async holen(name) {
    const n = (await this.daten()).nutzer.find((x) => x.name === name);
    return n ? oeffentlich(n) : null;
  }

  async anlegen({ name, anzeige, kennwort, admin = false }, { nurWennLeer = false } = {}) {
    name = String(name || '').trim().toLowerCase();
    if (!NAME.test(name)) throw new KontoFehler('Benutzername: Kleinbuchstaben, Ziffern, Punkt, Bindestrich (höchstens 40 Zeichen)');
    if (String(kennwort || '').length < KENNWORT_MIN) throw new KontoFehler(`Das Kennwort braucht mindestens ${KENNWORT_MIN} Zeichen`);
    const hash = await hashen(kennwort);
    return this.aendern((d) => {
      if (nurWennLeer && d.nutzer.length) throw new KontoFehler('Die Ersteinrichtung ist schon erledigt', 409);
      if (d.nutzer.some((x) => x.name === name)) throw new KontoFehler('Den Benutzer gibt es schon', 409);
      const n = { name, anzeige: String(anzeige || name).trim().slice(0, 80) || name, hash, admin: !!admin || d.nutzer.length === 0,
        version: 1, erstellt: new Date().toISOString(), freigaben: [] };   // Nicht-Admins sehen erst nach einer Freigabe etwas
      d.nutzer.push(n);
      return oeffentlich(n);
    });
  }

  /** Anmeldung prüfen; zu viele Fehlversuche je Quelle → 429. */
  async pruefen(name, kennwort, quelle = '') {
    const jetzt = Date.now();
    const f = this.fehlversuche.get(quelle) || { n: 0, seit: jetzt };
    if (jetzt - f.seit > 10 * 60_000) { f.n = 0; f.seit = jetzt; }
    if (f.n >= 10) throw new KontoFehler('Zu viele Fehlversuche – bitte in einigen Minuten erneut versuchen', 429);
    const n = (await this.daten()).nutzer.find((x) => x.name === String(name || '').trim().toLowerCase());
    const ok = n ? await vergleichen(kennwort, n.hash) : (await hashen('x'), false);
    if (!ok) { f.n += 1; this.fehlversuche.set(quelle, f); return null; }
    this.fehlversuche.delete(quelle);
    return oeffentlich(n);
  }

  async kennwortSetzen(name, kennwort) {
    if (String(kennwort || '').length < KENNWORT_MIN) throw new KontoFehler(`Das Kennwort braucht mindestens ${KENNWORT_MIN} Zeichen`);
    const hash = await hashen(kennwort);
    await this.aendern((d) => {
      const n = d.nutzer.find((x) => x.name === name);
      if (!n) throw new KontoFehler('Benutzer fehlt', 404);
      n.hash = hash; n.version = (n.version || 1) + 1; // alte Sitzungen enden
    });
  }

  /** `freigaben` kommt schon geprüft (server.js kennt den Baum). */
  async aendernNutzer(name, { anzeige, admin, freigaben }) {
    await this.aendern((d) => {
      const n = d.nutzer.find((x) => x.name === name);
      if (!n) throw new KontoFehler('Benutzer fehlt', 404);
      if (anzeige != null) n.anzeige = String(anzeige).trim().slice(0, 80) || n.name;
      if (Array.isArray(freigaben)) n.freigaben = freigaben.map((f) => ({ pfad: f.pfad, recht: f.recht }));
      if (admin != null) {
        if (!admin && n.admin && d.nutzer.filter((x) => x.admin).length === 1) throw new KontoFehler('Der letzte Administrator bleibt Administrator');
        n.admin = !!admin;
      }
    });
  }

  async loeschen(name) {
    await this.aendern((d) => {
      const n = d.nutzer.find((x) => x.name === name);
      if (!n) throw new KontoFehler('Benutzer fehlt', 404);
      if (n.admin && d.nutzer.filter((x) => x.admin).length === 1) throw new KontoFehler('Der letzte Administrator lässt sich nicht löschen');
      d.nutzer = d.nutzer.filter((x) => x !== n);
      d.schluessel = d.schluessel.filter((s) => s.nutzer !== name);
    });
    await profilbild.entfernen(this.bildOrdner, name);
  }

  /** Benutzername ändern: Zugangsschlüssel, Freigaben und Profilbild gehen mit; laufende Sitzungen enden. */
  async umbenennen(alt, neu) {
    neu = String(neu || '').trim().toLowerCase();
    if (!NAME.test(neu)) throw new KontoFehler('Benutzername: Kleinbuchstaben, Ziffern, Punkt, Bindestrich (höchstens 40 Zeichen)');
    const n = await this.aendern((d) => {
      const x = d.nutzer.find((y) => y.name === alt);
      if (!x) throw new KontoFehler('Benutzer fehlt', 404);
      if (alt === neu) return oeffentlich(x);
      if (d.nutzer.some((y) => y.name === neu)) throw new KontoFehler('Den Benutzer gibt es schon', 409);
      x.name = neu; x.version = (x.version || 1) + 1;
      for (const s of d.schluessel) if (s.nutzer === alt) s.nutzer = neu;
      return oeffentlich(x);
    });
    if (alt !== neu) await profilbild.umbenennen(this.bildOrdner, alt, neu);
    return n;
  }

  // --- Freigaben (Pfade wandern beim Verschieben mit, verschwinden beim Löschen) --------------------------------------

  freigabenUmziehen(alt, neu) {
    return this.aendern((d) => { for (const n of d.nutzer) freigabenUmziehen(n.freigaben, alt, neu); });
  }

  freigabenEntfernen(pfad) {
    return this.aendern((d) => {
      for (const n of d.nutzer) if (n.freigaben) n.freigaben = n.freigaben.filter((f) => !f.pfad || !liegtIn(f.pfad, pfad));
    });
  }

  // --- Profilbild ------------------------------------------------------------------------------------------------------

  async bildSetzen(name, daten, art) {
    if (!(await this.holen(name))) throw new KontoFehler('Benutzer fehlt', 404);
    await profilbild.schreiben(this.bildOrdner, name, art, daten);
    const stand = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    await this.aendern((d) => {
      const n = d.nutzer.find((x) => x.name === name);
      if (!n) throw new KontoFehler('Benutzer fehlt', 404);
      n.bild = { art, stand };
    });
    return stand;
  }

  async bildEntfernen(name) {
    await this.aendern((d) => { const n = d.nutzer.find((x) => x.name === name); if (n) delete n.bild; });
    await profilbild.entfernen(this.bildOrdner, name);
  }

  /** → {datei, typ, stand} oder null */
  async bildHolen(name) {
    const n = (await this.daten()).nutzer.find((x) => x.name === name);
    if (!n || !n.bild || !profilbild.TYP[n.bild.art]) return null;
    return { datei: profilbild.datei(this.bildOrdner, n.name, n.bild.art), typ: profilbild.TYP[n.bild.art], stand: n.bild.stand };
  }

  /** Name → Stand des Profilbilds (für die Aktivitätsliste). */
  async bilder() {
    return new Map((await this.daten()).nutzer.filter((n) => n.bild).map((n) => [n.name, n.bild.stand]));
  }

  // --- Zugangsschlüssel (für git und Skripte) ---------------------------------------------------------------------

  /** recht: 'schreiben' (Standard, wie bisher) oder 'lesen' (nur klonen/holen/abfragen, z. B. für FAH-NAS). */
  async schluesselErzeugen(nutzer, name, recht = 'schreiben') {
    recht = recht == null || recht === '' ? 'schreiben' : String(recht);
    if (!SCHLUESSEL_RECHTE.includes(recht)) throw new KontoFehler('Recht des Schlüssels: „lesen“ oder „schreiben“');
    const geheim = SCHLUESSEL_PRAEFIX + crypto.randomBytes(24).toString('base64url');
    const eintrag = { id: crypto.randomBytes(6).toString('hex'), nutzer, name: String(name || 'Schlüssel').trim().slice(0, 60) || 'Schlüssel',
      hash: sha256(geheim), anfang: geheim.slice(0, 9), recht, erstellt: new Date().toISOString(), zuletzt: null };
    await this.aendern((d) => {
      if (!d.nutzer.some((x) => x.name === nutzer)) throw new KontoFehler('Benutzer fehlt', 404);
      d.schluessel.push(eintrag);
    });
    return { ...this.schluesselOeffentlich(eintrag), geheim };
  }

  // Alte Schlüssel ohne Angabe = lesen und schreiben (wie vor 1.4.0)
  schluesselOeffentlich(s) {
    return { id: s.id, name: s.name, anfang: s.anfang, recht: s.recht === 'lesen' ? 'lesen' : 'schreiben', erstellt: s.erstellt, zuletzt: s.zuletzt };
  }

  async schluesselListe(nutzer) {
    return (await this.daten()).schluessel.filter((s) => s.nutzer === nutzer).map((s) => this.schluesselOeffentlich(s));
  }

  async schluesselLoeschen(nutzer, id) {
    await this.aendern((d) => {
      const vorher = d.schluessel.length;
      d.schluessel = d.schluessel.filter((s) => !(s.nutzer === nutzer && s.id === id));
      if (d.schluessel.length === vorher) throw new KontoFehler('Schlüssel fehlt', 404);
    });
  }

  /**
   * Zugangsschlüssel prüfen → Nutzer oder null. Ein Schlüssel „Nur lesen“ trägt `leseSchluessel: true` (deckelt die Rechte,
   * siehe rechte.js). Merkt sich die letzte Nutzung (höchstens einmal je Stunde geschrieben).
   */
  async schluesselPruefen(geheim) {
    if (!String(geheim || '').startsWith(SCHLUESSEL_PRAEFIX)) return null;
    const h = sha256(geheim);
    const d = await this.daten();
    const s = d.schluessel.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash, 'hex'), Buffer.from(h, 'hex')));
    if (!s) return null;
    const n = d.nutzer.find((x) => x.name === s.nutzer);
    if (!n) return null;
    if (!s.zuletzt || Date.now() - Date.parse(s.zuletzt) > 3600_000) {
      this.aendern((dd) => { const x = dd.schluessel.find((y) => y.id === s.id); if (x) x.zuletzt = new Date().toISOString(); }).catch(() => {});
    }
    return s.recht === 'lesen' ? { ...oeffentlich(n), leseSchluessel: true } : oeffentlich(n);
  }

  /** Für git: Benutzername + Kennwort ODER beliebiger Benutzername + Zugangsschlüssel. */
  async gitAnmeldung(name, geheim, quelle) {
    const ueberSchluessel = await this.schluesselPruefen(geheim);
    if (ueberSchluessel) return ueberSchluessel;
    return this.pruefen(name, geheim, `git:${quelle}`);
  }

  // --- Sitzungen ---------------------------------------------------------------------------------------------------

  async sitzungErzeugen(name) {
    const n = (await this.daten()).nutzer.find((x) => x.name === name);
    const inhalt = Buffer.from(JSON.stringify({ n: name, v: n.version || 1, b: Date.now() + SITZUNG_TAGE * 86400_000 })).toString('base64url');
    return `${inhalt}.${this.signatur(inhalt)}`;
  }

  signatur(t) { return crypto.createHmac('sha256', this.speicher.geheimnis()).update(t).digest('base64url'); }

  async sitzungPruefen(wert) {
    const [inhalt, sig] = String(wert || '').split('.');
    if (!inhalt || !sig) return null;
    const soll = Buffer.from(this.signatur(inhalt));
    const ist = Buffer.from(sig);
    if (soll.length !== ist.length || !crypto.timingSafeEqual(soll, ist)) return null;
    let d; try { d = JSON.parse(Buffer.from(inhalt, 'base64url').toString('utf8')); } catch { return null; }
    if (!d || Date.now() > d.b) return null;
    const n = (await this.daten()).nutzer.find((x) => x.name === d.n);
    if (!n || (n.version || 1) !== d.v) return null;
    return oeffentlich(n);
  }
}
