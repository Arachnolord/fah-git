// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ordner und Projekte. Auf der Platte ist ein Ordner ein Verzeichnis und ein Projekt ein nacktes Git-Repo „<name>.git“
// darin -- genau der Baum, den man im Browser sieht. Anzeigenamen, Beschreibungen und Umleitungen (nach dem Verschieben
// funktionieren alte Klon-Adressen weiter) stehen in meta.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { git, gitText } from './git.js';

export const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const TIEFE_MAX = 10;
const META = 'meta.json';
const META_VORGABE = { ordner: {}, projekte: {}, umleitungen: {} };

export class BaumFehler extends Error {
  constructor(text, status = 400) { super(text); this.status = status; }
}

/** Anzeigename → Pfadteil: „Mein Projekt (Beta)“ → „mein-projekt-beta“. */
export function slug(name) {
  const s = String(name || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s.slice(0, 100);
}

/** Pfad prüfen und in Teile zerlegen („a/b/c“). Leer = Wurzel. */
export function teile(pfad) {
  const t = String(pfad || '').replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!t) return [];
  const s = t.split('/');
  if (s.length > TIEFE_MAX) throw new BaumFehler(`Höchstens ${TIEFE_MAX} Ebenen`);
  for (const x of s) if (!SEGMENT.test(x) || x.endsWith('.git')) throw new BaumFehler(`Ungültiger Name im Pfad: „${x}“`);
  return s;
}

export class Baum {
  /** @param {import('./speicher.js').Speicher} speicher */
  constructor(speicher) {
    this.speicher = speicher;
    this.wurzel = speicher.repos;
  }

  meta() { return this.speicher.lesen(META, META_VORGABE); }
  metaAendern(f) { return this.speicher.aendern(META, META_VORGABE, f); }

  ordnerPfad(pfad) { return path.join(this.wurzel, ...teile(pfad)); }
  repoPfad(pfad) {
    const t = teile(pfad);
    if (!t.length) throw new BaumFehler('Projektpfad fehlt');
    return path.join(this.wurzel, ...t.slice(0, -1), `${t.at(-1)}.git`);
  }

  async istProjekt(pfad) {
    try { return (await fs.stat(path.join(this.repoPfad(pfad), 'HEAD'))).isFile(); } catch { return false; }
  }

  async istOrdner(pfad) {
    if (!teile(pfad).length) return true;
    try { return (await fs.stat(this.ordnerPfad(pfad))).isDirectory(); } catch { return false; }
  }

  /** Alten Pfad (vor dem Verschieben) auf den heutigen abbilden; unbekannt → unverändert. */
  async aufloesen(pfad) {
    const p = teile(pfad).join('/');
    if (await this.istProjekt(p)) return p;
    const { umleitungen } = await this.meta();
    let ziel = p; const gesehen = new Set();
    while (umleitungen[ziel] && !gesehen.has(ziel)) { gesehen.add(ziel); ziel = umleitungen[ziel]; }
    return ziel;
  }

  /** Der ganze Baum: Ordner mit Unterordnern und Projekten (sortiert, Ordner zuerst). */
  async liste() {
    const meta = await this.meta();
    const lauf = async (rel) => {
      const abs = path.join(this.wurzel, ...rel);
      const knoten = { ordner: [], projekte: [] };
      let eintraege = [];
      try { eintraege = await fs.readdir(abs, { withFileTypes: true }); } catch { return knoten; }
      for (const e of eintraege) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        if (e.name.endsWith('.git')) {
          const pfad = [...rel, e.name.slice(0, -4)].join('/');
          const m = meta.projekte[pfad] || {};
          knoten.projekte.push({ pfad, slug: e.name.slice(0, -4), name: m.name || e.name.slice(0, -4), beschreibung: m.beschreibung || '',
            themen: m.themen || [], quelle: m.quelle ? { url: m.quelle.url } : null, spiegel: (m.spiegel || []).length,
            zuletzt: m.zuletzt || m.erstellt || null });
        } else if (SEGMENT.test(e.name)) {
          const pfad = [...rel, e.name].join('/');
          const m = meta.ordner[pfad] || {};
          const unter = await lauf([...rel, e.name]);
          knoten.ordner.push({ pfad, slug: e.name, name: m.name || e.name, beschreibung: m.beschreibung || '', ...unter });
        }
      }
      const nachName = (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
      knoten.ordner.sort(nachName); knoten.projekte.sort(nachName);
      return knoten;
    };
    return lauf([]);
  }

  async ordnerAnlegen(eltern, name, { slugWert, beschreibung = '' } = {}) {
    const e = teile(eltern);
    if (!(await this.istOrdner(e.join('/')))) throw new BaumFehler('Übergeordneter Ordner fehlt', 404);
    const s = slugWert || slug(name);
    if (!SEGMENT.test(s)) throw new BaumFehler('Name ergibt keinen gültigen Ordnernamen');
    const pfad = [...e, s].join('/');
    if (await this.istProjekt(pfad)) throw new BaumFehler('Dort liegt schon ein Projekt mit diesem Namen', 409);
    try { await fs.mkdir(this.ordnerPfad(pfad)); } catch (err) {
      if (err.code === 'EEXIST') throw new BaumFehler('Den Ordner gibt es schon', 409);
      throw err;
    }
    await this.metaAendern((m) => { m.ordner[pfad] = { name: String(name || s).trim().slice(0, 100) || s, beschreibung: String(beschreibung).slice(0, 500), erstellt: new Date().toISOString() }; });
    return pfad;
  }

  /** Ordner sicherstellen (beim Import): legt fehlende Ebenen mit Anzeigenamen an. */
  async ordnerKette(teilePfad, namen = []) {
    let eltern = '';
    for (let i = 0; i < teilePfad.length; i++) {
      const pfad = [...teilePfad.slice(0, i + 1)].join('/');
      if (!(await this.istOrdner(pfad))) await this.ordnerAnlegen(eltern, namen[i] || teilePfad[i], { slugWert: teilePfad[i] });
      eltern = pfad;
    }
    return eltern;
  }

  async projektAnlegen(ordner, name, { slugWert, beschreibung = '', themen = [], standard = 'main', leer = true } = {}) {
    const o = teile(ordner);
    if (!(await this.istOrdner(o.join('/')))) throw new BaumFehler('Ordner fehlt', 404);
    const s = slugWert || slug(name);
    if (!SEGMENT.test(s)) throw new BaumFehler('Name ergibt keinen gültigen Projektnamen');
    const pfad = [...o, s].join('/');
    if (await this.istOrdner(pfad)) throw new BaumFehler('Dort liegt schon ein Ordner mit diesem Namen', 409);
    const ziel = this.repoPfad(pfad);
    try { await fs.mkdir(ziel); } catch (err) {
      if (err.code === 'EEXIST') throw new BaumFehler('Das Projekt gibt es schon', 409);
      throw err;
    }
    if (leer) await git(['init', '--quiet', '--bare', `--initial-branch=${standard}`, ziel]);
    await this.metaAendern((m) => {
      m.projekte[pfad] = { name: String(name || s).trim().slice(0, 100) || s, beschreibung: String(beschreibung).slice(0, 2000),
        themen: themen.slice(0, 20).map(String), erstellt: new Date().toISOString() };
      delete m.umleitungen[pfad];
    });
    return pfad;
  }

  async projektMeta(pfad) {
    const m = await this.meta();
    return m.projekte[pfad] || {};
  }

  async projektAendern(pfad, f) {
    return this.metaAendern((m) => {
      m.projekte[pfad] = m.projekte[pfad] || {};
      return f(m.projekte[pfad], m);
    });
  }

  async ordnerAendern(pfad, { name, beschreibung }) {
    if (!(await this.istOrdner(pfad)) || !teile(pfad).length) throw new BaumFehler('Ordner fehlt', 404);
    await this.metaAendern((m) => {
      const o = (m.ordner[pfad] = m.ordner[pfad] || {});
      if (name != null) o.name = String(name).trim().slice(0, 100) || o.name;
      if (beschreibung != null) o.beschreibung = String(beschreibung).slice(0, 500);
    });
  }

  /**
   * Projekt oder Ordner an einen anderen Ort und/oder unter neuem Pfadnamen. Alle betroffenen Projekte bekommen eine
   * Umleitung vom alten Pfad, damit vorhandene Klone weiter pushen können.
   */
  async verschieben(pfad, zielOrdner, neuerSlug) {
    const quelle = teile(pfad);
    if (!quelle.length) throw new BaumFehler('Die Wurzel lässt sich nicht verschieben');
    const ziel = teile(zielOrdner);
    const s = neuerSlug ? String(neuerSlug) : quelle.at(-1);
    if (!SEGMENT.test(s)) throw new BaumFehler('Ungültiger Name');
    const neu = [...ziel, s].join('/');
    const alt = quelle.join('/');
    if (neu === alt) return alt;
    const projekt = await this.istProjekt(alt);
    if (!projekt && !(await this.istOrdner(alt))) throw new BaumFehler('Nicht gefunden', 404);
    if (!(await this.istOrdner(ziel.join('/')))) throw new BaumFehler('Zielordner fehlt', 404);
    if (!projekt && (neu + '/').startsWith(alt + '/')) throw new BaumFehler('Ein Ordner kann nicht in sich selbst liegen');
    if (await this.istProjekt(neu) || (await this.istOrdner(neu))) throw new BaumFehler('Am Ziel gibt es schon etwas mit diesem Namen', 409);
    const von = projekt ? this.repoPfad(alt) : this.ordnerPfad(alt);
    const nach = projekt ? this.repoPfad(neu) : this.ordnerPfad(neu);
    await fs.rename(von, nach);
    await this.metaAendern((m) => {
      const umziehen = (sammlung, umleiten) => {
        for (const k of Object.keys(sammlung)) {
          if (k === alt || k.startsWith(alt + '/')) {
            const n = neu + k.slice(alt.length);
            sammlung[n] = sammlung[k];
            delete sammlung[k];
            if (umleiten) { m.umleitungen[k] = n; delete m.umleitungen[n]; }
          }
        }
      };
      umziehen(m.projekte, true);
      umziehen(m.ordner, false);
      // Ältere Umleitungen auf verschobene Pfade zeigen jetzt auf den neuen Ort.
      for (const [k, v] of Object.entries(m.umleitungen)) if (v === alt || v.startsWith(alt + '/')) m.umleitungen[k] = neu + v.slice(alt.length);
    });
    // Projekte ohne Meta-Eintrag (von Hand angelegt) bekommen ihre Umleitung trotzdem.
    if (projekt) await this.metaAendern((m) => { m.umleitungen[alt] = neu; });
    return neu;
  }

  async projektLoeschen(pfad) {
    if (!(await this.istProjekt(pfad))) throw new BaumFehler('Projekt fehlt', 404);
    await fs.rm(this.repoPfad(pfad), { recursive: true, force: true });
    await this.metaAendern((m) => {
      delete m.projekte[pfad];
      for (const [k, v] of Object.entries(m.umleitungen)) if (v === pfad) delete m.umleitungen[k];
    });
  }

  async ordnerLoeschen(pfad) {
    if (!teile(pfad).length || !(await this.istOrdner(pfad))) throw new BaumFehler('Ordner fehlt', 404);
    const inhalt = (await fs.readdir(this.ordnerPfad(pfad))).filter((n) => !n.startsWith('.'));
    if (inhalt.length) throw new BaumFehler('Der Ordner ist nicht leer – erst Projekte und Unterordner verschieben oder löschen', 409);
    await fs.rm(this.ordnerPfad(pfad), { recursive: true, force: true });
    await this.metaAendern((m) => { delete m.ordner[pfad]; });
  }

  async standardZweig(pfad) {
    try { return (await gitText(['symbolic-ref', '--short', 'HEAD'], { cwd: this.repoPfad(pfad) })).trim(); } catch { return 'main'; }
  }

  async standardZweigSetzen(pfad, zweig) {
    const repo = this.repoPfad(pfad);
    await gitText(['check-ref-format', '--branch', zweig]);
    await git(['symbolic-ref', 'HEAD', `refs/heads/${zweig}`], { cwd: repo });
  }
}
