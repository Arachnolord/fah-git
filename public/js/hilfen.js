// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kleine Helfer: Elemente bauen, Schnittstelle rufen, Meldungen, Dialoge, Zeit- und Größenangaben.

/** Element bauen: h('a', {href, onclick, class}, 'Text', kind, [weitere]) */
export function h(tag, attrs = {}, ...kinder) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  anhaengen(el, kinder);
  return el;
}

function anhaengen(el, kinder) {
  for (const k of kinder.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

/** Symbol aus dem SVG-Vorrat in index.html. */
export function sym(name, klasse = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('class', `i ${klasse}`.trim());
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(ns, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

export function leeren(el, ...kinder) { el.replaceChildren(); anhaengen(el, kinder); return el; }

export class ApiFehler extends Error {
  constructor(text, status) { super(text); this.status = status; }
}

/** Schnittstelle rufen (JSON; ein Blob geht roh mit seinem Typ). Wirft ApiFehler mit verständlichem Text. */
export async function api(methode, weg, daten) {
  const roh = daten instanceof Blob;
  const r = await fetch(`/api${weg}`, {
    method: methode, credentials: 'same-origin',
    headers: { 'X-FAHGIT': '1', ...(roh ? { 'Content-Type': daten.type || 'application/octet-stream' } : daten !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: roh ? daten : daten !== undefined ? JSON.stringify(daten) : undefined,
  });
  let inhalt = null;
  const t = await r.text();
  try { inhalt = t ? JSON.parse(t) : null; } catch { inhalt = { fehler: t }; }
  if (!r.ok) {
    if (r.status === 401 && weg !== '/anmelden' && weg !== '/status') window.dispatchEvent(new CustomEvent('fahgit:abgemeldet'));
    throw new ApiFehler((inhalt && inhalt.fehler) || `Fehler ${r.status}`, r.status);
  }
  return inhalt;
}

export const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

export function meldung(text, art = 'ok') {
  const el = h('div', { class: `meldung ${art === 'fehler' ? 'fehler' : ''}` }, text);
  document.getElementById('meldungen').append(el);
  setTimeout(() => el.remove(), art === 'fehler' ? 7000 : 3500);
}

export function fehlerMelden(e) { meldung(e && e.message ? e.message : String(e), 'fehler'); }

/** Infozeile unter einem Feld (kurz, in Alltagssprache). */
export function info(text) { return h('div', { class: 'info' }, sym('info'), h('span', {}, text)); }

/** Formularfeld mit Beschriftung und Info. */
export function feld(beschriftung, eingabe, infoText) {
  const id = eingabe.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  eingabe.id = id;
  return h('div', { class: 'feld' }, h('label', { for: id }, beschriftung), eingabe, infoText ? info(infoText) : null);
}

/**
 * Dialog öffnen. `inhalt` ist ein Element; `knoepfe` [{text, art, aktion → Promise|false}]. Gibt ein Promise zurück,
 * das mit dem Ergebnis der Aktion (oder null beim Abbrechen) erfüllt wird.
 */
export function dialog(titel, inhalt, knoepfe) {
  return new Promise((fertig) => {
    const vorher = document.activeElement;
    const hg = h('div', { class: 'dialog-hg' });
    const schliessen = (wert) => { hg.remove(); document.removeEventListener('keydown', taste); vorher && vorher.focus && vorher.focus(); fertig(wert); };
    const taste = (e) => { if (e.key === 'Escape') schliessen(null); };
    const fuss = h('footer', {});
    for (const k of knoepfe) {
      const b = h('button', { type: k.art === 'haupt' || k.art === 'gefahr' ? 'submit' : 'button', class: `knopf ${k.art === 'haupt' ? 'haupt' : ''} ${k.art === 'gefahr' ? 'gefahr voll' : ''}` }, k.text);
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!k.aktion) return schliessen(null);
        b.disabled = true;
        try { const r = await k.aktion(); if (r !== false) schliessen(r ?? true); } catch (err) { fehlerMelden(err); } finally { b.disabled = false; }
      });
      fuss.append(b);
    }
    const form = h('form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': titel },
      h('header', {}, titel), h('div', { class: 'dialog-inhalt' }, inhalt), fuss);
    form.addEventListener('submit', (e) => { e.preventDefault(); fuss.querySelector('button[type=submit]')?.click(); });
    hg.addEventListener('mousedown', (e) => { if (e.target === hg) schliessen(null); });
    hg.append(form);
    document.body.append(hg);
    document.addEventListener('keydown', taste);
    (form.querySelector('input, select, textarea') || fuss.querySelector('button'))?.focus();
  });
}

export async function bestaetigen(titel, text, knopf = 'Löschen') {
  return !!(await dialog(titel, h('p', {}, text), [{ text: 'Abbrechen' }, { text: knopf, art: 'gefahr', aktion: () => true }]));
}

/** Kleines Aufklappmenü an einem Knopf. eintraege: [{text, symbol, aktion, gefahr}] | 'trenner' */
export function menue(anker, eintraege) {
  document.querySelectorAll('.menue').forEach((m) => m.remove());
  const m = h('div', { class: 'menue', role: 'menu' });
  for (const e of eintraege) {
    if (e === 'trenner') { m.append(h('hr')); continue; }
    if (!e) continue;
    const b = e.href
      ? h('a', { href: e.href, role: 'menuitem' }, e.symbol ? sym(e.symbol) : null, e.text)
      : h('button', { type: 'button', role: 'menuitem', class: e.gefahr ? 'gefahr' : '' }, e.symbol ? sym(e.symbol) : null, e.text);
    b.addEventListener('click', () => { m.remove(); e.aktion && e.aktion(); });
    m.append(b);
  }
  document.body.append(m);
  const r = anker.getBoundingClientRect();
  const breite = Math.max(220, m.offsetWidth);
  m.style.top = `${r.bottom + window.scrollY + 6}px`;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - breite - 8, r.right + window.scrollX - breite))}px`;
  const weg = (e) => { if (!m.contains(e.target) && e.target !== anker) { m.remove(); document.removeEventListener('mousedown', weg); } };
  setTimeout(() => document.addEventListener('mousedown', weg), 0);
  m.querySelector('button, a')?.focus();
}

const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
export function vorZeit(iso) {
  if (!iso) return '';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'gerade eben';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  if (a < 365 * 86400) return rtf.format(Math.round(s / (30 * 86400)), 'month');
  return rtf.format(Math.round(s / (365 * 86400)), 'year');
}
export function datumZeit(iso) { return iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
export function tag(iso) { return new Date(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }

export function groesse(bytes) {
  if (bytes == null) return '';
  const e = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let w = bytes;
  while (w >= 1024 && i < e.length - 1) { w /= 1024; i++; }
  return `${w.toLocaleString('de-DE', { maximumFractionDigits: i ? 1 : 0 })} ${e[i]}`;
}

export async function kopieren(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = h('textarea', {}, text); document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  meldung('Kopiert');
}

/** Anfangsbuchstabe als Bild-Ersatz. */
export function initiale(text) { return String(text || '?').trim().charAt(0).toUpperCase(); }

/** Profilbild im Kreis – ohne Bild (oder wenn es nicht lädt) der Anfangsbuchstabe. n: {name, anzeige, bild} */
export function profilbild(n, klasse = '') {
  const text = initiale((n && (n.anzeige || n.name)) || '•');
  const el = h('span', { class: `avatar ${klasse}`.trim(), 'aria-hidden': 'true' });
  if (n && n.name && n.bild) {
    const img = h('img', { src: `/api/profilbild?${q({ name: n.name, v: n.bild })}`, alt: '', decoding: 'async' });
    img.addEventListener('error', () => leeren(el, text));
    el.append(img);
  } else el.append(text);
  return el;
}

export const PROFILBILD_PIXEL = 256;
export const PROFILBILD_MAX = 300 * 1024;

/** Bild im Browser mittig quadratisch zuschneiden und auf 256 × 256 verkleinern → Blob (WebP, sonst PNG). */
export async function profilbildVorbereiten(datei) {
  let quelle;
  try { quelle = await createImageBitmap(datei); } catch { throw new Error('Dieses Bild kann der Browser nicht lesen – bitte ein PNG, JPEG oder WebP wählen.'); }
  const seite = Math.min(quelle.width, quelle.height);
  const leinwand = document.createElement('canvas');
  leinwand.width = PROFILBILD_PIXEL; leinwand.height = PROFILBILD_PIXEL;
  const ctx = leinwand.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(quelle, (quelle.width - seite) / 2, (quelle.height - seite) / 2, seite, seite, 0, 0, PROFILBILD_PIXEL, PROFILBILD_PIXEL);
  quelle.close?.();
  const alsBlob = (typ, guete) => new Promise((ok) => leinwand.toBlob(ok, typ, guete));
  let blob = await alsBlob('image/webp', 0.9);
  if (!blob || blob.type !== 'image/webp') blob = await alsBlob('image/png');   // Browser ohne WebP-Ausgabe
  if (blob && blob.size > PROFILBILD_MAX && blob.type === 'image/webp') blob = await alsBlob('image/webp', 0.7);
  if (!blob || blob.size > PROFILBILD_MAX) throw new Error('Das Bild ist auch verkleinert noch zu groß (höchstens 300 KB).');
  return blob;
}
