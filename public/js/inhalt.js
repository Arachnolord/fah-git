// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Inhalte anzeigen: Quelltext mit Zeilennummern und Farben, Markdown (bereinigt), Änderungen (Diff).

import { h, sym, q } from './hilfen.js';

const ENDUNGEN = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', sh: 'bash',
  bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', sql: 'sql', ini: 'ini', toml: 'ini', conf: 'ini', cfg: 'ini', dockerfile: 'dockerfile',
  swift: 'swift', lua: 'lua', pl: 'perl', ps1: 'powershell', bat: 'dos', cmd: 'dos', makefile: 'makefile', mk: 'makefile', diff: 'diff', patch: 'diff',
};
export const BILD = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;

export function sprache(datei) {
  const name = String(datei || '').split('/').pop().toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const e = name.includes('.') ? name.split('.').pop() : '';
  const s = ENDUNGEN[e];
  return s && window.hljs && window.hljs.getLanguage(s) ? s : null;
}

function farbig(text, lang) {
  if (!window.hljs || text.length > 400_000) return null;
  try {
    if (lang) return window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    if (text.length < 60_000) return window.hljs.highlightAuto(text).value;
  } catch { /* ohne Farben */ }
  return null;
}

/** Quelltext mit Zeilennummern. */
export function quelltext(text, datei) {
  const zeilen = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const nummern = h('pre', { class: 'nummern' });
  nummern.textContent = zeilen.map((_, i) => i + 1).join('\n');
  const code = h('code', {});
  const html = farbig(text, sprache(datei));
  if (html != null) code.innerHTML = html; else code.textContent = text;
  return h('div', { class: 'code' }, nummern, h('pre', {}, code));
}

/** Markdown → bereinigtes HTML; relative Links und Bilder zeigen ins Repo. */
export function markdown(text, { projekt, ref, ordner = '' }) {
  const div = h('div', { class: 'markdown' });
  if (!window.marked || !window.DOMPurify) { div.append(h('pre', {}, text)); return div; }
  const roh = window.marked.parse(text, { gfm: true, async: false });
  div.innerHTML = window.DOMPurify.sanitize(roh, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
  const aufloesen = (ziel) => {
    const teile = (ordner ? ordner.split('/') : []);
    for (const t of ziel.split('/')) { if (t === '..') teile.pop(); else if (t && t !== '.') teile.push(t); }
    return teile.join('/');
  };
  const relativ = (u) => u && !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u);
  for (const img of div.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (relativ(src)) img.src = `/api/bild?${q({ pfad: projekt, ref, datei: aufloesen(src.split('?')[0].replace(/^\//, '')) })}`;
    img.loading = 'lazy';
  }
  for (const a of div.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (relativ(href)) {
      const ziel = aufloesen(href.split('#')[0].replace(/^\//, ''));
      a.href = `#/p/${projekt}/-/datei?${q({ ref, datei: ziel })}`;
    } else if (/^https?:/i.test(href || '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  }
  for (const c of div.querySelectorAll('pre code')) {
    const lang = (c.className.match(/language-([\w-]+)/) || [])[1];
    const html = window.hljs && lang && window.hljs.getLanguage(lang) ? farbig(c.textContent, lang) : null;
    if (html != null) c.innerHTML = html;
  }
  return div;
}

/** Unified Diff in Dateien und Abschnitte zerlegen. */
export function diffZerlegen(patch) {
  const dateien = [];
  let d = null;
  for (const zeile of patch.split('\n')) {
    if (zeile.startsWith('diff --git ')) {
      d = { kopf: zeile, alt: null, neu: null, zeilen: [], binaer: false };
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(zeile);
      if (m) { d.alt = m[1]; d.neu = m[2]; }
      dateien.push(d);
      continue;
    }
    if (!d) continue;
    if (zeile.startsWith('Binary files')) { d.binaer = true; continue; }
    if (zeile.startsWith('--- ') || zeile.startsWith('+++ ') || /^(index|new file|deleted file|similarity|rename|old mode|new mode)/.test(zeile)) {
      if (zeile.startsWith('new file')) d.neuAngelegt = true;
      if (zeile.startsWith('deleted file')) d.geloescht = true;
      continue;
    }
    d.zeilen.push(zeile);
  }
  return dateien;
}

export function diffTabelle(d) {
  const t = h('table', { class: 'diff' });
  let a = 0; let b = 0;
  const lang = sprache(d.neu || d.alt);
  const viele = d.zeilen.length > 3000;
  for (const z of d.zeilen) {
    if (z.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(z);
      if (m) { a = Number(m[1]); b = Number(m[2]); }
      t.append(h('tr', { class: 'abschnitt' }, h('td', { colspan: 3 }, z)));
      continue;
    }
    if (z === '\\ No newline at end of file') continue;
    const art = z[0] === '+' ? 'plus' : z[0] === '-' ? 'minus' : '';
    const text = z.slice(1);
    const zelle = h('td', { class: 'text' });
    const html = !viele && lang ? farbig(text, lang) : null;
    if (html != null) zelle.innerHTML = html; else zelle.textContent = text;
    t.append(h('tr', { class: art },
      h('td', { class: 'nr' }, art === 'plus' ? '' : String(a)), h('td', { class: 'nr' }, art === 'minus' ? '' : String(b)), zelle));
    if (art !== 'plus') a++;
    if (art !== 'minus') b++;
  }
  return t;
}

export function dateiSymbol(art) { return sym(art === 'ordner' ? 'ordner' : 'datei', art === 'ordner' ? 'ordner' : 'datei'); }
