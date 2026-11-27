// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Der Ordnerbaum: kompakt in der Seitenleiste (mit Ziehen und Ablegen) und groß auf Übersicht und Ordnerseiten.
// Verschieben per Ziehen dürfen nur Administratoren (1.4.0); der Server liefert ohnehin nur den sichtbaren Teil.

import { h, sym, api, meldung, fehlerMelden, vorZeit, initiale } from './hilfen.js';

const OFFEN_SCHLUESSEL = 'fahgit.offen';
let offen;
try { offen = new Set(JSON.parse(localStorage.getItem(OFFEN_SCHLUESSEL) || '[]')); } catch { offen = new Set(); }
function merken() { try { localStorage.setItem(OFFEN_SCHLUESSEL, JSON.stringify([...offen])); } catch { /* egal */ } }
export function aufklappen(pfad) {
  const t = String(pfad || '').split('/');
  for (let i = 1; i <= t.length; i++) offen.add(t.slice(0, i).join('/'));
  merken();
}

export const ordnerUrl = (pfad) => `#/o/${pfad}`;
export const projektUrl = (pfad, rest = '') => `#/p/${pfad}${rest}`;

/** Alle Projekte und Ordner flach (für Suche und Auswahllisten). */
export function flach(baum) {
  const ordner = []; const projekte = [];
  const lauf = (k, namen) => {
    for (const o of k.ordner) { ordner.push({ ...o, kette: [...namen, o.name] }); lauf(o, [...namen, o.name]); }
    for (const p of k.projekte) projekte.push({ ...p, kette: namen });
  };
  lauf(baum, []);
  return { ordner, projekte };
}

export function zaehle(k) {
  let n = k.projekte.length;
  for (const o of k.ordner) n += zaehle(o);
  return n;
}

export function finde(baum, pfad) {
  if (!pfad) return baum;
  const lauf = (k) => {
    for (const o of k.ordner) {
      if (o.pfad === pfad) return o;
      if (pfad.startsWith(o.pfad + '/')) return lauf(o);
    }
    return null;
  };
  return lauf(baum);
}

// --- Ziehen und Ablegen -------------------------------------------------------------------------------------------

let gezogen = null;

function ziehbar(el, art, pfad) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => { gezogen = { art, pfad }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', pfad); });
  el.addEventListener('dragend', () => { gezogen = null; document.querySelectorAll('.ziel').forEach((x) => x.classList.remove('ziel')); });
}

function ablageziel(el, zielPfad, nachher) {
  const passt = () => gezogen && gezogen.pfad !== zielPfad && !(gezogen.art === 'ordner' && (zielPfad + '/').startsWith(gezogen.pfad + '/'))
    && gezogen.pfad.split('/').slice(0, -1).join('/') !== zielPfad;
  el.addEventListener('dragover', (e) => { if (passt()) { e.preventDefault(); el.classList.add('ziel'); } });
  el.addEventListener('dragleave', () => el.classList.remove('ziel'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); el.classList.remove('ziel');
    if (!passt()) return;
    const quelle = gezogen; gezogen = null;
    try {
      const r = await api('POST', '/verschieben', { pfad: quelle.pfad, ziel: zielPfad });
      meldung(`Verschoben nach ${zielPfad || 'ganz oben'}`);
      aufklappen(zielPfad);
      nachher(quelle.pfad, r.pfad, quelle.art);
    } catch (err) { fehlerMelden(err); }
  });
}

// --- Seitenleiste ---------------------------------------------------------------------------------------------------

/** Art des Projekts als kleine Marke (1.17.1): App oder Docker – bestimmt die GitHub-Vorlage. */
const artMarke = (p, klasse = 'art') => (p.typ ? h('span', { class: `${klasse} ${p.typ}`, title: p.typ === 'app' ? 'App – GitHub wie FAH-Friday: README, Bilder, Release' : 'Docker – GitHub mit Quellcode' }, p.typ === 'app' ? 'App' : 'Docker') : null);

/**
 * @param {object} baum  Ergebnis von /api/baum
 * @param {string} aktiv aktueller Ordner- oder Projektpfad
 * @param {function} nachVerschieben (alt, neu, art) – Seite neu laden
 * @param {object} o {ziehen} – Verschieben per Ziehen anbieten (nur Administratoren)
 */
export function seitenbaum(baum, aktiv, nachVerschieben, { ziehen = true } = {}) {
  const ul = h('ul', { class: 'baum' });
  const zeichne = (k, ziel) => {
    for (const o of k.ordner) {
      const hatInhalt = o.ordner.length + o.projekte.length > 0;
      const istOffen = offen.has(o.pfad);
      const li = h('li');
      const auf = h('button', { type: 'button', class: `auf ${istOffen ? 'offen' : ''} ${hatInhalt ? '' : 'leer'}`, 'aria-label': istOffen ? 'Zuklappen' : 'Aufklappen', tabindex: -1 }, sym('pfeil'));
      const zeile = h('a', { href: ordnerUrl(o.pfad), class: `baum-zeile ${aktiv === o.pfad ? 'aktiv' : ''}`, title: o.weg ? `${o.name} – nur der Weg zu deinen Freigaben` : o.name },
        auf, sym(istOffen ? 'ordner-offen' : 'ordner', 'symbol-ordner'), h('span', { class: 'name' }, o.name), h('span', { class: 'zahl' }, zaehle(o)));
      auf.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (offen.has(o.pfad)) offen.delete(o.pfad); else offen.add(o.pfad);
        merken(); nachVerschieben(null);
      });
      if (ziehen) { ziehbar(zeile, 'ordner', o.pfad); ablageziel(zeile, o.pfad, nachVerschieben); }
      li.append(zeile);
      if (istOffen && hatInhalt) { const unter = h('ul', { class: 'baum' }); zeichne(o, unter); li.append(unter); }
      ziel.append(li);
    }
    for (const p of k.projekte) {
      const zeile = h('a', { href: projektUrl(p.pfad), class: `baum-zeile ${aktiv === p.pfad ? 'aktiv' : ''}`, title: p.beschreibung || p.name },
        h('span', { class: 'auf leer' }), sym('projekt', 'symbol-projekt'), h('span', { class: 'name' }, p.name),
        artMarke(p), p.quelle ? sym('schloss') : null);
      if (ziehen) ziehbar(zeile, 'projekt', p.pfad);
      ziel.append(h('li', {}, zeile));
    }
  };
  zeichne(baum, ul);
  const wurzel = h('a', { href: '#/', class: `baum-zeile ${aktiv === '' ? 'aktiv' : ''}` }, h('span', { class: 'auf leer' }), sym('ordner-offen', 'symbol-ordner'),
    h('span', { class: 'name' }, 'Alle Projekte'), h('span', { class: 'zahl' }, zaehle(baum)));
  if (ziehen) ablageziel(wurzel, '', nachVerschieben);
  return h('div', {}, h('div', { class: 'seite-titel', title: ziehen ? 'Projekte und Ordner lassen sich per Ziehen und Ablegen verschieben' : null }, h('span', {}, 'Ordner')),
    h('ul', { class: 'baum' }, h('li', {}, wurzel)), ul);
}

// --- Große Liste (Übersicht, Ordnerseite) -----------------------------------------------------------------------

export function grosseListe(knoten, neuZeichnen, nachVerschieben = null) {
  const ul = h('ul', { class: 'liste' });
  for (const o of knoten.ordner) {
    const hatInhalt = o.ordner.length + o.projekte.length > 0;
    const istOffen = offen.has(o.pfad);
    const auf = h('button', { type: 'button', class: `auf ${istOffen ? 'offen' : ''} ${hatInhalt ? '' : 'leer'}`, 'aria-label': istOffen ? 'Zuklappen' : 'Aufklappen' }, sym('pfeil'));
    auf.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (offen.has(o.pfad)) offen.delete(o.pfad); else offen.add(o.pfad); merken(); neuZeichnen(); });
    const anzahlUnter = o.ordner.length;
    const zeile = h('a', { href: ordnerUrl(o.pfad), class: 'listen-zeile' },
      auf, h('span', { class: 'gross-symbol ordner' }, sym('ordner')),
      h('span', { style: 'min-width:0' }, h('div', { class: 'titel' }, o.name), o.beschreibung ? h('div', { class: 'beschr' }, o.beschreibung) : null),
      h('span', { class: 'rechts' },
        anzahlUnter ? h('span', { title: 'Unterordner' }, sym('ordner'), ` ${anzahlUnter}`) : null,
        h('span', { title: 'Projekte' }, sym('projekt'), ` ${zaehle(o)}`)));
    if (nachVerschieben) { ziehbar(zeile, 'ordner', o.pfad); ablageziel(zeile, o.pfad, nachVerschieben); }
    const li = h('li', {}, zeile);
    if (istOffen && hatInhalt) li.append(grosseListe(o, neuZeichnen, nachVerschieben));
    ul.append(li);
  }
  for (const p of knoten.projekte) {
    const zeile = h('a', { href: projektUrl(p.pfad), class: 'listen-zeile' },
      h('span', { class: 'auf leer' }), h('span', { class: 'gross-symbol projekt' }, initiale(p.name)),
      h('span', { style: 'min-width:0' }, h('div', { class: 'titel' }, p.name), p.beschreibung ? h('div', { class: 'beschr' }, p.beschreibung) : null),
      h('span', { class: 'rechts' },
        artMarke(p, 'marker art'),
        p.quelle ? h('span', { class: 'marker grau', title: `Kopie von ${p.quelle.url}` }, sym('schloss'), 'Kopie') : null,
        p.spiegel ? h('span', { class: 'marker grau', title: 'Wird weitergeleitet' }, sym('spiegel'), p.spiegel) : null,
        p.zuletzt ? h('span', { class: 'zeit', title: new Date(p.zuletzt).toLocaleString('de-DE') }, vorZeit(p.zuletzt)) : null));
    if (nachVerschieben) ziehbar(zeile, 'projekt', p.pfad);
    ul.append(h('li', {}, zeile));
  }
  return ul;
}

/** Auswahlliste aller Ordner (für Dialoge). `nur(pfad)` schränkt ein (z. B. auf Ordner mit Schreibrecht). */
export function ordnerAuswahl(baum, gewaehlt = '', { ohne = null, nur = null } = {}) {
  const s = h('select', {});
  if (!nur || nur('')) s.append(h('option', { value: '' }, '(ganz oben)'));
  for (const o of flach(baum).ordner) {
    if (ohne && (o.pfad === ohne || o.pfad.startsWith(ohne + '/'))) continue;
    if (nur && !nur(o.pfad)) continue;
    s.append(h('option', { value: o.pfad, selected: o.pfad === gewaehlt }, o.kette.join(' › ')));
  }
  s.value = gewaehlt || '';
  if (s.selectedIndex < 0 && s.options.length) s.selectedIndex = 0;
  return s;
}
