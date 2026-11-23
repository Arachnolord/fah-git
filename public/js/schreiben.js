// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Schreiben aus der Dateiansicht (Betreiber 25.10.2026: „in einem Projekt keinen Unterordner erstellen“, „Dateiupload,
// um von der lokalen Festplatte Ordner oder Dateien in ein Projekt hochladen zu können“, „unter Dateien kann ich keine
// neue anlegen und auch keinen Ordner“): Neue Datei, Neuer Ordner, Dateien/Ordner hochladen, Ziehen aus dem Finder.
// Löschen (25.10.2026: „wie kann ich einzelne Dateien löschen“): Datei oder ganzen Ordner, ebenfalls als ein Commit.
// Jede Aktion ist EIN Commit auf dem angezeigten Zweig – im leeren Projekt der erste.

import { h, sym, api, leeren, meldung, fehlerMelden, feld, dialog, bestaetigen, menue, groesse, q } from './hilfen.js';
import { projektUrl } from './baum.js';

const AUSLASSEN = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const dateienUrl = (p, ref, ordner) => projektUrl(p.pfad, `/-/dateien?${q({ ref, ordner })}`);

function zeigen(ziel) {
  if (location.hash === ziel) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = ziel;
}

function ortText(zweig, ordner) {
  return h('p', { class: 'schwach' }, 'Zweig ', h('strong', {}, zweig), ordner ? [', in ', h('code', {}, ordner)] : ', oberste Ebene');
}

/** Knopf „Hinzufügen“ mit Neue Datei · Neuer Ordner · Dateien hochladen · Ordner hochladen. */
export function hinzufuegenKnopf(p, zweig, ordner) {
  const dateiWahl = h('input', { type: 'file', multiple: true, hidden: true });
  const ordnerWahl = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: '' });
  dateiWahl.addEventListener('change', () => { const l = [...dateiWahl.files].map((d) => ({ rel: d.name, datei: d })); dateiWahl.value = ''; hochladen(p, zweig, ordner, l); });
  ordnerWahl.addEventListener('change', () => { const l = [...ordnerWahl.files].map((d) => ({ rel: d.webkitRelativePath || d.name, datei: d })); ordnerWahl.value = ''; hochladen(p, zweig, ordner, l); });
  const knopf = h('button', { class: 'knopf klein haupt', type: 'button', title: 'Datei oder Ordner anlegen, Dateien von der Festplatte hochladen' }, sym('plus'), 'Hinzufügen');
  knopf.addEventListener('click', () => menue(knopf, [
    { text: 'Neue Datei', symbol: 'datei', aktion: () => neueDatei(p, zweig, ordner) },
    { text: 'Neuer Ordner', symbol: 'ordner', aktion: () => neuerOrdner(p, zweig, ordner) },
    'trenner',
    { text: 'Dateien hochladen …', symbol: 'datei', aktion: () => dateiWahl.click() },
    { text: 'Ordner hochladen …', symbol: 'ordner', aktion: () => ordnerWahl.click() },
  ]));
  return h('span', {}, knopf, dateiWahl, ordnerWahl);
}

/** Ziehen und Ablegen aus dem Finder/Explorer auf `el` – Dateien und ganze Ordner. */
export function ablageZone(el, p, zweig, ordner) {
  let tiefe = 0;
  el.addEventListener('dragenter', (e) => { if (!hatDateien(e)) return; e.preventDefault(); tiefe++; el.classList.add('ablage-aktiv'); });
  el.addEventListener('dragover', (e) => { if (!hatDateien(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('dragleave', () => { if (--tiefe <= 0) { tiefe = 0; el.classList.remove('ablage-aktiv'); } });
  el.addEventListener('drop', async (e) => {
    if (!hatDateien(e)) return;
    e.preventDefault(); tiefe = 0; el.classList.remove('ablage-aktiv');
    try { hochladen(p, zweig, ordner, await abgelegteDateien(e.dataTransfer)); } catch (err) { fehlerMelden(err); }
  });
  el.append(h('div', { class: 'ablage-hinweis' }, sym('plus'), ' Dateien oder Ordner hier ablegen'));
  return el;
}

const hatDateien = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

async function abgelegteDateien(dt) {
  const eintraege = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!eintraege.length) return [...dt.files].map((d) => ({ rel: d.name, datei: d }));
  const liste = [];
  const lies = async (eintrag) => {
    if (eintrag.isFile) {
      const datei = await new Promise((ok, nein) => eintrag.file(ok, nein));
      liste.push({ rel: eintrag.fullPath.replace(/^\/+/, ''), datei });
    } else if (eintrag.isDirectory) {
      const leser = eintrag.createReader();
      for (;;) {
        const teil = await new Promise((ok, nein) => leser.readEntries(ok, nein));   // liefert in Stücken, bis leer
        if (!teil.length) break;
        for (const k of teil) await lies(k);
      }
    }
  };
  for (const e of eintraege) await lies(e);
  return liste;
}

async function neuerOrdner(p, zweig, ordner) {
  const name = h('input', { type: 'text', required: true, placeholder: 'z. B. docs' });
  const nachricht = h('input', { type: 'text', placeholder: 'Ordner … angelegt' });
  const r = await dialog('Neuer Ordner', h('div', {}, ortText(zweig, ordner),
    feld('Name', name, 'Ohne Schrägstriche. Git speichert keine leeren Ordner – darin liegt deshalb eine leere Datei .gitkeep, wie bei GitLab.'),
    feld('Commit-Nachricht', nachricht, 'Optional. Der Ordner kommt als eigener Commit auf diesen Zweig, wie ein Push von dir.')),
  [{ text: 'Abbrechen' }, { text: 'Anlegen', art: 'haupt', aktion: () => api('POST', '/neuer-ordner', { pfad: p.pfad, zweig, ordner, name: name.value, nachricht: nachricht.value }) }]);
  if (!r) return;
  meldung(`Ordner ${r.pfad} angelegt`);
  zeigen(dateienUrl(p, zweig, r.pfad));
}

async function neueDatei(p, zweig, ordner) {
  const name = h('input', { type: 'text', required: true, placeholder: 'z. B. README.md oder docs/notizen.md' });
  const inhalt = h('textarea', { rows: 14, spellcheck: false, style: 'font-family:var(--mono, ui-monospace, monospace);font-size:13px' });
  const nachricht = h('input', { type: 'text', placeholder: '… angelegt' });
  const r = await dialog('Neue Datei', h('div', {}, ortText(zweig, ordner),
    feld('Dateiname', name, 'Mit Schrägstrich legst du gleich Unterordner mit an (docs/notizen.md). Eine vorhandene Datei wird nicht überschrieben.'),
    feld('Inhalt', inhalt), feld('Commit-Nachricht', nachricht, 'Optional. Die Datei kommt als eigener Commit auf diesen Zweig.')),
  [{ text: 'Abbrechen' }, { text: 'Anlegen', art: 'haupt', aktion: () => api('POST', '/neue-datei', { pfad: p.pfad, zweig, ordner, name: name.value, inhalt: inhalt.value, nachricht: nachricht.value }) }]);
  if (!r) return;
  meldung(`${r.pfad} angelegt`);
  zeigen(projektUrl(p.pfad, `/-/datei?${q({ ref: zweig, datei: r.pfad })}`));
}

/** liste: [{rel, datei: File}] – zeigt, was hochgeht, und lädt nach „Hochladen“ Datei für Datei mit Fortschritt. */
async function hochladen(p, zweig, ordner, liste) {
  const ausgelassen = liste.filter((x) => x.rel.split('/').some((t) => t === '.git' || AUSLASSEN.has(t) || t === '__MACOSX'));
  const dateien = liste.filter((x) => !ausgelassen.includes(x));
  if (!dateien.length) { meldung(ausgelassen.length ? 'Nichts hochzuladen (nur .git-Ordner oder Systemdateien)' : 'Keine Dateien gewählt', 'fehler'); return; }
  const summe = dateien.reduce((s, x) => s + x.datei.size, 0);
  const nachricht = h('input', { type: 'text', placeholder: `${dateien.length} Datei${dateien.length === 1 ? '' : 'en'} hochgeladen` });
  const stand = h('div', { class: 'schwach', style: 'min-height:20px' });
  const balken = h('progress', { max: dateien.length, value: 0, style: 'width:100%', hidden: true });
  const vorschau = h('ul', { class: 'hochladen-liste' }, dateien.slice(0, 8).map((x) => h('li', {}, h('code', {}, x.rel), ' ', h('span', { class: 'schwach' }, groesse(x.datei.size)))),
    dateien.length > 8 ? h('li', { class: 'schwach' }, `… und ${dateien.length - 8} weitere`) : null);
  const r = await dialog('Hochladen', h('div', {}, ortText(zweig, ordner),
    h('p', {}, h('strong', {}, `${dateien.length} Datei${dateien.length === 1 ? '' : 'en'}`), ` · ${groesse(summe)}`,
      ausgelassen.length ? h('span', { class: 'schwach' }, ` · ${ausgelassen.length} ausgelassen (.git-Ordner, .DS_Store u. Ä.)`) : null),
    vorschau,
    feld('Commit-Nachricht', nachricht, 'Optional. Alles kommt als EIN Commit auf diesen Zweig. Vorhandene Dateien gleichen Namens werden ersetzt; die alte Fassung bleibt im Verlauf.'),
    balken, stand),
  [{ text: 'Abbrechen' }, { text: 'Hochladen', art: 'haupt', aktion: async () => {
    const s = await api('POST', '/hochladen/start', { pfad: p.pfad, zweig, ordner });
    balken.hidden = false;
    try {
      let n = 0; let bytes = 0;
      for (const x of dateien) {
        stand.textContent = `${n + 1} / ${dateien.length}: ${x.rel}`;
        const antwort = await fetch(`/api/hochladen/datei?${q({ id: s.id, datei: x.rel })}`, {
          method: 'PUT', credentials: 'same-origin', headers: { 'X-FAHGIT': '1', 'Content-Type': 'application/octet-stream' }, body: x.datei });
        if (!antwort.ok) {
          const t = await antwort.text(); let text = t;
          try { text = JSON.parse(t).fehler || t; } catch { /* Text bleibt */ }
          throw new Error(`${x.rel}: ${text || `Fehler ${antwort.status}`}`);
        }
        n++; bytes += x.datei.size; balken.value = n;
        stand.textContent = `${n} / ${dateien.length} · ${groesse(bytes)}`;
      }
      stand.textContent = 'Commit wird angelegt …';
      return await api('POST', '/hochladen/fertig', { id: s.id, nachricht: nachricht.value });
    } catch (err) {
      api('DELETE', `/hochladen?${q({ id: s.id })}`).catch(() => {});
      stand.textContent = '';
      throw err;
    }
  } }]);
  if (!r) return;
  meldung(`${r.anzahl} Datei${r.anzahl === 1 ? '' : 'en'} hochgeladen`);
  zeigen(dateienUrl(p, zweig, ordner));
}

/** Textfeld-Editor: volle Breite, Monospace, Tab fügt einen Tabulator ein (statt den Fokus zu verschieben). */
export function textEditor(text) {
  const ta = h('textarea', { class: 'editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
  ta.value = text ?? '';
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; const en = ta.selectionEnd; ta.setRangeText('\t', s, en, 'end'); }
  });
  return ta;
}

/**
 * Knopf „Bearbeiten“ in der Dateiansicht (Betreiber 23.11.2026: „.md/.py wie in einem Editor bearbeiten“). Schaltet die
 * Karte in den Editor um: Inhalt → Textfeld mit Commit-Nachricht · Abbrechen · Speichern. Speichern legt EINEN Commit auf
 * den Zweig – mit Konfliktschutz über die geladene Blob-Kennung (d.sha). Danach wird die Ansicht frisch geladen.
 * koerperEl = Karten-Körper (Anzeige), werkzeugEl = rechte Knopfleiste im Karten-Kopf.
 */
export function bearbeitenKnopf(p, zweig, datei, d, koerperEl, werkzeugEl) {
  const knopf = h('button', { class: 'knopf klein', type: 'button', title: 'Datei im Browser bearbeiten' }, sym('bearbeiten'), 'Bearbeiten');
  knopf.addEventListener('click', () => {
    const ta = textEditor(d.text);
    const nachricht = h('input', { type: 'text', class: 'editor-nachricht', placeholder: `${datei} bearbeitet` });
    const abbrechen = h('button', { class: 'knopf klein', type: 'button' }, 'Abbrechen');
    const speichern = h('button', { class: 'knopf klein haupt', type: 'button' }, sym('haken'), 'Speichern');
    const geaendert = () => ta.value !== (d.text ?? '');
    const schliessen = () => window.dispatchEvent(new HashChangeEvent('hashchange'));   // Route neu zeichnen → zeigt den gespeicherten Stand
    abbrechen.addEventListener('click', async () => {
      if (geaendert() && !(await bestaetigen('Bearbeiten abbrechen', 'Die ungespeicherten Änderungen gehen verloren.', 'Verwerfen'))) return;
      schliessen();
    });
    const sichern = async () => {
      if (speichern.disabled) return;
      speichern.disabled = true; abbrechen.disabled = true;
      try {
        await api('POST', '/datei-speichern', { pfad: p.pfad, zweig, datei, basis: d.sha, inhalt: ta.value, nachricht: nachricht.value });
        meldung(`${datei} gespeichert`);
        schliessen();
      } catch (e) { fehlerMelden(e); speichern.disabled = false; abbrechen.disabled = false; }
    };
    speichern.addEventListener('click', sichern);
    ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); sichern(); } });
    leeren(werkzeugEl, h('span', { class: 'schwach klein' }, 'Bearbeiten …'));
    leeren(koerperEl, h('div', { class: 'editor-rahmen' }, ta, h('div', { class: 'editor-leiste' }, nachricht, abbrechen, speichern)));
    ta.focus();
  });
  return knopf;
}

/** Kleiner Müll-Knopf für eine Zeile der Dateiliste bzw. „Löschen“ in der Dateiansicht. art: 'datei' | 'ordner'. */
export function loeschenKnopf(p, zweig, pfad, art, { text = false } = {}) {
  const was = art === 'ordner' ? 'Ordner' : 'Datei';
  const b = h('button', { class: `knopf klein ${text ? 'gefahr' : 'nur-symbol loeschen'}`, type: 'button', title: `${was} löschen`, 'aria-label': `${was} ${pfad} löschen` },
    sym('muell'), text ? 'Löschen' : null);
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); loeschen(p, zweig, pfad, art); });
  return b;
}

async function loeschen(p, zweig, pfad, art) {
  const ordnerArt = art === 'ordner';
  const name = pfad.split('/').pop();
  const nachricht = h('input', { type: 'text', placeholder: `${pfad}${ordnerArt ? '/' : ''} gelöscht` });
  const r = await dialog(ordnerArt ? 'Ordner löschen' : 'Datei löschen', h('div', {},
    h('p', {}, h('code', {}, pfad), ordnerArt ? ' und alles darin wird' : ' wird', ' vom Zweig ', h('strong', {}, zweig), ' entfernt.'),
    h('p', { class: 'schwach' }, 'Im Verlauf bleibt ', ordnerArt ? 'jede Datei' : 'die Datei', ' erhalten und lässt sich aus einem älteren Commit zurückholen.'),
    feld('Commit-Nachricht', nachricht, 'Optional. Das Löschen kommt als eigener Commit auf diesen Zweig, wie ein Push von dir.')),
  [{ text: 'Abbrechen' }, { text: 'Löschen', art: 'gefahr', aktion: () => api('POST', '/loeschen', { pfad: p.pfad, zweig, dateien: [pfad], nachricht: nachricht.value }) }]);
  if (!r) return;
  meldung(ordnerArt ? `Ordner ${name} gelöscht (${r.dateien} Datei${r.dateien === 1 ? '' : 'en'})` : `${name} gelöscht`);
  zeigen(dateienUrl(p, zweig, r.ordner || ''));
}
