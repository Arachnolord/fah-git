// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Spiegel in zwei Richtungen.
//
// Weiterleiten (Push): Nach jedem Push gehen Zweige und Tags an ein anderes Git (z. B. GitLab, GitHub …) -- NIE erzwungen und
// NIE gelöscht. Hat das Ziel etwas, das hier fehlt (ein Kollege hat dort gepusht), bleibt der Zweig dort, wie er ist, und
// der Spiegel meldet ihn als abweichend. So kann ein Spiegel fremde Arbeit nicht zerstören.
//
// Übernehmen (Quelle): Ein Projekt ist die Kopie eines fremden Gits und zieht in einem festen Takt nach. Es ist dann nur
// lesbar -- wer hier pusht, verlöre seine Arbeit beim nächsten Abgleich.
//
// GitHub (1.8.0): Spiegel mit `art:'github'` nutzen den EINEN GitHub-Zugang aus den Einstellungen. Der Betreiber wählt je Spiegel
// WAS (`zweige`: null = alle Zweige und Tags, sonst nur diese Zweige) und WANN (`auto`: false = nur von Hand, Vorgabe).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, gitText, refs as refsLesen } from './git.js';
import { githubGrund, repoPruefen } from './github.js';
import { standBauen, standCommit, nurPruefen, WEGLASSEN_VORGABE } from './bereinigung.js';

export const TAKT_VORGABE_MIN = 15;
export const NEUVERSUCH_MIN = 30;

/** Adresse prüfen: nur http(s), ohne eingebettete Zugangsdaten (die stehen verschlüsselt daneben). */
export function adressePruefen(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw Object.assign(new Error('Keine gültige Adresse'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Nur http- und https-Adressen'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Benutzer und Schlüssel bitte in die eigenen Felder, nicht in die Adresse'), { status: 400 });
  return u.toString();
}

/**
 * Regeln „Ziel-Server → nur aus diesem Ordner“ (Beispiel: an einen Firmen-Server geht nur, was im Firmen-Ordner
 * hinterlegt ist). Gibt den Grund zurück, wenn das Projekt nicht an diesen Server weiterleiten darf, sonst null.
 */
export function regelVerletzt(regeln, pfad, url) {
  let host;
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  const passend = (regeln || []).filter((x) => String(x.host || '').toLowerCase() === host);
  if (!passend.length) return null;
  if (passend.some((x) => !x.ordner || pfad === x.ordner || pfad.startsWith(`${x.ordner}/`))) return null;
  return `Nach ${host} darf nur weitergeleitet werden, was im Ordner „${passend.map((x) => x.ordner).join('“ oder „')}“ liegt`;
}

/** Zeilen von `git push --porcelain` auswerten. */
export function pushAuswerten(text, github = false) {
  const ergebnis = { neu: [], aktualisiert: [], erzwungen: [], gleich: 0, abweichend: [] };
  for (const zeile of String(text).split('\n')) {
    const m = /^([ +\-*!=])\t([^:]*):([^\t]*)\t(.*)$/.exec(zeile);
    if (!m) continue;
    const [, flag, , ziel, text2] = m;
    if (flag === '*') ergebnis.neu.push(ziel);
    else if (flag === ' ') ergebnis.aktualisiert.push(ziel);
    else if (flag === '+') ergebnis.erzwungen.push(ziel);
    else if (flag === '=') ergebnis.gleich += 1;
    else if (flag === '!') ergebnis.abweichend.push({ ref: ziel, grund: grundLesbar(text2, github) });
  }
  return ergebnis;
}

/** Warum das Ziel einen Zweig nicht genommen hat, in Alltagssprache. */
function grundLesbar(text, github = false) {
  const t = String(text || '');
  const gh = github ? githubGrund(t) : null;   // GitHub-Deutung nur für GitHub-Spiegel (Firmen-GitLab bleibt unberührt)
  if (gh) return gh;
  if (/fetch first|non-fast-forward|stale info/i.test(t)) return 'am Ziel liegt ein anderer Stand';
  if (/protected|pre-receive hook declined|denied|not allowed to force/i.test(t)) return 'am Ziel geschützt (Überschreiben dort nicht erlaubt)';
  return t.replace(/^\[[^\]]*\]\s*/, '').replace(/[()]/g, '') || 'abgelehnt';
}

/** Zweigwahl prüfen: null/undefined = alles, sonst Liste gültiger Zweignamen (mind. einer). */
export function zweigListe(zweige) {
  if (zweige == null) return null;
  if (!Array.isArray(zweige)) throw Object.assign(new Error('Zweige als Liste'), { status: 400 });
  const liste = [...new Set(zweige.map((z) => String(z).trim()).filter(Boolean))].slice(0, 200);
  for (const z of liste) {
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(z) || z.startsWith('-') || z.startsWith('/') || z.endsWith('/') || z.includes('..') || z.includes('//') || /\.lock$/.test(z)) {
      throw Object.assign(new Error(`Ungültiger Zweig „${z}“`), { status: 400 });
    }
  }
  if (!liste.length) throw Object.assign(new Error('Mindestens einen Zweig wählen – oder „alle Zweige und Tags“'), { status: 400 });
  return liste;
}

const VOLL_OEFFENTLICH = 'Dieses GitHub-Repo ist öffentlich – „Vollständig mit Verlauf“ würde alle alten Stände mitschicken. Nimm „Öffentlicher Stand (bereinigt)“.';

export class Spiegel {
  /**
   * @param {object} o {speicher, baum, aktivitaet}
   */
  constructor({ speicher, baum, aktivitaet, regeln = async () => [], github = async () => null, bereinigung = async () => null, githubInfo = null, istApp = null }) {
    this.istApp = istApp;         // pfad → true bei Apps (Vorlage „App“, 1.17.0)
    this.githubInfo = githubInfo; // repo → {privat} live von GitHub (vor jedem Vollspiegel-Push)
    this.speicher = speicher;
    this.regeln = regeln;
    this.github = github;        // → {benutzer, name, geheim (verschlüsselt), web} oder null
    this.bereinigung = bereinigung; // → {ersetzen, verboten, weglassen} für den öffentlichen Stand
    this.baum = baum;
    this.aktivitaet = aktivitaet;
    this.laeuft = new Map();     // projekt → Promise (je Projekt nacheinander)
    this.warten = new Map();     // projekt → Timer (Pushes kurz sammeln)
    this.askpass = path.join(speicher.ordner, 'askpass.sh');
    fs.writeFileSync(this.askpass, '#!/bin/sh\ncase "$1" in\n  *sername*) printf \'%s\\n\' "$FAHGIT_BENUTZER" ;;\n  *) printf \'%s\\n\' "$FAHGIT_GEHEIM" ;;\nesac\n', { mode: 0o700 });
  }

  umgebung(benutzer, geheimVerschluesselt) {
    return { GIT_ASKPASS: this.askpass, FAHGIT_BENUTZER: benutzer || 'git', FAHGIT_GEHEIM: this.speicher.entschluesseln(geheimVerschluesselt) };
  }

  /** Adresse + Zugang eines Spiegels; GitHub-Spiegel holen beides frisch aus dem zentralen Zugang. */
  async zugang(s) {
    if (s.art !== 'github') return { url: s.url, env: this.umgebung(s.benutzer, s.geheim) };
    const gh = await this.github();
    if (!gh || !gh.geheim) throw Object.assign(new Error('GitHub-Zugang fehlt – unter Einstellungen → GitHub hinterlegen'), { klar: true, status: 400 });
    return { url: `${gh.web}/${repoPruefen(s.repo)}.git`, env: this.umgebung(gh.benutzer, gh.geheim) };
  }

  /** Was übertragen wird: alles (Zweige + Tags) oder nur die gewählten, noch vorhandenen Zweige. */
  async refspecs(repoOrdner, s) {
    if (!Array.isArray(s.zweige)) return { specs: ['refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'], fehlen: [] };
    const hier = await refsLesen(repoOrdner);
    const da = s.zweige.filter((z) => hier.has(`refs/heads/${z}`));
    const fehlen = s.zweige.filter((z) => !hier.has(`refs/heads/${z}`));
    if (!da.length) throw Object.assign(new Error('Keiner der gewählten Zweige existiert (mehr) – unter „Ändern“ neu wählen'), { klar: true });
    return { specs: da.map((z) => `refs/heads/${z}:refs/heads/${z}`), fehlen };
  }

  /** Je Projekt streng nacheinander. */
  nacheinander(pfad, arbeit) {
    const vorher = this.laeuft.get(pfad) || Promise.resolve();
    const lauf = vorher.catch(() => {}).then(arbeit);
    this.laeuft.set(pfad, lauf.catch(() => {}));
    return lauf;
  }

  // --- Weiterleiten -----------------------------------------------------------------------------------------------

  async weiterleitenAnlegen(pfad, { url, benutzer, geheim }) {
    const adresse = adressePruefen(url);
    const grund = regelVerletzt(await this.regeln(), pfad, adresse);
    if (grund) throw Object.assign(new Error(grund), { status: 403 });
    const eintrag = { id: crypto.randomBytes(5).toString('hex'), url: adresse, benutzer: String(benutzer || '').trim().slice(0, 100),
      geheim: geheim ? this.speicher.verschluesseln(geheim) : '', aktiv: true, erstellt: new Date().toISOString(), zuletzt: null };
    await this.baum.projektAendern(pfad, (p) => { p.spiegel = [...(p.spiegel || []), eintrag]; });
    return this.oeffentlich(eintrag);
  }

  oeffentlich(s) {
    if (s.art === 'github') {
      return { id: s.id, art: 'github', repo: s.repo, url: s.url, auto: s.auto === true, zweige: Array.isArray(s.zweige) ? s.zweige : null, aktiv: s.aktiv !== false, zuletzt: s.zuletzt,
        modus: s.modus === 'oeffentlich' ? 'oeffentlich' : 'voll', sichtbarkeit: s.sichtbarkeit || null,
        // Öffentlich stellen nur, wenn FAH-Git das Repo selbst neu angelegt hat und dort nie ein Vollstand lag (Review 1.9.0)
        veroeffentlichbar: !!s.neu && !s.belastet, releases: s.releases || [] };
    }
    return { id: s.id, url: s.url, benutzer: s.benutzer, hat_geheim: !!s.geheim, aktiv: s.aktiv !== false, zuletzt: s.zuletzt };
  }

  /** GitHub-Spiegel anlegen: Repo „besitzer/name“, Vorgabe nur von Hand und alles. Überträgt NICHTS von selbst. */
  async githubAnlegen(pfad, { repo, url, auto, zweige, modus, sichtbarkeit = null, neu = false, ghid = null }) {
    const r = repoPruefen(repo);
    const grund = regelVerletzt(await this.regeln(), pfad, url);
    if (grund) throw Object.assign(new Error(grund), { status: 403 });
    const m = modus === 'oeffentlich' ? 'oeffentlich' : 'voll';
    if (m === 'voll' && sichtbarkeit === 'oeffentlich') throw Object.assign(new Error(VOLL_OEFFENTLICH), { status: 400 });
    const eintrag = { id: crypto.randomBytes(5).toString('hex'), art: 'github', repo: r, url, auto: auto === true, zweige: zweigListe(zweige),
      modus: m, sichtbarkeit, neu: !!neu, belastet: m === 'voll', ghid: ghid || null, aktiv: true, erstellt: new Date().toISOString(), zuletzt: null };
    await this.baum.projektAendern(pfad, (p) => {
      if ((p.spiegel || []).some((x) => x.art === 'github' && x.repo.toLowerCase() === r.toLowerCase())) throw Object.assign(new Error(`Das Projekt spiegelt schon nach ${r}`), { status: 409 });
      p.spiegel = [...(p.spiegel || []), eintrag];
    });
    return this.oeffentlich(eintrag);
  }

  // --- Von FAH-Git selbst angelegte GitHub-Repos (1.15.4) ----------------------------------------------------------
  // Betreiber 27.11.2026 (fah-cockpit): Spiegel gelöscht und neu verbunden → der Dialog wählte das vorhandene Repo, „neu“
  // ging verloren, öffentlich stellen war für immer gesperrt. Darum merkt sich FAH-Git je GitHub-Kennung (nicht Name: ein
  // gelöschtes und von Hand neu angelegtes Repo hat eine andere), welches Projekt das Repo angelegt hat und ob dort je ein
  // Vollstand lag. Eigener Schlüssel in einstellungen.json, damit „GitHub trennen“ die Liste nicht löscht.

  async eigeneRepos() { return (await this.speicher.lesen('einstellungen.json', {})).github_eigene || {}; }

  async eigenesRepoMerken(ghid, { repo, projekt, belastet }) {
    if (!ghid) return;
    await this.speicher.aendern('einstellungen.json', {}, (e) => {
      const l = (e.github_eigene = e.github_eigene || {});
      const alt = l[ghid];
      l[ghid] = { repo, projekt, erstellt: alt ? alt.erstellt : new Date().toISOString(), belastet: !!(belastet || (alt && alt.belastet)) };
    });
  }

  /** Lag (oder liegt) je ein Vollstand im Repo, bleibt es für immer privat. */
  async eigenesRepoBelasten(ghid) {
    if (!ghid) return;
    await this.speicher.aendern('einstellungen.json', {}, (e) => { if (e.github_eigene && e.github_eigene[ghid]) e.github_eigene[ghid].belastet = true; });
  }

  /** Darf ein wieder verbundenes Repo veröffentlicht werden? Nur dasselbe Projekt, nie belastet, nur „Öffentlicher Stand“. */
  async wiederVeroeffentlichbar(ghid, projekt, modus) {
    if (!ghid || modus !== 'oeffentlich') return false;
    const e = (await this.eigeneRepos())[ghid];
    return !!e && e.projekt === projekt && !e.belastet;
  }

  async weiterleitenAendern(pfad, id, { aktiv, benutzer, geheim, auto, zweige, modus }) {
    let belasten = null;
    await this.baum.projektAendern(pfad, (p) => {
      const s = (p.spiegel || []).find((x) => x.id === id);
      if (!s) throw Object.assign(new Error('Spiegel fehlt'), { status: 404 });
      if (aktiv != null) s.aktiv = !!aktiv;
      if (s.art === 'github') {
        if (modus != null) {
          const m = modus === 'oeffentlich' ? 'oeffentlich' : 'voll';
          if (m === 'voll' && s.sichtbarkeit === 'oeffentlich') throw Object.assign(new Error(VOLL_OEFFENTLICH), { status: 400 });
          if (m !== (s.modus === 'oeffentlich' ? 'oeffentlich' : 'voll')) {
            // Wechsel: alter Zustand gilt nicht mehr; war/ist es ein Vollspiegel, liegt (evtl.) Verlauf am Ziel → nie öffentlich stellen
            s.zuletzt = null;
            s.belastet = true;
            belasten = s.ghid || null;
          }
          s.modus = m;
        }
        if (auto != null) s.auto = auto === true;
        if (zweige !== undefined) s.zweige = zweigListe(zweige);
        return;
      }
      if (benutzer != null) s.benutzer = String(benutzer).trim().slice(0, 100);
      if (geheim) s.geheim = this.speicher.verschluesseln(geheim);
    });
    if (belasten) await this.eigenesRepoBelasten(belasten);
  }

  async weiterleitenLoeschen(pfad, id) {
    await this.baum.projektAendern(pfad, (p) => {
      const vorher = (p.spiegel || []).length;
      p.spiegel = (p.spiegel || []).filter((x) => x.id !== id);
      if (p.spiegel.length === vorher) throw Object.assign(new Error('Spiegel fehlt'), { status: 404 });
    });
    // Kette des öffentlichen Stands mit entfernen (nur FAH-Git-intern, GitHub bleibt unberührt)
    const repo = this.baum.repoPfad(pfad);
    const refs = (await gitText(['for-each-ref', '--format=%(refname)', `refs/fahgit/oeffentlich/${id}/`], { cwd: repo }).catch(() => '')).split('\n').filter(Boolean);
    for (const r of refs) await git(['update-ref', '-d', r], { cwd: repo }).catch(() => {});
  }

  /** Nach einem Push: kurz sammeln, dann alle aktiven Spiegel des Projekts bedienen. */
  nachPush(pfad) {
    clearTimeout(this.warten.get(pfad));
    this.warten.set(pfad, setTimeout(() => { this.warten.delete(pfad); this.weiterleiten(pfad).catch(() => {}); }, 1500));
  }

  async weiterleiten(pfad, nurId = null) {
    return this.nacheinander(pfad, async () => {
      const meta = await this.baum.projektMeta(pfad);
      const ergebnisse = [];
      for (const s of meta.spiegel || []) {
        // Ohne bestimmten Spiegel (nach einem Push): pausierte und „nur von Hand“-Spiegel bleiben still.
        if (nurId ? s.id !== nurId : (s.aktiv === false || s.auto === false)) continue;
        ergebnisse.push(await this.einSpiegel(pfad, s));
      }
      return ergebnisse;
    });
  }

  async einSpiegel(pfad, s) {
    const repo = this.baum.repoPfad(pfad);
    let zuletzt;
    try {
      const grund = regelVerletzt(await this.regeln(), pfad, s.url);
      if (grund) throw Object.assign(new Error(grund), { regel: true });
      const { url, env } = await this.zugang(s);
      let a; let fehlen = []; let zusatz = '';
      if (s.art === 'github' && s.modus === 'oeffentlich') {
        const o = await this.oeffentlichPushen(pfad, s, url, env);
        if (o.gesperrt) {
          zuletzt = { zeit: new Date().toISOString(), ergebnis: 'fehler', gesperrt: true, zweig: o.zweig, abweichend: [],
            text: `Gesperrt: ${o.bericht.funde_gesamt} Fund(e) im Zweig ${o.zweig} – nichts übertragen. Je Fund „Datei weglassen“ oder „freigeben“.`,
            funde: o.bericht.funde, funde_gesamt: o.bericht.funde_gesamt };
          throw Object.assign(new Error('gesperrt'), { gesperrt: true });
        }
        ({ a, fehlen } = o);
        zusatz = ` · bereinigt: ${o.ersetzt} Datei(en) angepasst, ${o.weggelassen} weggelassen`;
      } else {
        if (s.art === 'github' && this.githubInfo) {
          // Live prüfen: ein inzwischen öffentliches Repo bekommt nie den vollen Verlauf
          const info = await this.githubInfo(s.repo);
          if (!info.privat) throw Object.assign(new Error(VOLL_OEFFENTLICH), { klar: true });
        }
        const sp = await this.refspecs(repo, s);
        fehlen = sp.fehlen;
        const r = await git(['-c', 'credential.helper=', 'push', '--porcelain', url, ...sp.specs],
          { cwd: repo, env, zeitlimitMs: 15 * 60_000, erlaubteCodes: [0, 1] });
        a = this.pushErgebnis(r, s);
      }
      zuletzt = { zeit: new Date().toISOString(), ergebnis: a.abweichend.length ? 'teilweise' : 'ok',
        text: (a.abweichend.length
          ? `${a.abweichend.length} Zweig(e) am Ziel abweichend – dort nichts überschrieben`
          : (a.neu.length + a.aktualisiert.length ? `${a.neu.length + a.aktualisiert.length} Zweig(e)/Tag(s) übertragen` : 'Ziel war schon aktuell'))
          + (fehlen.length ? ` · gewählt, aber nicht mehr da: ${fehlen.join(', ')}` : '') + zusatz,
        abweichend: a.abweichend };
    } catch (e) {
      if (!e.gesperrt) zuletzt = { zeit: new Date().toISOString(), ergebnis: 'fehler', text: e.regel || e.klar ? e.message : this.lesbar(e, s.art === 'github'), abweichend: [] };
    }
    await this.baum.projektAendern(pfad, (p) => { const x = (p.spiegel || []).find((y) => y.id === s.id); if (x) x.zuletzt = zuletzt; });
    if (zuletzt.ergebnis !== 'ok') this.aktivitaet.melden({ art: 'spiegel', projekt: pfad, ergebnis: zuletzt.ergebnis, text: `${s.url}: ${zuletzt.text}` });
    return { id: s.id, ...zuletzt };
  }

  /** `git push --porcelain` auswerten; leere Ausgabe mit Fehler → werfen. */
  pushErgebnis(r, s) {
    const istGh = s.art === 'github';
    const a = pushAuswerten(r.stdout.toString('utf8'), istGh);
    // GitHub nennt den eigentlichen Grund (Workflow-Recht, 100 MB, Geheimnis im Code) nur in den „remote:“-Zeilen.
    const gh = istGh ? githubGrund(r.stderr) : null;
    if (gh) for (const x of a.abweichend) if (/geschützt|abgelehnt/.test(x.grund)) x.grund = gh;
    const leer = !a.neu.length && !a.aktualisiert.length && !a.abweichend.length && !a.gleich && !a.erzwungen.length;
    if (leer && r.stderr && /fatal|error/i.test(r.stderr)) throw Object.assign(new Error(r.stderr.trim().split('\n').pop()), { stderr: r.stderr });
    return a;
  }

  // --- Öffentlicher Stand (1.9.0): bereinigter Schnappschuss ohne Verlauf auf eigener Kette ---------------------------

  /** Welche Zweige: gewählte oder der Standardzweig. */
  async oeffentlicheZweige(pfad, s, hier) {
    const gewaehlt = Array.isArray(s.zweige) ? s.zweige : [await this.baum.standardZweig(pfad)];
    const da = gewaehlt.filter((z) => hier.has(`refs/heads/${z}`));
    if (!da.length) throw Object.assign(new Error('Keiner der gewählten Zweige existiert (mehr) – unter „Ändern“ neu wählen'), { klar: true, status: 400 });
    return { da, fehlen: gewaehlt.filter((z) => !hier.has(`refs/heads/${z}`)) };
  }

  /** Bereinigung = zentrale Regeln + je PROJEKT „weggelassen“/„freigegeben“ (hängt am Inhalt, nicht am Ziel). */
  async bereinigungsOptionen(pfad, schreiben) {
    const eigen = (await this.baum.projektMeta(pfad)).bereinigung || {};
    return { bereinigung: (await this.bereinigung()) || { ersetzen: [], verboten: [], weglassen: WEGLASSEN_VORGABE },
      weglassenExtra: eigen.weglassen || [], nur: eigen.nur || [], freigaben: eigen.freigaben || [], schreiben };
  }

  /**
   * Bereinigte Stände bauen und übertragen. `erzwingen` = Liste von Zweigen, die am Ziel ersetzt werden sollen (sonst nie erzwungen).
   * → {gesperrt, bericht, zweig} oder {a, fehlen, ersetzt, weggelassen}
   */
  async oeffentlichPushen(pfad, s, url, env, erzwingen = null) {
    const repo = this.baum.repoPfad(pfad);
    const hier = await refsLesen(repo);
    const { da, fehlen } = await this.oeffentlicheZweige(pfad, s, hier);
    const gh = await this.github();
    const autor = { name: (gh && (gh.name || gh.benutzer)) || 'FAH-Git', mail: `${(gh && gh.benutzer) || 'fah-git'}@users.noreply.github.com` };
    const opt = await this.bereinigungsOptionen(pfad, true);
    if (!(opt.bereinigung.ersetzen || []).length && !(opt.bereinigung.verboten || []).length) {
      throw Object.assign(new Error('Erst Regeln hinterlegen: Einstellungen → GitHub → Bereinigung (Ersetzen/Verboten) – sonst gingen z. B. Adresse und Heimnetz mit'), { klar: true, status: 400 });
    }
    const staende = []; let ersetzt = 0; let weggelassen = 0;
    for (const z of da) {
      if (erzwingen && !erzwingen.includes(z)) continue;
      const quelle = hier.get(`refs/heads/${z}`);
      const { baum, bericht } = await standBauen(repo, quelle, opt);
      if (!baum) return { gesperrt: true, bericht, zweig: z };
      // Nie einen LEEREN Stand übertragen (z. B. „Nur diese Dateien“ trifft im Zweig nichts) – das würde GitHub leeren
      if (!bericht.dateien) throw Object.assign(new Error(`Im Zweig ${z} bleibt keine einzige Datei übrig – „Nur diese Dateien“/„Weglassen“ prüfen. Nichts übertragen.`), { klar: true, status: 400 });
      // Vorlage „App“ (1.17.0): ohne öffentliches README sähe das Repo auf GitHub leer aus – dann lieber gar nicht
      if (this.istApp && await this.istApp(pfad)) {
        const readme = (await gitText(['ls-tree', '--name-only', baum, '.github/README.md'], { cwd: repo }).catch(() => '')).trim();
        if (!readme) throw Object.assign(new Error(`App-Vorlage: Im Zweig ${z} fehlt .github/README.md – das öffentliche README (Download-Link aufs Release, Bilder, Erster Start, wie bei FAH-Friday) zuerst anlegen. Nichts übertragen.`), { klar: true, status: 400 });
      }
      ersetzt = Math.max(ersetzt, bericht.ersetzt.length); weggelassen = Math.max(weggelassen, bericht.weggelassen.length);
      const ref = `refs/fahgit/oeffentlich/${s.id}/${z}`;
      const eltern = (await gitText(['rev-parse', '--verify', '-q', ref], { cwd: repo }).catch(() => '')).trim() || null;
      const { commit } = await standCommit(repo, { baum, eltern, autor, quelle });
      staende.push({ z, commit, ref });
    }
    if (!staende.length) throw Object.assign(new Error('Nichts zu übertragen'), { klar: true, status: 400 });
    const r = await git(['-c', 'credential.helper=', 'push', '--porcelain', url, ...staende.map((x) => `${erzwingen ? '+' : ''}${x.commit}:refs/heads/${x.z}`)],
      { cwd: repo, env, zeitlimitMs: 15 * 60_000, erlaubteCodes: [0, 1] });
    const a = this.pushErgebnis(r, s);
    for (const x of a.abweichend) {
      if (/anderer Stand/.test(x.grund)) x.grund = 'auf GitHub liegt ein anderer Stand (z. B. ein alter Vollspiegel) – „Überschreiben“ ersetzt ihn durch den bereinigten';
    }
    // Eigene Kette nur dort nachziehen, wo GitHub den Stand jetzt hat.
    const abgelehnt = new Set(a.abweichend.map((x) => x.ref));
    for (const x of staende) if (!abgelehnt.has(`refs/heads/${x.z}`)) await git(['update-ref', x.ref, x.commit], { cwd: repo });
    return { a, fehlen, ersetzt, weggelassen };
  }

  /** Probelauf: was würde ersetzt, weggelassen, gesperrt? Sendet nichts. */
  async probelauf(pfad, id) {
    const s = ((await this.baum.projektMeta(pfad)).spiegel || []).find((x) => x.id === id);
    if (!s || s.art !== 'github' || s.modus !== 'oeffentlich') throw Object.assign(new Error('Probelauf gibt es nur für „Öffentlicher Stand (bereinigt)“'), { status: 400 });
    const repo = this.baum.repoPfad(pfad);
    const hier = await refsLesen(repo);
    const { da } = await this.oeffentlicheZweige(pfad, s, hier);
    const opt = await this.bereinigungsOptionen(pfad, false);
    const ergebnis = [];
    for (const z of da) ergebnis.push({ zweig: z, ...(await standBauen(repo, hier.get(`refs/heads/${z}`), opt)).bericht });
    return ergebnis;
  }

  /** Fund behandeln (je Projekt): Datei weglassen, Funde freigeben (nur Fingerabdrücke) oder beides zurücksetzen. */
  async befund(pfad, { aktion, datei, fps }) {
    await this.baum.projektAendern(pfad, (p) => {
      const s = (p.bereinigung = p.bereinigung || { weglassen: [], freigaben: [] });
      const d = String(datei || '').slice(0, 1000);
      if (aktion === 'weglassen') {
        if (!d) throw Object.assign(new Error('Datei fehlt'), { status: 400 });
        s.weglassen = [...new Set([...(s.weglassen || []), d])].slice(-2000);
      } else if (aktion === 'freigeben') {
        const liste = (Array.isArray(fps) ? fps : []).map(String).filter((x) => /^[0-9a-f]{16}$/.test(x));
        if (!d || !liste.length) throw Object.assign(new Error('Datei und Fund fehlen'), { status: 400 });
        const vorhanden = new Set((s.freigaben || []).map((f) => `${f.datei}\0${f.fp}`));
        s.freigaben = [...(s.freigaben || []), ...liste.filter((fp) => !vorhanden.has(`${d}\0${fp}`)).map((fp) => ({ datei: d, fp }))].slice(-5000);
      } else if (aktion === 'nur') {
        s.nur = nurPruefen(fps);      // Liste kommt im Feld „fps“ bzw. „liste“ (siehe Server)
      } else if (aktion === 'zuruecksetzen') {
        s.weglassen = []; s.freigaben = [];
      } else throw Object.assign(new Error('Unbekannte Aktion'), { status: 400 });
    });
  }

  /**
   * Vor „öffentlich stellen“: Auf GitHub darf GENAU der bereinigte Stand liegen – nur die gewählten Zweige, jeweils gleich der
   * eigenen Kette, keine anderen Zweige, Tags oder PR-Verweise. Wirft mit verständlicher Liste, sonst ok.
   */
  async veroeffentlichungPruefen(pfad, s) {
    const repo = this.baum.repoPfad(pfad);
    const { url, env } = await this.zugang(s);
    let aus;
    try { aus = await gitText(['-c', 'credential.helper=', 'ls-remote', url], { cwd: repo, env, zeitlimitMs: 60_000 }); } catch (e) { throw Object.assign(new Error(this.lesbar(e, true)), { status: 502 }); }
    const fremd = [];
    let passend = 0;
    // Eigene Release-Tags (über FAH-Git angelegt) sind erlaubt, wenn sie auf einen Stand der eigenen Kette zeigen
    const eigeneTags = new Set((s.releases || []).map((x) => x.tag));
    const ketten = (await gitText(['for-each-ref', '--format=%(refname)', `refs/fahgit/oeffentlich/${s.id}/`], { cwd: repo }).catch(() => '')).split('\n').filter(Boolean);
    const inKette = async (sha) => {
      for (const k of ketten) {
        try { await git(['merge-base', '--is-ancestor', sha, k], { cwd: repo }); return true; } catch { /* nächste */ }
      }
      return false;
    };
    for (const zeile of aus.split('\n').filter(Boolean)) {
      const [sha, ref] = zeile.split('\t');
      if (ref === 'HEAD') continue;
      const m = /^refs\/heads\/(.+)$/.exec(ref);
      const t = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref);
      const eigen = m ? (await gitText(['rev-parse', '--verify', '-q', `refs/fahgit/oeffentlich/${s.id}/${m[1]}`], { cwd: repo }).catch(() => '')).trim() : '';
      if (eigen && eigen === sha) passend++;
      else if (t && eigeneTags.has(t[1]) && await inKette(sha)) continue;
      else fremd.push(ref.replace(/^refs\/heads\//, 'Zweig ').replace(/^refs\/tags\//, 'Tag '));
    }
    if (fremd.length) throw Object.assign(new Error(`Auf GitHub liegt mehr als der bereinigte Stand: ${fremd.slice(0, 8).join(', ')}${fremd.length > 8 ? ' …' : ''} – erst dort entfernen oder ein neues Repo nehmen`), { status: 409 });
    if (!passend) throw Object.assign(new Error('Auf GitHub liegt noch kein bereinigter Stand – erst „Jetzt zu GitHub“'), { status: 409 });
  }

  async sichtbarkeitMerken(pfad, id, wert) {
    await this.baum.projektAendern(pfad, (p) => { const s = (p.spiegel || []).find((x) => x.id === id); if (s) s.sichtbarkeit = wert; });
  }

  lesbar(e, github = false) {
    const t = String((e && (e.stderr || e.message)) || e).trim();
    const gh = github ? githubGrund(t) : null;
    if (gh) return gh;
    if (/Authentication failed|401|403|could not read Username|invalid credentials/i.test(t)) return 'Anmeldung am Ziel abgelehnt – Benutzer/Schlüssel prüfen (Schlüssel braucht Schreibrecht)';
    if (/Could not resolve host|Connection refused|timed out|unable to access/i.test(t)) return 'Ziel nicht erreichbar – Adresse und Netz prüfen';
    if (/not found|does not appear to be a git repository/i.test(t)) return 'Am Ziel gibt es kein Repo unter dieser Adresse';
    return t.split('\n').filter(Boolean).pop()?.slice(0, 300) || 'Unbekannter Fehler';
  }

  /**
   * Abweichende Zweige/Tags am Ziel bewusst mit dem Stand von FAH-Git überschreiben (Betreiber: „melden, aber mit Möglichkeit,
   * dies zu überschreiben“). Nur Refs, die es hier gibt; was das Ziel trotzdem ablehnt (geschützter Zweig), kommt als
   * „abgelehnt“ mit Grund zurück. Danach ein normaler Abgleich für den Zustand.
   */
  async ueberschreiben(pfad, id, gewuenscht, wer) {
    return this.nacheinander(pfad, async () => {
      const s = ((await this.baum.projektMeta(pfad)).spiegel || []).find((x) => x.id === id);
      if (!s) throw Object.assign(new Error('Spiegel fehlt'), { status: 404 });
      const grund = regelVerletzt(await this.regeln(), pfad, s.url);
      if (grund) throw Object.assign(new Error(grund), { status: 403 });
      if (s.art === 'github' && s.modus === 'oeffentlich') {
        const { url, env } = await this.zugang(s);
        const zweige = [...new Set((gewuenscht || []).map(String))].filter((x) => x.startsWith('refs/heads/')).map((x) => x.slice(11));
        if (!zweige.length) throw Object.assign(new Error('Nichts zu überschreiben'), { status: 400 });
        let o;
        try { o = await this.oeffentlichPushen(pfad, s, url, env, zweige); } catch (e) { throw Object.assign(new Error(e.klar ? e.message : this.lesbar(e, true)), { status: e.status || 502 }); }
        if (o.gesperrt) throw Object.assign(new Error(`Gesperrt: ${o.bericht.funde_gesamt} Fund(e) – erst „Probelauf“ ansehen`), { status: 409 });
        const ueberschrieben = [...o.a.erzwungen, ...o.a.aktualisiert, ...o.a.neu];
        this.aktivitaet.melden({ art: 'spiegel', projekt: pfad, nutzer: wer && wer.name, anzeige: wer && wer.anzeige, ergebnis: o.a.abweichend.length ? 'teilweise' : 'ok',
          text: `${s.url}: ${ueberschrieben.length} Zweig(e) durch den bereinigten Stand ersetzt` });
        const zustand = await this.einSpiegel(pfad, s);
        return { ueberschrieben, abgelehnt: o.a.abweichend, zustand };
      }
      const repo = this.baum.repoPfad(pfad);
      const hier = await refsLesen(repo);
      // GitHub-Spiegel mit Zweigwahl: auch beim Überschreiben nur die gewählten Zweige (keine Tags, keine anderen Zweige).
      const erlaubt = s.art === 'github' && Array.isArray(s.zweige) ? new Set(s.zweige.map((z) => `refs/heads/${z}`)) : null;
      const liste = [...new Set((gewuenscht || []).map(String))].filter((x) => /^refs\/(heads|tags)\//.test(x) && hier.has(x) && (!erlaubt || erlaubt.has(x)));
      if (!liste.length) throw Object.assign(new Error('Nichts zu überschreiben – die Zweige gibt es in FAH-Git nicht (mehr) oder sie sind für dieses Ziel nicht gewählt'), { status: 400 });
      const { url, env } = await this.zugang(s);
      let a;
      try {
        const r = await git(['-c', 'credential.helper=', 'push', '--porcelain', url, ...liste.map((x) => `+${x}:${x}`)],
          { cwd: repo, env, zeitlimitMs: 15 * 60_000, erlaubteCodes: [0, 1] });
        a = pushAuswerten(r.stdout.toString('utf8'), s.art === 'github');
      } catch (e) { throw Object.assign(new Error(this.lesbar(e, s.art === 'github')), { status: 502 }); }
      const ueberschrieben = [...a.erzwungen, ...a.aktualisiert, ...a.neu];
      this.aktivitaet.melden({ art: 'spiegel', projekt: pfad, nutzer: wer && wer.name, anzeige: wer && wer.anzeige, ergebnis: a.abweichend.length ? 'teilweise' : 'ok',
        text: `${s.url}: ${ueberschrieben.length} Zweig(e)/Tag(s) mit dem FAH-Git-Stand überschrieben${a.abweichend.length ? `, ${a.abweichend.length} abgelehnt` : ''}` });
      const zustand = await this.einSpiegel(pfad, s);
      return { ueberschrieben, abgelehnt: a.abweichend, zustand };
    });
  }

  // --- Übernehmen (fremdes Git als Quelle) -------------------------------------------------------------------------

  async quelleSetzen(pfad, { url, benutzer, geheim, takt }) {
    const adresse = adressePruefen(url);
    const minuten = Math.max(5, Math.min(1440, parseInt(takt, 10) || TAKT_VORGABE_MIN));
    await this.baum.projektAendern(pfad, (p) => {
      p.quelle = { url: adresse, benutzer: String(benutzer || '').trim().slice(0, 100),
        geheim: geheim ? this.speicher.verschluesseln(geheim) : (p.quelle && p.quelle.url === adresse ? p.quelle.geheim : ''),
        takt: minuten, zuletzt: p.quelle && p.quelle.url === adresse ? p.quelle.zuletzt : null };
    });
  }

  async quelleEntfernen(pfad) {
    await this.baum.projektAendern(pfad, (p) => { delete p.quelle; });
  }

  async abgleichen(pfad) {
    return this.nacheinander(pfad, async () => {
      const q = (await this.baum.projektMeta(pfad)).quelle;
      if (!q) return null;
      const repo = this.baum.repoPfad(pfad);
      let zuletzt;
      try {
        const env = this.umgebung(q.benutzer, q.geheim);
        await git(['-c', 'credential.helper=', 'fetch', '--prune', '--update-head-ok', '--quiet', q.url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
          { cwd: repo, env, zeitlimitMs: 30 * 60_000 });
        const kopf = await gitText(['-c', 'credential.helper=', 'ls-remote', '--symref', q.url, 'HEAD'], { cwd: repo, env, zeitlimitMs: 60_000 }).catch(() => '');
        const m = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(kopf);
        if (m) await this.baum.standardZweigSetzen(pfad, m[1]).catch(() => {});
        zuletzt = { zeit: new Date().toISOString(), ergebnis: 'ok', text: 'Stand übernommen' };
      } catch (e) {
        zuletzt = { zeit: new Date().toISOString(), ergebnis: 'fehler', text: this.lesbar(e) };
        this.aktivitaet.melden({ art: 'quelle', projekt: pfad, ergebnis: 'fehler', text: `${q.url}: ${zuletzt.text}` });
      }
      await this.baum.projektAendern(pfad, (p) => { if (p.quelle) p.quelle.zuletzt = zuletzt; p.zuletzt = zuletzt.zeit; });
      return zuletzt;
    });
  }

  /** Jede Minute: fällige Quellen abgleichen, fehlgeschlagene Weiterleitungen neu versuchen. */
  starten() {
    const runde = async () => {
      const meta = await this.baum.meta().catch(() => null);
      if (!meta) return;
      const jetzt = Date.now();
      for (const [pfad, p] of Object.entries(meta.projekte)) {
        if (p.quelle) {
          const seit = p.quelle.zuletzt ? jetzt - Date.parse(p.quelle.zuletzt.zeit) : Infinity;
          if (seit >= p.quelle.takt * 60_000) this.abgleichen(pfad).catch(() => {});
        }
        for (const s of p.spiegel || []) {
          if (s.aktiv === false || s.auto === false || !s.zuletzt || s.zuletzt.ergebnis !== 'fehler' || s.zuletzt.gesperrt) continue;
          if (jetzt - Date.parse(s.zuletzt.zeit) >= NEUVERSUCH_MIN * 60_000) this.weiterleiten(pfad, s.id).catch(() => {});
        }
      }
    };
    this.uhr = setInterval(() => { runde().catch(() => {}); }, 60_000);
    this.uhr.unref?.();
    setTimeout(() => { runde().catch(() => {}); }, 5000).unref?.();
  }

  stoppen() { clearInterval(this.uhr); }
}
