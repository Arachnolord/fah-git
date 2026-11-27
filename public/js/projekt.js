// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Projektseite: Kopf mit Klonen, Reiter Dateien · Verlauf · Zweige · Spiegel · Einstellungen, Datei- und Commit-Ansicht.
// 1.4.0: Schreibknöpfe nur mit Schreibrecht, Weiterleitungen/Quellen/Verschieben/Löschen nur für Administratoren,
// Knopf „Auf FAH-NAS bauen“ (wenn in den Einstellungen eine FAH-NAS-Adresse steht).

import { h, sym, api, leeren, meldung, fehlerMelden, feld, info, dialog, bestaetigen, menue, vorZeit, datumZeit, tag, groesse, kopieren, initiale, q } from './hilfen.js';
import { quelltext, markdown, diffZerlegen, diffTabelle, dateiSymbol, BILD } from './inhalt.js';
import { pfadleiste, aktivitaetListe, verschiebenDialog, darfSchreiben } from './app.js';
import { projektUrl } from './baum.js';
import { hinzufuegenKnopf, ablageZone, loeschenKnopf, bearbeitenKnopf } from './schreiben.js';

const url = (p, ansicht, params = {}) => projektUrl(p.pfad, `/-/${ansicht}${Object.keys(params).length ? `?${q(params)}` : ''}`);

export async function projektSeite(r, ctx) {
  const p = await api('GET', `/projekt?${q({ pfad: r.pfad })}`);
  if (p.pfad !== r.pfad) { location.replace(projektUrl(p.pfad)); return h('div'); }
  const ref = r.params.ref || p.standard;
  const ansicht = r.ansicht;
  const admin = !!ctx.zustand.ich.admin && ctx.zustand.failover?.rolle !== 'ersatz';
  const schreiben = darfSchreiben(p.pfad);
  const reiterAktiv = { dateien: 'dateien', datei: 'dateien', verlauf: 'verlauf', commit: 'verlauf', zweige: 'zweige', spiegel: 'spiegel', releases: 'releases', einstellungen: 'einstellungen', aktivitaet: 'aktivitaet' }[ansicht] || 'dateien';
  let inhaltEl;
  if (p.leer && ['dateien', 'datei', 'verlauf', 'commit'].includes(ansicht)) inhaltEl = leerAnleitung(p);
  else if (ansicht === 'dateien') inhaltEl = await dateienAnsicht(p, ref, r.params.ordner || '');
  else if (ansicht === 'datei') inhaltEl = await dateiAnsicht(p, ref, r.params.datei || '');
  else if (ansicht === 'verlauf') inhaltEl = await verlaufAnsicht(p, ref, r.params.datei || '', Number(r.params.seite) || 0);
  else if (ansicht === 'commit') inhaltEl = await commitAnsicht(p, r.params.sha);
  else if (ansicht === 'zweige') inhaltEl = zweigeAnsicht(p);
  else if (ansicht === 'spiegel') inhaltEl = spiegelAnsicht(p, admin);
  else if (ansicht === 'releases') inhaltEl = releasesAnsicht(p, admin);
  else if (ansicht === 'aktivitaet') inhaltEl = h('div', { class: 'karte' }, aktivitaetListe(await api('GET', `/aktivitaet?${q({ projekt: p.pfad, anzahl: 100 })}`)));
  else if (ansicht === 'einstellungen') inhaltEl = schreiben ? einstellungenAnsicht(p, ctx) : h('div', { class: 'leer-hinweis' }, 'Die Einstellungen ändern nur Benutzer mit Schreibrecht.');
  else inhaltEl = h('div', { class: 'leer-hinweis' }, 'Unbekannte Ansicht');

  const reiter = (id, text, symbol, anzahl) => h('a', { href: url(p, id), class: reiterAktiv === id ? 'aktiv' : '' }, sym(symbol), text, anzahl != null ? h('span', { class: 'anzahl' }, anzahl) : null);
  const problem = p.spiegel.some((s) => s.aktiv && s.zuletzt && s.zuletzt.ergebnis !== 'ok') || (p.quelle && p.quelle.zuletzt && p.quelle.zuletzt.ergebnis === 'fehler');
  return h('div', {},
    pfadleiste(p.pfad),
    h('div', { class: 'kopfzeile' },
      h('div', { style: 'min-width:0' },
        h('h1', {}, h('span', { class: 'gross-symbol projekt', style: 'width:36px;height:36px;font-size:16px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center' }, initiale(p.name)), p.name),
        p.beschreibung ? h('p', { class: 'untertitel', style: 'margin-bottom:4px' }, p.beschreibung) : null,
        h('div', { class: 'marken' },
          p.quelle ? h('span', { class: 'marker warn', title: 'Wird von dort aktualisiert; hier nur lesbar' }, sym('schloss'), `Kopie von ${new URL(p.quelle.url).host}`) : null,
          p.spiegel.length ? h('span', { class: `marker ${problem ? 'rot' : 'gruen'}` }, sym('spiegel'), `Weiterleitung an ${p.spiegel.length} Ziel${p.spiegel.length > 1 ? 'e' : ''}`) : null,
          admin ? artWahl(p) : p.typ ? h('span', { class: `marker art ${p.typ}`, title: 'Art des Projekts – bestimmt die GitHub-Vorlage' }, p.typ === 'app' ? 'App' : 'Docker') : null,
          ...p.themen.map((t) => h('span', { class: 'marker grau' }, t)),
          p.zuletzt ? h('span', { class: 'marker grau' }, sym('uhr'), `geändert ${vorZeit(p.zuletzt)}`) : null,
          h('span', { class: 'marker grau' }, groesse(p.groesse)))),
      h('div', { class: 'zeile' }, klonKnopf(p), !p.leer ? h('a', { class: 'knopf', href: `/api/archiv?${q({ pfad: p.pfad, ref })}`, title: 'Stand als ZIP herunterladen' }, sym('laden'), 'ZIP') : null,
        nasKnopf(p, ref, ctx.zustand.fahnas))),
    h('nav', { class: 'reiter' },
      reiter('dateien', 'Dateien', 'datei'), reiter('verlauf', 'Verlauf', 'commit'), reiter('zweige', 'Zweige', 'zweig', p.zweige.length),
      reiter('spiegel', 'Spiegel', 'spiegel', p.spiegel.length + (p.quelle ? 1 : 0) || null),
      p.releases.dateien.length || admin ? reiter('releases', 'Releases', 'laden', p.releases.dateien.length || null) : null, reiter('aktivitaet', 'Aktivität', 'uhr'), schreiben ? reiter('einstellungen', 'Einstellungen', 'einstellungen') : null),
    inhaltEl);
}

/**
 * „Auf FAH-NAS bauen“ (26.10.2026): öffnet FAH-NAS in einem neuen Tab; dort wird das Projekt als Docker-App gebaut.
 * Format für FAH-NAS: <adresse>/#/apps/fahgit/<Projektpfad>/<Zweig>, beides je als EIN Segment kodiert (/ → %2F).
 */
export function nasLink(adresse, pfad, zweig) {
  return `${String(adresse).replace(/\/+$/, '')}/#/apps/fahgit/${encodeURIComponent(pfad)}/${encodeURIComponent(zweig)}`;
}

function nasKnopf(p, ref, adresse) {
  if (!adresse || p.leer) return null;
  const zweig = p.zweige.some((z) => z.name === ref) ? ref : p.standard;   // Tag oder alter Stand → Standardzweig
  return h('a', { class: 'knopf nas-knopf', href: nasLink(adresse, p.pfad, zweig), target: '_blank', rel: 'noopener',
    title: 'Öffnet FAH-NAS: dort wird das Projekt als Docker-App gebaut (docker-compose.yml bzw. Dockerfile im Projekt).' }, sym('bauen'), 'Auf FAH-NAS bauen');
}

function klonKnopf(p) {
  const b = h('button', { class: 'knopf haupt', type: 'button' }, sym('kopieren'), 'Klonen');
  b.addEventListener('click', async () => {
    const eingabe = h('input', { type: 'text', value: p.klon, readonly: true });
    eingabe.addEventListener('focus', () => eingabe.select());
    await dialog('Klonen', h('div', {},
      h('div', { class: 'klonfeld abschnitt' }, eingabe, h('button', { class: 'knopf', type: 'button', onclick: () => kopieren(p.klon) }, sym('kopieren'), 'Kopieren')),
      h('div', { class: 'befehle' }, `git clone ${p.klon}`),
      info('Beim ersten Mal fragt git nach Benutzername und Kennwort: Als Kennwort einen Zugangsschlüssel aus „Mein Konto“ nehmen. Der Mac merkt ihn sich im Schlüsselbund.')),
    [{ text: 'Schließen', art: 'haupt', aktion: () => true }]);
  });
  return b;
}

function leerAnleitung(p) {
  const befehle = (t) => h('div', { class: 'befehle' }, t, h('div', { style: 'text-align:right' }, h('button', { class: 'knopf klein', type: 'button', onclick: () => kopieren(t) }, sym('kopieren'), 'Kopieren')));
  // Auch ein leeres Projekt lässt sich direkt hier füllen: Datei, Ordner oder Hochladen werden der erste Commit.
  const fuellen = p.quelle || !darfSchreiben(p.pfad) ? null : h('div', { class: 'karte abschnitt' }, h('div', { class: 'karten-inhalt' },
    h('div', { class: 'zeile', style: 'justify-content:space-between;gap:12px;flex-wrap:wrap' },
      h('div', {}, h('h3', { style: 'margin:0 0 4px' }, 'Direkt hier anfangen'),
        h('p', { class: 'schwach', style: 'margin:0' }, `Datei anlegen, Ordner anlegen oder von der Festplatte hochladen – wird der erste Commit auf „${p.standard}“.`)),
      hinzufuegenKnopf(p, p.standard, ''))));
  if (fuellen) ablageZone(fuellen, p, p.standard, '');
  return h('div', {}, fuellen, h('div', { class: 'karte' }, h('div', { class: 'karten-inhalt' },
    h('h3', { style: 'margin-top:0' }, 'Das Projekt ist noch leer'),
    p.quelle ? h('p', {}, 'Es wird beim nächsten Abgleich von ', h('code', {}, p.quelle.url), ' gefüllt.') : [
      h('p', {}, 'Vorhandenen Ordner hochschieben:'),
      befehle(`cd <dein-ordner>\ngit remote add origin ${p.klon}\ngit push -u origin --all\ngit push origin --tags`),
      h('p', {}, 'Oder neu beginnen:'),
      befehle(`git clone ${p.klon}\ncd ${p.slug}\n# Dateien anlegen …\ngit add .\ngit commit -m "Erster Stand"\ngit push -u origin ${p.standard}`),
      info('Als Kennwort einen Zugangsschlüssel aus „Mein Konto“ verwenden.')])));
}

function zweigWahl(p, ref, ziel) {
  const s = h('select', { 'aria-label': 'Zweig oder Tag' });
  s.append(h('optgroup', { label: 'Zweige' }, p.zweige.map((z) => h('option', { value: z.name, selected: z.name === ref }, z.name === p.standard ? `${z.name} (Standard)` : z.name))));
  if (p.tags.length) s.append(h('optgroup', { label: 'Tags' }, p.tags.map((t) => h('option', { value: t.name, selected: t.name === ref }, t.name))));
  if (![...p.zweige, ...p.tags].some((x) => x.name === ref)) s.prepend(h('option', { value: ref, selected: true }, ref.slice(0, 12)));
  s.addEventListener('change', () => { location.hash = ziel(s.value); });
  return h('span', { class: 'zeile', style: 'gap:6px' }, sym('zweig'), s);
}

function repoPfadLeiste(p, ref, pfad, { datei = false } = {}) {
  const t = pfad ? pfad.split('/') : [];
  const leiste = h('span', { class: 'repo-pfad' }, h('a', { href: url(p, 'dateien', { ref }) }, p.slug));
  t.forEach((teil, i) => {
    leiste.append(h('span', { class: 'trenner' }, '/'));
    const istLetzt = i === t.length - 1;
    leiste.append(istLetzt && datei ? h('span', {}, teil) : h('a', { href: url(p, 'dateien', { ref, ordner: t.slice(0, i + 1).join('/') }) }, teil));
  });
  return leiste;
}

function letzterBalken(p, letzter) {
  if (!letzter) return null;
  return h('div', { class: 'letzter' }, h('span', { class: 'kreis', style: 'width:24px;height:24px;font-size:11px;border-radius:50%;background:var(--akzent-hell);display:inline-flex;align-items:center;justify-content:center;font-weight:700' }, initiale(letzter.autor)),
    h('a', { class: 'betreff', href: url(p, 'commit', { sha: letzter.sha }), style: 'color:inherit' }, h('strong', {}, letzter.autor), ' ', letzter.betreff),
    h('a', { class: 'sha', href: url(p, 'commit', { sha: letzter.sha }) }, letzter.kurz), h('span', { class: 'schwach klein', title: datumZeit(letzter.datum) }, vorZeit(letzter.datum)));
}

async function dateienAnsicht(p, ref, ordner) {
  const d = await api('GET', `/dateien?${q({ pfad: p.pfad, ref, ordner })}`);
  // Schreiben nur auf einem Zweig (nicht in Tags oder alten Ständen) und nicht in nur lesbaren Kopien.
  const schreibbar = p.zweige.some((z) => z.name === ref) && !p.quelle && darfSchreiben(p.pfad);
  const tabelle = h('table', { class: 'dateiliste' });
  if (ordner) tabelle.append(h('tr', {}, h('td', { class: 'name', colspan: schreibbar ? 3 : 2 }, h('a', { href: url(p, 'dateien', { ref, ordner: ordner.split('/').slice(0, -1).join('/') }) }, sym('ordner-offen', 'ordner'), '..'))));
  for (const e of d.eintraege) {
    const ziel = e.art === 'ordner' ? url(p, 'dateien', { ref, ordner: e.pfad }) : e.art === 'modul' ? null : url(p, 'datei', { ref, datei: e.pfad });
    tabelle.append(h('tr', {}, h('td', { class: 'name' }, ziel ? h('a', { href: ziel }, dateiSymbol(e.art), e.name) : h('span', {}, sym('projekt'), ` ${e.name} (Untermodul)`)),
      h('td', { class: 'groesse' }, e.art === 'datei' ? groesse(e.groesse) : ''),
      schreibbar ? h('td', { class: 'aktion' }, e.art === 'modul' ? null : loeschenKnopf(p, ref, e.pfad, e.art)) : null));
  }
  const teile = [
    h('div', { class: 'werkzeug' }, zweigWahl(p, ref, (r2) => url(p, 'dateien', { ref: r2, ordner })), repoPfadLeiste(p, ref, ordner),
      h('a', { class: 'knopf klein', href: url(p, 'verlauf', { ref, datei: ordner }), style: 'margin-left:auto' }, sym('uhr'), 'Verlauf'),
      schreibbar ? hinzufuegenKnopf(p, ref, ordner) : null),
    (() => {
      const karte = h('div', { class: 'karte abschnitt' }, letzterBalken(p, d.letzter), d.eintraege.length ? tabelle : h('div', { class: 'leer-hinweis' }, 'Leerer Ordner'));
      return schreibbar ? ablageZone(karte, p, ref, ordner) : karte;
    })(),
  ];
  const readme = d.eintraege.find((e) => e.art === 'datei' && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
  if (readme) {
    const r = await api('GET', `/datei?${q({ pfad: p.pfad, ref, datei: readme.pfad })}`).catch(() => null);
    if (r && r.text != null) {
      teile.push(h('div', { class: 'karte' }, h('div', { class: 'karten-kopf' }, h('h3', {}, sym('datei'), ` ${readme.name}`)),
        /\.(md|markdown)$/i.test(readme.name) ? markdown(r.text, { projekt: p.pfad, ref, ordner }) : h('pre', { class: 'markdown', style: 'white-space:pre-wrap' }, r.text)));
    }
  }
  return h('div', {}, teile);
}

async function dateiAnsicht(p, ref, datei) {
  const d = await api('GET', `/datei?${q({ pfad: p.pfad, ref, datei })}`);
  const roh = `/api/roh?${q({ pfad: p.pfad, ref, datei })}`;
  let koerper;
  const istMarkdown = /\.(md|markdown)$/i.test(datei);
  if (BILD.test(datei)) koerper = h('div', { class: 'bild-vorschau' }, h('img', { src: `/api/bild?${q({ pfad: p.pfad, ref, datei })}`, alt: datei }));
  else if (d.zu_gross) koerper = h('div', { class: 'leer-hinweis' }, `Die Datei ist ${groesse(d.groesse)} groß – zu groß für die Anzeige. `, h('a', { href: roh }, 'Herunterladen'));
  else if (d.binaer) koerper = h('div', { class: 'leer-hinweis' }, 'Binärdatei – ', h('a', { href: roh }, 'herunterladen'));
  else if (istMarkdown) {
    const ordner = datei.split('/').slice(0, -1).join('/');
    const vorschau = markdown(d.text, { projekt: p.pfad, ref, ordner });
    const quelle = quelltext(d.text, datei);
    quelle.classList.add('versteckt');
    const umschalten = h('button', { class: 'knopf klein', type: 'button' }, 'Quelltext');
    umschalten.addEventListener('click', () => { const q2 = quelle.classList.toggle('versteckt'); vorschau.classList.toggle('versteckt', !q2); umschalten.textContent = q2 ? 'Quelltext' : 'Vorschau'; });
    koerper = h('div', {}, h('div', { style: 'padding:8px 16px 0;text-align:right' }, umschalten), vorschau, quelle);
  } else koerper = quelltext(d.text, datei);
  const zeilen = d.text != null ? d.text.split('\n').length - (d.text.endsWith('\n') ? 1 : 0) : null;
  const darf = p.zweige.some((z) => z.name === ref) && !p.quelle && darfSchreiben(p.pfad);
  const koerperWrap = h('div', {}, koerper);              // eigener Rahmen – der Editor tauscht nur diesen Inhalt aus
  const werkzeug = h('div', { class: 'zeile' });          // zuerst leer, damit „Bearbeiten“ eine Referenz darauf bekommt
  leeren(werkzeug,
    d.text != null ? h('button', { class: 'knopf klein', type: 'button', onclick: () => kopieren(d.text) }, sym('kopieren'), 'Kopieren') : null,
    h('a', { class: 'knopf klein', href: url(p, 'verlauf', { ref, datei }) }, sym('uhr'), 'Verlauf'),
    h('a', { class: 'knopf klein', href: roh }, sym('laden'), 'Herunterladen'),
    darf && d.text != null ? bearbeitenKnopf(p, ref, datei, d, koerperWrap, werkzeug) : null,
    darf ? loeschenKnopf(p, ref, datei, 'datei', { text: true }) : null);
  return h('div', {},
    h('div', { class: 'werkzeug' }, zweigWahl(p, ref, (r2) => url(p, 'datei', { ref: r2, datei })), repoPfadLeiste(p, ref, datei, { datei: true })),
    h('div', { class: 'karte' },
      letzterBalken(p, d.letzter),
      h('div', { class: 'karten-kopf' }, h('span', { class: 'schwach klein' }, [zeilen != null ? `${zeilen} Zeile${zeilen === 1 ? '' : 'n'}` : null, groesse(d.groesse)].filter(Boolean).join(' · ')),
        werkzeug),
      koerperWrap));
}

async function verlaufAnsicht(p, ref, datei, seite) {
  const v = await api('GET', `/verlauf?${q({ pfad: p.pfad, ref, datei, seite })}`);
  const gruppen = new Map();
  for (const c of v.commits) {
    const t = tag(c.datum);
    if (!gruppen.has(t)) gruppen.set(t, []);
    gruppen.get(t).push(c);
  }
  return h('div', {},
    h('div', { class: 'werkzeug' }, zweigWahl(p, ref, (r2) => url(p, 'verlauf', { ref: r2, datei })), datei ? h('span', {}, 'nur ', h('code', {}, datei), ' ', h('a', { href: url(p, 'verlauf', { ref }) }, '(alle)')) : null),
    v.commits.length ? [...gruppen].map(([t, liste]) => h('div', {}, h('div', { class: 'tag-kopf' }, t),
      h('div', { class: 'karte' }, liste.map((c) => h('div', { class: 'commit-zeile' },
        h('div', { style: 'min-width:0' }, h('a', { class: 'betreff', href: url(p, 'commit', { sha: c.sha }) }, c.betreff || '(ohne Nachricht)'),
          h('span', { class: 'wer' }, `${c.autor} · ${vorZeit(c.datum)}`)),
        h('div', { class: 'zeile' }, h('a', { class: 'sha', href: url(p, 'commit', { sha: c.sha }) }, c.kurz),
          h('button', { class: 'knopf klein nur-symbol', type: 'button', title: 'Kennung kopieren', onclick: () => kopieren(c.sha) }, sym('kopieren')),
          h('a', { class: 'knopf klein', href: url(p, 'dateien', { ref: c.sha }), title: 'Dateien in diesem Stand' }, sym('datei'))))))))
      : h('div', { class: 'karte leer-hinweis' }, 'Keine Commits.'),
    h('div', { class: 'zeile', style: 'margin-top:14px' },
      seite > 0 ? h('a', { class: 'knopf', href: url(p, 'verlauf', { ref, datei, seite: seite - 1 }) }, 'Neuere') : null,
      v.weitere ? h('a', { class: 'knopf', href: url(p, 'verlauf', { ref, datei, seite: seite + 1 }) }, 'Ältere') : null));
}

async function commitAnsicht(p, sha) {
  const c = await api('GET', `/commit?${q({ pfad: p.pfad, sha })}`);
  const [betreff, ...rest] = c.nachricht.split('\n');
  const dateien = diffZerlegen(c.patch);
  const plus = c.dateien.reduce((s, d) => s + d.plus, 0); const minus = c.dateien.reduce((s, d) => s + d.minus, 0);
  return h('div', {},
    h('div', { class: 'karte abschnitt' }, h('div', { class: 'karten-inhalt' },
      h('h2', { style: 'margin:0 0 6px;font-size:19px' }, betreff),
      rest.join('\n').trim() ? h('pre', { style: 'white-space:pre-wrap;margin:0 0 10px;font-family:inherit;font-size:14px' }, rest.join('\n').trim()) : null,
      h('div', { class: 'zeile schwach klein' }, h('strong', { style: 'color:var(--text)' }, c.autor), ` · ${datumZeit(c.datum)}`,
        h('span', { class: 'sha' }, c.sha.slice(0, 12)), h('button', { class: 'knopf klein nur-symbol', type: 'button', title: 'Kennung kopieren', onclick: () => kopieren(c.sha) }, sym('kopieren')),
        c.eltern.length ? h('span', {}, 'Vorgänger: ', c.eltern.map((e) => h('a', { class: 'sha', href: url(p, 'commit', { sha: e }), style: 'margin-right:4px' }, e.slice(0, 8)))) : null,
        h('a', { class: 'knopf klein', href: url(p, 'dateien', { ref: c.sha }) }, sym('datei'), 'Dateien in diesem Stand')))),
    h('p', { class: 'schwach' }, `${c.dateien.length} Datei${c.dateien.length === 1 ? '' : 'en'} geändert · `, h('span', { class: 'plusz' }, `+${plus}`), ' ', h('span', { class: 'minusz' }, `−${minus}`)),
    c.gekuerzt ? h('div', { class: 'hinweisbox warn' }, sym('warnung'), 'Sehr große Änderung – die Anzeige ist gekürzt.') : null,
    dateien.map((d) => {
      const s = c.dateien.find((x) => x.pfad === d.neu || x.pfad === d.alt) || { plus: 0, minus: 0 };
      const tabelle = d.binaer ? h('div', { class: 'leer-hinweis' }, 'Binärdatei geändert') : diffTabelle(d);
      const zu = d.zeilen.length > 1500;
      if (zu) tabelle.classList.add('versteckt');
      const kopf = h('div', { class: 'karten-kopf' },
        h('span', { class: 'mono', style: 'overflow-wrap:anywhere' }, d.alt !== d.neu ? `${d.alt} → ${d.neu}` : d.neu, d.neuAngelegt ? h('span', { class: 'marker gruen', style: 'margin-left:6px' }, 'neu') : null, d.geloescht ? h('span', { class: 'marker rot', style: 'margin-left:6px' }, 'gelöscht') : null),
        h('span', { class: 'stat' }, h('span', { class: 'plusz' }, `+${s.plus}`), ' ', h('span', { class: 'minusz' }, `−${s.minus}`), zu ? ' · zum Aufklappen klicken' : ''));
      kopf.addEventListener('click', () => tabelle.classList.toggle('versteckt'));
      return h('div', { class: 'karte diff-datei' }, kopf, tabelle);
    }));
}

function zweigeAnsicht(p) {
  const nurLesen = !!p.quelle || !darfSchreiben(p.pfad);
  return h('div', { class: 'karte' }, p.zweige.length ? h('table', { class: 'tabelle' },
    h('tr', {}, h('th', {}, 'Zweig'), h('th', {}, 'Letzter Commit'), h('th', {})),
    p.zweige.map((z) => h('tr', {},
      h('td', {}, h('a', { href: url(p, 'dateien', { ref: z.name }) }, h('strong', {}, z.name)), z.name === p.standard ? h('span', { class: 'marker', style: 'margin-left:8px' }, 'Standard') : null),
      h('td', {}, h('div', {}, z.betreff), h('div', { class: 'schwach klein' }, `${z.autor} · ${vorZeit(z.datum)}`)),
      h('td', { style: 'text-align:right' }, z.name !== p.standard && !nurLesen ? h('div', { class: 'zeile ende' },
        h('button', { class: 'knopf klein', type: 'button', onclick: async () => {
          try { await api('PATCH', '/projekt', { pfad: p.pfad, standard: z.name }); meldung(`${z.name} ist jetzt Standard`); location.reload(); } catch (e) { fehlerMelden(e); }
        } }, 'Als Standard'),
        h('button', { class: 'knopf klein gefahr', type: 'button', onclick: async () => {
          if (!(await bestaetigen('Zweig löschen', `Zweig „${z.name}“ wird gelöscht. Commits, die nur dort liegen, gehen verloren.`))) return;
          try { await api('DELETE', `/zweig?${q({ pfad: p.pfad, name: z.name })}`); meldung('Zweig gelöscht'); location.reload(); } catch (e) { fehlerMelden(e); }
        } }, 'Löschen')) : null))))
    : h('div', { class: 'leer-hinweis' }, 'Noch keine Zweige.'),
  p.tags.length ? h('div', { class: 'karten-inhalt' }, h('strong', {}, 'Tags: '), p.tags.map((t) => h('a', { class: 'marker grau', href: url(p, 'dateien', { ref: t.name }), style: 'margin:2px' }, t.name))) : null);
}

export function zustandText(z) {
  if (!z) return h('span', { class: 'schwach' }, 'noch nicht gelaufen');
  return h('span', {}, h('span', { class: `zustand-punkt ${z.ergebnis}`, style: 'margin-right:6px' }), z.text, h('span', { class: 'schwach' }, ` · ${vorZeit(z.zeit)}`));
}

const refName = (r) => r.startsWith('refs/tags/') ? `Tag ${r.slice(10)}` : r.replace('refs/heads/', '');

async function ueberschreiben(p, s) {
  const haken = s.zuletzt.abweichend.map((a) => ({ ref: a.ref, feld: h('input', { type: 'checkbox', checked: true }) }));
  const r = await dialog('Am Ziel überschreiben', h('div', {},
    h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {}, oeffentlichMod(s)
      ? `Auf GitHub (${s.repo}) wird der Stand dieser Zweige durch den BEREINIGTEN Stand ersetzt – der bisherige Verlauf dort verschwindet aus den Zweigen.`
      : `Am Ziel ${new URL(s.url).host} wird der Stand dieser Zweige durch den aus FAH-Git ersetzt. Commits, die nur dort liegen, gehen dort verloren. Bei main startet dort die Pipeline.`)),
    haken.map((x) => h('label', { class: 'haken' }, x.feld, h('code', {}, refName(x.ref)))),
    info('Lehnt das Ziel ab (z. B. geschützter Zweig), steht der Grund danach am Spiegel; dort muss Überschreiben erlaubt werden.')),
  [{ text: 'Abbrechen' }, { text: 'Überschreiben', art: 'gefahr', aktion: () => api('POST', '/spiegel/ueberschreiben', { pfad: p.pfad, id: s.id, refs: haken.filter((x) => x.feld.checked).map((x) => x.ref) }) }]);
  if (!r) return;
  meldung(r.abgelehnt.length ? `${r.ueberschrieben.length} überschrieben, ${r.abgelehnt.length} vom Ziel abgelehnt: ${r.abgelehnt.map((a) => `${refName(a.ref)} (${a.grund})`).join(', ')}` : `${r.ueberschrieben.length} Zweig(e) überschrieben`, r.abgelehnt.length ? 'fehler' : 'ok');
  location.reload();
}

// --- GitHub (1.8.0): Repo auswählen, WAS (alles oder Zweige) und WANN (von Hand oder nach jedem Push) je Spiegel ---------

const githubLink = (s) => String(s.url || '').replace(/\.git$/, '');
const oeffentlichMod = (s) => s.modus === 'oeffentlich';
export const githubArt = (s) => [oeffentlichMod(s) ? 'Öffentlicher Stand (bereinigt)' : 'Vollständig mit Verlauf',
  s.auto ? 'automatisch nach jedem Push' : 'nur von Hand',
  s.zweige ? `Zweige: ${s.zweige.join(', ')}` : (oeffentlichMod(s) ? 'Standardzweig' : 'alle Zweige und Tags'),
  s.sichtbarkeit === 'oeffentlich' ? 'auf GitHub ÖFFENTLICH' : s.sichtbarkeit === 'privat' ? 'auf GitHub privat' : null].filter(Boolean).join(' · ');

/** Probelauf: was ersetzt, weggelassen, gesperrt würde – Funde direkt behandeln (je Projekt). Sendet nichts. */
async function probelaufDialog(p, s) {
  const inhalt = h('div', {});
  const liste = (titel, eintraege) => (eintraege.length ? h('details', { style: 'margin:6px 0' }, h('summary', {}, `${titel} (${eintraege.length})`),
    h('div', { class: 'mono klein', style: 'max-height:180px;overflow:auto;overflow-wrap:anywhere' }, eintraege.slice(0, 400).map((x) => h('div', {}, x)))) : null);
  const aktion = (body) => async (e) => {
    e.currentTarget.disabled = true;
    try { await api('POST', '/spiegel/befund', { pfad: p.pfad, ...body }); await zeichnen(); } catch (err) { fehlerMelden(err); e.currentTarget.disabled = false; }
  };
  const fundeListe = (funde) => {
    const jeDatei = new Map();
    for (const f of funde) { if (!jeDatei.has(f.datei)) jeDatei.set(f.datei, []); jeDatei.get(f.datei).push(f); }
    return h('div', {}, [...jeDatei].map(([datei, fs]) => h('div', { style: 'border-top:1px solid var(--rand);padding:8px 0' },
      h('div', { class: 'mono', style: 'overflow-wrap:anywhere;font-weight:600' }, datei),
      fs.slice(0, 6).map((f) => h('div', { class: 'klein' }, f.zeile ? `Zeile ${f.zeile}: ` : '', f.text, f.auszug ? h('span', { class: 'schwach' }, ` · ${f.auszug}`) : null)),
      fs.length > 6 ? h('div', { class: 'klein schwach' }, `… und ${fs.length - 6} weitere`) : null,
      h('div', { class: 'zeile', style: 'margin-top:6px' },
        h('button', { class: 'knopf klein', type: 'button', onclick: aktion({ aktion: 'weglassen', datei }) }, 'Datei weglassen'),
        h('button', { class: 'knopf klein', type: 'button', onclick: aktion({ aktion: 'freigeben', datei, fps: fs.map((f) => f.fp) }) }, 'Harmlos (Testwert) – freigeben')))));
  };
  async function zeichnen() {
    leeren(inhalt, h('p', { class: 'schwach' }, 'Prüfe den aktuellen Stand …'));
    let erg;
    try { erg = await api('POST', '/spiegel/probelauf', { pfad: p.pfad, id: s.id }); } catch (e) { leeren(inhalt, h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {}, e.message))); return; }
    leeren(inhalt,
      info('So sähe der öffentliche Stand aus. Weglassen und Freigaben gelten für dieses Projekt (alle seine GitHub-Ziele). Regeln für Ersetzen/Verboten/Weglassen: Einstellungen → GitHub.'),
      erg.map((z) => h('div', { style: 'margin-top:10px' },
        h('div', {}, h('strong', {}, `Zweig ${z.zweig}: `), `${z.dateien} Dateien geprüft · ${z.ersetzt.length} angepasst · ${z.weggelassen.length} weggelassen · `,
          z.nicht_gewaehlt ? `${z.nicht_gewaehlt} nicht gewählt („Nur diese Dateien“) · ` : '',
          z.funde_gesamt ? h('strong', { style: 'color:var(--gefahr)' }, `${z.funde_gesamt} Fund(e) – sperrt`) : h('strong', { style: 'color:var(--erfolg)' }, 'keine Funde – bereit')),
        z.funde.length ? fundeListe(z.funde) : null,
        liste('Ersetzt', z.ersetzt.map((x) => `${x.datei} (${x.anzahl}×)`)),
        liste('Weggelassen', z.weggelassen))),
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'knopf klein', type: 'button', onclick: async (e) => {
        if (!(await bestaetigen('Zurücksetzen', 'Alle für dieses Projekt weggelassenen Dateien und Freigaben werden vergessen. Der nächste Probelauf zeigt die Funde wieder.', 'Zurücksetzen'))) return;
        await aktion({ aktion: 'zuruecksetzen' })(e);
      } }, 'Weglassen/Freigaben dieses Projekts zurücksetzen')));
  }
  zeichnen();
  await dialog(`Probelauf: GitHub ${s.repo}`, inhalt, [{ text: 'Schließen' }]);
  location.reload();
}

/** Fertige Datei (z. B. die Mac-App als ZIP) als GitHub-Release hochladen. */
async function releaseHochladen(p, s) {
  const heute = new Date();
  const version = h('input', { type: 'text', required: true, value: `${heute.getFullYear()}.${String(heute.getMonth() + 1).padStart(2, '0')}.${String(heute.getDate()).padStart(2, '0')}`, autocomplete: 'off' });
  const titel = h('input', { type: 'text', placeholder: `${p.name} – Version …` });
  const text = h('textarea', { rows: 3, placeholder: 'Was ist neu? (optional)' });
  const datei = h('input', { type: 'file', required: true });
  const standBalken = h('progress', { max: 1000, value: 0, style: 'width:100%;height:10px' });
  const standText = h('div', { class: 'klein', style: 'margin-top:4px' }, 'Hochladen beginnt …');
  const stand = h('div', { hidden: true, style: 'margin-top:8px' }, standBalken, standText);
  const r = await dialog(`Release für GitHub ${s.repo}`, h('div', {},
    h('div', { class: 'hinweisbox warn' }, sym('warnung'), h('div', {}, 'Die Datei geht so, wie sie ist, nach GitHub – sie wird NICHT bereinigt oder geprüft. Nur fertige Release-Dateien ohne persönliche Daten hochladen (z. B. die verteilbare App als ZIP).')),
    feld('Version', version, 'Wird als Tag auf GitHub angelegt (z. B. 2026.11.20 oder v1.2.0). Jede Version nur einmal.'),
    feld('Titel', titel, 'Leer = die Version.'),
    feld('Beschreibung', text, 'Steht auf der Release-Seite (optional).'),
    feld('Datei', datei, 'Bis 2 GB. Die Datei erscheint auf GitHub unter „Releases“ zum Herunterladen.'),
    info('Danach bleibt auf GitHub nur dieses neueste Release: ältere Releases und ihre Tags löscht FAH-Git nach dem Hochladen.'), stand),
  [{ text: 'Abbrechen' }, { text: 'Hochladen', art: 'haupt', aktion: async () => {
    const f = datei.files && datei.files[0];
    if (!f) throw new Error('Bitte eine Datei wählen');
    // 1.14.0: mit Fortschritt (XHR meldet die hochgeladenen Bytes)
    stand.hidden = false;
    const seit = Date.now();
    return new Promise((fertig, fehler) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/github/release?${q({ pfad: p.pfad, id: s.id, version: version.value.trim(), titel: titel.value.trim(), text: text.value.trim(), datei: f.name })}`);
      x.setRequestHeader('X-FAHGIT', '1'); x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const sek = (Date.now() - seit) / 1000; const rate = sek > 1 ? e.loaded / sek : 0;
        standBalken.value = Math.round((e.loaded / e.total) * 1000);
        standText.textContent = e.loaded >= e.total ? `${f.name} ist oben – GitHub legt das Release an …`
          : `${Math.floor((e.loaded / e.total) * 100)} % · ${mb(e.loaded)} von ${mb(e.total)}${rate ? ` · ${mb(rate)}/s · noch etwa ${dauerText((e.total - e.loaded) / rate)}` : ''}`;
      };
      x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText || '{}'); } catch { /* leer */ } if (x.status >= 200 && x.status < 300) fertig(d); else fehler(new Error(d.fehler || `Fehler ${x.status}`)); };
      x.onerror = () => fehler(new Error('Hochladen abgebrochen – Netz prüfen'));
      x.send(f);
    });
  } }]);
  if (r) {
    const e = r.entfernt || {};
    const n = (e.releases || []).length; const t = (e.tags || []).length;
    if ((e.fehler || []).length) { fehlerMelden(new Error(`Release angelegt – Altes auf GitHub nicht ganz entfernt: ${e.fehler.join('; ')}`)); return; }
    meldung(n || t ? `Release angelegt · ${n} ältere(s) Release(s) und ${t} Tag(s) auf GitHub entfernt` : 'Release angelegt');
    setTimeout(() => location.reload(), 1500);
  }
}

async function sichtbarkeitAendern(p, s, oeffentlich) {
  const ok = oeffentlich
    ? await bestaetigen('Auf GitHub öffentlich stellen', `Danach kann JEDER ${s.repo} sehen und herunterladen – was einmal öffentlich war, gilt als veröffentlicht. Übertragen wird weiter nur der bereinigte Stand.`, 'Öffentlich stellen')
    : await bestaetigen('Wieder privat stellen', `${s.repo} ist danach nur noch für dich sichtbar.`, 'Privat stellen');
  if (!ok) return;
  try { await api('POST', '/github/sichtbarkeit', { pfad: p.pfad, id: s.id, oeffentlich }); meldung(oeffentlich ? 'Jetzt öffentlich' : 'Jetzt privat'); location.reload(); } catch (e) { fehlerMelden(e); }
}

/** Felder „Was übertragen?“ und „Wann?“ – für Neu und Ändern. */
function wasWannFelder(p, s = null, vorlage = null) {
  const oeff = h('input', { type: 'radio', name: 'gh-art', checked: !s || oeffentlichMod(s) });
  const voll = h('input', { type: 'radio', name: 'gh-art', checked: !!(s && !oeffentlichMod(s)), disabled: !!(s && s.sichtbarkeit === 'oeffentlich') });
  const allesText = h('span', {});
  const alles = h('input', { type: 'radio', name: 'gh-was', checked: !s || !s.zweige });
  const nurZweige = h('input', { type: 'radio', name: 'gh-was', checked: !!(s && s.zweige), disabled: !p.zweige.length });
  const haken = p.zweige.map((z) => ({ name: z.name, feld: h('input', { type: 'checkbox', checked: s && s.zweige ? s.zweige.includes(z.name) : z.name === p.standard }) }));
  const box = h('div', { style: 'margin:4px 0 0 28px' }, haken.map((x) => h('label', { class: 'haken' }, x.feld, h('code', {}, x.name))));
  const zeigen = () => { box.hidden = !nurZweige.checked; allesText.textContent = oeff.checked ? `Nur den Standardzweig (${p.standard || 'main'})` : 'Alle Zweige und Tags'; nurFeld.hidden = !oeff.checked; };
  for (const x of [alles, nurZweige, oeff, voll]) x.addEventListener('change', zeigen);
  // Vorlage „App“ (1.17.0): beim Verbinden einer App automatisch und nur öffentliches README + Bilder
  const vorlageNeu = !!(vorlage && !s);
  const auto = h('input', { type: 'checkbox', checked: !!(s ? s.auto : vorlageNeu) });
  const nurBisher = (p.bereinigung && p.bereinigung.nur) || [];
  const nur = h('textarea', { rows: 3, spellcheck: 'false', class: 'mono', placeholder: '/.github/README.md\n/docs/screenshots/**' },
    (nurBisher.length || !vorlageNeu ? nurBisher : vorlage.nur || []).join('\n'));
  const nurFeld = feld('Nur diese Dateien (leer = alle)', nur, 'Ein Muster je Zeile (gilt für dieses Projekt). Z. B. für eine Mac-App nur die fertige App: „build/*.app/**“ und „/README.md“ – dann gehen Quellen und Bauskripte nicht mit. ** = beliebige Ordner, * = beliebige Zeichen; „/“ vorne = nur im Hauptordner (ohne: in jedem Ordner).');
  zeigen();
  const el = h('div', {},
    vorlageNeu ? h('div', { class: 'hinweisbox', style: 'margin-bottom:12px' }, sym('info'), vorlage.art === 'app'
      ? h('div', {}, h('strong', {}, 'Vorlage „App“: '), 'Auf GitHub liegen nur das öffentliche README (', h('code', {}, '.github/README.md'),
        ') und die Bilder, die App selbst kommt als Release. Übertragen und neue Releases laufen automatisch. Fehlt das README, überträgt FAH-Git nichts und sagt, was fehlt.')
      : h('div', {}, h('strong', {}, 'Vorlage „Docker“: '), 'Öffentlicher Stand mit Quellcode (bereinigt), automatisch übertragen; neue Fassungen der öffentlichen Release-Datei gehen von selbst raus.')) : null,
    h('div', { class: 'feld' }, h('label', {}, 'Wie wird übertragen?'),
      h('div', {},
        h('label', { class: 'haken' }, oeff, h('span', {}, h('div', {}, 'Öffentlicher Stand (bereinigt, ohne Verlauf)'),
          h('div', { class: 'schwach klein' }, 'Nur der aktuelle Stand; Adresse, Heimnetz & Co. ersetzt, Geheimnisse gesperrt. Zum Veröffentlichen.'))),
        h('label', { class: 'haken' }, voll, h('span', {}, h('div', {}, 'Vollständig mit Verlauf'),
          h('div', { class: 'schwach klein' }, 'Alle Commits, Zweige und Tags wie hier – nur für private Repos (z. B. als Sicherung).')))),
      info('Beim öffentlichen Stand siehst du vorher per „Probelauf“, was ersetzt, weggelassen oder gesperrt würde. Öffentlich stellen kann FAH-Git nur Repos, die es selbst neu angelegt hat – ein vorhandenes Repo kann alten Verlauf enthalten.')),
    h('div', { class: 'feld' }, h('label', {}, 'Was wird übertragen?'),
      h('div', {}, h('label', { class: 'haken' }, alles, allesText),
        h('label', { class: 'haken' }, nurZweige, h('span', {}, 'Nur diese Zweige', p.zweige.length ? '' : ' (das Projekt hat noch keine)')), box),
      info('Bei „Nur diese Zweige“ gehen keine Tags mit. Von selbst wird am Ziel nie etwas gelöscht oder überschrieben – nur, wenn du bei einer Abweichung ausdrücklich „Mit FAH-Git-Stand überschreiben“ wählst.')),
    nurFeld,
    h('div', { class: 'feld' }, h('label', {}, 'Wann wird übertragen?'),
      h('div', {}, h('label', { class: 'haken' }, auto, h('span', {}, 'Automatisch nach jedem Push'))),
      info('Ohne Haken überträgt FAH-Git nur, wenn du auf „Jetzt zu GitHub“ klickst – hier oder unter Einstellungen → GitHub.')));
  const werte = () => {
    const zweige = nurZweige.checked ? haken.filter((x) => x.feld.checked).map((x) => x.name) : null;
    if (zweige && !zweige.length) throw new Error('Mindestens einen Zweig wählen');
    return { modus: oeff.checked ? 'oeffentlich' : 'voll', auto: auto.checked, zweige, ...(oeff.checked ? { nur: nur.value.split('\n').map((x) => x.trim()).filter(Boolean) } : {}) };
  };
  return { el, werte };
}

async function githubNeu(p) {
  let zugang; let repos;
  try { zugang = await api('GET', '/github'); } catch (e) { return fehlerMelden(e); }
  if (!zugang.eingerichtet) {
    const weiter = await dialog('GitHub noch nicht verbunden', h('p', {}, 'Hinterlege einmal deinen GitHub-Token unter Einstellungen → GitHub. Danach wählst du hier nur noch das Repo aus.'),
      [{ text: 'Abbrechen' }, { text: 'Zu den Einstellungen', art: 'haupt', aktion: () => true }]);
    if (weiter) location.hash = '#/einstellungen';
    return;
  }
  try { repos = await api('GET', `/github/repos?pfad=${encodeURIComponent(p.pfad)}`); } catch (e) { return fehlerMelden(e); }
  const NEU = '__neu__';
  const vergeben = new Set(p.spiegel.filter((s) => s.art === 'github').map((s) => s.repo.toLowerCase()));
  const suche = h('input', { type: 'search', placeholder: 'Repo suchen …', autocomplete: 'off' });
  const auswahl = h('select', { size: 8, style: 'width:100%' });
  const neuName = h('input', { type: 'text', value: p.slug, autocomplete: 'off', spellcheck: 'false' });
  const neuFeld = feld('Name des neuen Repos', neuName, `Wird PRIVAT in deinem GitHub-Konto „${zugang.konto}“ angelegt, leer (ohne README).`);
  const passend = repos.find((r) => r.repo.toLowerCase().endsWith(`/${p.slug.toLowerCase()}`) && !vergeben.has(r.repo.toLowerCase()) && r.schreiben && !r.archiviert);
  let gewaehlt = passend ? passend.repo : NEU;
  const zeichnen = () => {
    const f = suche.value.trim().toLowerCase();
    leeren(auswahl, h('option', { value: NEU }, '+ Neues privates Repo anlegen …'),
      repos.filter((r) => !f || r.repo.toLowerCase().includes(f)).map((r) => {
        const grund = vergeben.has(r.repo.toLowerCase()) ? 'schon verbunden' : !r.schreiben ? 'nur Leserecht' : r.archiviert ? 'archiviert' : '';
        const herkunft = r.fahgit === 'veroeffentlichbar' ? ' – von FAH-Git für dieses Projekt angelegt' : '';
        return h('option', { value: r.repo, disabled: !!grund }, `${r.repo}${r.privat ? ' (privat)' : ' (öffentlich)'}${grund ? ` – ${grund}` : herkunft}`);
      }));
    if ([...auswahl.options].some((o) => o.value === gewaehlt && !o.disabled)) auswahl.value = gewaehlt;
    hinweisZeigen();
  };
  // 1.15.4: Ein vorhandenes Repo kann alte Stände tragen und wird darum nie öffentlich – außer FAH-Git hat es selbst für
  // dieses Projekt angelegt (z. B. Spiegel gelöscht und neu verbunden). Das steht jetzt sichtbar unter der Auswahl.
  const hinweis = h('p', { class: 'klein', style: 'margin:6px 0 0;padding:6px 10px;border-radius:8px' });
  const hinweisZeigen = () => {
    neuFeld.hidden = auswahl.value !== NEU;
    const r = repos.find((x) => x.repo === auswahl.value);
    hinweis.hidden = !r;
    if (!r) return;
    hinweis.style.background = r.fahgit === 'veroeffentlichbar' ? 'var(--erfolg-hell)' : 'var(--warnung-hell)';
    hinweis.textContent = r.fahgit === 'veroeffentlichbar'
      ? 'FAH-Git hat dieses Repo für dieses Projekt angelegt – mit „Öffentlicher Stand“ lässt es sich später öffentlich stellen.'
      : 'Vorhandenes Repo: Es kann alte Stände enthalten und lässt sich darum nie öffentlich stellen. Zum Veröffentlichen „+ Neues privates Repo anlegen“ wählen.';
  };
  suche.addEventListener('input', zeichnen);
  auswahl.addEventListener('change', () => { gewaehlt = auswahl.value; hinweisZeigen(); });
  zeichnen();
  const ww = wasWannFelder(p, null, p.typ ? { art: p.typ, nur: p.typ === 'app' ? zugang.app_vorlage.nur : [] } : null);
  const jetzt = h('input', { type: 'checkbox', checked: true });
  const r = await dialog('Zu GitHub übertragen', h('div', {},
    feld(`GitHub-Repo (Konto ${zugang.konto})`, h('div', {}, suche, h('div', { style: 'margin-top:6px' }, auswahl), hinweis), 'Alle Repos, an die dein Token herankommt. Grau = schon mit diesem Projekt verbunden oder ohne Schreibrecht.'),
    neuFeld, ww.el,
    h('label', { class: 'haken' }, jetzt, h('span', {}, 'Nach dem Einrichten gleich einmal übertragen'))),
  [{ text: 'Abbrechen' }, { text: 'Verbinden', art: 'haupt', aktion: () => {
    const { modus, auto, zweige, nur } = ww.werte();
    const ziel = auswahl.value || gewaehlt;
    if (!ziel) throw new Error('Bitte ein Repo wählen');
    return api('POST', '/spiegel', { pfad: p.pfad, modus, auto, zweige, nur, jetzt: jetzt.checked, ...(ziel === NEU ? { github_neu: neuName.value.trim() } : { github: ziel }) });
  } }]);
  if (!r) return;
  meldung(jetzt.checked ? `Mit ${r.repo} verbunden – Übertragung läuft` : `Mit ${r.repo} verbunden – übertragen wird, wenn du „Jetzt zu GitHub“ klickst`);
  setTimeout(() => location.reload(), jetzt.checked ? 2500 : 300);
}

async function githubAendern(p, s) {
  const ww = wasWannFelder(p, s);
  const r = await dialog(`GitHub: ${s.repo}`, ww.el,
    [{ text: 'Abbrechen' }, { text: 'Speichern', art: 'haupt', aktion: () => api('PATCH', '/spiegel', { pfad: p.pfad, id: s.id, ...ww.werte() }) }]);
  if (r) { meldung('Gespeichert'); location.reload(); }
}

// --- Releases (1.12.0) ---------------------------------------------------------------------------------------------
// Fertige Dateien aus der Release-Ablage des NAS (nur lesend eingebunden). Je Projekt zugeordnet; eine davon ist
// „öffentlich“ und geht per Knopf als GitHub-Release raus – ohne erneutes Hochladen.
const releaseSpiegel = (p) => p.spiegel.filter((s) => s.art === 'github' && oeffentlichMod(s) && s.zuletzt && s.zuletzt.ergebnis === 'ok');

const mb = (n) => `${(n / 1048576).toLocaleString('de-DE', { maximumFractionDigits: n < 10 * 1048576 ? 1 : 0 })} MB`;
const dauerText = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

/**
 * Fortschritt einer Veröffentlichung (1.14.0): Balken + Text, fragt jede Sekunde nach, solange der Auftrag läuft und das
 * Element auf der Seite ist. Bleibt auch nach dem Neuladen sichtbar (der Server merkt sich den letzten Lauf je Projekt).
 */
function releaseFortschritt(lauf, { klein = false } = {}) {
  const balken = h('progress', { max: 1000, value: 0, style: 'width:100%;height:10px' });
  const text = h('div', { class: klein ? 'klein' : '', style: 'margin-top:4px' });
  const kasten = h('div', { class: klein ? '' : 'hinweisbox', style: klein ? 'margin-top:6px' : 'display:block;margin-top:8px' }, balken, text);
  let zuletzt = null;
  function zeichnen(a) {
    const f = a.fortschritt || {};
    const anteil = f.gesamt ? Math.min(1, (f.erledigt || 0) / f.gesamt) : 0;
    balken.value = Math.round(anteil * 1000);
    const sek = f.seit ? (Date.now() - f.seit) / 1000 : 0;
    const rate = sek > 1 ? (f.erledigt || 0) / sek : 0;
    const rest = rate > 0 && f.gesamt ? (f.gesamt - (f.erledigt || 0)) / rate : null;
    const pz = `${Math.floor(anteil * 100)} %`;
    if (a.status === 'fehler') { balken.hidden = true; text.textContent = `Nicht veröffentlicht: ${a.fehler}`; text.style.color = 'var(--gefahr)'; return; }
    if (a.status === 'fertig') {
      balken.value = 1000;
      leeren(text);
      text.append(`Veröffentlicht: ${a.datei} als ${a.version || ''} – `, a.ergebnis && a.ergebnis.url ? h('a', { href: a.ergebnis.url, target: '_blank', rel: 'noopener noreferrer' }, 'auf GitHub ansehen') : '');
      return;
    }
    text.textContent = f.phase === 'hochladen'
      ? `Lade ${a.datei} zu GitHub ${a.repo || ''} … ${pz} · ${mb(f.erledigt || 0)} von ${mb(f.gesamt || 0)}${rate ? ` · ${mb(rate)}/s` : ''}${rest !== null ? ` · noch etwa ${dauerText(rest)}` : ''}`
      : f.phase === 'abschluss' ? `${a.datei} ist oben – schließe ab (ältere Releases aufräumen) …`
      : `Prüfe ${a.datei || 'Datei'} (Prüfsumme und Inhalt) …${f.erledigt ? ` ${pz}` : ''}`;
  }
  async function fragen() {
    if (!kasten.isConnected && zuletzt) return;
    try {
      const a = await api('GET', `/auftrag?${q({ id: lauf.id })}`);
      zuletzt = a; zeichnen(a);
      if (a.status === 'laeuft') setTimeout(fragen, 1000);
      else if (a.status === 'fertig') meldung('Release veröffentlicht');
    } catch { text.textContent = 'Fortschritt nicht abrufbar (FAH-Git neu gestartet?) – Seite neu laden.'; }
  }
  zeichnen(lauf);
  if (lauf.status === 'laeuft') setTimeout(fragen, 300);
  return kasten;
}

function releasesAnsicht(p, admin) {
  const r = p.releases;
  const ziele = releaseSpiegel(p);
  const zeile = (d) => h('tr', {},
    h('td', { style: 'overflow-wrap:anywhere' }, h('div', {}, h('strong', {}, d.name),
      d.oeffentlich ? h('span', { class: 'marker gruen', style: 'margin-left:8px' }, sym('schild'), 'öffentlich') : null,
      d.gesperrt ? h('span', { class: 'marker rot', style: 'margin-left:8px', title: d.gesperrt }, sym('schloss'), 'gesperrt') : null,
      d.fehlt ? h('span', { class: 'marker warn', style: 'margin-left:8px' }, sym('warnung'), 'nicht mehr in der Ablage') : null,
      d.vermerk === 'ok' ? h('span', { class: 'marker grau', style: 'margin-left:8px', title: 'Prüfvermerk des Bauskripts liegt daneben; vor dem Veröffentlichen prüft FAH-Git Prüfsumme und (bei ISOs) den Inhalt' }, sym('haken'), 'Prüfvermerk') : null,
      d.vermerk === 'abweichend' ? h('span', { class: 'marker rot', style: 'margin-left:8px' }, sym('warnung'), 'Vermerk passt nicht') : null),
      d.rel ? h('div', { class: 'schwach klein mono' }, d.rel) : null),
    h('td', { class: 'schwach', style: 'white-space:nowrap' }, d.groesse != null ? groesse(d.groesse) : '–'),
    h('td', { class: 'schwach', style: 'white-space:nowrap' }, d.zeit ? datumZeit(d.zeit) : '–'),
    h('td', { style: 'text-align:right' }, !d.gesperrt && !d.fehlt
      ? h('a', { class: 'knopf klein', href: `/api/release-datei?${q({ pfad: p.pfad, nr: String(d.nr) })}`, download: d.name }, sym('laden'), 'Herunterladen') : null));
  // 1.16.0: Ist der Stand der öffentlichen Datei schon das Release auf GitHub? Dann kein Knopf-Zwang und kein alter Fehler.
  const oeff = r.dateien.find((d) => d.oeffentlich);
  const aktuell = (s) => { const x = (s.releases || [])[0]; return !!(x && oeff && x.quelle === r.oeffentlich && x.tag === oeff.version); };
  const lauf = r.lauf && r.lauf.status === 'fehler' && ziele.some(aktuell) ? null : r.lauf;
  const autoSetzen = async (an) => {
    try { await api('PUT', '/releases', { pfad: p.pfad, dateien: r.dateien.map((d) => d.rel), oeffentlich: r.oeffentlich, verboten: r.verboten, auto: an }); meldung(an ? 'Neue Fassungen gehen ab jetzt automatisch raus' : 'Automatik aus'); location.reload(); }
    catch (e) { fehlerMelden(e); }
  };
  const stand = admin && oeff && ziele.length ? h('div', { style: 'margin-top:8px' },
    ziele.map((s) => {
      const x = (s.releases || [])[0];
      return h('p', { class: 'klein', style: 'margin:4px 0' }, aktuell(s)
        ? [h('span', { class: 'marker gruen' }, sym('haken'), 'aktuell'), ` Auf GitHub ${s.repo}: Release `, h('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.tag), ` = ${oeff.name} vom ${datumZeit(oeff.zeit)}`]
        : [h('span', { class: 'marker warn' }, sym('warnung'), 'neu'), ` ${oeff.name} vom ${datumZeit(oeff.zeit)} ist noch nicht auf GitHub ${s.repo}`,
          r.auto ? ' – geht in den nächsten Minuten automatisch raus.' : '.', x ? h('span', { class: 'schwach' }, ` (dort: ${x.tag})`) : null]);
    }),
    h('label', { class: 'haken', style: 'margin-top:6px' }, h('input', { type: 'checkbox', checked: !!r.auto, onchange: (e) => autoSetzen(e.target.checked) }),
      h('span', {}, 'Neue Fassungen automatisch veröffentlichen'), h('span', { class: 'schwach klein' }, ' – liegt eine neue Fassung der öffentlichen Datei in der Ablage, geht sie mit denselben Prüfungen von selbst zu GitHub')),
    r.auto_fehler ? h('div', { class: 'hinweisbox rot', style: 'margin-top:8px' }, sym('warnung'), h('div', {}, `Automatik gestoppt bei ${r.auto_fehler.version}: ${r.auto_fehler.fehler} – die nächste Fassung wird wieder versucht.`)) : null) : null;
  return h('div', {},
    h('div', { class: 'karte abschnitt' },
      h('div', { class: 'karten-kopf' }, h('h2', {}, 'Releases'),
        admin ? h('div', { class: 'zeile ende' },
          r.oeffentlich && ziele.length ? ziele.map((s) => h('button', { class: aktuell(s) ? 'knopf klein' : 'knopf haupt klein', type: 'button', onclick: () => releaseAusAblage(p, s, aktuell(s)) }, sym('schild'),
            aktuell(s) ? 'Mit eigener Version veröffentlichen …' : ziele.length > 1 ? `Auf GitHub ${s.repo} veröffentlichen …` : 'Auf GitHub veröffentlichen …')) : null,
          h('button', { class: 'knopf klein', type: 'button', onclick: () => releasesZuordnen(p) }, sym('bearbeiten'), 'Dateien zuordnen …')) : null),
      h('div', { class: 'karten-inhalt' },
        info('Fertige Dateien (ZIP, ISO, PDF …) aus der Release-Ablage auf dem NAS – FAH-Git liest sie nur und lädt nichts hoch. Die als „öffentlich“ gewählte Datei geht mit einem Klick als Release zu GitHub; dort bleibt nur das neueste.'),
        !r.ablage ? h('div', { class: 'hinweisbox warn', style: 'margin-top:8px' }, sym('warnung'), h('div', {}, 'Die Release-Ablage ist nicht eingebunden (in der .env von FAH-Git: ABLAGE=<Ordner auf dem NAS>).')) : null,
        r.verboten.length ? h('p', { class: 'klein' }, 'Darf nicht in der öffentlichen Datei stecken: ', r.verboten.map((v) => h('code', { style: 'margin-right:6px' }, v))) : null,
        admin && r.oeffentlich && !ziele.length ? h('p', { class: 'klein schwach' }, 'Zum Veröffentlichen braucht das Projekt eine GitHub-Weiterleitung „Öffentlicher Stand“, die schon einmal sauber übertragen hat (Reiter Spiegel).') : null,
        stand,
        admin && lauf ? releaseFortschritt(lauf) : null),
      r.dateien.length ? h('table', { class: 'tabelle' }, h('tr', {}, h('th', {}, 'Datei'), h('th', {}, 'Größe'), h('th', {}, 'Stand'), h('th', {})), r.dateien.map(zeile))
        : h('div', { class: 'leer-hinweis' }, admin ? 'Noch keine Dateien zugeordnet – „Dateien zuordnen …“ wählt sie aus der Ablage.' : 'Keine Release-Dateien.')));
}

/** Dateien aus der Ablage zuordnen: Ordner durchklicken, ankreuzen, eine davon „öffentlich“. */
async function releasesZuordnen(p) {
  const gewaehlt = new Map(p.releases.dateien.map((d) => [d.rel, d]));
  let oeffentlich = p.releases.oeffentlich;
  let ordner = p.releases.dateien.length ? p.releases.dateien[0].rel.split('/').slice(0, -1).join('/') : '';
  const verboten = h('textarea', { rows: 2, placeholder: 'z. B. lokale-stimme/' }, p.releases.verboten.join('\n'));
  const liste = h('div', { class: 'ablage-liste', style: 'max-height:300px;overflow:auto;border:1px solid var(--rand);border-radius:8px;padding:6px' });
  const auswahl = h('div', {});
  const pfadZeile = h('div', { class: 'klein', style: 'margin:6px 0' });
  function auswahlZeichnen() {
    leeren(auswahl);
    if (!gewaehlt.size) { auswahl.appendChild(h('div', { class: 'schwach klein' }, 'Noch nichts angekreuzt.')); return; }
    if (oeffentlich && !gewaehlt.has(oeffentlich)) oeffentlich = null;
    auswahl.appendChild(h('div', { class: 'klein schwach', style: 'margin-bottom:4px' }, 'Zugeordnet – welche Datei ist für GitHub (öffentlich)? Möglich sind ZIPs (Inhalt wird geprüft) und Dateien mit Prüfvermerk des Bauskripts (z. B. eine Installer-ISO).'));
    for (const d of [{ rel: '', name: 'keine (nichts öffentlich)' }, ...gewaehlt.values()]) {
      const zip = !d.rel || /\.(zip|apk|jar)$/i.test(d.rel) || d.vermerk === 'ok';
      const radio = h('input', { type: 'radio', name: 'oeffentlich', disabled: !zip, checked: (oeffentlich || '') === d.rel, onchange: () => { oeffentlich = d.rel || null; } });
      auswahl.appendChild(h('label', { style: `display:flex;gap:8px;align-items:center;margin:3px 0;${zip ? '' : 'opacity:.6'}` }, radio, h('span', {}, d.name),
        d.rel ? h('span', { class: 'schwach klein mono' }, d.rel) : null,
        d.vermerk === 'ok' ? h('span', { class: 'marker gruen klein' }, sym('haken'), 'Prüfvermerk') : d.vermerk === 'abweichend' ? h('span', { class: 'marker rot klein' }, sym('warnung'), 'Vermerk passt nicht') : null,
        zip ? null : h('span', { class: 'schwach klein' }, '(nur zum Herunterladen – kein Prüfvermerk)')));
    }
  }
  async function laden() {
    leeren(liste); liste.appendChild(h('div', { class: 'schwach klein' }, 'Lade …'));
    let d;
    try { d = await api('GET', `/ablage?${q({ ordner })}`); } catch (e) { leeren(liste); liste.appendChild(h('div', { class: 'hinweisbox warn' }, sym('warnung'), h('div', {}, e.message))); return; }
    leeren(liste); leeren(pfadZeile);
    const teile = d.ordner ? d.ordner.split('/') : [];
    pfadZeile.appendChild(h('a', { href: '#', onclick: (e) => { e.preventDefault(); ordner = ''; laden(); } }, 'Ablage'));
    teile.forEach((t, i) => { pfadZeile.appendChild(document.createTextNode(' / ')); pfadZeile.appendChild(h('a', { href: '#', onclick: (e) => { e.preventDefault(); ordner = teile.slice(0, i + 1).join('/'); laden(); } }, t)); });
    if (!d.eintraege.length) liste.appendChild(h('div', { class: 'schwach klein' }, 'Leer – keine Release-Dateien in diesem Ordner.'));
    for (const e of d.eintraege) {
      if (e.ordner) { liste.appendChild(h('div', { style: 'padding:3px 2px' }, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); ordner = e.rel; laden(); } }, sym('ordner'), ` ${e.name}`))); continue; }
      const box = h('input', { type: 'checkbox', checked: gewaehlt.has(e.rel), disabled: !!e.gesperrt, onchange: () => { if (box.checked) gewaehlt.set(e.rel, e); else gewaehlt.delete(e.rel); auswahlZeichnen(); } });
      liste.appendChild(h('label', { style: `display:flex;gap:8px;align-items:center;padding:3px 2px;${e.gesperrt ? 'opacity:.55' : ''}`, title: e.gesperrt || '' },
        box, sym(e.gesperrt ? 'schloss' : 'datei'), h('span', {}, e.name), h('span', { class: 'schwach klein' }, `${groesse(e.groesse)} · ${datumZeit(e.zeit)}`),
        e.gesperrt ? h('span', { class: 'klein', style: 'color:var(--gefahr)' }, e.gesperrt) : null));
    }
  }
  auswahlZeichnen(); laden();
  const r = await dialog(`Release-Dateien für ${p.name}`, h('div', {},
    info('Nur lesend: FAH-Git verändert die Ablage nie. Dateien mit Namen nach Schlüssel/Privatem (z. B. „NICHT VERTEILEN“) sind gesperrt.'),
    pfadZeile, liste, h('div', { style: 'margin-top:10px' }, auswahl),
    feld('Darf nicht in der öffentlichen Datei stecken', verboten, 'Je Zeile ein Teilpfad. Vor dem Veröffentlichen liest FAH-Git das Inhaltsverzeichnis der ZIP – steckt so etwas darin (oder Schlüssel), gibt es kein Release.')),
  [{ text: 'Abbrechen' }, { text: 'Speichern', art: 'haupt', aktion: () => api('PUT', '/releases', { pfad: p.pfad, dateien: [...gewaehlt.keys()], oeffentlich,
    verboten: verboten.value.split('\n').map((x) => x.trim()).filter(Boolean) }) }]);
  if (r) { meldung('Releases gespeichert'); location.reload(); }
}

/** Die als „öffentlich“ gewählte Datei als GitHub-Release veröffentlichen (ohne Hochladen). */
async function releaseAusAblage(p, s, schonAktuell = false) {
  const d = p.releases.dateien.find((x) => x.oeffentlich);
  if (!d) { fehlerMelden(new Error('Keine öffentliche Datei gewählt')); return; }
  const version = h('input', { type: 'text', autocomplete: 'off', required: schonAktuell,
    placeholder: schonAktuell ? `Dieser Stand ist schon online (${d.version}) – andere Version eintragen` : `leer = Stand der Datei (${d.version || 'z. B. 2026.11.27-0928'})` });
  const titel = h('input', { type: 'text', placeholder: `${p.name} – Version …` });
  const text = h('textarea', { rows: 3, placeholder: 'Was ist neu? (optional)' });
  const r = await dialog(`Release für GitHub ${s.repo}`, h('div', {},
    h('p', { style: 'margin-top:0' }, 'Datei: ', h('strong', {}, d.name), h('span', { class: 'schwach' }, ` · ${d.groesse != null ? groesse(d.groesse) : '?'} · Stand ${d.zeit ? datumZeit(d.zeit) : '?'}`)),
    h('div', { class: 'hinweisbox warn' }, sym('warnung'), h('div', {}, /\.(zip|apk|jar)$/i.test(d.name)
      ? 'Die Datei geht so, wie sie ist, öffentlich nach GitHub. FAH-Git prüft vorher das Inhaltsverzeichnis der ZIP auf Schlüssel und auf die für dieses Projekt verbotenen Pfade.'
      : 'Die Datei geht so, wie sie ist, öffentlich nach GitHub. FAH-Git prüft vorher Prüfvermerk und Prüfsumme und liest bei einer ISO den Inhalt (eigene Teile, eingebettete Archive) auf Schlüssel, private Begriffe und die für dieses Projekt verbotenen Pfade.')),
    feld('Version', version, 'Wird als Tag auf GitHub angelegt. Leer = Datum und Uhrzeit der Datei. Jede Version nur einmal.'),
    feld('Titel', titel, 'Leer = die Version.'),
    feld('Beschreibung', text, 'Steht auf der Release-Seite (optional).'),
    info('Läuft im Hintergrund: Fortschritt mit Restzeit im Reiter Releases und in der Spiegel-Zeile – auch nach dem Neuladen der Seite. Danach bleibt auf GitHub nur dieses neueste Release: ältere Releases und ihre Tags löscht FAH-Git nach dem Hochladen.')),
  [{ text: 'Abbrechen' }, { text: 'Veröffentlichen', art: 'haupt', aktion: () => api('POST', '/github/release-ablage',
    { pfad: p.pfad, id: s.id, version: version.value.trim(), titel: titel.value.trim(), text: text.value.trim() }) }]);
  if (r && r.schon) { meldung(`Schon auf GitHub: Release ${r.version} ist genau dieser Stand`); location.reload(); return; }
  if (r && r.auftrag) { meldung(`${d.name} geht zu GitHub – Fortschritt im Reiter Releases`); location.hash = url(p, 'releases'); setTimeout(() => location.reload(), 300); }
}

function spiegelAnsicht(p, admin) {
  if (!admin) return nurAnsehen(p);
  const neuWeiter = async () => {
    const adresse = h('input', { type: 'url', required: true, placeholder: 'https://gitlab.example.com/gruppe/projekt.git' });
    const benutzer = h('input', { type: 'text', placeholder: 'z. B. benutzer' });
    const geheim = h('input', { type: 'password', autocomplete: 'off' });
    const r = await dialog('Weiterleiten an ein anderes Git', h('div', {},
      feld('Adresse des Ziel-Repos', adresse, 'Die Klon-Adresse (https) des Repos, das immer deinen Stand bekommen soll.'),
      feld('Benutzer am Ziel', benutzer, 'Dein Benutzername dort. Bei GitLab-Schlüsseln geht auch „oauth2“.'),
      feld('Zugangsschlüssel am Ziel', geheim, 'Braucht Schreibrecht für Repos (GitLab: write_repository). Wird verschlüsselt gespeichert und nie wieder angezeigt.'),
      h('div', { class: 'hinweisbox' }, sym('info'), h('div', {}, 'Sicher: Am Ziel wird nie etwas überschrieben oder gelöscht. Hat dort jemand anderes gepusht, bleibt der Zweig dort, wie er ist, und hier erscheint eine Warnung.'))),
    [{ text: 'Abbrechen' }, { text: 'Einrichten', art: 'haupt', aktion: () => api('POST', '/spiegel', { pfad: p.pfad, url: adresse.value, benutzer: benutzer.value, geheim: geheim.value }) }]);
    if (r) { meldung('Eingerichtet – der erste Abgleich läuft'); setTimeout(() => location.reload(), 2500); }
  };
  const quelleSetzen = async () => {
    const adresse = h('input', { type: 'url', required: true, value: p.quelle ? p.quelle.url : '' });
    const benutzer = h('input', { type: 'text', value: p.quelle ? p.quelle.benutzer : '' });
    const geheim = h('input', { type: 'password', autocomplete: 'off', placeholder: p.quelle && p.quelle.hat_geheim ? 'unverändert' : '' });
    const takt = h('input', { type: 'number', min: 5, max: 1440, value: p.quelle ? p.quelle.takt : 15 });
    const r = await dialog('Kopie eines anderen Gits', h('div', {},
      h('div', { class: 'hinweisbox warn' }, sym('warnung'), h('div', {}, 'Das Projekt übernimmt dann regelmäßig den Stand der Quelle und ist hier nur lesbar. Hier gepushte Änderungen würden überschrieben.')),
      feld('Adresse der Quelle', adresse, 'Die Klon-Adresse (https) des Repos, von dem kopiert wird.'),
      feld('Benutzer', benutzer, 'Leer lassen, wenn die Quelle öffentlich ist.'),
      feld('Zugangsschlüssel', geheim, 'Leserecht genügt (GitLab: read_repository).'),
      feld('Abgleich alle … Minuten', takt, 'Wie oft der Stand geholt wird (5 bis 1440).')),
    [{ text: 'Abbrechen' }, { text: 'Speichern und abgleichen', art: 'haupt', aktion: () => api('PUT', '/quelle', { pfad: p.pfad, url: adresse.value, benutzer: benutzer.value, geheim: geheim.value, takt: takt.value }) }]);
    if (r) { meldung(r.ergebnis === 'ok' ? 'Stand übernommen' : r.text, r.ergebnis === 'ok' ? 'ok' : 'fehler'); location.reload(); }
  };
  return h('div', {},
    h('div', { class: 'karte abschnitt' },
      h('div', { class: 'karten-kopf' }, h('h2', {}, 'Weiterleiten an andere Gits'), !p.quelle ? h('div', { class: 'zeile ende' },
        h('button', { class: 'knopf haupt klein', type: 'button', onclick: () => githubNeu(p) }, sym('plus'), 'Zu GitHub'),
        h('button', { class: 'knopf klein', type: 'button', onclick: neuWeiter }, sym('plus'), 'Anderes Git')) : null),
      h('div', { class: 'karten-inhalt' }, info('Andere Gits bekommen deinen Stand nach jedem Push automatisch – z. B. das GitLab der Firma, wo dann die Pipeline startet. Bei GitHub legst du je Ziel selbst fest, was und wann übertragen wird.')),
      p.spiegel.length ? h('table', { class: 'tabelle spiegel-tabelle' }, h('tr', {}, h('th', {}, 'Ziel'), h('th', {}, 'Zuletzt'), h('th', {})),
        p.spiegel.map((s) => h('tr', {},
          s.art === 'github'
            ? h('td', { style: 'overflow-wrap:anywhere;min-width:8em' }, h('div', {}, h('strong', { style: 'overflow-wrap:normal' }, 'GitHub '), h('a', { class: 'mono', href: githubLink(s), target: '_blank', rel: 'noopener noreferrer' }, s.repo)),
              h('div', { class: 'schwach klein' }, githubArt(s)),
              (s.releases || []).length ? h('div', { class: 'klein' }, 'Release: ', h('a', { href: s.releases[0].url, target: '_blank', rel: 'noopener noreferrer' }, `${s.releases[0].tag} (${s.releases[0].datei})`)) : null,
              p.releases.lauf && p.releases.lauf.spiegel === s.id && p.releases.lauf.status === 'laeuft' ? releaseFortschritt(p.releases.lauf, { klein: true }) : null)
            : h('td', { style: 'overflow-wrap:anywhere' }, h('div', { class: 'mono' }, s.url), h('div', { class: 'schwach klein' }, s.benutzer ? `als ${s.benutzer}` : 'ohne Benutzer', s.aktiv ? '' : ' · pausiert')),
          h('td', {}, zustandText(s.zuletzt),
            s.zuletzt && s.zuletzt.gesperrt ? h('div', { style: 'margin-top:6px' }, h('button', { class: 'knopf klein gefahr', type: 'button', onclick: () => probelaufDialog(p, s) }, `${s.zuletzt.funde_gesamt} Fund(e) ansehen …`)) : null,
            s.zuletzt && s.zuletzt.abweichend && s.zuletzt.abweichend.length
            ? h('div', { class: 'klein', style: 'margin-top:6px' },
              s.zuletzt.abweichend.map((a) => h('div', {}, h('code', {}, refName(a.ref)), h('span', { class: 'schwach' }, ` – ${a.grund}`))),
              info('Am Ziel liegt ein anderer Stand als in FAH-Git. Entweder dort holen und hier zusammenführen – oder den FAH-Git-Stand erzwingen.'),
              h('button', { class: 'knopf klein gefahr', type: 'button', style: 'margin-top:6px', onclick: () => ueberschreiben(p, s) }, 'Mit FAH-Git-Stand überschreiben …'))
            : null),
          h('td', { style: 'text-align:right' }, h('div', { class: 'zeile ende' },
            h('button', { class: 'knopf klein', type: 'button', onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { const [r] = await api('POST', '/spiegel/jetzt', { pfad: p.pfad, id: s.id }); meldung(r.text, r.ergebnis === 'fehler' ? 'fehler' : 'ok'); location.reload(); } catch (err) { fehlerMelden(err); }
            } }, s.art === 'github' ? 'Jetzt zu GitHub' : 'Jetzt abgleichen'),
            s.art === 'github' && oeffentlichMod(s) ? h('button', { class: 'knopf klein', type: 'button', onclick: () => probelaufDialog(p, s) }, 'Probelauf') : null,
            s.art === 'github' ? h('button', { class: 'knopf klein', type: 'button', onclick: () => githubAendern(p, s) }, 'Ändern') : null,
            s.art === 'github' && oeffentlichMod(s) && s.veroeffentlichbar && s.sichtbarkeit !== 'oeffentlich' && s.zuletzt && s.zuletzt.ergebnis === 'ok'
              ? h('button', { class: 'knopf klein', type: 'button', onclick: () => sichtbarkeitAendern(p, s, true) }, 'Öffentlich stellen …') : null,
            s.art === 'github' && s.sichtbarkeit === 'oeffentlich' ? h('button', { class: 'knopf klein', type: 'button', onclick: () => sichtbarkeitAendern(p, s, false) }, 'Wieder privat') : null,
            s.art === 'github' && oeffentlichMod(s) && s.zuletzt && s.zuletzt.ergebnis === 'ok' && p.releases.oeffentlich
              ? h('button', { class: 'knopf klein haupt', type: 'button', onclick: () => releaseAusAblage(p, s) }, 'Öffentliches Release veröffentlichen …') : null,
            s.art === 'github' && oeffentlichMod(s) && s.zuletzt && s.zuletzt.ergebnis === 'ok' ? h('button', { class: 'knopf klein', type: 'button', onclick: () => releaseHochladen(p, s) }, 'Release hochladen …') : null,
            s.art !== 'github' ? h('button', { class: 'knopf klein', type: 'button', onclick: async () => { await api('PATCH', '/spiegel', { pfad: p.pfad, id: s.id, aktiv: !s.aktiv }); location.reload(); } }, s.aktiv ? 'Pausieren' : 'Fortsetzen') : null,
            s.art !== 'github' ? h('button', { class: 'knopf klein', type: 'button', onclick: async () => {
              const g = h('input', { type: 'password', autocomplete: 'off', required: true });
              const b = h('input', { type: 'text', value: s.benutzer });
              const r = await dialog('Zugang erneuern', h('div', {}, feld('Benutzer', b), feld('Neuer Zugangsschlüssel', g, 'Z. B. wenn der alte Schlüssel abgelaufen ist.')),
                [{ text: 'Abbrechen' }, { text: 'Speichern', art: 'haupt', aktion: () => api('PATCH', '/spiegel', { pfad: p.pfad, id: s.id, benutzer: b.value, geheim: g.value }) }]);
              if (r) { meldung('Gespeichert'); location.reload(); }
            } }, 'Zugang') : null,
            h('button', { class: 'knopf klein gefahr', type: 'button', onclick: async () => {
              if (!(await bestaetigen('Weiterleitung entfernen', `Nach ${s.art === 'github' ? `GitHub ${s.repo}` : s.url} wird danach nichts mehr übertragen. Am Ziel bleibt alles, wie es ist.`, 'Entfernen'))) return;
              await api('DELETE', `/spiegel?${q({ pfad: p.pfad, id: s.id })}`); location.reload();
            } }, 'Entfernen'))))))
        : h('div', { class: 'leer-hinweis' }, p.quelle ? 'Bei einer Kopie nicht möglich – sie bekommt ihren Stand von der Quelle.' : 'Keine Ziele eingerichtet.')),
    h('div', { class: 'karte' },
      h('div', { class: 'karten-kopf' }, h('h2', {}, 'Kopie eines anderen Gits'),
        h('button', { class: 'knopf klein', type: 'button', onclick: quelleSetzen }, p.quelle ? 'Ändern' : 'Als Kopie einrichten')),
      p.quelle ? h('div', { class: 'karten-inhalt' },
        h('p', { style: 'margin-top:0' }, 'Holt alle ', h('strong', {}, `${p.quelle.takt} Minuten`), ' den Stand von ', h('code', { style: 'overflow-wrap:anywhere' }, p.quelle.url), '.'),
        h('p', {}, zustandText(p.quelle.zuletzt)),
        h('div', { class: 'zeile' },
          h('button', { class: 'knopf', type: 'button', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { const r = await api('POST', '/quelle/jetzt', { pfad: p.pfad }); meldung(r.text, r.ergebnis === 'ok' ? 'ok' : 'fehler'); location.reload(); } catch (err) { fehlerMelden(err); }
          } }, 'Jetzt abgleichen'),
          h('button', { class: 'knopf', type: 'button', onclick: async () => {
            if (!(await bestaetigen('Kopie lösen', 'Das Projekt holt danach keinen Stand mehr von der Quelle und wird hier beschreibbar – ab dann ist FAH-Git die Quelle.', 'Lösen'))) return;
            await api('DELETE', `/quelle?${q({ pfad: p.pfad })}`); meldung('Gelöst – das Projekt ist jetzt hier beschreibbar'); location.reload();
          } }, 'Kopie lösen (hier weiterarbeiten)')))
        : h('div', { class: 'karten-inhalt' }, info('Für Projekte, die woanders gepflegt werden: FAH-Git hält dann eine aktuelle, nur lesbare Kopie.'))));
}

/** Weiterleitungen und Quelle für Nicht-Admins: nur ansehen, ohne Zugänge und ohne Knöpfe. */
function nurAnsehen(p) {
  return h('div', {},
    h('div', { class: 'karte abschnitt' },
      h('div', { class: 'karten-kopf' }, h('h2', {}, 'Weiterleiten an andere Gits')),
      h('div', { class: 'karten-inhalt' }, info('Diese Ziele bekommen den Stand dieses Projekts. Einrichten und ändern dürfen nur Administratoren.')),
      p.spiegel.length ? h('table', { class: 'tabelle' }, h('tr', {}, h('th', {}, 'Ziel'), h('th', {}, 'Zuletzt')),
        p.spiegel.map((s) => h('tr', {}, s.art === 'github'
          ? h('td', { style: 'overflow-wrap:anywhere' }, h('div', { class: 'mono' }, `GitHub ${s.repo}`), h('div', { class: 'schwach klein' }, githubArt(s)))
          : h('td', { class: 'mono', style: 'overflow-wrap:anywhere' }, s.url, s.aktiv ? '' : ' (pausiert)'), h('td', {}, zustandText(s.zuletzt)))))
        : h('div', { class: 'leer-hinweis' }, 'Keine Ziele eingerichtet.')),
    p.quelle ? h('div', { class: 'karte' }, h('div', { class: 'karten-kopf' }, h('h2', {}, 'Kopie eines anderen Gits')),
      h('div', { class: 'karten-inhalt' }, h('p', { style: 'margin-top:0' }, 'Holt alle ', h('strong', {}, `${p.quelle.takt} Minuten`), ' den Stand von ', h('code', { style: 'overflow-wrap:anywhere' }, p.quelle.url), '.'),
        h('p', { style: 'margin-bottom:0' }, zustandText(p.quelle.zuletzt)))) : null);
}

/** Art schnell umstellen (1.17.2, Betreiber: „ich möchte aber auch schnell selbst projekte als APP oder DOCKER kennzeichnen
 *  können“): Auswahl direkt im Projektkopf, speichert sofort. */
function artWahl(p) {
  const wahl = h('select', { class: `art-wahl marker art ${p.typ || 'leer'}`, 'aria-label': 'Art des Projekts',
    title: 'Art des Projekts – bestimmt die GitHub-Vorlage (App: README, Bilder, Release · Docker: Quellcode)' },
  [['', 'Art: –'], ['app', 'App'], ['docker', 'Docker']].map(([w, t]) => h('option', { value: w, selected: (p.typ || '') === w }, t)));
  wahl.addEventListener('change', async () => {
    try {
      await api('PATCH', '/projekt', { pfad: p.pfad, typ: wahl.value });
      p.typ = wahl.value; wahl.className = `art-wahl marker art ${p.typ || 'leer'}`;
      meldung(p.typ ? `Als ${p.typ === 'app' ? 'App' : 'Docker'} gekennzeichnet` : 'Art entfernt');
    } catch (e) { wahl.value = p.typ || ''; fehlerMelden(e); }
  });
  return wahl;
}

function einstellungenAnsicht(p, ctx) {
  const admin = !!ctx.zustand.ich.admin && ctx.zustand.failover?.rolle !== 'ersatz';
  const name = h('input', { type: 'text', value: p.name, required: true, readonly: !admin });
  const beschreibung = h('textarea', {}, p.beschreibung);
  const themen = h('input', { type: 'text', value: p.themen.join(', '), placeholder: 'z. B. docker, python' });
  const standard = h('select', {}, p.zweige.map((z) => h('option', { value: z.name, selected: z.name === p.standard }, z.name)));
  const art = h('select', { disabled: !admin }, [['', 'Sonstiges (ohne Vorlage)'], ['app', 'App (Mac/Windows/…)'], ['docker', 'Docker']].map(([w, t]) => h('option', { value: w, selected: (p.typ || '') === w }, t)));
  const form = h('form', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h2', {}, 'Allgemein')), h('div', { class: 'karten-inhalt' },
    feld('Name', name, admin ? 'Anzeigename. Die Klon-Adresse bleibt gleich (die änderst du über „Verschieben“).' : 'Umbenennen dürfen nur Administratoren.'),
    feld('Beschreibung', beschreibung),
    feld('Themen', themen, 'Stichworte, durch Komma getrennt. Erscheinen als Marken am Projekt.'),
    feld('Art', art, 'Bestimmt die GitHub-Vorlage. App: auf GitHub nur das öffentliche README (.github/README.md) und die Bilder, die App als Release. Docker: Quellcode (bereinigt). Beide: automatisch übertragen, Releases automatisch.'),
    p.zweige.length ? feld('Standardzweig', standard, 'Wird beim Klonen ausgecheckt und in der Dateiansicht zuerst gezeigt.') : null,
    h('button', { class: 'knopf haupt', type: 'submit' }, 'Speichern')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', '/projekt', { pfad: p.pfad, name: name.value, beschreibung: beschreibung.value, themen: themen.value.split(',').map((t) => t.trim()).filter(Boolean),
        ...(admin && art.value !== (p.typ || '') ? { typ: art.value } : {}),
        ...(p.zweige.length && standard.value !== p.standard ? { standard: standard.value } : {}) });
      meldung('Gespeichert'); await ctx.baumLaden(); location.reload();
    } catch (err) { fehlerMelden(err); }
  });
  const loeschen = async () => {
    const eingabe = h('input', { type: 'text', autocomplete: 'off', placeholder: p.slug });
    const r = await dialog('Projekt löschen', h('div', {},
      h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {}, 'Das Projekt wird mit allen Zweigen, Tags und dem ganzen Verlauf gelöscht. Das lässt sich nicht rückgängig machen.')),
      feld(`Zum Bestätigen „${p.slug}“ eintippen`, eingabe)),
    [{ text: 'Abbrechen' }, { text: 'Endgültig löschen', art: 'gefahr', aktion: () => api('DELETE', `/projekt?${q({ pfad: p.pfad, bestaetigung: eingabe.value })}`) }]);
    if (r) { meldung('Projekt gelöscht'); await ctx.baumLaden(); location.hash = p.pfad.includes('/') ? `#/o/${p.pfad.split('/').slice(0, -1).join('/')}` : '#/'; }
  };
  if (!admin) return h('div', {}, form);
  return h('div', {}, form,
    h('div', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h2', {}, 'Verschieben')), h('div', { class: 'karten-inhalt' },
      info('In einen anderen Ordner oder unter neuem Kurznamen. Vorhandene Klone pushen über die alte Adresse weiter.'),
      h('div', { style: 'margin-top:10px' }, h('button', { class: 'knopf', type: 'button', onclick: () => verschiebenDialog(p.pfad, 'projekt') }, 'Verschieben …')))),
    h('div', { class: 'karte' }, h('div', { class: 'karten-kopf' }, h('h2', { style: 'color:var(--gefahr)' }, 'Löschen')), h('div', { class: 'karten-inhalt' },
      h('button', { class: 'knopf gefahr', type: 'button', onclick: loeschen }, 'Projekt löschen …'))));
}
