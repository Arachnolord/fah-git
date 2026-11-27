// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sicherung: der GANZE Datenordner (nackte Repos + nutzer.json/meta.json/einstellungen.json/aktivitaet.json, die
// Profilbilder UND geheim.key = Sitzungen + verschlüsselte Spiegel-Zugänge) als EINE .tar.gz. Weil alles unter /daten
// liegt, ist das vollständig – damit lässt sich FAH-Git nach einem Totalschaden 1:1 wiederherstellen (Repos + Konten +
// Rechte + Weiterleitungen/Quellen samt Zugängen). Nur Werkzeuge aus dem Image: `tar` (busybox) und Node-Bordmittel,
// kein zstd. Die Sicherungen liegen in <daten>/_backups (vom Bind-Mount automatisch mitgesichert, wenn FAH-Sicherung
// den Datenordner erfasst = der einzige Weg zu „off-box“).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const execFileP = promisify(execFile);
const UNTERORDNER = '_backups';
const PRAEFIX = 'fah-git-sicherung-';
const VOR = 'vor-wiederherstellung-';
const TEIL = '.teil';
const STUNDE = 3600_000;

/** Zeitstempel für Dateinamen: 2026-10-30-1203. */
function stempel() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

export class Sicherung {
  /** @param {{speicher, baum, konten, einstellungen:()=>Promise<object>, version:string}} abh */
  constructor({ speicher, baum, konten, einstellungen, version }) {
    this.speicher = speicher;
    this.daten = speicher.ordner;
    this.baum = baum;
    this.konten = konten;
    this.einstellungen = einstellungen || (async () => ({}));
    this.version = version || '';
    this.ordner = path.join(this.daten, UNTERORDNER);
    this.laeuft = false;
    this.stand = null;
    this._uhr = null;
  }

  async _bereit() { await fsp.mkdir(this.ordner, { recursive: true }); }

  /** tar (busybox/GNU) ausführen; Fehlertext aus stderr. */
  _tar(args) {
    return new Promise((ok, fail) => {
      const k = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      k.stderr.on('data', (d) => { err += d; });
      k.on('error', fail);
      k.on('close', (code) => (code === 0 ? ok() : fail(new Error(`tar (${code}): ${err.trim() || 'fehlgeschlagen'}`))));
    });
  }

  /** Beschreibt den aktuellen Stand (für die Liste und zum Prüfen beim Einspielen). */
  async manifest() {
    const meta = await this.baum.meta().catch(() => ({ projekte: {}, ordner: {} }));
    const projekte = Object.keys(meta.projekte || {});
    let spiegel = 0;
    for (const p of projekte) { const x = meta.projekte[p] || {}; spiegel += (x.spiegel || []).length + (x.quelle ? 1 : 0); }
    const nutzer = await this.konten.liste().catch(() => []);
    return {
      werkzeug: 'fah-git', art: 'vollsicherung', fassung: 1, version: this.version, erstellt: new Date().toISOString(),
      projekte: projekte.length, ordner: Object.keys(meta.ordner || {}).length, nutzer: nutzer.length, spiegel,
    };
  }

  /** So viele Bytes wird tar schreiben (Kopf je Eintrag + auf 512 gerundeter Inhalt + Endblöcke), Grundlage des Balkens. */
  async _rohgroesse(eintraege) {
    let summe = 1024;
    const geh = async (p) => {
      const st = await fsp.lstat(p).catch(() => null);
      if (!st) return;
      summe += 512;
      if (st.isDirectory()) { for (const n of await fsp.readdir(p).catch(() => [])) await geh(path.join(p, n)); }
      else if (st.isFile()) summe += Math.ceil(st.size / 512) * 512;
    };
    for (const n of eintraege) await geh(path.join(this.daten, n));
    return summe;
  }

  /** Packt wie `tar -czf`, zählt aber die Bytes mit, damit die Oberfläche Fortschritt und Restzeit zeigen kann. */
  async _packen(ziel, eintraege, gesamt) {
    const k = spawn('tar', ['-cf', '-', '-C', this.daten, ...eintraege], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; let fertig = 0;
    k.stderr.on('data', (d) => { err += d; });
    const ende = new Promise((ok, fail) => {
      k.on('error', fail);
      k.on('close', (code) => (code === 0 ? ok() : fail(new Error(`tar (${code}): ${err.trim() || 'fehlgeschlagen'}`))));
    });
    const zaehler = new Transform({ transform: (stueck, _kodierung, weiter) => {
      fertig += stueck.length; this._melde('packen', fertig, gesamt); weiter(null, stueck);
    } });
    await Promise.all([ende, pipeline(k.stdout, zaehler, zlib.createGzip(), fs.createWriteStream(ziel))]);
  }

  /** Ganzes /daten (ohne _backups) nach `ziel` packen; schreibt kurz ein _manifest.json mit hinein. Ohne Sperre. */
  async _archivNach(ziel) {
    await this._bereit();
    this._melde('packen', 0, 0);
    const manifestPfad = path.join(this.daten, '_manifest.json');
    const m = await this.manifest();
    await fsp.writeFile(manifestPfad, JSON.stringify(m, null, 1));
    // Erst unter dem endgültigen Namen, wenn alles geschrieben ist: Ein abgebrochener Lauf darf nie als Sicherung gelten.
    const teil = path.join(path.dirname(ziel), `.${path.basename(ziel)}${TEIL}`);
    try {
      // Nur Dinge auf oberster Ebene aufzählen (statt tar-eigenem --exclude, das busybox nicht sicher kann): erfasst
      // repos/, *.json, geheim.key, avatare/ und alles Neue automatisch – nur _backups und halbe .tmp bleiben außen vor.
      const eintraege = (await fsp.readdir(this.daten)).filter((n) => n !== UNTERORDNER && n !== '_failover' && !n.endsWith('.tmp'));
      await this._packen(teil, eintraege, await this._rohgroesse(eintraege));
      await fsp.rename(teil, ziel);
      this._schrittEnde('packen');
    } catch (e) {
      await fsp.rm(teil, { force: true }).catch(() => {});
      throw e;
    } finally {
      await fsp.rm(manifestPfad, { force: true }).catch(() => {});
    }
    return m;
  }

  /** Nur eine Sicherungs-Tätigkeit gleichzeitig (packen/einspielen schließen sich aus). */
  async _mitSperre(fn) {
    if (this.laeuft) throw new Error('Eine Sicherung läuft gerade – bitte einen Moment warten.');
    this.laeuft = true;
    try { return await fn(); } finally { this.laeuft = false; }
  }

  // --- Fortschritt -------------------------------------------------------------------------------------------------
  // this.stand beschreibt den laufenden oder letzten Vorgang: je Schritt Bytes, Prozent, Tempo und Restzeit.

  async _lauf(schritte, fn) {
    this.stand = { laeuft: true, start: new Date().toISOString(), ende: null, fehler: null, ergebnis: null,
      schritte: schritte.map(({ id, titel }) => ({ id, titel, zustand: 'wartet', beginn: 0, fertig: 0, gesamt: 0, prozent: 0, tempo: 0, rest_s: null, dauer_s: 0, fehler: null })) };
    const stand = this.stand;
    try {
      stand.ergebnis = await fn();
      return stand.ergebnis;
    } catch (e) {
      stand.fehler = String(e.message || e).slice(0, 300);
      for (const s of stand.schritte) if (s.zustand === 'laeuft') this._schrittEnde(s.id, stand.fehler);
      throw e;
    } finally {
      stand.laeuft = false; stand.ende = new Date().toISOString();
    }
  }

  _melde(id, fertig, gesamt) {
    const s = this.stand?.schritte.find((x) => x.id === id);
    if (!s) return;
    const jetzt = Date.now();
    if (!s.beginn) { s.beginn = jetzt; s.zustand = 'laeuft'; }
    s.fertig = fertig;
    s.gesamt = gesamt || s.gesamt;
    const vergangen = (jetzt - s.beginn) / 1000;
    // Die Gesamtgröße ist bei tar geschätzt, darum bleibt 100 % dem echten Ende vorbehalten.
    s.prozent = s.gesamt ? Math.min(99, Math.floor((fertig / s.gesamt) * 100)) : 0;
    s.tempo = vergangen > 0 ? Math.round(fertig / vergangen) : 0;
    s.rest_s = vergangen >= 2 && s.tempo ? Math.ceil(Math.max(0, s.gesamt - fertig) / s.tempo) : null;
  }

  _schrittEnde(id, fehler = '') {
    const s = this.stand?.schritte.find((x) => x.id === id);
    if (!s) return;
    if (!s.beginn) s.beginn = Date.now();
    Object.assign(s, { zustand: fehler ? 'fehler' : 'fertig', fehler: fehler || null, rest_s: 0, dauer_s: Math.round((Date.now() - s.beginn) / 1000) });
    if (!fehler) Object.assign(s, { prozent: 100, fertig: s.gesamt || s.fertig });
  }

  // --- Öffentlich ------------------------------------------------------------------------------------------------

  /** Sicherung in <daten>/_backups ablegen (von Hand oder automatisch); danach aufräumen. */
  jetzt(grund = '') {
    return this._mitSperre(async () => {
      const nas = (await this.smbKonfig()).aktiv ? [{ id: 'nas', titel: 'Aufs NAS kopieren' }] : [];
      return this._lauf([{ id: 'packen', titel: 'Sicherung packen' }, ...nas], () => this._jetzt(grund));
    });
  }

  /** Für die Oberfläche: Lauf anstoßen und sofort antworten, Stand und Ergebnis stehen dann in this.stand. */
  jetztImHintergrund(grund = '') {
    if (this.laeuft) throw new Error('Eine Sicherung läuft gerade – bitte einen Moment warten.');
    this.jetzt(grund).catch((e) => console.error('Sicherung:', e.message));
    return { gestartet: true };
  }

  async _jetzt(grund) {
    const name = `${PRAEFIX}${stempel()}.tar.gz`;
    const ziel = path.join(this.ordner, name);
    const manifest = await this._archivNach(ziel);
    const st = await fsp.stat(ziel);
    manifest.grund = grund || '';
    manifest.groesse = st.size;
    // Zusätzlich auf die NAS-Freigabe kopieren (best effort – darf die lokale Sicherung nicht scheitern lassen).
    let nas = null;
    try {
      if ((await this.smbKonfig()).aktiv) {
        const k = await this._smbKopieren(name);
        nas = k.ok ? { ok: true, zeit: new Date().toISOString() } : { ok: false, fehler: k.grund };
      }
    } catch (e) { nas = { ok: false, fehler: String(e.message || e).slice(0, 200) }; }
    if (nas) manifest.nas = nas;
    await fsp.writeFile(path.join(this.ordner, `${name}.json`), JSON.stringify(manifest, null, 1)).catch(() => {});
    await this._aufraeumen();
    return { name, groesse: st.size, erstellt: manifest.erstellt, manifest, nas };
  }

  /** Frische Sicherung direkt als Download in die HTTP-Antwort streamen. */
  herunterladen(res) { return this._mitSperre(() => this._lauf([{ id: 'packen', titel: 'Sicherung packen' }], () => this._herunterladen(res))); }
  async _herunterladen(res) {
    await this._bereit();
    const name = `${PRAEFIX}${stempel()}.tar.gz`;
    const tmp = path.join(this.ordner, `.download-${stempel()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`);
    try {
      await this._archivNach(tmp);
      const st = await fsp.stat(tmp);
      res.writeHead(200, {
        'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': st.size, 'Cache-Control': 'no-store',
      });
      await new Promise((ok, fail) => {
        const s = fs.createReadStream(tmp);
        s.on('error', fail); res.on('error', fail); res.on('close', ok); s.on('end', ok);
        s.pipe(res);
      });
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Liste der vorhandenen Sicherungen (neueste zuerst). */
  async liste() {
    await this._bereit();
    const namen = (await fsp.readdir(this.ordner)).filter((n) => n.endsWith('.tar.gz') && !n.startsWith('.'));
    const out = [];
    for (const name of namen) {
      const st = await fsp.stat(path.join(this.ordner, name)).catch(() => null);
      if (!st) continue;
      let manifest = null;
      try { manifest = JSON.parse(await fsp.readFile(path.join(this.ordner, `${name}.json`), 'utf8')); } catch { /* ohne Beipackzettel */ }
      out.push({ name, groesse: st.size, erstellt: manifest?.erstellt || st.mtime.toISOString(), manifest,
        art: name.startsWith(VOR) ? 'vor-wiederherstellung' : 'sicherung' });
    }
    out.sort((a, b) => b.erstellt.localeCompare(a.erstellt));
    return out;
  }

  /** Übersicht für die Oberfläche: Zeitplan + letzte + ganze Liste. */
  async uebersicht() {
    const e = await this.einstellungen();
    const cfg = e.sicherung || {};
    const liste = await this.liste();
    return { auto: cfg.auto !== false, behalten: cfg.behalten || 14, ordner: this.ordner, laeuft: this.laeuft, fortschritt: this.stand,
      smb: this._smbOeffentlich(cfg.smb), letzte: liste[0] || null, liste };
  }

  /** Kurzfassung für die Dashboard-Kachel. */
  async kurz() {
    const e = await this.einstellungen();
    const liste = await this.liste().catch(() => []);
    const l = liste[0] || null;
    const schritt = this.stand?.laeuft ? this.stand.schritte.find((x) => x.zustand === 'laeuft') : null;
    return { auto: (e.sicherung || {}).auto !== false, nasAktiv: !!((e.sicherung || {}).smb || {}).aktiv,
      laeuft: this.laeuft, prozent: schritt ? schritt.prozent : null,
      letzte: l ? { erstellt: l.erstellt, groesse: l.groesse } : null, anzahl: liste.length };
  }

  /** Eine Sicherungsdatei löschen (nur innerhalb des _backups-Ordners). */
  async loeschen(name) {
    const sauber = path.basename(String(name || ''));
    if (!/\.tar\.gz$/.test(sauber) || sauber.startsWith('.')) throw new Error('Unbekannte Sicherung');
    const datei = path.join(this.ordner, sauber);
    if (!datei.startsWith(this.ordner + path.sep)) throw new Error('Unbekannte Sicherung');
    await fsp.rm(datei, { force: true });
    await fsp.rm(`${datei}.json`, { force: true });
    await this._smbLoeschen(sauber);
  }

  /** Hochgeladenes Archiv (Datenstrom) in eine Datei schreiben und einspielen. */
  hochladenUndEinspielen(req, max = 8 * 1024 * 1024 * 1024) {
    return new Promise((ok, fail) => {
      this._bereit().then(() => {
        const ziel = path.join(this.ordner, `.hochladen-${stempel()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`);
        const strom = fs.createWriteStream(ziel);
        let summe = 0; let abbruch = false;
        const schluss = async (fehler, wert) => {
          await fsp.rm(ziel, { force: true }).catch(() => {});
          fehler ? fail(fehler) : ok(wert);
        };
        req.on('data', (d) => {
          summe += d.length;
          if (summe > max && !abbruch) { abbruch = true; strom.destroy(); req.destroy(); schluss(new Error('Die Sicherung ist zu groß (über 8 GB).')); }
        });
        strom.on('error', (e) => !abbruch && schluss(e));
        req.on('error', (e) => !abbruch && schluss(e));
        strom.on('finish', async () => {
          if (abbruch) return;
          try { ok(await this.einspielen(ziel)); } catch (e) { fail(e); } finally { await fsp.rm(ziel, { force: true }).catch(() => {}); }
        });
        req.pipe(strom);
      }).catch(fail);
    });
  }

  /** Aus einer Sicherungsdatei wiederherstellen: erst Ist-Stand sichern, dann Inhalt austauschen. Danach sollte der
   * Dienst neu starten (der Aufrufer beendet den Prozess; der Container kommt von selbst zurück). */
  einspielen(tarPfad) { return this._mitSperre(() => this._lauf([{ id: 'packen', titel: 'Sicherheitskopie packen' }], () => this._einspielen(tarPfad))); }
  async _einspielen(tarPfad) {
    await this._bereit();
    // 1. Sicherheitskopie des aktuellen Standes – falls die eingespielte Datei doch nicht passt.
    const vorher = path.join(this.ordner, `${VOR}${stempel()}.tar.gz`);
    const vm = await this._archivNach(vorher);
    await fsp.writeFile(`${vorher}.json`, JSON.stringify({ ...vm, grund: 'vor Wiederherstellung' }, null, 1)).catch(() => {});

    // 2. Hochgeladenes Archiv in ein Staging IM Datenordner entpacken (gleiches Dateisystem → rename möglich) und prüfen.
    const stage = path.join(this.ordner, `.einspielen-${stempel()}-${Math.random().toString(36).slice(2, 8)}`);
    await fsp.mkdir(stage, { recursive: true });
    try {
      await this._tar(['-xzf', tarPfad, '-C', stage]);
      let manifest = null;
      try { manifest = JSON.parse(await fsp.readFile(path.join(stage, '_manifest.json'), 'utf8')); } catch { /* unten abgefangen */ }
      if (!manifest || manifest.werkzeug !== 'fah-git') throw new Error('Das ist keine FAH-Git-Sicherung (das Kennzeichen im Archiv fehlt).');
      if (!fs.existsSync(path.join(stage, 'repos'))) throw new Error('Die Sicherung enthält keinen repos-Ordner – abgebrochen.');

      // 3. Umschalten: aktuelle Einträge (außer _backups) beiseite, Inhalte aus dem Staging an ihre Stelle.
      const beiseite = path.join(this.ordner, `.ersetzt-${stempel()}`);
      await fsp.mkdir(beiseite, { recursive: true });
      for (const n of await fsp.readdir(this.daten)) {
        // _failover (Rolle „übernommen“, Kopplung) gehört zu diesem Rechner, nicht zur Sicherung – bleibt stehen.
        if (n === UNTERORDNER || n === '_failover') continue;
        await fsp.rename(path.join(this.daten, n), path.join(beiseite, n));
      }
      for (const n of await fsp.readdir(stage)) {
        if (n === '_manifest.json') continue;
        await fsp.rename(path.join(stage, n), path.join(this.daten, n));
      }
      await fsp.rm(beiseite, { recursive: true, force: true }).catch(() => {});
      return manifest;
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Nur die automatischen/handgemachten Sicherungen auf `behalten` neueste kürzen (vor-wiederherstellung bleibt). */
  async _aufraeumen() {
    const e = await this.einstellungen().catch(() => ({}));
    const behalten = Math.max(1, Math.min(90, Number((e.sicherung || {}).behalten) || 14));
    const dateien = (await this.liste()).filter((x) => x.name.startsWith(PRAEFIX));
    for (const x of dateien.slice(behalten)) await this.loeschen(x.name).catch(() => {});
  }

  // --- Kopie auf eine NAS-/SMB-Freigabe --------------------------------------------------------------------------
  // Jede erstellte Sicherung wird zusätzlich auf eine SMB-Freigabe (NAS) kopiert – über rclone (SMB-Backend, kein
  // Mount). Das Passwort liegt mit geheim.key verschlüsselt in einstellungen.json und wird nur zur Laufzeit für rclone
  // verschleiert. Fällt die Kopie aus, scheitert die lokale Sicherung trotzdem nicht.

  async smbKonfig() { return ((await this.einstellungen()).sicherung || {}).smb || {}; }
  _smbOeffentlich(smb) {
    smb = smb || {};
    return { aktiv: !!smb.aktiv, host: smb.host || '', freigabe: smb.freigabe || '', ordner: smb.ordner || '',
      nutzer: smb.nutzer || '', port: smb.port || 445, hatPass: !!smb.pass };
  }
  _smbPfad(cfg) {
    const f = String(cfg.freigabe || '').replace(/^\/+|\/+$/g, '');
    const o = String(cfg.ordner || '').replace(/^\/+|\/+$/g, '');
    return `:smb:${[f, o].filter(Boolean).join('/')}`;
  }
  _smbFlags(cfg, obsc) {
    return ['--smb-host', String(cfg.host), '--smb-user', String(cfg.nutzer), '--smb-port', String(cfg.port || 445), '--smb-pass', obsc];
  }
  async _obscure(klartext) {
    const { stdout } = await execFileP('rclone', ['obscure', String(klartext)], { timeout: 10000 });
    return stdout.trim();
  }
  /** Konfig + verschleiertes Passwort, wenn aktiv und vollständig – sonst null. */
  async _smbBereit() {
    const cfg = await this.smbKonfig();
    if (!cfg.aktiv || !cfg.host || !cfg.freigabe || !cfg.nutzer || !cfg.pass) return null;
    let klartext;
    try { klartext = this.speicher.entschluesseln(cfg.pass); } catch { return null; }
    return { cfg, obsc: await this._obscure(klartext) };
  }

  /** NAS-Zugang speichern (Passwort verschlüsselt; leeres Passwortfeld = unverändert). */
  async smbSpeichern(roh) {
    const host = String(roh.host || '').trim();
    const freigabe = String(roh.freigabe || '').trim().replace(/^\/+|\/+$/g, '');
    const ordner = String(roh.ordner || '').trim().replace(/^\/+|\/+$/g, '');
    const nutzer = String(roh.nutzer || '').trim();
    const port = Math.max(1, Math.min(65535, Number(roh.port) || 445));
    const aktiv = !!roh.aktiv;
    if (aktiv && (!host || !freigabe || !nutzer)) throw new Error('Server, Freigabe und Benutzer werden gebraucht.');
    await this.speicher.aendern('einstellungen.json', {}, (e) => {
      const s = e.sicherung || {};
      const pass = roh.passwort ? this.speicher.verschluesseln(String(roh.passwort)) : (s.smb || {}).pass;
      if (aktiv && !pass) throw new Error('Passwort für die Freigabe wird gebraucht.');
      s.smb = { aktiv, host, freigabe, ordner, nutzer, port, pass: pass || '' };
      e.sicherung = s;
    });
    return { ok: true };
  }

  /** Verbindung zur Freigabe testen (listet die Freigabe-Wurzel). */
  async smbPruefen() {
    const cfg = await this.smbKonfig();
    if (!cfg.host || !cfg.freigabe || !cfg.nutzer) throw new Error('Server, Freigabe und Benutzer eintragen.');
    if (!cfg.pass) throw new Error('Kein gespeichertes Passwort – bitte eintragen und speichern.');
    const obsc = await this._obscure(this.speicher.entschluesseln(cfg.pass));
    const freigabe = String(cfg.freigabe).replace(/^\/+|\/+$/g, '');
    try {
      await execFileP('rclone', ['lsd', `:smb:${freigabe}`, ...this._smbFlags(cfg, obsc), '--timeout', '30s'], { timeout: 45000, maxBuffer: 4e6 });
      return { ok: true, hinweis: `Freigabe \\\\${cfg.host}\\${freigabe} erreichbar` };
    } catch (e) {
      throw new Error(`SMB: ${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200)}`);
    }
  }

  /** Ordner auf der Freigabe auflisten (zum Durchklicken): pfad '' = Freigaben, sonst Unterordner. */
  async smbBlaettern({ host, nutzer, port, passwort, pfad } = {}) {
    host = String(host || '').trim();
    nutzer = String(nutzer || '').trim();
    port = Number(port) || 445;
    if (!host || !nutzer) throw new Error('Server und Benutzer eintragen.');
    let obsc;
    if (passwort) obsc = await this._obscure(String(passwort));
    else {
      const cfg = await this.smbKonfig();
      if (!cfg.pass) throw new Error('Passwort eintragen.');
      obsc = await this._obscure(this.speicher.entschluesseln(cfg.pass));
    }
    const rel = String(pfad || '').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
    try {
      const { stdout } = await execFileP('rclone', ['lsjson', `:smb:${rel}`, '--dirs-only', '--smb-host', host, '--smb-user', nutzer, '--smb-port', String(port), '--smb-pass', obsc, '--timeout', '30s'],
        { timeout: 45000, maxBuffer: 8e6 });
      const eintraege = JSON.parse(stdout || '[]').filter((e) => e.IsDir).map((e) => e.Name).sort((a, b) => a.localeCompare(b, 'de'));
      return { pfad: rel, eintraege };
    } catch (e) {
      throw new Error(`SMB: ${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200)}`);
    }
  }

  /** rclone mit Stand-Zeilen: meldet die übertragenen Bytes, als Fehlertext dient die letzte Meldung. */
  _rclone(args, melde, frist = 1800_000) {
    return new Promise((ok, fail) => {
      const k = spawn('rclone', [...args, '--use-json-log', '--log-level', 'NOTICE', '--stats', '1s', '--stats-log-level', 'NOTICE'], { stdio: ['ignore', 'ignore', 'pipe'] });
      const uhr = setTimeout(() => k.kill(), frist);
      let rest = ''; let letzte = '';
      k.stderr.setEncoding('utf8');
      k.stderr.on('data', (d) => {
        const zeilen = (rest + d).split('\n');
        rest = zeilen.pop();
        for (const z of zeilen) {
          try {
            const j = JSON.parse(z);
            if (j.stats) melde(j.stats.bytes || 0); else if (j.msg) letzte = j.msg;
          } catch { if (z.trim()) letzte = z.trim(); }
        }
      });
      k.on('error', (e) => { clearTimeout(uhr); fail(e); });
      k.on('close', (code) => { clearTimeout(uhr); code === 0 ? ok() : fail(new Error(letzte || `rclone (${code})`)); });
    });
  }

  /** Eine vorhandene Sicherung auf die NAS-Freigabe kopieren (ohne Sperre, läuft innerhalb eines Vorgangs). */
  async _smbKopieren(name) {
    const b = await this._smbBereit();
    if (!b) { this._schrittEnde('nas', 'NAS-Kopie nicht konfiguriert'); return { ok: false, grund: 'NAS-Kopie nicht konfiguriert' }; }
    const datei = path.join(this.ordner, path.basename(String(name)));
    if (!fs.existsSync(datei)) throw new Error('Sicherung nicht gefunden');
    const gesamt = (await fsp.stat(datei)).size;
    this._melde('nas', 0, gesamt);
    try {
      await this._rclone(['copy', datei, this._smbPfad(b.cfg), ...this._smbFlags(b.cfg, b.obsc), '--no-traverse', '--timeout', '120s'],
        (bytes) => this._melde('nas', bytes, gesamt));
      this._schrittEnde('nas');
      return { ok: true };
    } catch (e) {
      const text = `NAS-Kopie fehlgeschlagen: ${String(e.message).trim().split('\n').pop().slice(0, 200)}`;
      this._schrittEnde('nas', text);
      throw new Error(text);
    }
  }

  smbKopieren(name) { return this._mitSperre(() => this._lauf([{ id: 'nas', titel: 'Aufs NAS kopieren' }], () => this._smbKopieren(name))); }

  /** Für die Oberfläche: Kopie anstoßen und sofort antworten, nur offensichtliche Fehler kommen direkt zurück. */
  async kopieImHintergrund(name) {
    if (this.laeuft) throw new Error('Eine Sicherung läuft gerade – bitte einen Moment warten.');
    if (!(await this._smbBereit())) throw new Error('NAS-Kopie nicht konfiguriert');
    if (!fs.existsSync(path.join(this.ordner, path.basename(String(name))))) throw new Error('Sicherung nicht gefunden');
    this.smbKopieren(name).catch((e) => console.error('Sicherung:', e.message));
    return { gestartet: true };
  }

  /** NAS-Kopie einer Sicherung entfernen (beim Aufräumen/Löschen – best effort). */
  async _smbLoeschen(name) {
    const b = await this._smbBereit().catch(() => null);
    if (!b) return;
    const ziel = `${this._smbPfad(b.cfg)}/${path.basename(String(name))}`.replace(/^:smb:\//, ':smb:');
    await execFileP('rclone', ['deletefile', ziel, ...this._smbFlags(b.cfg, b.obsc), '--timeout', '30s'], { timeout: 60000 }).catch(() => {});
  }

  // --- Zeitplan --------------------------------------------------------------------------------------------------

  starten() {
    if (this._uhr) return;
    // Reste eines beim Neustart abgebrochenen Laufs
    fsp.readdir(this.ordner).then(async (namen) => {
      for (const n of namen.filter((x) => x.endsWith(TEIL))) await fsp.rm(path.join(this.ordner, n), { force: true });
    }).catch(() => {});
    const lauf = async () => {
      try {
        const e = await this.einstellungen();
        if ((e.sicherung || {}).auto === false) return;
        const juengste = (await this.liste()).find((x) => x.name.startsWith(PRAEFIX));
        if (juengste && Date.now() - Date.parse(juengste.erstellt) < 23 * STUNDE) return;
        await this.jetzt('automatisch');
      } catch (err) { console.error('Auto-Sicherung:', err.message); }
    };
    this._uhr = setInterval(lauf, STUNDE); this._uhr.unref?.();
    setTimeout(lauf, 15_000).unref?.();   // kurz nach dem Start, falls heute noch keine da ist
  }

  stoppen() { if (this._uhr) { clearInterval(this._uhr); this._uhr = null; } }
}
