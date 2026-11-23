// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// FAH-Git Oberfläche: Gerüst, Navigation (#/…), Suche, Übersicht, Ordner, Konto, Verwaltung, Import, Anmeldung.
// 1.4.0: Profilbilder, Schlüssel „Nur lesen“, Rechte je Ordner/Projekt (Knöpfe ohne Recht bleiben weg; der Server prüft
// trotzdem), FAH-NAS-Adresse für den Knopf „Auf FAH-NAS bauen“.

import { h, sym, api, leeren, meldung, fehlerMelden, feld, info, dialog, bestaetigen, menue, vorZeit, datumZeit, groesse, kopieren, initiale, q,
  profilbild, profilbildVorbereiten } from './hilfen.js';
import { seitenbaum, grosseListe, flach, finde, zaehle, ordnerAuswahl, aufklappen, ordnerUrl, projektUrl } from './baum.js';
import { projektSeite, zustandText, githubArt } from './projekt.js';

const zustand = { ich: null, version: '', baum: null, fahnas: '' };
const app = document.getElementById('app');
let seite; let inhalt; let suchfeld; let nutzerKnopf; let neuKnopf;

// --- Rechte (wie src/rechte.js): Admins alles, sonst Freigaben {pfad, recht} für den Pfad und alles darunter ------------

const STUFE = { lesen: 1, schreiben: 2 };
export function recht(pfad) {
  const ich = zustand.ich;
  if (!ich) return 0;
  if (ich.admin) return 2;
  let r = 0;
  for (const f of ich.freigaben || []) if (!f.pfad || pfad === f.pfad || String(pfad).startsWith(`${f.pfad}/`)) r = Math.max(r, STUFE[f.recht] || 0);
  return r;
}
export const darfSchreiben = (pfad) => recht(pfad) >= 2;
/** Ordner ganz oben legen nur Admins an, Unterordner alle mit Schreibrecht auf den Elternordner. */
const darfOrdnerIn = (eltern) => (eltern ? darfSchreiben(eltern) : !!zustand.ich?.admin);
const alleOrdner = () => ['', ...flach(zustand.baum || { ordner: [], projekte: [] }).ordner.map((o) => o.pfad)];
const kannProjektAnlegen = () => alleOrdner().some(darfSchreiben);
const kannOrdnerAnlegen = () => alleOrdner().some(darfOrdnerIn);

// --- Start, Anmeldung -----------------------------------------------------------------------------------------------

async function start() {
  try {
    const s = await api('GET', '/status');
    zustand.version = s.version;
    if (s.ersteinrichtung) return ersteinrichtung();
    if (!s.nutzer) return anmeldung();
    zustand.ich = s.nutzer;
    zustand.fahnas = s.fahnas || '';
    geruest();
    await baumLaden();
    route();
  } catch (e) {
    leeren(app, h('div', { class: 'mitte' }, h('div', { class: 'karte' }, h('h1', {}, 'FAH-Git'), h('p', {}, 'Der Server antwortet nicht: ', e.message))));
  }
}

window.addEventListener('fahgit:abgemeldet', () => { zustand.ich = null; anmeldung(); });

function anmeldeKarte(titel, untertitel, felder, knopf, aktion) {
  const fehler = h('div', { class: 'hinweisbox rot versteckt' });
  const form = h('form', { class: 'karte' },
    h('h1', {}, h('img', { src: '/static/symbol.svg', alt: '', width: 34, height: 34 }), titel),
    untertitel ? h('p', { class: 'untertitel', style: 'text-align:center' }, untertitel) : null,
    fehler, ...felder, h('button', { class: 'knopf haupt', type: 'submit', style: 'width:100%;justify-content:center' }, knopf));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    fehler.classList.add('versteckt');
    try { await aktion(); } catch (err) { fehler.textContent = err.message; fehler.classList.remove('versteckt'); }
  });
  leeren(app, h('div', { class: 'mitte' }, form));
  form.querySelector('input')?.focus();
}

function anmeldung() {
  const name = h('input', { type: 'text', autocomplete: 'username', required: true });
  const kennwort = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  anmeldeKarte('FAH-Git', 'Bitte anmelden', [feld('Benutzername', name), feld('Kennwort', kennwort)], 'Anmelden', async () => {
    await api('POST', '/anmelden', { name: name.value, kennwort: kennwort.value });
    start();
  });
}

function ersteinrichtung() {
  const name = h('input', { type: 'text', autocomplete: 'username', required: true, value: 'fabian' });
  const anzeige = h('input', { type: 'text', autocomplete: 'name', value: '' });
  const kennwort = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  anmeldeKarte('FAH-Git einrichten', 'Lege das erste Konto an. Es wird Administrator.', [
    feld('Benutzername', name, 'Damit meldest du dich an und pushst. Kleinbuchstaben, Ziffern, Punkt und Bindestrich.'),
    feld('Anzeigename', anzeige, 'So erscheinst du in der Aktivität. Leer lassen = Benutzername.'),
    feld('Kennwort', kennwort, 'Mindestens 8 Zeichen.'),
  ], 'Konto anlegen', async () => {
    await api('POST', '/ersteinrichtung', { name: name.value, anzeige: anzeige.value, kennwort: kennwort.value });
    meldung('Willkommen bei FAH-Git');
    start();
  });
}

// --- Gerüst ---------------------------------------------------------------------------------------------------------

function geruest() {
  suchfeld = h('input', { type: 'search', placeholder: 'Projekte und Ordner suchen …  ( / )', 'aria-label': 'Suchen', autocomplete: 'off' });
  const treffer = h('div', { class: 'suchtreffer versteckt', role: 'listbox' });
  const suche = h('div', { class: 'suche' }, sym('suche'), suchfeld, treffer);
  sucheEinrichten(suchfeld, treffer);
  const menueKnopf = h('button', { class: 'knopf nur-symbol menue-knopf', type: 'button', 'aria-label': 'Ordner anzeigen' }, sym('menue'));
  neuKnopf = h('button', { class: 'knopf haupt', type: 'button' }, sym('plus'), h('span', {}, 'Neu'));
  neuKnopf.addEventListener('click', () => menue(neuKnopf, [
    kannProjektAnlegen() ? { text: 'Neues Projekt', symbol: 'projekt', aktion: () => neuesProjekt(aktuellerOrdner()) } : null,
    kannOrdnerAnlegen() ? { text: 'Neuer Ordner', symbol: 'ordner', aktion: () => neuerOrdner(aktuellerOrdner()) } : null,
    ...(zustand.ich.admin ? ['trenner', { text: 'Aus GitLab oder Gitea übernehmen', symbol: 'import', href: '#/import' }] : []),
  ]));
  nutzerKnopf = h('button', { class: 'knopf nur-symbol konto-knopf', type: 'button', title: zustand.ich.anzeige, 'aria-label': 'Konto' });
  kopfBild();
  nutzerKnopf.addEventListener('click', () => menue(nutzerKnopf, [
    { text: `${zustand.ich.anzeige} (${zustand.ich.name})`, symbol: 'nutzer', href: '#/konto' },
    { text: 'Mein Konto & Zugangsschlüssel', symbol: 'schloss', href: '#/konto' },
    zustand.ich.admin ? { text: 'Benutzer verwalten', symbol: 'nutzer', href: '#/nutzer' } : null,
    zustand.ich.admin ? { text: 'Einstellungen', symbol: 'einstellungen', href: '#/einstellungen' } : null,
    zustand.ich.admin ? { text: 'Sicherung', symbol: 'schild', href: '#/sicherung' } : null,
    'trenner',
    // Nach dem Abmelden zur Übersicht: der nächste Nutzer soll nicht auf einer Seite landen, die er nicht sehen darf.
    { text: 'Abmelden', aktion: async () => { await api('POST', '/abmelden').catch(() => {}); zustand.ich = null; history.replaceState(null, '', '#/'); anmeldung(); } },
  ]));
  seite = h('nav', { class: 'seite', 'aria-label': 'Ordner' });
  inhalt = h('main', { class: 'inhalt', id: 'inhalt' });
  menueKnopf.addEventListener('click', () => seite.classList.toggle('offen'));
  leeren(app,
    h('header', { class: 'kopf' }, menueKnopf, h('a', { href: '#/', class: 'marke' }, h('img', { src: '/static/symbol.svg', alt: '' }), h('span', {}, 'FAH-Git')),
      suche, h('div', { class: 'kopf-rechts' }, neuKnopf, nutzerKnopf)),
    h('div', { class: 'rahmen' }, seite, leistenGriff(), inhalt));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) { e.preventDefault(); suchfeld.focus(); }
  });
}

/** Konto-Knopf oben rechts: Profilbild oder Anfangsbuchstabe (nach Hochladen/Entfernen neu). */
function kopfBild() {
  if (!nutzerKnopf || !zustand.ich) return;
  nutzerKnopf.title = zustand.ich.anzeige;
  leeren(nutzerKnopf, profilbild(zustand.ich));
}

// Breite der Seitenleiste per Ziehen am rechten Rand (gemerkt im Browser), Doppelklick = Standard
const BREITE_SCHLUESSEL = 'fahgit.seitenbreite';
const BREITE_STANDARD = 280;
const BREITE_MIN = 200;
const breiteMax = () => Math.max(BREITE_MIN, Math.min(640, Math.round(window.innerWidth * 0.5)));

function breiteSetzen(px, merken) {
  const b = Math.round(Math.min(breiteMax(), Math.max(BREITE_MIN, px)));
  document.documentElement.style.setProperty('--seite', `${b}px`);
  if (merken) { try { localStorage.setItem(BREITE_SCHLUESSEL, String(b)); } catch { /* egal */ } }
  return b;
}

function leistenGriff() {
  try {
    const gemerkt = Number(localStorage.getItem(BREITE_SCHLUESSEL));
    if (gemerkt) breiteSetzen(gemerkt, false);
  } catch { /* egal */ }
  const griff = h('div', {
    class: 'leisten-griff', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
    'aria-label': 'Breite der Seitenleiste', title: 'Ziehen ändert die Breite der Seitenleiste. Doppelklick: Standardbreite.',
  });
  const aktuell = () => seite.getBoundingClientRect().width;
  griff.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    griff.setPointerCapture(e.pointerId);
    const start = e.clientX; const breite = aktuell();
    document.body.classList.add('zieht-breite');
    const bewegen = (ev) => breiteSetzen(breite + ev.clientX - start, false);
    const los = (ev) => {
      griff.removeEventListener('pointermove', bewegen);
      griff.removeEventListener('pointerup', los);
      griff.removeEventListener('pointercancel', los);
      document.body.classList.remove('zieht-breite');
      breiteSetzen(breite + ev.clientX - start, true);
    };
    griff.addEventListener('pointermove', bewegen);
    griff.addEventListener('pointerup', los);
    griff.addEventListener('pointercancel', los);
  });
  griff.addEventListener('dblclick', () => breiteSetzen(BREITE_STANDARD, true));
  griff.addEventListener('keydown', (e) => {
    const schritt = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') breiteSetzen(aktuell() - schritt, true);
    else if (e.key === 'ArrowRight') breiteSetzen(aktuell() + schritt, true);
    else if (e.key === 'Home') breiteSetzen(BREITE_STANDARD, true);
    else return;
    e.preventDefault();
  });
  // Fenster kleiner gezogen: Leiste nicht breiter als die Hälfte lassen
  window.addEventListener('resize', () => {
    if (aktuell() > breiteMax()) breiteSetzen(breiteMax(), false);
  });
  return griff;
}

async function baumLaden() {
  zustand.baum = await api('GET', '/baum');
  seiteZeichnen();
}

function aktuellerPfad() {
  const r = routeLesen();
  return r.art === 'ordner' || r.art === 'projekt' ? r.pfad : r.art === 'uebersicht' ? '' : null;
}

function aktuellerOrdner() {
  const r = routeLesen();
  if (r.art === 'ordner') return r.pfad;
  if (r.art === 'projekt') return r.pfad.split('/').slice(0, -1).join('/');
  return '';
}

function seiteZeichnen() {
  if (!seite || !zustand.baum) return;
  neuKnopf?.classList.toggle('versteckt', !(zustand.ich.admin || kannProjektAnlegen() || kannOrdnerAnlegen()));
  const unten = h('div', { class: 'seite-unten' },
    zustand.ich.admin ? h('a', { href: '#/import' }, sym('import'), 'Übernehmen (GitLab/Gitea)') : null,
    h('a', { href: '#/konto' }, sym('schloss'), 'Zugangsschlüssel'),
    h('div', { class: 'schwach klein', style: 'padding:6px 8px' }, `FAH-Git ${zustand.version}`));
  leeren(seite, seitenbaum(zustand.baum, aktuellerPfad(), async (alt, neu) => {
    if (alt) {
      await baumLaden();
      const r = routeLesen();
      if ((r.art === 'projekt' || r.art === 'ordner') && (r.pfad === alt || r.pfad.startsWith(alt + '/'))) {
        location.hash = location.hash.replace(`/${alt}`, `/${neu}`);
        return;
      }
      route();
    } else seiteZeichnen();
  }, { ziehen: !!zustand.ich.admin }), unten);
}

function sucheEinrichten(eingabe, treffer) {
  let auswahl = 0; let liste = [];
  const zeigen = () => {
    const t = eingabe.value.trim().toLowerCase();
    if (!t || !zustand.baum) { treffer.classList.add('versteckt'); return; }
    const { ordner, projekte } = flach(zustand.baum);
    const passt = (x) => `${x.name} ${x.pfad} ${x.beschreibung || ''}`.toLowerCase().includes(t);
    liste = [...projekte.filter(passt).map((p) => ({ ...p, art: 'projekt' })), ...ordner.filter(passt).map((o) => ({ ...o, art: 'ordner' }))].slice(0, 12);
    auswahl = 0;
    leeren(treffer, liste.length ? liste.map((x, i) => h('a', { href: x.art === 'projekt' ? projektUrl(x.pfad) : ordnerUrl(x.pfad), class: i === 0 ? 'aktiv' : '', role: 'option' },
      sym(x.art === 'projekt' ? 'projekt' : 'ordner'), h('span', {}, h('div', {}, x.name), h('div', { class: 'schwach klein' }, x.kette.join(' › ') || 'ganz oben'))))
      : h('div', { class: 'leer-hinweis' }, 'Nichts gefunden'));
    treffer.classList.remove('versteckt');
  };
  eingabe.addEventListener('input', zeigen);
  eingabe.addEventListener('focus', zeigen);
  eingabe.addEventListener('blur', () => setTimeout(() => treffer.classList.add('versteckt'), 150));
  eingabe.addEventListener('keydown', (e) => {
    const links = [...treffer.querySelectorAll('a')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      auswahl = (auswahl + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % Math.max(1, links.length);
      links.forEach((a, i) => a.classList.toggle('aktiv', i === auswahl));
    } else if (e.key === 'Enter' && links[auswahl]) {
      e.preventDefault(); location.hash = links[auswahl].getAttribute('href'); eingabe.value = ''; treffer.classList.add('versteckt'); eingabe.blur();
    } else if (e.key === 'Escape') { eingabe.value = ''; treffer.classList.add('versteckt'); eingabe.blur(); }
  });
  treffer.addEventListener('mousedown', (e) => { if (e.target.closest('a')) { eingabe.value = ''; } });
}

// --- Navigation ----------------------------------------------------------------------------------------------------

function routeLesen() {
  const roh = decodeURI(location.hash.replace(/^#/, '')) || '/';
  const [weg, suchteil] = roh.split('?');
  const params = Object.fromEntries(new URLSearchParams(suchteil || ''));
  let m;
  if (weg === '/' || weg === '') return { art: 'uebersicht', params };
  if ((m = /^\/o\/(.+?)\/?$/.exec(weg))) return { art: 'ordner', pfad: m[1], params };
  if ((m = /^\/p\/(.+?)(?:\/-\/([a-z]+))?\/?$/.exec(weg))) return { art: 'projekt', pfad: m[1], ansicht: m[2] || 'dateien', params };
  if ((m = /^\/(konto|nutzer|einstellungen|import|sicherung)\/?$/.exec(weg))) return { art: m[1], params };
  return { art: 'unbekannt', params };
}

let lauf = 0;
async function route() {
  if (!zustand.ich) return;
  const nr = ++lauf;
  const r = routeLesen();
  seite?.classList.remove('offen');
  seiteZeichnen();
  leeren(inhalt, h('div', { class: 'laedt' }, 'Lädt …'));
  const ctx = { zustand, baumLaden, neuesProjekt, neuerOrdner, istAktuell: () => nr === lauf };
  try {
    let el;
    if (r.art === 'uebersicht') el = await uebersicht();
    else if (r.art === 'ordner') el = await ordnerSeite(r.pfad);
    else if (r.art === 'projekt') { aufklappen(r.pfad.split('/').slice(0, -1).join('/')); el = await projektSeite(r, ctx); }
    else if (r.art === 'konto') el = await kontoSeite();
    else if (r.art === 'nutzer') el = await nutzerSeite();
    else if (r.art === 'einstellungen') el = await einstellungenSeite();
    else if (r.art === 'sicherung') el = await sicherungSeite();
    else if (r.art === 'import') el = await importSeite();
    else el = h('div', { class: 'leer-hinweis' }, 'Diese Seite gibt es nicht. ', h('a', { href: '#/' }, 'Zur Übersicht'));
    if (nr !== lauf) return;
    leeren(inhalt, el);
    if (r.art === 'projekt' || r.art === 'ordner') seiteZeichnen();
    window.scrollTo(0, 0);
  } catch (e) {
    if (nr !== lauf) return;
    leeren(inhalt, h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {}, e.message, ' ', h('a', { href: '#/' }, 'Zur Übersicht'))));
  }
}
window.addEventListener('hashchange', route);

/** Nach Ziehen und Ablegen in der großen Liste: Baum neu laden, Seite neu zeichnen. */
async function nachDemZiehen() { await baumLaden(); route(); }

// --- Übersicht --------------------------------------------------------------------------------------------------------

function ereignisText(e) {
  const projekt = e.projekt ? h('a', { href: e.art === 'ordner' ? ordnerUrl(e.projekt) : projektUrl(e.projekt) }, e.projekt) : null;
  const wer = h('strong', {}, e.anzeige || e.nutzer || 'System');
  if (e.art === 'push') {
    const z = (e.zweige || []).map((x) => x.art === 'geloescht' ? `Zweig ${x.name} gelöscht`
      : `${x.name}${x.anzahl != null ? ` (+${x.anzahl})` : ' (neu)'}${x.betreff ? ` – „${x.betreff}“` : ''}`);
    const t = (e.tags || []).length ? [`Tag ${e.tags.join(', ')}`] : [];
    return [wer, ' hat nach ', projekt, ' gepusht: ', [...z, ...t].join('; ')];
  }
  if (e.art === 'spiegel') return [h('span', { class: `marker ${e.ergebnis === 'fehler' ? 'rot' : 'warn'}` }, 'Spiegel'), ' ', projekt, ': ', e.text];
  if (e.art === 'quelle') return [h('span', { class: 'marker rot' }, 'Kopie'), ' ', projekt, ': ', e.text];
  if (e.art === 'import') return [wer, ' – ', e.text];
  if (e.art === 'verschoben') {
    const ziel = e.projekt ? h('a', { href: e.ordner ? ordnerUrl(e.projekt) : projektUrl(e.projekt) }, e.projekt) : null;
    return [wer, ' hat ', h('code', {}, e.alt || '?'), ' verschoben nach ', ziel];
  }
  return [wer, ' – ', e.text || e.art, ' ', projekt];
}

export function aktivitaetListe(liste) {
  if (!liste.length) return h('div', { class: 'leer-hinweis' }, 'Noch nichts passiert.');
  return h('div', {}, liste.map((e) => h('div', { class: 'ereignis' },
    profilbild({ name: e.nutzer, anzeige: e.anzeige || e.nutzer, bild: e.bild }, 'kreis'),
    h('div', {}, h('div', { class: 'was' }, ereignisText(e)), h('div', { class: 'wann', title: datumZeit(e.zeit) }, vorZeit(e.zeit))))));
}

async function uebersicht() {
  const [u] = await Promise.all([api('GET', '/uebersicht'), baumLaden()]);
  const probleme = u.spiegel.filter((s) => s.aktiv && s.zuletzt && s.zuletzt.ergebnis !== 'ok');
  const listenKarte = h('div', { class: 'karte' });
  const admin = !!zustand.ich.admin;
  const listeZeichnen = () => leeren(listenKarte,
    h('div', { class: 'karten-kopf' }, h('h2', {}, admin ? 'Alle Projekte' : 'Deine Projekte'),
      h('div', { class: 'zeile' },
        admin ? h('span', { class: 'schwach klein', title: 'Projekte und Ordner auf einen Ordner ziehen, um sie zu verschieben' }, 'Ziehen zum Verschieben') : null,
        admin ? h('button', { class: 'knopf klein', type: 'button', onclick: () => neuerOrdner('') }, sym('ordner'), 'Ordner') : null,
        kannProjektAnlegen() ? h('button', { class: 'knopf klein', type: 'button', onclick: () => neuesProjekt('') }, sym('plus'), 'Projekt') : null)),
    zustand.baum.ordner.length + zustand.baum.projekte.length ? grosseListe(zustand.baum, listeZeichnen, admin ? nachDemZiehen : null)
      : admin ? h('div', { class: 'leer-hinweis' }, 'Noch keine Projekte. ', h('a', { href: '#/import' }, 'Aus GitLab oder Gitea übernehmen'), ' oder oben auf „Neu“.')
        : h('div', { class: 'leer-hinweis' }, sym('schloss'), ' Noch keine Projekte freigegeben – bitte einen Admin fragen.'));
  listeZeichnen();
  const spiegelKarte = u.spiegel.length ? h('div', { class: 'karte abschnitt' },
    h('div', { class: 'karten-kopf' }, h('h3', {}, 'Spiegel'), h('span', { class: 'schwach klein' }, `${u.spiegel.length} eingerichtet`)),
    h('div', {}, u.spiegel.slice().sort((a, b) => (b.zuletzt?.ergebnis !== 'ok') - (a.zuletzt?.ergebnis !== 'ok')).slice(0, 8).map((s) => h('div', { class: 'ereignis' },
      h('span', { style: 'display:flex;align-items:center;justify-content:center' }, h('span', { class: `zustand-punkt ${!s.aktiv ? 'aus' : s.zuletzt ? s.zuletzt.ergebnis : 'aus'}` })),
      h('div', {}, h('div', { class: 'was' }, h('a', { href: projektUrl(s.projekt, '/-/spiegel') }, s.name), s.art === 'quelle' ? ' ← ' : ' → ', h('span', { class: 'schwach' }, s.repo ? `GitHub ${s.repo}` : new URL(s.url).host)),
        h('div', { class: 'wann' }, s.zuletzt ? `${s.zuletzt.text} · ${vorZeit(s.zuletzt.zeit)}` : 'noch nicht gelaufen')))))) : null;
  return h('div', {},
    h('h1', {}, 'Übersicht'),
    h('p', { class: 'untertitel' }, `Angemeldet als ${zustand.ich.anzeige}`),
    h('div', { class: 'kacheln' },
      h('div', { class: 'karte kachel' }, h('span', { class: 'titel' }, sym('projekt'), 'Projekte'), h('span', { class: 'wert' }, u.projekte)),
      h('div', { class: 'karte kachel' }, h('span', { class: 'titel' }, sym('ordner'), 'Ordner'), h('span', { class: 'wert' }, u.ordner)),
      h('a', { href: '#/', class: `karte kachel ${u.spiegel.length ? (probleme.length ? 'schlecht' : 'gut') : ''}`, style: 'color:inherit;text-decoration:none' },
        h('span', { class: 'titel' }, sym('spiegel'), 'Spiegel'),
        h('span', { class: 'wert' }, u.spiegel.length ? (probleme.length ? `${probleme.length} Problem${probleme.length > 1 ? 'e' : ''}` : 'alles ok') : '–')),
      h('div', { class: 'karte kachel' }, h('span', { class: 'titel' }, sym('laden'), 'Speicher frei'), h('span', { class: 'wert' }, u.frei != null ? groesse(u.frei) : '–')),
      u.sicherung ? h('a', { href: '#/sicherung', class: `karte kachel ${u.sicherung.letzte ? 'gut' : 'schlecht'}`, style: 'color:inherit;text-decoration:none' },
        h('span', { class: 'titel' }, sym('schild'), 'Sicherung'),
        h('span', { class: 'wert', title: u.sicherung.letzte ? datumZeit(u.sicherung.letzte.erstellt) : '' },
          u.sicherung.laeuft ? `läuft${u.sicherung.prozent == null ? '' : ` · ${u.sicherung.prozent} %`}` : u.sicherung.letzte ? vorZeit(u.sicherung.letzte.erstellt) : (u.sicherung.auto ? 'läuft an' : 'keine'))) : null,
      u.github && (u.github.eingerichtet || u.github.anzahl) ? h('a', { href: '#/einstellungen', class: `karte kachel ${u.github.eingerichtet ? '' : 'schlecht'}`, style: 'color:inherit;text-decoration:none', title: u.github.konto ? `Konto ${u.github.konto}` : '' },
        h('span', { class: 'titel' }, sym('spiegel'), 'GitHub'),
        h('span', { class: 'wert' }, !u.github.eingerichtet ? 'Token fehlt' : `${u.github.anzahl} Projekt${u.github.anzahl === 1 ? '' : 'e'}`)) : null),
    h('div', { class: 'spalten' }, listenKarte,
      h('div', {}, spiegelKarte,
        u.zuletzt.length ? h('div', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h3', {}, 'Zuletzt geändert')),
          h('div', {}, u.zuletzt.map((p) => h('a', { href: projektUrl(p.pfad), class: 'listen-zeile', style: 'grid-template-columns:28px minmax(0,1fr) auto' },
            h('span', { class: 'gross-symbol projekt' }, initiale(p.name)), h('span', { class: 'titel' }, p.name), h('span', { class: 'rechts' }, vorZeit(p.zuletzt)))))) : null,
        h('div', { class: 'karte' }, h('div', { class: 'karten-kopf' }, h('h3', {}, 'Aktivität')), aktivitaetListe(u.aktivitaet)))));
}

// --- Ordner ---------------------------------------------------------------------------------------------------------

export function pfadleiste(pfad, { mitLetztem = false } = {}) {
  const t = pfad ? pfad.split('/') : [];
  const leiste = h('div', { class: 'pfadleiste' }, h('a', { href: '#/' }, 'Alle Projekte'));
  for (let i = 0; i < t.length - (mitLetztem ? 0 : 1); i++) {
    const p = t.slice(0, i + 1).join('/');
    const o = finde(zustand.baum, p);
    leiste.append(sym('pfeil'), h('a', { href: ordnerUrl(p) }, o ? o.name : t[i]));
  }
  return leiste;
}

async function ordnerSeite(pfad) {
  await baumLaden();
  const o = finde(zustand.baum, pfad);
  if (!o) throw new Error('Diesen Ordner gibt es nicht (mehr).');
  aufklappen(pfad);
  const admin = !!zustand.ich.admin;
  const mehr = h('button', { class: 'knopf nur-symbol', type: 'button', 'aria-label': 'Weitere Aktionen' }, sym('mehr'));
  mehr.addEventListener('click', () => menue(mehr, [
    { text: 'Umbenennen / Beschreibung', symbol: 'einstellungen', aktion: () => ordnerAendern(o) },
    { text: 'Verschieben', symbol: 'spiegel', aktion: () => verschiebenDialog(o.pfad, 'ordner') },
    'trenner',
    { text: 'Ordner löschen', gefahr: true, aktion: async () => {
      if (!(await bestaetigen('Ordner löschen', `„${o.name}“ wird gelöscht. Das geht nur, wenn er leer ist.`))) return;
      try { await api('DELETE', `/ordner?${q({ pfad: o.pfad })}`); meldung('Ordner gelöscht'); await baumLaden(); location.hash = ordnerUrlOderStart(o.pfad); } catch (e) { fehlerMelden(e); }
    } },
  ]));
  const karte = h('div', { class: 'karte' });
  const zeichnen = () => leeren(karte, o.ordner.length + o.projekte.length ? grosseListe(o, zeichnen, admin ? nachDemZiehen : null)
    : h('div', { class: 'leer-hinweis' }, admin ? 'Dieser Ordner ist leer. Lege ein Projekt an oder zieh eins aus der Seitenleiste hierher.' : 'Dieser Ordner ist leer.'));
  zeichnen();
  return h('div', {},
    pfadleiste(pfad),
    h('div', { class: 'kopfzeile' },
      h('div', {}, h('h1', {}, sym('ordner-offen'), o.name), o.beschreibung ? h('p', { class: 'untertitel' }, o.beschreibung)
        : h('p', { class: 'untertitel' }, o.weg ? 'Nur der Weg zu deinen freigegebenen Projekten' : `${zaehle(o)} Projekte`)),
      h('div', { class: 'zeile' },
        darfOrdnerIn(pfad) ? h('button', { class: 'knopf', type: 'button', onclick: () => neuerOrdner(pfad) }, sym('ordner'), 'Unterordner') : null,
        darfSchreiben(pfad) ? h('button', { class: 'knopf haupt', type: 'button', onclick: () => neuesProjekt(pfad) }, sym('plus'), 'Neues Projekt') : null,
        admin ? mehr : null)),
    karte);
}

function ordnerUrlOderStart(pfad) {
  const eltern = pfad.split('/').slice(0, -1).join('/');
  return eltern ? ordnerUrl(eltern) : '#/';
}

async function ordnerAendern(o) {
  const name = h('input', { type: 'text', value: o.name, required: true });
  const beschreibung = h('textarea', {}, o.beschreibung || '');
  await dialog('Ordner bearbeiten', h('div', {}, feld('Name', name, 'So heißt der Ordner in der Ansicht. Die Adresse bleibt gleich.'), feld('Beschreibung', beschreibung)),
    [{ text: 'Abbrechen' }, { text: 'Speichern', art: 'haupt', aktion: async () => { await api('PATCH', '/ordner', { pfad: o.pfad, name: name.value, beschreibung: beschreibung.value }); meldung('Gespeichert'); route(); } }]);
}

export async function verschiebenDialog(pfad, art) {
  const ziel = ordnerAuswahl(zustand.baum, pfad.split('/').slice(0, -1).join('/'), { ohne: art === 'ordner' ? pfad : null });
  const kurz = h('input', { type: 'text', value: pfad.split('/').pop(), pattern: '[a-z0-9][a-z0-9._-]*' });
  const r = await dialog(art === 'ordner' ? 'Ordner verschieben' : 'Projekt verschieben', h('div', {},
    feld('Zielordner', ziel, 'Wohin es kommt. Tipp: In der Seitenleiste geht das auch per Ziehen und Ablegen.'),
    feld('Kurzname in der Adresse', kurz, 'Teil der Klon-Adresse. Alte Adressen funktionieren nach dem Verschieben weiter.')),
  [{ text: 'Abbrechen' }, { text: 'Verschieben', art: 'haupt', aktion: () => api('POST', '/verschieben', { pfad, ziel: ziel.value, slug: kurz.value }) }]);
  if (!r) return;
  meldung('Verschoben');
  aufklappen(ziel.value);
  await baumLaden();
  location.hash = art === 'ordner' ? ordnerUrl(r.pfad) : projektUrl(r.pfad);
}

async function neuerOrdner(eltern) {
  await baumLaden();
  const wo = ordnerAuswahl(zustand.baum, eltern || '', { nur: darfOrdnerIn });
  const name = h('input', { type: 'text', required: true, placeholder: 'z. B. Docker' });
  const beschreibung = h('textarea', { placeholder: 'optional' });
  const r = await dialog('Neuer Ordner', h('div', {}, feld('Liegt in', wo), feld('Name', name, 'Ordner sortieren deine Projekte – beliebig tief verschachtelbar.'), feld('Beschreibung', beschreibung)),
    [{ text: 'Abbrechen' }, { text: 'Anlegen', art: 'haupt', aktion: () => api('POST', '/ordner', { eltern: wo.value, name: name.value, beschreibung: beschreibung.value }) }]);
  if (!r) return;
  aufklappen(r.pfad);
  await baumLaden();
  location.hash = ordnerUrl(r.pfad);
}

async function neuesProjekt(ordner) {
  await baumLaden();
  const wo = ordnerAuswahl(zustand.baum, ordner || '', { nur: darfSchreiben });
  const name = h('input', { type: 'text', required: true, placeholder: 'z. B. fah-musik' });
  const beschreibung = h('textarea', { placeholder: 'optional' });
  const readme = h('input', { type: 'checkbox', checked: true });
  const r = await dialog('Neues Projekt', h('div', {},
    feld('Ordner', wo), feld('Name', name, 'Aus dem Namen wird die Klon-Adresse (Kleinbuchstaben, Bindestriche).'), feld('Beschreibung', beschreibung),
    h('label', { class: 'haken' }, readme, h('span', {}, h('div', {}, 'Mit README anlegen'),
      info('Das Projekt startet mit einer README-Datei und lässt sich sofort klonen. Ohne Haken bleibt es leer – richtig, wenn du einen vorhandenen Ordner hochschieben willst.')))),
  [{ text: 'Abbrechen' }, { text: 'Anlegen', art: 'haupt', aktion: () => api('POST', '/projekte', { ordner: wo.value, name: name.value, beschreibung: beschreibung.value, readme: readme.checked }) }]);
  if (!r) return;
  aufklappen(wo.value);
  await baumLaden();
  location.hash = projektUrl(r.pfad);
}

// --- Konto -----------------------------------------------------------------------------------------------------------

async function kontoSeite() {
  const k = await api('GET', '/konto');
  const anzeige = h('input', { type: 'text', value: k.anzeige });
  const alt = h('input', { type: 'password', autocomplete: 'current-password' });
  const neu = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const titelBild = h('span', { class: 'titel-bild' });

  // Profilbild (26.10.2026): im Browser mittig quadratisch zugeschnitten, 256 × 256, als WebP/PNG hochgeladen.
  const bildKarte = h('div', { class: 'karte abschnitt' });
  const bildWahl = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/*', hidden: true, 'aria-label': 'Profilbild wählen' });
  const bildNeu = () => { leeren(titelBild, profilbild(zustand.ich, 'titel')); kopfBild(); bildZeichnen(); };
  bildWahl.addEventListener('change', async () => {
    const datei = bildWahl.files[0]; bildWahl.value = '';
    if (!datei) return;
    try {
      const blob = await profilbildVorbereiten(datei);
      const r = await api('PUT', '/konto/bild', blob);
      zustand.ich.bild = r.bild; meldung('Profilbild gespeichert'); bildNeu();
    } catch (err) { fehlerMelden(err); }
  });
  const bildZeichnen = () => leeren(bildKarte,
    h('div', { class: 'karten-kopf' }, h('h2', {}, 'Profilbild')),
    h('div', { class: 'karten-inhalt profilbild-zeile' }, profilbild(zustand.ich, 'gross'),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'zeile', style: 'margin-bottom:8px' },
          h('button', { class: 'knopf haupt', type: 'button', onclick: () => bildWahl.click() }, sym('bild'), zustand.ich.bild ? 'Anderes Bild …' : 'Bild hochladen …'),
          zustand.ich.bild ? h('button', { class: 'knopf', type: 'button', onclick: async () => {
            try { await api('DELETE', '/konto/bild'); zustand.ich.bild = null; meldung('Profilbild entfernt'); bildNeu(); } catch (err) { fehlerMelden(err); }
          } }, 'Entfernen') : null),
        info('Erscheint oben rechts, in der Aktivität und in der Benutzerliste. Das Bild wird mittig quadratisch zugeschnitten und auf 256 × 256 Pixel verkleinert – ohne Bild steht dein Anfangsbuchstabe da.'))),
    bildWahl);
  bildZeichnen();
  leeren(titelBild, profilbild(zustand.ich, 'titel'));

  const schluesselKarte = h('div', { class: 'karte abschnitt' });
  const rechtMarke = (s) => (s.recht === 'lesen'
    ? h('span', { class: 'marker grau', title: 'Nur klonen, holen und abfragen – Pushen und Änderungen werden abgewiesen' }, sym('schloss'), 'Nur lesen')
    : h('span', { class: 'marker', title: 'Klonen, pushen und über die Schnittstelle ändern' }, 'Lesen und schreiben'));
  const schluesselZeichnen = (liste) => leeren(schluesselKarte,
    h('div', { class: 'karten-kopf' }, h('h2', {}, 'Zugangsschlüssel'), h('button', { class: 'knopf haupt klein', type: 'button', onclick: neuerSchluessel }, sym('plus'), 'Neuer Schlüssel')),
    h('div', { class: 'karten-inhalt' }, info('Für git und Skripte statt deines Kennworts: Beim Klonen oder Pushen als Kennwort eingeben (Benutzername beliebig, z. B. dein eigener). Jeder Schlüssel lässt sich einzeln widerrufen.')),
    liste.length ? h('table', { class: 'tabelle' }, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Recht'), h('th', {}, 'Beginnt mit'), h('th', {}, 'Erstellt'), h('th', {}, 'Zuletzt benutzt'), h('th', {})),
      liste.map((s) => h('tr', {}, h('td', {}, s.name), h('td', {}, rechtMarke(s)), h('td', { class: 'mono' }, `${s.anfang}…`), h('td', {}, datumZeit(s.erstellt)), h('td', {}, s.zuletzt ? vorZeit(s.zuletzt) : 'noch nie'),
        h('td', { style: 'text-align:right' }, h('button', { class: 'knopf klein gefahr', type: 'button', onclick: async () => {
          if (!(await bestaetigen('Schlüssel widerrufen', `„${s.name}“ funktioniert danach nicht mehr.`, 'Widerrufen'))) return;
          await api('DELETE', `/konto/schluessel?${q({ id: s.id })}`); meldung('Widerrufen'); schluesselZeichnen((await api('GET', '/konto')).schluessel);
        } }, 'Widerrufen')))))
      : h('div', { class: 'leer-hinweis' }, 'Noch keine Schlüssel.'));
  async function neuerSchluessel() {
    const name = h('input', { type: 'text', value: 'Mac', required: true });
    const recht2 = h('select', {}, h('option', { value: 'schreiben', selected: true }, 'Lesen und schreiben'), h('option', { value: 'lesen' }, 'Nur lesen (z. B. für FAH-NAS)'));
    const s = await dialog('Neuer Zugangsschlüssel', h('div', {}, feld('Wofür?', name, 'Ein Name zum Wiedererkennen, z. B. „Mac“, „Bau-PC“ oder „FAH-NAS“.'),
      feld('Recht', recht2, 'Nur lesen: klonen, holen und abfragen – Pushen und jede Änderung werden abgewiesen. Richtig für FAH-NAS und Bau-Rechner.')),
    [{ text: 'Abbrechen' }, { text: 'Erstellen', art: 'haupt', aktion: () => api('POST', '/konto/schluessel', { name: name.value, recht: recht2.value }) }]);
    if (!s) return;
    const feldS = h('input', { type: 'text', value: s.geheim, readonly: true });
    await dialog('Schlüssel erstellt', h('div', {},
      h('div', { class: 'hinweisbox warn' }, sym('warnung'), h('div', {}, 'Jetzt kopieren – der Schlüssel wird nur dieses eine Mal angezeigt.')),
      h('div', { class: 'klonfeld abschnitt' }, feldS, h('button', { class: 'knopf', type: 'button', onclick: () => kopieren(s.geheim) }, sym('kopieren'), 'Kopieren')),
      h('div', { class: 'zeile' }, 'Recht: ', rechtMarke(s))),
    [{ text: 'Fertig', art: 'haupt', aktion: () => true }]);
    schluesselZeichnen((await api('GET', '/konto')).schluessel);
  }
  schluesselZeichnen(k.schluessel);
  const formKonto = h('form', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h2', {}, 'Profil')),
    h('div', { class: 'karten-inhalt' }, feld('Benutzername', h('input', { type: 'text', value: k.name, readonly: true }), 'Ändern kann ihn ein Administrator unter „Benutzer verwalten“.'),
      feld('Anzeigename', anzeige, 'So erscheinst du in der Aktivität.'), h('button', { class: 'knopf haupt', type: 'submit' }, 'Speichern')));
  formKonto.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('PATCH', '/konto', { anzeige: anzeige.value }); meldung('Gespeichert'); zustand.ich.anzeige = anzeige.value; kopfBild(); } catch (err) { fehlerMelden(err); } });
  const formKw = h('form', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h2', {}, 'Kennwort ändern')),
    h('div', { class: 'karten-inhalt' }, feld('Bisheriges Kennwort', alt), feld('Neues Kennwort', neu, 'Mindestens 8 Zeichen. Andere angemeldete Geräte werden dabei abgemeldet.'),
      h('button', { class: 'knopf haupt', type: 'submit' }, 'Kennwort ändern')));
  formKw.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/konto/kennwort', { alt: alt.value, neu: neu.value }); alt.value = ''; neu.value = ''; meldung('Kennwort geändert'); } catch (err) { fehlerMelden(err); } });
  const freigaben = (k.freigaben || []).length;
  return h('div', {}, h('h1', {}, titelBild, 'Mein Konto'),
    h('p', { class: 'untertitel' }, k.admin ? 'Administrator' : `Benutzer · ${freigaben ? `${freigaben} Freigabe${freigaben === 1 ? '' : 'n'}` : 'noch keine Projekte freigegeben'}`),
    bildKarte, schluesselKarte, formKonto, formKw);
}

// --- Verwaltung (nur Administratoren) -----------------------------------------------------------------------------

/** Anzeigename eines Pfads in Freigaben: „Ordner › Unterordner › Projekt“; '' = alles. */
function pfadName(pfad) {
  if (!pfad) return 'Alles';
  const { ordner, projekte } = flach(zustand.baum);
  const o = ordner.find((x) => x.pfad === pfad);
  if (o) return o.kette.join(' › ');
  const p = projekte.find((x) => x.pfad === pfad);
  return p ? [...p.kette, p.name].join(' › ') : pfad;
}

async function rechteDialog(n) {
  const liste = (n.freigaben || []).map((f) => ({ ...f }));
  const { ordner, projekte } = flach(zustand.baum);
  const wahl = h('select', { 'aria-label': 'Ordner oder Projekt', style: 'flex:1;min-width:0' },
    h('option', { value: '' }, 'Alles (jeder Ordner, jedes Projekt)'),
    ordner.length ? h('optgroup', { label: 'Ordner' }, ordner.map((o) => h('option', { value: o.pfad }, o.kette.join(' › ')))) : null,
    projekte.length ? h('optgroup', { label: 'Projekte' }, projekte.map((p) => h('option', { value: p.pfad }, [...p.kette, p.name].join(' › ')))) : null);
  wahl.value = ordner[0] ? ordner[0].pfad : '';
  const wahlRecht = () => h('select', { 'aria-label': 'Recht' }, h('option', { value: 'lesen' }, 'Lesen'), h('option', { value: 'schreiben' }, 'Lesen und schreiben'));
  const neuRecht = wahlRecht();
  const tabelle = h('div', { class: 'abschnitt' });
  const zeichnen = () => leeren(tabelle, liste.length
    ? h('table', { class: 'tabelle' }, h('tr', {}, h('th', {}, 'Ordner oder Projekt'), h('th', {}, 'Recht'), h('th', {})),
      liste.map((f, i) => {
        const r = wahlRecht(); r.value = f.recht;
        r.addEventListener('change', () => { f.recht = r.value; });
        return h('tr', {}, h('td', { style: 'overflow-wrap:anywhere' }, sym(!f.pfad ? 'ordner-offen' : projekte.some((p) => p.pfad === f.pfad) ? 'projekt' : 'ordner'), ' ', pfadName(f.pfad)),
          h('td', {}, r),
          h('td', { style: 'text-align:right' }, h('button', { class: 'knopf klein gefahr', type: 'button', onclick: () => { liste.splice(i, 1); zeichnen(); } }, 'Entfernen')));
      }))
    : h('div', { class: 'leer-hinweis' }, 'Keine Freigaben – sieht nichts.'));
  zeichnen();
  const dazu = h('button', { class: 'knopf', type: 'button', onclick: () => {
    const da = liste.find((f) => f.pfad === wahl.value);
    if (da) da.recht = neuRecht.value; else liste.push({ pfad: wahl.value, recht: neuRecht.value });
    zeichnen();
  } }, sym('plus'), 'Hinzufügen');
  const r = await dialog(`Rechte von ${n.anzeige}`, h('div', {},
    info('Eine Freigabe gilt für den Ordner bzw. das Projekt und alles darunter; das stärkste passende Recht zählt. Ohne Freigabe sieht der Benutzer nichts – Administratoren dürfen ohnehin alles.'),
    tabelle,
    h('div', { class: 'feld' }, h('label', {}, 'Neue Freigabe'), h('div', { class: 'zeile freigabe-neu' }, wahl, neuRecht, dazu))),
  [{ text: 'Abbrechen' }, { text: 'Speichern', art: 'haupt', aktion: () => api('PATCH', '/nutzer', { name: n.name, freigaben: liste }) }]);
  if (r) { meldung('Rechte gespeichert'); route(); }
}

async function nutzerSeite() {
  const [liste] = await Promise.all([api('GET', '/nutzer'), baumLaden()]);
  const neu = async () => {
    const name = h('input', { type: 'text', required: true });
    const anzeige = h('input', { type: 'text' });
    const kennwort = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const admin = h('input', { type: 'checkbox' });
    const r = await dialog('Neuer Benutzer', h('div', {}, feld('Benutzername', name), feld('Anzeigename', anzeige), feld('Kennwort', kennwort, 'Mindestens 8 Zeichen; der Benutzer kann es danach selbst ändern.'),
      h('label', { class: 'haken' }, admin, h('span', {}, h('div', {}, 'Administrator'), info('Darf alles: alle Projekte, Benutzer und Einstellungen. Alle anderen sehen nur, was du ihnen unter „Rechte“ freigibst – am Anfang nichts.')))),
    [{ text: 'Abbrechen' }, { text: 'Anlegen', art: 'haupt', aktion: () => api('POST', '/nutzer', { name: name.value, anzeige: anzeige.value, kennwort: kennwort.value, admin: admin.checked }) }]);
    if (r) { meldung(r.admin ? 'Benutzer angelegt' : 'Benutzer angelegt – jetzt unter „Rechte“ Projekte freigeben'); route(); }
  };
  const rechteText = (n) => {
    if (n.admin) return h('span', { class: 'schwach' }, 'alles');
    const f = n.freigaben || [];
    if (!f.length) return h('span', { class: 'marker warn' }, 'keine – sieht nichts');
    const text = f.map((x) => `${pfadName(x.pfad)} (${x.recht === 'schreiben' ? 'schreiben' : 'lesen'})`);
    return h('span', { title: text.join('\n') }, text.slice(0, 2).join(', '), f.length > 2 ? ` und ${f.length - 2} weitere` : '');
  };
  const bearbeiten = async (n) => {
    const neuName = h('input', { type: 'text', value: n.name, autocomplete: 'off', pattern: '[a-z0-9][a-z0-9._-]*' });
    const kw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    const admin = h('input', { type: 'checkbox', checked: n.admin });
    const r = await dialog(`${n.anzeige} bearbeiten`, h('div', {},
      feld('Benutzername', neuName, 'Zum Anmelden und Pushen. Beim Ändern gehen Zugangsschlüssel, Rechte und Profilbild mit; angemeldete Geräte melden sich neu an.'),
      feld('Neues Kennwort', kw, 'Leer lassen = unverändert.'), h('label', { class: 'haken' }, admin, 'Administrator')),
    [{ text: 'Abbrechen' }, { text: 'Speichern', art: 'haupt', aktion: async () => {
      let name = n.name;
      if (neuName.value.trim().toLowerCase() !== n.name) name = (await api('POST', '/nutzer/umbenennen', { name: n.name, neu: neuName.value })).nutzer.name;
      return api('PATCH', '/nutzer', { name, admin: admin.checked, ...(kw.value ? { kennwort: kw.value } : {}) });
    } }]);
    if (r) { meldung('Gespeichert'); route(); }
  };
  return h('div', {}, h('div', { class: 'kopfzeile' }, h('div', {}, h('h1', {}, sym('nutzer'), 'Benutzer'), h('p', { class: 'untertitel' }, 'Wer sich an FAH-Git anmelden darf – und was er sieht.')),
    h('button', { class: 'knopf haupt', type: 'button', onclick: neu }, sym('plus'), 'Neuer Benutzer')),
  h('div', { class: 'karte' }, h('table', { class: 'tabelle' }, h('tr', {}, h('th', {}, 'Benutzer'), h('th', {}, 'Rolle'), h('th', {}, 'Rechte'), h('th', {}, 'Seit'), h('th', {})),
    liste.map((n) => h('tr', {},
      h('td', {}, h('span', { class: 'nutzer-zelle' }, profilbild(n), h('span', { style: 'min-width:0' }, h('strong', {}, n.anzeige), ' ', h('span', { class: 'schwach' }, n.name)))),
      h('td', {}, n.admin ? h('span', { class: 'marker' }, 'Administrator') : 'Benutzer'),
      h('td', { class: 'klein' }, rechteText(n)),
      h('td', {}, datumZeit(n.erstellt)),
      h('td', { style: 'text-align:right' }, n.name === zustand.ich.name ? h('span', { class: 'schwach klein' }, 'du') : h('div', { class: 'zeile ende' },
        !n.admin ? h('button', { class: 'knopf klein', type: 'button', onclick: () => rechteDialog(n) }, sym('schloss'), 'Rechte') : null,
        h('button', { class: 'knopf klein', type: 'button', onclick: () => bearbeiten(n) }, 'Bearbeiten'),
        h('button', { class: 'knopf klein gefahr', type: 'button', onclick: async () => {
          if (!(await bestaetigen('Benutzer löschen', `${n.anzeige} kann sich danach nicht mehr anmelden; seine Zugangsschlüssel und sein Profilbild verschwinden.`))) return;
          try { await api('DELETE', `/nutzer?${q({ name: n.name })}`); meldung('Gelöscht'); route(); } catch (e) { fehlerMelden(e); }
        } }, 'Löschen'))))))));
}

async function einstellungenSeite() {
  const [e] = await Promise.all([api('GET', '/einstellungen'), baumLaden()]);
  const adresse = h('input', { type: 'url', value: e.adresse || '', placeholder: `${location.protocol}//${location.host}` });
  const fahnas = h('input', { type: 'url', value: e.fahnas_adresse || '', placeholder: 'https://nas.example:8443' });
  const form = h('form', { class: 'karte abschnitt' }, h('div', { class: 'karten-inhalt' },
    feld('Adresse für Klon-Links', adresse, 'Steht vor jeder Klon-Adresse. Leer lassen = so, wie du FAH-Git gerade aufrufst. Ändern, wenn FAH-Git hinter einem Proxy mit eigenem Namen läuft.'),
    feld('FAH-NAS-Adresse', fahnas, 'Adresse deiner FAH-NAS-Oberfläche, z. B. https://nas.example:8443 – dann zeigt jede Projektseite den Knopf „Auf FAH-NAS bauen“. Leer = Knopf ausgeblendet; FAH-NAS liest die Projekte mit einem Zugangsschlüssel „Nur lesen“.'),
    h('button', { class: 'knopf haupt', type: 'submit', disabled: !zustand.ich.admin }, 'Speichern')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('PUT', '/einstellungen', { adresse: adresse.value, fahnas_adresse: fahnas.value });
      zustand.fahnas = (await api('GET', '/status')).fahnas || '';
      fahnas.value = zustand.fahnas;
      meldung('Gespeichert');
    } catch (err) { fehlerMelden(err); }
  });
  // Regeln „an diesen Server nur aus diesem Ordner“ (z. B. ein Firmen-Git nur aus dem Firmen-Ordner)
  const regeln = (e.ziel_regeln || []).map((x) => ({ ...x }));
  const regelKarte = h('div', { class: 'karte abschnitt' });
  const speichern = async () => { await api('PUT', '/einstellungen', { ziel_regeln: regeln }); meldung('Regeln gespeichert'); };
  const ordnerName = (pfad) => { const t = flach(zustand.baum).ordner.find((o) => o.pfad === pfad); return t ? t.kette.join(' › ') : pfad; };
  const regelnZeichnen = () => leeren(regelKarte,
    h('div', { class: 'karten-kopf' }, h('h2', {}, 'Regeln für Weiterleitungen')),
    h('div', { class: 'karten-inhalt' }, info('An einen hier genannten Server dürfen nur Projekte aus dem zugehörigen Ordner weiterleiten. So landet z. B. bei der Firma nur, was im Firmen-Ordner liegt. Gilt beim Einrichten und bei jedem Abgleich; verschiebst du den Ordner, wandert die Regel mit.')),
    regeln.length ? h('table', { class: 'tabelle' }, h('tr', {}, h('th', {}, 'Server'), h('th', {}, 'Nur aus Ordner'), h('th', {})),
      regeln.map((x, i) => h('tr', {}, h('td', { class: 'mono' }, x.host), h('td', {}, ordnerName(x.ordner)),
        h('td', { style: 'text-align:right' }, zustand.ich.admin ? h('button', { class: 'knopf klein gefahr', type: 'button', onclick: async () => {
          regeln.splice(i, 1);
          try { await speichern(); regelnZeichnen(); } catch (err) { fehlerMelden(err); }
        } }, 'Entfernen') : null))))
      : h('div', { class: 'leer-hinweis' }, 'Keine Regeln – jedes Projekt darf überall hin weiterleiten.'),
    zustand.ich.admin ? h('div', { class: 'karten-inhalt' }, h('button', { class: 'knopf', type: 'button', onclick: async () => {
      const host = h('input', { type: 'text', required: true, placeholder: 'gitlab.example.com' });
      const ordner = ordnerAuswahl(zustand.baum, '');
      const r = await dialog('Neue Regel', h('div', {}, feld('Server', host, 'Name des Ziel-Servers, wie er in der Klon-Adresse steht (ohne https://).'),
        feld('Nur aus Ordner', ordner, 'Nur Projekte in diesem Ordner (und seinen Unterordnern) dürfen an den Server weiterleiten.')),
      [{ text: 'Abbrechen' }, { text: 'Hinzufügen', art: 'haupt', aktion: async () => { regeln.push({ host: host.value, ordner: ordner.value }); try { await speichern(); return true; } catch (err) { regeln.pop(); throw err; } } }]);
      if (r) regelnZeichnen();
    } }, sym('plus'), 'Regel hinzufügen')) : null);
  regelnZeichnen();
  const githubKarte = h('div', { class: 'karte abschnitt' });
  await githubZeichnen(githubKarte);
  return h('div', {}, h('h1', {}, sym('einstellungen'), 'Einstellungen'), h('p', { class: 'untertitel' }, `FAH-Git ${zustand.version}`), form, githubKarte, regelKarte);
}

// GitHub (1.8.0): Token EINMAL hinterlegen; was und wann übertragen wird, legt der Betreiber je Projekt-Spiegel fest.
async function githubZeichnen(karte) {
  let g;
  try { g = await api('GET', '/github'); } catch (e) { leeren(karte, h('div', { class: 'karten-inhalt' }, info(e.message))); return; }
  const neu = () => githubZeichnen(karte);
  const tokenDialog = async (titel) => {
    const token = h('input', { type: 'password', autocomplete: 'off', required: true, spellcheck: 'false', placeholder: 'ghp_… oder github_pat_…' });
    const r = await dialog(titel, h('div', {}, feld('GitHub-Token', token, 'Wird geprüft, mit dem Schlüssel dieser Installation verschlüsselt gespeichert und nie wieder angezeigt.'),
      h('div', { class: 'hinweisbox' }, sym('info'), h('div', {},
        'Anlegen auf github.com → Settings → Developer settings → Personal access tokens. ',
        h('strong', {}, 'Klassisch: '), 'Recht „repo“, dazu „workflow“, wenn Projekte .github/workflows enthalten. ',
        h('strong', {}, 'Fein: '), 'alle Repos, „Contents“ und „Administration“ (zum Anlegen neuer Repos) auf Lesen und Schreiben, bei Bedarf „Workflows“.'))),
    [{ text: 'Abbrechen' }, { text: 'Prüfen und speichern', art: 'haupt', aktion: () => api('PUT', '/github', { token: token.value }) }]);
    if (r) { meldung(`Verbunden als ${r.konto}`); neu(); }
  };
  const jetzt = (x) => async (e) => {
    e.currentTarget.disabled = true;
    try { const [r] = await api('POST', '/spiegel/jetzt', { pfad: x.projekt, id: x.id }); meldung(`${x.repo}: ${r.text}`, r.ergebnis === 'fehler' ? 'fehler' : 'ok'); } catch (err) { fehlerMelden(err); }
    neu();
  };
  leeren(karte,
    h('div', { class: 'karten-kopf' }, h('h2', {}, 'GitHub')),
    h('div', { class: 'karten-inhalt' },
      info('Einmal hinterlegen – danach wählst du in jedem Projekt unter „Spiegel → Zu GitHub“ nur noch das Repo. Was und wann übertragen wird, legst du dort je Projekt fest; ohne „automatisch“ geht nur etwas raus, wenn du auf „Jetzt zu GitHub“ klickst.'),
      g.eingerichtet
        ? h('div', { class: 'zeile', style: 'margin-top:10px;flex-wrap:wrap' },
          h('span', {}, h('span', { class: 'zustand-punkt ok', style: 'margin-right:6px' }), 'Verbunden als ', h('strong', {}, g.konto), g.geprueft ? h('span', { class: 'schwach' }, ` · geprüft ${vorZeit(g.geprueft)}`) : null),
          h('button', { class: 'knopf klein', type: 'button', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { const r = await api('POST', '/github/pruefen'); meldung(`Token gültig – Konto ${r.konto}`); } catch (err) { fehlerMelden(err); }
            neu();
          } }, 'Prüfen'),
          h('button', { class: 'knopf klein', type: 'button', onclick: () => tokenDialog('GitHub-Token ersetzen') }, 'Token ersetzen'),
          h('button', { class: 'knopf klein gefahr', type: 'button', onclick: async () => {
            if (!(await bestaetigen('GitHub trennen', 'Der Token wird gelöscht. Die GitHub-Spiegel der Projekte bleiben eingerichtet, übertragen aber nichts mehr, bis du wieder einen Token hinterlegst. Auf GitHub bleibt alles, wie es ist.', 'Trennen'))) return;
            try { await api('DELETE', '/github'); meldung('GitHub getrennt'); } catch (err) { fehlerMelden(err); }
            neu();
          } }, 'Trennen'))
        : h('div', { style: 'margin-top:10px' }, h('button', { class: 'knopf haupt', type: 'button', onclick: () => tokenDialog('Mit GitHub verbinden') }, sym('plus'), 'Mit GitHub verbinden'))),
    // Als Zeilen statt Tabelle: bricht auf dem Handy sauber um (Knopf rutscht unter den Text).
    g.spiegel.length
      ? h('div', {}, g.spiegel.map((x) => h('div', { class: 'zeile', style: 'justify-content:space-between;padding:12px 16px;border-top:1px solid var(--rand)' },
        h('div', { style: 'flex:1 1 260px;min-width:0;overflow-wrap:anywhere' },
          h('div', {}, h('a', { href: projektUrl(x.projekt, '/-/spiegel') }, x.name), h('span', { class: 'schwach' }, ' → '), h('span', { class: 'mono' }, x.repo)),
          h('div', { class: 'schwach klein' }, githubArt(x)),
          h('div', { class: 'klein', style: 'margin-top:4px' }, zustandText(x.zuletzt))),
        h('button', { class: 'knopf klein', type: 'button', disabled: !g.eingerichtet, onclick: jetzt(x) }, 'Jetzt zu GitHub'))))
      : h('div', { class: 'leer-hinweis' }, 'Noch kein Projekt mit GitHub verbunden.'),
    bereinigungFormular(g));
}

// Bereinigung für „Öffentlicher Stand“ (1.9.0): zentrale Regeln. Persönliches steht nur hier (einstellungen.json), nie im Code.
function bereinigungFormular(g) {
  const b = g.bereinigung || { ersetzen: [], verboten: [], weglassen: g.weglassen_vorgabe || [] };
  const ersetzen = h('textarea', { rows: 6, spellcheck: 'false', class: 'mono', placeholder: 'Musterweg 1, 12345 Musterstadt => \nre:\\b10\\.9\\.8\\.(\\d+)\\b => 192.168.1.$1' },
    b.ersetzen.map((x) => `${x.suchen} => ${x.durch}`).join('\n'));
  const verboten = h('textarea', { rows: 4, spellcheck: 'false', class: 'mono', placeholder: 'Musterweg\n10.9.8.' }, b.verboten.join('\n'));
  const weglassen = h('textarea', { rows: 6, spellcheck: 'false', class: 'mono' }, b.weglassen.join('\n'));
  const zeilen = (t) => t.value.split('\n').map((x) => x.trim()).filter(Boolean);
  const form = h('form', { class: 'karten-inhalt', style: 'border-top:1px solid var(--rand)' },
    h('h3', { style: 'margin-top:0' }, 'Bereinigung für „Öffentlicher Stand“'),
    info('Gilt für alle GitHub-Spiegel der Art „Öffentlicher Stand (bereinigt)“. Danach prüft FAH-Git jeden Stand auf Schlüssel, Tokens und Kennwörter – ein Fund sperrt die Übertragung, bis du ihn im Probelauf weglässt oder freigibst.'),
    feld('Ersetzen', ersetzen, 'Eine Regel je Zeile: „suchen => ersetzen durch“ (rechts leer = entfernen). Groß-/Kleinschreibung egal. Mit „re:“ davor ist „suchen“ ein Muster (JavaScript-RegExp, $1 … im Ersatz). Wirkt nur in Textdateien.'),
    feld('Verboten', verboten, 'Ein Begriff je Zeile, der nach dem Ersetzen nirgends mehr stehen darf – auch nicht in Binärdateien (z. B. Straßenname, Heimnetz, eigene Domain). Fund = Sperre.'),
    feld('Weglassen', weglassen, 'Ein Muster je Zeile für Dateien, die nie mitgehen (**/ = beliebige Ordner, * = beliebige Zeichen). „!“ davor = Ausnahme, z. B. !**/*.example. Spätere Zeilen gewinnen.'),
    h('div', { class: 'zeile' },
      h('button', { class: 'knopf haupt', type: 'submit' }, 'Regeln speichern'),
      h('button', { class: 'knopf', type: 'button', onclick: () => { weglassen.value = (g.weglassen_vorgabe || []).join('\n'); } }, 'Weglassen: Vorgabe einsetzen')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const regeln = zeilen(ersetzen).map((z) => {
        const i = z.indexOf(' =>');
        if (i < 0) throw new Error(`Ersetzen: „${z}“ – bitte „suchen => ersetzen durch“`);
        return { suchen: z.slice(0, i).trim(), durch: z.slice(i + 3).trim() };
      });
      const neu = await api('PUT', '/github/bereinigung', { ersetzen: regeln, verboten: zeilen(verboten), weglassen: zeilen(weglassen) });
      weglassen.value = neu.weglassen.join('\n');
      meldung('Regeln gespeichert – im Projekt per „Probelauf“ prüfen');
    } catch (err) { fehlerMelden(err); }
  });
  return form;
}

// --- Sicherung (nur Administratoren) -----------------------------------------------------------------------------

async function sicherungSeite() {
  const s = await api('GET', '/sicherung');
  const smb = s.smb || {};

  // Zeitplan: automatisch täglich + wie viele behalten
  const auto = h('input', { type: 'checkbox', checked: s.auto !== false });
  const behalten = h('input', { type: 'number', min: 1, max: 90, value: s.behalten || 14, style: 'width:6em' });
  const autoSpeichern = async () => {
    try { await api('PUT', '/sicherung/auto', { auto: auto.checked, behalten: Number(behalten.value) }); meldung('Zeitplan gespeichert'); } catch (e) { fehlerMelden(e); }
  };
  auto.addEventListener('change', autoSpeichern);
  behalten.addEventListener('change', autoSpeichern);
  const planKarte = h('div', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h2', {}, sym('uhr'), 'Automatisch')),
    h('div', { class: 'karten-inhalt' },
      h('label', { class: 'haken' }, auto, h('span', {}, h('div', {}, 'Täglich automatisch sichern'),
        info('Einmal am Tag wird im Hintergrund eine vollständige Sicherung in den Datenordner gelegt. Für Schutz auch bei Plattenverlust muss dieser Ordner von FAH-Sicherung off-box erfasst werden.'))),
      feld('Wie viele behalten', behalten, 'Ältere automatische Sicherungen werden darüber hinaus gelöscht (Sicherheitskopien von Wiederherstellungen bleiben immer).')));

  // Stand der laufenden Arbeit: ein Balken je Schritt (Packen, NAS) mit Restzeit, läuft auch nach neuem Seitenaufruf weiter
  const laufKarte = h('div', { class: 'karte abschnitt', hidden: true });
  const dauerText = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`);
  const schrittText = (s) => {
    if (s.zustand === 'fehler') return s.fehler || 'Fehlgeschlagen';
    if (s.zustand === 'fertig') return `Fertig nach ${dauerText(s.dauer_s)}`;
    if (s.zustand === 'wartet') return 'Wartet';
    if (!s.gesamt) return 'Wird vorbereitet …';
    return `${s.prozent} % · ${groesse(s.fertig)} von ${groesse(s.gesamt)} · ${s.rest_s == null ? 'Restzeit wird ermittelt …' : `noch ca. ${dauerText(s.rest_s)}`}`;
  };
  const laufZeichnen = (f) => {
    laufKarte.hidden = false;
    leeren(laufKarte,
      h('div', { class: 'karten-kopf' }, h('h2', {}, sym('uhr'), f.laeuft ? 'Sicherung läuft' : f.schritte.some((x) => x.zustand === 'fehler') ? 'Mit Fehler beendet' : 'Fertig')),
      h('div', { class: 'karten-inhalt' }, f.schritte.map((x) => h('div', { class: 'lauf-schritt' },
        h('div', { class: 'lauf-zeile' }, h('b', {}, x.titel), h('span', { class: 'klein schwach' }, schrittText(x))),
        h('progress', { max: 100, value: x.prozent, class: x.zustand === 'fehler' ? 'rot' : '', 'aria-label': x.titel })))));
  };
  let beobachtet = false;
  const beobachten = async () => {
    if (beobachtet) return;
    beobachtet = true; jetztKnopf.disabled = true;
    try {
      for (;;) {
        const f = await api('GET', '/sicherung/fortschritt');
        if (f.schritte.length) laufZeichnen(f);
        if (!f.laeuft) {
          const nas = f.schritte.find((x) => x.id === 'nas');
          if (f.ergebnis && f.ergebnis.groesse) meldung(`Gesichert (${groesse(f.ergebnis.groesse)})${nas ? (nas.zustand === 'fertig' ? ' · aufs NAS kopiert' : ' · NAS-Kopie fehlgeschlagen') : ''}`);
          else if (f.fehler) fehlerMelden(new Error(f.fehler));
          else if (nas) meldung('Aufs NAS kopiert');
          zeichnen((await api('GET', '/sicherung')).liste);
          return;
        }
        await new Promise((weiter) => setTimeout(weiter, 1000));
        if (!laufKarte.isConnected) return;
      }
    } catch (e) { fehlerMelden(e); } finally { beobachtet = false; jetztKnopf.disabled = false; }
  };

  // Liste + Löschen/Download, wird nach Aktionen neu gezeichnet
  const listenKarte = h('div', { class: 'karte abschnitt' });
  const zeichnen = (liste) => leeren(listenKarte,
    h('div', { class: 'karten-kopf' }, h('h2', {}, 'Vorhandene Sicherungen'), h('span', { class: 'schwach klein' }, `${liste.length} · in ${s.ordner}`)),
    liste.length ? h('table', { class: 'tabelle' },
      h('tr', {}, h('th', {}, 'Erstellt'), h('th', {}, 'Inhalt'), h('th', {}, 'Größe'), h('th', {}, 'Art'), h('th', {})),
      liste.map((b) => h('tr', {},
        h('td', { title: datumZeit(b.erstellt) }, vorZeit(b.erstellt)),
        h('td', { class: 'klein schwach' }, b.manifest ? `${b.manifest.projekte} Projekte · ${b.manifest.nutzer} Konten · ${b.manifest.spiegel} Weiterleitungen` : '—'),
        h('td', {}, groesse(b.groesse)),
        h('td', {}, b.art === 'vor-wiederherstellung' ? h('span', { class: 'marker warn', title: 'Vor einer Wiederherstellung automatisch angelegt' }, 'vor Einspielen') : h('span', { class: 'marker grau' }, 'Sicherung'),
          b.manifest && b.manifest.nas ? (b.manifest.nas.ok
            ? h('span', { class: 'marker', title: 'Auch aufs NAS kopiert', style: 'margin-left:4px' }, 'NAS')
            : h('span', { class: 'marker warn', title: b.manifest.nas.fehler || 'NAS-Kopie fehlgeschlagen', style: 'margin-left:4px' }, 'NAS ✗')) : null),
        h('td', { style: 'text-align:right' }, h('div', { class: 'zeile ende' },
          smb.aktiv ? h('button', { class: 'knopf klein', type: 'button', title: 'Diese Sicherung aufs NAS kopieren', onclick: async (ev) => {
            const b2 = ev.currentTarget; b2.disabled = true;
            try { await api('POST', '/sicherung/kopieren', { name: b.name, hintergrund: true }); await beobachten(); } catch (e) { fehlerMelden(e); } finally { b2.disabled = false; }
          } }, sym('spiegel'), 'NAS') : null,
          h('a', { class: 'knopf klein', href: `/api/sicherung/export`, title: 'Frische Sicherung herunterladen', onclick: () => { setTimeout(beobachten, 600); } }, sym('laden'), 'Laden'),
          h('button', { class: 'knopf klein gefahr', type: 'button', onclick: async () => {
            if (!(await bestaetigen('Sicherung löschen', `„${b.name}“ endgültig löschen?`))) return;
            try { await api('DELETE', `/sicherung?${q({ name: b.name })}`); meldung('Gelöscht'); zeichnen((await api('GET', '/sicherung')).liste); } catch (e) { fehlerMelden(e); }
          } }, 'Löschen'))))))
      : h('div', { class: 'leer-hinweis' }, 'Noch keine Sicherung – lege oben die erste an.'));
  zeichnen(s.liste);

  // Wiederherstellen: Datei wählen, bestätigen, hochladen → Dienst startet neu
  const wahl = h('input', { type: 'file', accept: '.gz,.tgz,application/gzip', hidden: true, 'aria-label': 'Sicherungsdatei wählen' });
  wahl.addEventListener('change', async () => {
    const datei = wahl.files[0]; wahl.value = '';
    if (!datei) return;
    if (!(await bestaetigen('Wiederherstellen', `„${datei.name}" einspielen? Der gesamte jetzige Bestand (Projekte, Konten, Rechte, Zugänge) wird dadurch ersetzt. Eine Sicherheitskopie des aktuellen Standes wird vorher automatisch angelegt. FAH-Git startet danach neu.`, 'Einspielen'))) return;
    try {
      meldung('Wird eingespielt – bitte warten …');
      const r = await api('PUT', '/sicherung/einspielen', datei);
      await dialog('Wiederhergestellt', h('div', {},
        h('div', { class: 'hinweisbox' }, sym('haken'), h('div', {}, `Eingespielt: ${r.manifest.projekte} Projekte, ${r.manifest.nutzer} Konten. FAH-Git startet jetzt neu – die Seite lädt in ein paar Sekunden von selbst nach.`))),
      [{ text: 'OK', art: 'haupt', aktion: () => true }]);
      setTimeout(() => location.reload(), 6000);
    } catch (e) { fehlerMelden(e); }
  });
  const restoreKarte = h('div', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h2', {}, sym('import'), 'Wiederherstellen')),
    h('div', { class: 'karten-inhalt' },
      info('Spielt eine zuvor geladene Sicherungsdatei (.tar.gz) wieder ein – für den Umzug auf einen neuen Server oder nach einem Datenverlust. Der aktuelle Bestand wird vollständig ersetzt (vorher wird automatisch eine Sicherheitskopie angelegt), danach startet FAH-Git neu.'),
      h('div', { class: 'zeile' }, h('button', { class: 'knopf', type: 'button', onclick: () => wahl.click() }, sym('import'), 'Sicherungsdatei wählen …')),
      wahl));

  // Kopie auf NAS (SMB): einmal eintragen, dann wird jede Sicherung zusätzlich dorthin kopiert.
  const nAktiv = h('input', { type: 'checkbox', checked: !!smb.aktiv });
  const nServer = h('input', { type: 'text', value: smb.host || '', placeholder: '192.168.1.23' });
  const nFreigabe = h('input', { type: 'hidden', value: smb.freigabe || '' });
  const nOrdner = h('input', { type: 'hidden', value: smb.ordner || '' });
  const nNutzer = h('input', { type: 'text', value: smb.nutzer || '', placeholder: 'fabian' });
  const nPass = h('input', { type: 'password', placeholder: smb.hatPass ? '•••• (leer = unverändert)' : 'Passwort' });
  const zielText = h('code', { class: 'mono', style: 'overflow-wrap:anywhere' });
  const zielZeigen = () => leeren(zielText, nFreigabe.value ? `\\\\${nServer.value || '…'}\\${[nFreigabe.value, nOrdner.value].filter(Boolean).join('\\')}` : '— noch kein Zielordner gewählt —');
  zielZeigen();
  const nasSpeichern = async () => {
    await api('PUT', '/sicherung/smb', { aktiv: nAktiv.checked, host: nServer.value, freigabe: nFreigabe.value, ordner: nOrdner.value, nutzer: nNutzer.value, port: smb.port || 445, passwort: nPass.value });
    nPass.value = ''; smb.hatPass = smb.hatPass || !!nPass.value; meldung('NAS-Zugang gespeichert');
  };
  async function zielWaehlen() {
    if (!nServer.value || !nNutzer.value) { meldung('Erst Server, Benutzer und Passwort eintragen.', 'fehler'); return; }
    let pfad = [nFreigabe.value, ...(nOrdner.value ? nOrdner.value.split('/') : [])].filter(Boolean).join('/');
    const brot = h('div', { class: 'pfadleiste' });
    const liste = h('div', {});
    const neuName = h('input', { type: 'text', placeholder: 'z. B. fah-git' });
    const laden = async (p) => {
      pfad = p;
      leeren(liste, h('div', { class: 'laedt' }, 'Lädt …'));
      try {
        const r = await api('POST', '/sicherung/smb/blaettern', { host: nServer.value, nutzer: nNutzer.value, passwort: nPass.value, pfad });
        leeren(brot, h('a', { href: '#', onclick: (e) => { e.preventDefault(); laden(''); } }, sym('spiegel'), nServer.value || 'Freigaben'));
        let akk = '';
        for (const t of (pfad ? pfad.split('/') : [])) { akk = akk ? `${akk}/${t}` : t; const bis = akk; brot.append(sym('pfeil'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); laden(bis); } }, t)); }
        leeren(liste, r.eintraege.length
          ? r.eintraege.map((n) => h('button', { class: 'knopf klein', type: 'button', style: 'display:block;width:100%;text-align:left;margin:2px 0', onclick: () => laden(pfad ? `${pfad}/${n}` : n) }, sym(pfad ? 'ordner' : 'spiegel'), n))
          : h('div', { class: 'leer-hinweis' }, pfad ? 'Keine Unterordner – hier wählen oder unten einen neuen anlegen.' : 'Keine Freigaben gefunden.'));
      } catch (e) { leeren(liste, h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {}, e.message))); }
    };
    await laden(pfad);
    const ok = await dialog('Zielordner wählen', h('div', {},
      info('Klick dich zur Freigabe und zum Zielordner. Unten kannst du einen neuen Unterordner anhängen (wird beim ersten Lauf angelegt).'),
      brot, h('div', { class: 'abschnitt', style: 'max-height:260px;overflow:auto' }, liste),
      feld('Neuer Unterordner (optional)', neuName)),
    [{ text: 'Abbrechen' }, { text: 'Diesen Ordner wählen', art: 'haupt', aktion: () => {
      let p = pfad; const nn = neuName.value.trim().replace(/^\/+|\/+$/g, '');
      if (nn) p = p ? `${p}/${nn}` : nn;
      const seg = p.split('/').filter(Boolean);
      if (!seg.length) throw new Error('Bitte zuerst eine Freigabe wählen.');
      nFreigabe.value = seg[0]; nOrdner.value = seg.slice(1).join('/');
      return true;
    } }]);
    if (ok) zielZeigen();
  }
  const nasKarte = h('div', { class: 'karte abschnitt' }, h('div', { class: 'karten-kopf' }, h('h2', {}, sym('spiegel'), 'Kopie auf NAS (SMB)')),
    h('div', { class: 'karten-inhalt' },
      h('label', { class: 'haken' }, nAktiv, h('span', {}, h('div', {}, 'Jede Sicherung zusätzlich aufs NAS kopieren'),
        info('Nach jeder Sicherung (von Hand und täglich) wird die .tar.gz auf diese SMB-Freigabe kopiert – fah-gits eigenes Off-box, ohne FAH-Sicherung. Kopiert per rclone, kein Mount.'))),
      feld('Server (NAS)', nServer, 'Adresse des NAS, z. B. 192.168.1.23.'),
      feld('Benutzer', nNutzer, 'Konto mit Schreibrecht auf der Freigabe.'),
      feld('Passwort', nPass, 'Wird verschlüsselt gespeichert (geheim.key), nie wieder angezeigt. Leer lassen = unverändert.'),
      nFreigabe, nOrdner,
      h('div', { class: 'feld' }, h('label', {}, 'Zielordner'),
        h('div', { class: 'zeile', style: 'align-items:center;gap:8px;flex-wrap:wrap' }, zielText,
          h('button', { class: 'knopf', type: 'button', onclick: () => zielWaehlen().catch(fehlerMelden) }, sym('ordner'), 'Durchsuchen …')),
        info('Freigabe + optionaler Unterordner auf dem NAS. Trag Server, Benutzer und Passwort ein, dann „Durchsuchen" – Freigaben und Ordner zum Anklicken.')),
      h('div', { class: 'zeile' },
        h('button', { class: 'knopf haupt', type: 'button', onclick: async () => { try { await nasSpeichern(); } catch (e) { fehlerMelden(e); } } }, 'Speichern'),
        h('button', { class: 'knopf', type: 'button', onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true;
          try { const r = await api('POST', '/sicherung/smb/pruefen'); meldung(r.hinweis || 'Freigabe erreichbar'); } catch (e) { fehlerMelden(e); } finally { b.disabled = false; }
        } }, sym('spiegel'), 'Verbindung prüfen')),
      info('„Durchsuchen" und „Prüfen" nutzen die eingetragenen Zugangsdaten. Zum dauerhaften Kopieren einmal „Speichern".')));

  const jetztKnopf = h('button', { class: 'knopf haupt', type: 'button' }, sym('schild'), 'Jetzt sichern');
  jetztKnopf.addEventListener('click', async () => {
    jetztKnopf.disabled = true;
    try { await api('POST', '/sicherung/jetzt', { hintergrund: true }); await beobachten(); } catch (e) { fehlerMelden(e); jetztKnopf.disabled = false; }
  });
  if (s.laeuft) setTimeout(beobachten, 300);

  return h('div', {},
    h('div', { class: 'kopfzeile' },
      h('div', {}, h('h1', {}, sym('schild'), 'Sicherung'), h('p', { class: 'untertitel' }, 'Der gesamte FAH-Git-Bestand – Repos, Konten, Rechte, Zugangsschlüssel und Weiterleitungen – als eine Datei.')),
      h('div', { class: 'zeile' }, h('a', { class: 'knopf', href: '/api/sicherung/export', onclick: () => { setTimeout(beobachten, 600); } }, sym('laden'), 'Herunterladen'), jetztKnopf)),
    h('div', { class: 'hinweisbox' }, sym('info'), h('div', {}, 'Eine Sicherung enthält alles unter dem Datenordner (auch den Schlüssel für Sitzungen und verschlüsselte Zugänge). Damit lässt sich FAH-Git nach einem Totalschaden 1:1 wiederherstellen. Für off-box richte unten „Kopie auf NAS (SMB)" ein – dann liegt jede Sicherung zusätzlich auf deinem NAS.')),
    laufKarte, planKarte, listenKarte, nasKarte, restoreKarte);
}

// --- Übernahme aus GitLab/Gitea ---------------------------------------------------------------------------------

async function importSeite() {
  await baumLaden();
  const basis = h('input', { type: 'url', required: true, placeholder: 'http://192.168.1.29:8929' });
  const schluessel = h('input', { type: 'password', required: true, autocomplete: 'off' });
  const bereich = h('input', { type: 'text', placeholder: 'leer = alles' });
  const ziel = ordnerAuswahl(zustand.baum, '');
  const laufend = h('input', { type: 'checkbox', checked: false });
  const takt = h('input', { type: 'number', min: 5, max: 1440, value: 15 });
  const taktFeld = feld('Abgleich alle … Minuten', takt, 'Wie oft die Kopien den Stand der Quelle holen.');
  taktFeld.classList.add('versteckt');
  laufend.addEventListener('change', () => taktFeld.classList.toggle('versteckt', !laufend.checked));
  const ausgabe = h('div', { class: 'abschnitt' });
  const form = h('form', { class: 'karte' }, h('div', { class: 'karten-inhalt' },
    feld('Adresse der Quelle', basis, 'Die Startadresse von GitLab oder Gitea, z. B. http://192.168.1.29:8929. FAH-Git erkennt selbst, welches es ist.'),
    feld('Zugangsschlüssel der Quelle', schluessel, 'Ein Schlüssel mit Leserecht für Repos und Schnittstelle (GitLab: read_api + read_repository; Gitea: Repository lesen). Er wird nur für Kopien gespeichert – verschlüsselt.'),
    feld('Nur diesen Bereich', bereich, 'Optional: nur Projekte unterhalb dieser Gruppe, z. B. socialwave/meinwlan/unifi. Die Gruppe selbst fällt dann im Ordnerpfad weg.'),
    feld('Ablegen in', ziel, 'Unter diesem Ordner entsteht dieselbe Ordnerstruktur wie in der Quelle.'),
    h('label', { class: 'haken abschnitt' }, laufend, h('span', {}, h('div', {}, 'Als laufende Kopie behalten'),
      info('Die Projekte holen sich regelmäßig den Stand der Quelle und sind hier nur lesbar. Ohne Haken: einmalige Übernahme – danach ist FAH-Git die Quelle.'))),
    taktFeld,
    h('button', { class: 'knopf haupt', type: 'submit' }, sym('import'), 'Übernehmen')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const knopf = form.querySelector('button[type=submit]');
    knopf.disabled = true;
    try {
      const { auftrag } = await api('POST', '/import', { basis: basis.value, schluessel: schluessel.value, bereich: bereich.value, ziel: ziel.value, laufend: laufend.checked, takt: Number(takt.value) });
      const protokoll = h('div', { class: 'fortschritt' }, 'Startet …');
      leeren(ausgabe, h('div', { class: 'karte' }, h('div', { class: 'karten-kopf' }, h('h3', {}, 'Fortschritt')), h('div', { class: 'karten-inhalt' }, protokoll)));
      for (;;) {
        const a = await api('GET', `/auftrag?${q({ id: auftrag })}`);
        protokoll.textContent = a.meldungen.join('\n');
        protokoll.scrollTop = protokoll.scrollHeight;
        if (a.status === 'fehler') { protokoll.textContent += `\n\nFehler: ${a.fehler}`; break; }
        if (a.status === 'fertig') {
          const r = a.ergebnis;
          protokoll.textContent += `\n\nFertig: ${r.neu.length} übernommen, ${r.vorhanden.length} schon vorhanden, ${r.fehler.length} Fehler.` + r.fehler.map((f) => `\n  ${f.pfad}: ${f.text}`).join('');
          await baumLaden();
          meldung(`${r.neu.length} Projekte übernommen`);
          break;
        }
        await new Promise((x) => setTimeout(x, 800));
      }
    } catch (err) { fehlerMelden(err); } finally { knopf.disabled = false; }
  });
  return h('div', {}, h('h1', {}, sym('import'), 'Aus GitLab oder Gitea übernehmen'),
    h('p', { class: 'untertitel' }, 'Holt alle Projekte samt Zweigen, Tags, Beschreibung und Ordnerstruktur. Bestehende Projekte bleiben unangetastet.'), form, ausgabe);
}

export { zustand, route };
start();
