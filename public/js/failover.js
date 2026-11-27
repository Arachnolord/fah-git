// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fail-over (1.14.0) in der Oberfläche: Koppeln eines frischen Ersatzes, Wartebild während des ersten Abgleichs,
// Hinweisleiste „nur lesen“, Karte in den Einstellungen (Haupt und Ersatz) und die Kachel in der Übersicht.

import { h, sym, api, leeren, meldung, fehlerMelden, feld, info, dialog, bestaetigen, vorZeit, datumZeit, kopieren } from './hilfen.js';
import { anmeldeKarte } from './app.js';

const STILL_MS = 2 * 60_000;
const still = (iso) => !iso || Date.now() - Date.parse(iso) > STILL_MS;

function koppelFelder() {
  const haupt = h('input', { type: 'url', required: true, placeholder: 'http://192.168.1.10:3300', autocomplete: 'off' });
  const code = h('input', { type: 'password', required: true, autocomplete: 'off', placeholder: 'fgfo_…', spellcheck: 'false' });
  return { haupt, code, felder: [
    feld('Adresse des Haupts', haupt, 'So erreicht dieser Rechner die Haupt-Instanz im Heimnetz, z. B. http://192.168.1.10:3300 (ohne Pfad).'),
    feld('Kopplungscode', code, 'Am Haupt unter Einstellungen → Fail-over → „Kopplungscode erzeugen“. Er beginnt mit „fgfo_“ und wird dort nur einmal angezeigt.'),
  ] };
}

/** Frischer Ersatz ohne Kopplung: Adresse des Haupts und Kopplungscode eintragen. */
export function koppelnSeite(weiter) {
  const f = koppelFelder();
  anmeldeKarte('FAH-Git Fail-over', 'Diese Instanz ist als Ersatz eingerichtet. Verbinde sie mit dem Haupt – danach hält sie sich selbst auf dessen Stand.',
    f.felder, 'Koppeln und abgleichen', async () => {
      const r = await api('POST', '/failover/koppeln', { haupt: f.haupt.value, code: f.code.value });
      meldung(`Gekoppelt mit ${r.haupt} – ${r.repos} Projekte werden geholt`);
      weiter();
    });
}

/** Ersatz ohne Konten: Der erste Abgleich läuft (Konten kommen zuerst, dann die Repos). */
export function ersterAbgleich(weiter) {
  const text = h('p', { class: 'untertitel', style: 'text-align:center' }, 'Verbinde …');
  const fehler = h('div', { class: 'hinweisbox rot versteckt' });
  leeren(document.getElementById('app'), h('div', { class: 'mitte' }, h('div', { class: 'karte' },
    h('h1', {}, h('img', { src: '/static/symbol.svg', alt: '', width: 34, height: 34 }), 'Erster Abgleich'), text, fehler,
    info('Sobald die Konten des Haupts da sind, kannst du dich hier mit denselben Zugangsdaten anmelden.'))));
  const lauf = async () => {
    let s;
    try { s = await api('GET', '/status'); } catch (e) { text.textContent = e.message; return setTimeout(lauf, 3000); }
    if (!s.ersteinrichtung || !s.failover?.gekoppelt) return weiter();
    const f = s.failover;
    text.textContent = f.gesamt ? `Holt den Stand von ${f.haupt}: ${f.fertig || 0} von ${f.gesamt} Projekten …` : `Verbinde mit ${f.haupt || 'dem Haupt'} …`;
    fehler.textContent = f.fehler || '';
    fehler.classList.toggle('versteckt', !f.fehler);
    setTimeout(lauf, 3000);
  };
  lauf();
}

/** Hinweisleiste auf jeder Seite des Ersatzes; aktualisiert sich alle 20 Sekunden selbst. */
export function failoverHinweis() {
  const el = h('div', { class: 'hinweisbox warn', role: 'status' });
  const zeichnen = (f) => leeren(el, sym('info'), h('div', {},
    h('strong', {}, 'Fail-over – nur lesen. '),
    f && f.zuletzt ? `Stand ${vorZeit(f.zuletzt)}` : 'Noch kein vollständiger Abgleich',
    f && f.fehler ? h('span', { style: 'color:var(--gefahr)' }, ` · ${f.fehler}`) : null,
    '. Änderungen und Pushes bitte am Haupt',
    f && f.haupt ? [': ', h('a', { href: f.haupt, target: '_blank', rel: 'noopener' }, f.haupt)] : null, '.'));
  const holen = async () => {
    try { zeichnen(await api('GET', '/failover/status')); } catch { /* still */ }
  };
  zeichnen(null); holen();
  setInterval(holen, 20_000);
  return el;
}

/** Kachel in der Übersicht (Haupt mit Kopplung oder Ersatz). */
export function failoverKachel(f) {
  if (!f) return null;
  let wert; let gut;
  if (f.rolle === 'ersatz') {
    const repoFehler = (f.repoFehler || []).length;
    gut = !f.fehler && !repoFehler && !!f.aktuell;
    wert = f.fehler ? 'Haupt fehlt' : repoFehler ? `${repoFehler} Fehler` : f.aktuell ? 'aktuell' : f.zuletzt ? vorZeit(f.zuletzt) : 'holt …';
  } else if (f.uebernommen && !f.eingerichtet) {
    gut = false; wert = 'übernommen';
  } else {
    const e = f.ersatz;
    gut = !!(e && !still(e.zeit) && e.aktuell && !e.fehler);
    wert = !e ? 'wartet' : still(e.zeit) ? 'meldet sich nicht' : e.fehler ? 'Fehler' : e.aktuell ? 'aktuell' : 'holt nach';
  }
  return h('a', { href: '#/einstellungen', class: `karte kachel ${gut ? 'gut' : 'schlecht'}`, style: 'color:inherit;text-decoration:none',
    title: f.rolle === 'ersatz' ? `Ersatz von ${f.haupt || '?'}` : 'Zweite Instanz, die sich laufend auf diesen Stand bringt' },
  h('span', { class: 'titel' }, sym('spiegel'), 'Fail-over'), h('span', { class: 'wert' }, wert));
}

function neuStartAbwarten(text) {
  meldung(text);
  const lauf = async () => {
    try { await api('GET', '/status'); location.reload(); } catch { setTimeout(lauf, 2000); }
  };
  setTimeout(lauf, 4000);
}

/** Karte „Fail-over“ in den Einstellungen. */
export async function failoverKarte(karte) {
  let f;
  try { f = await api('GET', '/failover/status'); } catch (e) {
    return leeren(karte, h('div', { class: 'karten-kopf' }, h('h2', {}, 'Fail-over')), h('div', { class: 'karten-inhalt' }, h('div', { class: 'hinweisbox rot' }, e.message)));
  }
  const neu = () => failoverKarte(karte);
  const kopf = h('div', { class: 'karten-kopf' }, h('h2', {}, 'Fail-over'), h('span', { class: 'schwach klein' }, f.rolle === 'ersatz' ? 'Dieser Rechner ist der Ersatz' : 'Dieser Rechner ist der Haupt'));

  if (f.rolle === 'ersatz') {
    const fehlerListe = (f.repoFehler || []).length ? h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {},
      h('strong', {}, `${f.repoFehler.length} Projekt(e) nicht geholt: `), f.repoFehler.slice(0, 5).map((x) => h('div', { class: 'klein' }, h('code', {}, x.pfad), ` – ${x.fehler}`)))) : null;
    return leeren(karte, kopf, h('div', { class: 'karten-inhalt' },
      info('Diese Instanz holt alle 15 Sekunden den Stand des Haupts – nur, was sich geändert hat: Projekte samt Zweigen und Tags, Ordner, Konten, Rechte, Einstellungen und Aktivität. Hier lässt sich nichts ändern und nichts pushen. Bekommt der Haupt eine neue Version, holt sie sich das unterschriebene Update selbst (manage.sh spielt es ein). Fällt der Haupt aus, macht „Zum Haupt machen“ diese Instanz voll nutzbar.'),
      h('table', { class: 'tabelle' },
        h('tr', {}, h('th', {}, 'Haupt'), h('td', {}, f.haupt ? h('a', { href: f.haupt, target: '_blank', rel: 'noopener' }, f.haupt) : '–', f.haupt_version ? h('span', { class: 'schwach' }, ` · Version ${f.haupt_version}`) : null)),
        h('tr', {}, h('th', {}, 'Letzter Abgleich'), h('td', { title: datumZeit(f.zuletzt) }, f.zuletzt ? vorZeit(f.zuletzt) : 'noch keiner', ' ',
          f.laeuft ? h('span', { class: 'marker' }, 'läuft') : f.aktuell ? h('span', { class: 'marker gruen' }, 'aktuell') : null)),
        f.gesamt != null ? h('tr', {}, h('th', {}, 'Projekte'), h('td', {}, `${f.fertig ?? 0} von ${f.gesamt} geprüft`)) : null,
        h('tr', {}, h('th', {}, 'Version hier'), h('td', {}, f.version, ' ', f.haupt_version && f.haupt_version !== f.version ? h('span', { class: 'marker warn' }, 'anders als am Haupt') : null)),
        f.update ? h('tr', {}, h('th', {}, 'Update'), h('td', {}, f.update)) : null),
      f.fehler ? h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {}, f.fehler)) : null, fehlerListe,
      h('div', { class: 'zeile' },
        h('button', { class: 'knopf', type: 'button', onclick: async () => { try { await api('POST', '/failover/jetzt'); meldung('Abgleich angestoßen'); setTimeout(neu, 3000); } catch (e) { fehlerMelden(e); } } }, sym('laden'), 'Jetzt abgleichen'),
        f.quelle === 'umgebung' ? h('span', { class: 'schwach klein' }, 'Kopplung steht in der .env') : h('button', { class: 'knopf', type: 'button', onclick: async () => {
          const k = koppelFelder();
          k.haupt.value = f.haupt || '';
          const r = await dialog('Kopplung ändern', h('div', {}, ...k.felder), [{ text: 'Abbrechen' },
            { text: 'Koppeln', art: 'haupt', aktion: () => api('POST', '/failover/koppeln', { haupt: k.haupt.value, code: k.code.value }) }]);
          if (r) { meldung('Neu gekoppelt'); neu(); }
        } }, 'Kopplung ändern'),
        h('button', { class: 'knopf gefahr', type: 'button', onclick: async () => {
          const ok = await bestaetigen('Zum Haupt machen?', 'Nur, wenn der Haupt ausgefallen ist: Diese Instanz hört auf abzugleichen, nimmt Änderungen und Pushes an und übernimmt Weiterleitungen und Sicherungen. Kommt der alte Haupt zurück, darf er nicht parallel weiterlaufen – dort stoppen oder als Ersatz neu koppeln. Sie startet dazu kurz neu.', 'Zum Haupt machen');
          if (!ok) return;
          try { await api('POST', '/failover/uebernehmen', { bestaetigt: true }); neuStartAbwarten('Wird zum Haupt – startet neu …'); } catch (e) { fehlerMelden(e); }
        } }, 'Zum Haupt machen'))));
  }

  // Haupt
  const teile = [];
  if (f.uebernommen) {
    teile.push(h('div', { class: 'hinweisbox warn' }, sym('warnung'), h('div', {},
      h('strong', {}, `Diese Instanz war der Ersatz und ist seit ${datumZeit(f.seit) || 'kurzem'} der Haupt. `),
      'Läuft der alte Haupt wieder, nicht beide parallel nutzen. „Wieder Ersatz werden“ gleicht danach alles vom gekoppelten Haupt ab – was nur hier geändert wurde, geht dabei verloren (vorher dorthin pushen). Bleibt diese Instanz dauerhaft Haupt, in ihrer .env „ROLLE=“ leeren.',
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'knopf', type: 'button', onclick: async () => {
        const ok = await bestaetigen('Wieder Ersatz werden?', 'Diese Instanz wird wieder nur lesend und holt beim nächsten Abgleich den Stand des Haupts – Änderungen, die nur hier gemacht wurden, werden überschrieben. Sie startet dazu kurz neu.', 'Wieder Ersatz werden');
        if (!ok) return;
        try { await api('POST', '/failover/zurueck', { bestaetigt: true }); neuStartAbwarten('Wird wieder Ersatz – startet neu …'); } catch (e) { fehlerMelden(e); }
      } }, 'Wieder Ersatz werden')))));
  }
  teile.push(info('Eine zweite FAH-Git-Instanz (z. B. auf dem NAS) hält sich laufend auf diesem Stand: Sie fragt alle 15 Sekunden nach und holt nur Geändertes – Projekte samt Zweigen und Tags, Ordner, Konten, Rechte und Einstellungen. Selbst nimmt sie nichts an (nur lesen), leitet nichts weiter und sichert nicht. Neue Versionen übernimmt sie von hier selbst (unterschriebenes Update-Paket). Fällt dieser Rechner aus, macht dort ein Klick sie zum Haupt. Der Kopplungscode verlässt nie den Rechner: Jede Anfrage ist damit unterschrieben, jede Antwort verschlüsselt.'));
  const codeZeigen = (r) => dialog('Kopplungscode', h('div', {},
    h('p', {}, 'Am Ersatz eintragen – auf seiner Startseite oder unter Einstellungen → Fail-over → „Kopplung ändern“. Der Code wird nur jetzt angezeigt.'),
    h('div', { class: 'zeile' }, h('input', { type: 'text', readonly: true, value: r.code, class: 'mono', style: 'flex:1;min-width:0', onfocus: (e) => e.target.select() }),
      h('button', { class: 'knopf', type: 'button', onclick: () => kopieren(r.code) }, sym('kopieren'), 'Kopieren'))),
  [{ text: 'Fertig', art: 'haupt', aktion: () => true }]);
  const erzeugen = async (warnen) => {
    if (warnen && !(await bestaetigen('Neuen Kopplungscode erzeugen?', 'Der bisherige Code gilt dann nicht mehr – der Ersatz gleicht erst wieder ab, wenn du ihm den neuen Code gibst.', 'Neuen Code erzeugen'))) return;
    try { await codeZeigen(await api('POST', '/failover/code')); neu(); } catch (e) { fehlerMelden(e); }
  };
  if (!f.eingerichtet) {
    teile.push(h('div', { class: 'leer-hinweis' }, 'Kein Ersatz gekoppelt.'),
      h('button', { class: 'knopf haupt', type: 'button', onclick: () => erzeugen(false) }, sym('plus'), 'Kopplungscode erzeugen'));
  } else {
    const e = f.ersatz;
    const zustandEl = !e ? h('span', { class: 'marker warn' }, 'hat sich noch nicht gemeldet')
      : still(e.zeit) ? h('span', { class: 'marker rot' }, `meldet sich nicht seit ${vorZeit(e.zeit).replace(/^vor /, '')}`)
        : e.fehler ? h('span', { class: 'marker rot' }, 'Fehler') : e.aktuell ? h('span', { class: 'marker gruen' }, 'aktuell') : h('span', { class: 'marker warn' }, 'holt nach');
    teile.push(h('table', { class: 'tabelle' },
      h('tr', {}, h('th', {}, 'Kopplungscode'), h('td', {}, h('code', {}, `${f.anfang}…`), h('span', { class: 'schwach' }, ` seit ${datumZeit(f.erstellt)}`))),
      h('tr', {}, h('th', {}, 'Ersatz'), h('td', {}, e ? [e.adresse ? h('a', { href: e.adresse, target: '_blank', rel: 'noopener' }, e.adresse) : (e.quelle || '?'), ' '] : null, zustandEl)),
      e ? h('tr', {}, h('th', {}, 'Zuletzt gemeldet'), h('td', { title: datumZeit(e.zeit) }, vorZeit(e.zeit), e.zuletzt ? h('span', { class: 'schwach' }, ` · letzter vollständiger Abgleich ${vorZeit(e.zuletzt)}`) : null)) : null,
      e ? h('tr', {}, h('th', {}, 'Version'), h('td', {}, e.version || '?', ' ', e.version && e.version !== f.version
        ? h('span', { class: 'marker warn' }, e.update ? 'aktualisiert sich selbst' : `Haupt hat ${f.version}`) : null)) : null,
      e && e.update ? h('tr', {}, h('th', {}, 'Update'), h('td', {}, e.update)) : null),
    e && e.fehler ? h('div', { class: 'hinweisbox rot' }, sym('warnung'), h('div', {}, `Der Ersatz meldet: ${e.fehler}`)) : null,
    h('div', { class: 'zeile' },
      h('button', { class: 'knopf', type: 'button', onclick: () => erzeugen(true) }, 'Neuen Code erzeugen'),
      h('button', { class: 'knopf gefahr', type: 'button', onclick: async () => {
        if (!(await bestaetigen('Kopplung lösen?', 'Der Ersatz bekommt danach keinen neuen Stand mehr (er behält, was er hat).', 'Kopplung lösen'))) return;
        try { await api('DELETE', '/failover/code'); meldung('Kopplung gelöst'); neu(); } catch (err) { fehlerMelden(err); }
      } }, 'Kopplung lösen')));
  }
  return leeren(karte, kopf, h('div', { class: 'karten-inhalt' }, ...teile));
}
