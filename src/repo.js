// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Lesen aus einem Repo für die Oberfläche: Zweige, Dateibaum, Dateien, Verlauf, einzelne Änderungen.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { git, gitText, GIT_UMGEBUNG } from './git.js';

export const DATEI_MAX = 2 * 1024 * 1024;
export const DIFF_MAX = 3 * 1024 * 1024;
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/@{}+-]{1,250}$/;
const SHA = /^[0-9a-f]{4,64}$/;

export class RepoFehler extends Error {
  constructor(text, status = 400) { super(text); this.status = status; }
}

export function refPruefen(ref) {
  if (!REF.test(String(ref || ''))) throw new RepoFehler('Ungültiger Zweig oder Stand');
  return String(ref);
}

export function dateiPruefen(datei) {
  const d = String(datei || '').replace(/^\/+|\/+$/g, '');
  if (d.split('/').some((t) => t === '..' || t === '.')) throw new RepoFehler('Ungültiger Dateipfad');
  return d;
}

const TRENNER = '\x1e';

export async function istLeer(repo) {
  return !(await gitText(['for-each-ref', '--count=1', '--format=x', 'refs/heads'], { cwd: repo })).trim();
}

export async function zweige(repo) {
  const out = await gitText(['for-each-ref', '--sort=-committerdate',
    `--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(contents:subject)%00%(authorname)${TRENNER}`, 'refs/heads'], { cwd: repo });
  return out.split(TRENNER).map((z) => z.replace(/^\n/, '')).filter(Boolean).map((z) => {
    const [name, sha, datum, betreff, autor] = z.split('\0');
    return { name, sha, datum, betreff, autor };
  });
}

export async function tags(repo) {
  const out = await gitText(['for-each-ref', '--sort=-creatordate', `--format=%(refname:short)%00%(objectname)%00%(creatordate:iso-strict)${TRENNER}`, 'refs/tags'], { cwd: repo });
  return out.split(TRENNER).map((z) => z.replace(/^\n/, '')).filter(Boolean).map((z) => {
    const [name, sha, datum] = z.split('\0');
    return { name, sha, datum };
  });
}

/** Einträge eines Ordners im Stand `ref`. */
export async function ordnerInhalt(repo, ref, ordner) {
  refPruefen(ref);
  const o = dateiPruefen(ordner);
  const baumRef = o ? `${ref}:${o}` : `${ref}^{tree}`;
  let out;
  try { out = await gitText(['ls-tree', '-z', '-l', baumRef], { cwd: repo }); } catch {
    throw new RepoFehler('Ordner oder Stand nicht gefunden', 404);
  }
  const eintraege = out.split('\0').filter(Boolean).map((z) => {
    const tab = z.indexOf('\t');
    const [modus, art, sha, groesse] = z.slice(0, tab).split(/\s+/);
    const name = z.slice(tab + 1);
    return { name, pfad: o ? `${o}/${name}` : name, art: art === 'tree' ? 'ordner' : art === 'commit' ? 'modul' : 'datei',
      groesse: groesse === '-' ? null : Number(groesse), modus, sha };
  });
  eintraege.sort((a, b) => (a.art === 'ordner') === (b.art === 'ordner') ? a.name.localeCompare(b.name, 'de') : a.art === 'ordner' ? -1 : 1);
  return eintraege;
}

export async function letzterCommit(repo, ref, datei = '') {
  refPruefen(ref);
  const args = ['log', '-1', '--format=%H%x00%h%x00%an%x00%aI%x00%s', ref, '--'];
  if (datei) args.push(dateiPruefen(datei));
  const out = (await gitText(args, { cwd: repo }).catch(() => '')).trim();
  if (!out) return null;
  const [sha, kurz, autor, datum, betreff] = out.split('\0');
  return { sha, kurz, autor, datum, betreff };
}

export async function datei(repo, ref, pfad) {
  refPruefen(ref);
  const d = dateiPruefen(pfad);
  if (!d) throw new RepoFehler('Datei fehlt');
  const obj = `${ref}:${d}`;
  let groesse;
  try { groesse = Number((await gitText(['cat-file', '-s', obj], { cwd: repo })).trim()); } catch { throw new RepoFehler('Datei nicht gefunden', 404); }
  if (groesse > DATEI_MAX) return { pfad: d, groesse, zu_gross: true };
  const inhalt = (await git(['cat-file', 'blob', obj], { cwd: repo, ausgabeMax: DATEI_MAX + 1 })).stdout;
  const binaer = inhalt.subarray(0, 8000).includes(0);
  const sha = (await gitText(['rev-parse', obj], { cwd: repo })).trim();   // Blob-Kennung – der Editor erkennt damit eine zwischenzeitliche Änderung.
  return { pfad: d, groesse, binaer, sha, text: binaer ? null : inhalt.toString('utf8') };
}

/** Rohdaten einer Datei (Download). */
export async function roh(repo, ref, pfad) {
  refPruefen(ref);
  const d = dateiPruefen(pfad);
  try { return (await git(['cat-file', 'blob', `${ref}:${d}`], { cwd: repo, ausgabeMax: 512 * 1024 * 1024 })).stdout; } catch {
    throw new RepoFehler('Datei nicht gefunden', 404);
  }
}

export async function verlauf(repo, ref, { datei: d = '', seite = 0, anzahl = 40 } = {}) {
  refPruefen(ref);
  const args = ['log', `--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%P${TRENNER}`, `-n${anzahl + 1}`, `--skip=${seite * anzahl}`, ref, '--'];
  if (d) args.push(dateiPruefen(d));
  const out = await gitText(args, { cwd: repo }).catch(() => '');
  const liste = out.split(TRENNER).map((z) => z.replace(/^\n/, '')).filter(Boolean).map((z) => {
    const [sha, kurz, autor, mail, datum, betreff, eltern] = z.split('\0');
    return { sha, kurz, autor, mail, datum, betreff, eltern: eltern ? eltern.split(' ') : [] };
  });
  return { commits: liste.slice(0, anzahl), weitere: liste.length > anzahl };
}

export async function commit(repo, sha) {
  if (!SHA.test(String(sha || ''))) throw new RepoFehler('Ungültige Commit-Kennung');
  let kopf;
  try { kopf = await gitText(['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%B', sha], { cwd: repo }); } catch {
    throw new RepoFehler('Commit nicht gefunden', 404);
  }
  const [voll, eltern, autor, mail, datum, committer, cdatum, nachricht] = kopf.split('\0');
  const stat = await gitText(['show', '--format=', '--numstat', '-M', '-z', sha], { cwd: repo });
  const dateien = [];
  const t = stat.split('\0');
  for (let i = 0; i < t.length; i++) {
    const z = t[i].replace(/^\n/, '');
    if (!z) continue;
    const [plus, minus, name] = z.split('\t');
    if (name === '') { dateien.push({ plus: Number(plus) || 0, minus: Number(minus) || 0, alt: t[i + 1], pfad: t[i + 2], binaer: plus === '-' }); i += 2; }
    else dateien.push({ plus: Number(plus) || 0, minus: Number(minus) || 0, pfad: name, binaer: plus === '-' });
  }
  const p = await git(['show', '--format=', '--patch', '--no-color', '-M', '--no-ext-diff', sha], { cwd: repo, ausgabeMax: DIFF_MAX });
  return { sha: voll, eltern: eltern ? eltern.split(' ') : [], autor, mail, datum, committer, cdatum, nachricht: nachricht.trim(), dateien,
    patch: p.stdout.toString('utf8'), gekuerzt: p.abgeschnitten };
}

/** Erster Stand mit README in ein leeres, nacktes Repo (beim Anlegen per Oberfläche). */
export async function ersterStand(repo, { zweig, titel, beschreibung, autor }) {
  const inhalt = `# ${titel}\n\n${beschreibung ? beschreibung + '\n' : ''}`;
  const blob = (await gitText(['hash-object', '-w', '--stdin'], { cwd: repo, eingabe: inhalt })).trim();
  const baumSha = (await gitText(['mktree'], { cwd: repo, eingabe: `100644 blob ${blob}\tREADME.md\n` })).trim();
  const env = { GIT_AUTHOR_NAME: autor.anzeige, GIT_AUTHOR_EMAIL: `${autor.name}@fah-git`, GIT_COMMITTER_NAME: autor.anzeige, GIT_COMMITTER_EMAIL: `${autor.name}@fah-git` };
  const c = (await gitText(['commit-tree', baumSha, '-m', 'Erster Stand'], { cwd: repo, env })).trim();
  await git(['update-ref', `refs/heads/${zweig}`, c], { cwd: repo });
}

/**
 * Neuen Ordner in einem Zweig anlegen (Oberfläche, 25.10.2026 – Betreiber: „in FAH-Git kann ich in einem Projekt keinen
 * Unterordner erstellen“). Git kennt keine leeren Ordner; wie bei GitLab entsteht er mit einer leeren `.gitkeep`.
 * Ein Commit auf dem Zweig – mit Vergleich gegen den alten Stand, damit ein gleichzeitiger Push nicht überschrieben wird.
 * @returns {{pfad: string, sha: string, alt: string, betreff: string}}
 */
export async function ordnerAnlegen(repo, { zweig, ordner = '', name, autor, nachricht = '' }) {
  refPruefen(zweig);
  const eltern = dateiPruefen(ordner);
  const n = String(name || '').trim();
  if (eltern && !(await zweigKopf(repo, zweig))) throw new RepoFehler('Übergeordneter Ordner fehlt', 404);
  if (!n || n === '.' || n === '..' || n.toLowerCase() === '.git' || n.length > 200 || /[\/\\\x00-\x1f]/.test(n)) {
    throw new RepoFehler('Ungültiger Ordnername (keine Schrägstriche, nicht „.“ oder „..“)');
  }
  const ziel = eltern ? `${eltern}/${n}` : n;
  const alt = await kopfOderLeer(repo, zweig);
  if (eltern) {
    const art = (await gitText(['ls-tree', '--format=%(objecttype)', alt, '--', eltern], { cwd: repo })).trim();
    if (!alt || art !== 'tree') throw new RepoFehler('Übergeordneter Ordner fehlt', 404);
  }
  if (alt && (await gitText(['ls-tree', alt, '--', ziel], { cwd: repo })).trim()) throw new RepoFehler(`„${n}“ gibt es hier schon`, 409);
  const blob = (await gitText(['hash-object', '-w', '--stdin'], { cwd: repo, eingabe: '' })).trim();
  const betreff = String(nachricht || '').trim().slice(0, 500) || `Ordner ${ziel} angelegt`;
  const neu = await einchecken(repo, { zweig, alt, eintraege: [{ pfad: `${ziel}/.gitkeep`, sha: blob }], autor, betreff });
  return { pfad: ziel, sha: neu, alt, betreff };
}

/**
 * Dateien als EIN Commit auf den Zweig legen: Zwischen-Index aus dem alten Stand, Einträge dazu, Baum, Commit, dann
 * update-ref mit dem alten Wert als Vergleich – ein gleichzeitiger Push wird nie überschrieben.
 * eintraege: [{pfad, sha, modus?}] (Blobs liegen schon im Repo). Liefert den neuen Commit.
 */
export async function einchecken(repo, { zweig, alt, eintraege, autor, betreff }) {
  const index = path.join(os.tmpdir(), `fahgit-index-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const mitIndex = { GIT_INDEX_FILE: index };
    await git(alt ? ['read-tree', alt] : ['read-tree', '--empty'], { cwd: repo, env: mitIndex });
    const null40 = '0'.repeat(40);
    const zeilen = eintraege.map((e) => (e.sha ? `${e.modus || '100644'} ${e.sha}\t${e.pfad}\n` : `0 ${null40}\t${e.pfad}\n`)).join('');
    try {
      await git(['update-index', '--add', '--index-info'], { cwd: repo, env: mitIndex, eingabe: zeilen });
    } catch (e) {
      throw new RepoFehler(`Datei und Ordner gleichen Namens: ${String(e.message).replace(/^git update-index fehlgeschlagen: /, '')}`, 409);
    }
    const baumSha = (await gitText(['write-tree'], { cwd: repo, env: mitIndex })).trim();
    const altBaum = alt ? (await gitText(['rev-parse', `${alt}^{tree}`], { cwd: repo })).trim() : '';
    if (baumSha === altBaum) throw new RepoFehler('Keine Änderung – die Dateien liegen genau so schon im Zweig', 400);
    const env = { GIT_AUTHOR_NAME: autor.anzeige, GIT_AUTHOR_EMAIL: `${autor.name}@fah-git`, GIT_COMMITTER_NAME: autor.anzeige, GIT_COMMITTER_EMAIL: `${autor.name}@fah-git` };
    const neu = (await gitText(['commit-tree', baumSha, ...(alt ? ['-p', alt] : []), '-m', betreff], { cwd: repo, env })).trim();
    try {
      // Vergleichswert: alter Kopf – oder lauter Nullen = „den Zweig darf es noch nicht geben“ (erster Commit).
      await git(['update-ref', `refs/heads/${zweig}`, neu, alt || '0'.repeat(neu.length)], { cwd: repo });
    } catch {
      throw new RepoFehler('Der Zweig hat sich gerade geändert – bitte neu laden und noch einmal versuchen', 409);
    }
    return neu;
  } finally {
    await fs.rm(index, { force: true });
  }
}

/**
 * Kopf des Zweigs, auf den geschrieben wird – oder '' im leeren Projekt (dann wird es der erste Commit). Einen
 * anderen, fehlenden Zweig gibt es nicht: Neue Zweige entstehen weiter per Push.
 */
export async function kopfOderLeer(repo, zweig) {
  const kopf = await zweigKopf(repo, zweig);
  if (kopf) return kopf;
  if (await istLeer(repo)) return '';
  throw new RepoFehler('Diesen Zweig gibt es nicht', 400);
}

/** Neue Textdatei anlegen (Oberfläche). Name darf Unterordner enthalten („docs/a.md“); vorhandene Dateien bleiben. */
export async function dateiAnlegen(repo, { zweig, ordner = '', name, inhalt = '', autor, nachricht = '' }) {
  refPruefen(zweig);
  const rel = hochladePfad(name);
  const eltern = dateiPruefen(ordner);
  const ziel = eltern ? `${eltern}/${rel}` : rel;
  const alt = await kopfOderLeer(repo, zweig);
  if (alt && (await gitText(['ls-tree', alt, '--', ziel], { cwd: repo })).trim()) throw new RepoFehler(`„${rel}“ gibt es hier schon`, 409);
  const daten = Buffer.from(String(inhalt), 'utf8');
  if (daten.length > DATEI_MAX) throw new RepoFehler('Zu groß für den Editor – bitte hochladen', 413);
  const blob = (await gitText(['hash-object', '-w', '--stdin'], { cwd: repo, eingabe: daten })).trim();
  const betreff = String(nachricht || '').trim().slice(0, 500) || `${ziel} angelegt`;
  const neu = await einchecken(repo, { zweig, alt, eintraege: [{ pfad: ziel, sha: blob }], autor, betreff });
  return { pfad: ziel, sha: neu, alt, betreff };
}

/**
 * Eine vorhandene Textdatei im Zweig überschreiben – EIN Commit (Oberfläche: „Dateien wie in einem Editor bearbeiten“).
 * `basis` ist die Blob-Kennung, die der Editor beim Öffnen geladen hat: Stimmt sie nicht mehr mit dem Zweig überein,
 * wurde die Datei inzwischen (z. B. per Push) geändert – dann bricht das Speichern ab, statt fremde Arbeit zu überschreiben.
 * @returns {{pfad: string, sha: string, alt: string, betreff: string}}
 */
export async function dateiSpeichern(repo, { zweig, datei, inhalt = '', basis = '', autor, nachricht = '' }) {
  refPruefen(zweig);
  const ziel = dateiPruefen(datei);
  if (!ziel) throw new RepoFehler('Datei fehlt');
  const alt = await zweigKopf(repo, zweig);
  if (!alt) throw new RepoFehler('Diesen Zweig gibt es nicht', 400);
  const eintrag = (await gitText(['ls-tree', '--format=%(objecttype) %(objectname)', alt, '--', ziel], { cwd: repo })).trim();
  const [typ, jetzt] = eintrag.split(' ');
  if (typ !== 'blob') throw new RepoFehler('Diese Datei gibt es in diesem Zweig nicht', 404);
  if (basis && jetzt && basis !== jetzt) throw new RepoFehler('Die Datei wurde inzwischen geändert – bitte neu laden und noch einmal bearbeiten', 409);
  const daten = Buffer.from(String(inhalt), 'utf8');
  if (daten.length > DATEI_MAX) throw new RepoFehler('Zu groß für den Editor – bitte hochladen', 413);
  const blob = (await gitText(['hash-object', '-w', '--stdin'], { cwd: repo, eingabe: daten })).trim();
  if (blob === jetzt) throw new RepoFehler('Keine Änderung – die Datei liegt genau so schon im Zweig', 400);
  const betreff = String(nachricht || '').trim().slice(0, 500) || `${ziel} bearbeitet`;
  const neu = await einchecken(repo, { zweig, alt, eintraege: [{ pfad: ziel, sha: blob }], autor, betreff });
  return { pfad: ziel, sha: neu, alt, betreff };
}

/**
 * Dateien oder ganze Ordner aus einem Zweig entfernen – EIN Commit (Betreiber 25.10.2026: „wie kann ich einzelne Dateien
 * löschen“). Ordner verlieren alle Dateien darunter; im Verlauf bleibt alles erhalten.
 */
export async function entfernen(repo, { zweig, pfade, autor, nachricht = '' }) {
  refPruefen(zweig);
  const alt = await zweigKopf(repo, zweig);
  if (!alt) throw new RepoFehler('Diesen Zweig gibt es nicht', 400);
  const liste = [...new Set((Array.isArray(pfade) ? pfade : [pfade]).map((x) => dateiPruefen(x)))].filter(Boolean);
  if (!liste.length) throw new RepoFehler('Nichts zum Löschen angegeben');
  const eintraege = []; const namen = [];
  for (const pf of liste) {
    const art = (await gitText(['ls-tree', '--format=%(objecttype)', alt, '--', pf], { cwd: repo })).trim();
    if (!art) throw new RepoFehler(`„${pf}“ gibt es in diesem Zweig nicht`, 404);
    if (art === 'tree') {
      const unter = (await gitText(['ls-tree', '-r', '-z', '--name-only', alt, '--', pf], { cwd: repo })).split('\0').filter(Boolean);
      for (const u of unter) eintraege.push({ pfad: u, sha: null });
      namen.push(`${pf}/`);
    } else {
      eintraege.push({ pfad: pf, sha: null });
      namen.push(pf);
    }
  }
  const betreff = String(nachricht || '').trim().slice(0, 500) || (namen.length === 1 ? `${namen[0]} gelöscht` : `${namen.length} Einträge gelöscht`);
  const neu = await einchecken(repo, { zweig, alt, eintraege, autor, betreff });
  // Tiefster Ordner, den es danach noch gibt – leere Ordner verschwinden in Git mit ihrer letzten Datei.
  let ordner = liste[0].split('/').slice(0, -1).join('/');
  while (ordner && !(await gitText(['ls-tree', neu, '--', ordner], { cwd: repo })).trim()) ordner = ordner.split('/').slice(0, -1).join('/');
  return { sha: neu, alt, betreff, dateien: eintraege.length, ordner };
}

/** Kopf eines Zweigs (Commit) oder '' – ohne Fehler, wenn es ihn nicht gibt. */
export async function zweigKopf(repo, zweig) {
  refPruefen(zweig);
  return (await gitText(['for-each-ref', '--format=%(objectname)', `refs/heads/${zweig}`], { cwd: repo })).trim();
}

/** Relativer Pfad einer hochgeladenen Datei: keine leeren, „.“-, „..“- oder „.git“-Teile, keine Steuerzeichen. */
export function hochladePfad(rel) {
  const teile = String(rel || '').replace(/\\/g, '/').split('/').filter((t) => t !== '');
  if (!teile.length || teile.length > 64 || teile.join('/').length > 1000) throw new RepoFehler('Ungültiger Dateipfad');
  for (const t of teile) {
    if (t === '.' || t === '..' || t.toLowerCase() === '.git' || /[\x00-\x1f]/.test(t) || t.length > 255) throw new RepoFehler(`Ungültiger Dateipfad: ${rel}`);
  }
  return teile.join('/');
}

/** Datenstrom als Blob ins Repo (git hash-object -w --stdin), höchstens `max` Bytes. → {sha, groesse} */
export function blobAusStrom(repo, strom, max) {
  return new Promise((resolve, reject) => {
    const kind = spawn('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: { ...process.env, ...GIT_UMGEBUNG }, stdio: ['pipe', 'pipe', 'pipe'] });
    let groesse = 0; let aus = ''; let fehler = ''; let fertig = false;
    const abbruch = (e) => { if (fertig) return; fertig = true; kind.kill('SIGKILL'); strom.unpipe?.(kind.stdin); strom.resume?.(); reject(e); };
    strom.on('data', (d) => { groesse += d.length; if (groesse > max) abbruch(new RepoFehler(`Datei zu groß (höchstens ${Math.round(max / 1048576)} MB)`, 413)); });
    strom.on('error', (e) => abbruch(new RepoFehler(`Übertragung abgebrochen: ${e.message}`, 400)));
    kind.stdout.on('data', (d) => { aus += d; });
    kind.stderr.on('data', (d) => { fehler += d; });
    kind.stdin.on('error', () => {});
    kind.on('close', (code) => {
      if (fertig) return; fertig = true;
      const sha = aus.trim();
      if (code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return reject(new RepoFehler(`Datei nicht gespeichert: ${fehler.trim() || code}`, 500));
      resolve({ sha, groesse });
    });
    strom.pipe(kind.stdin);
  });
}

export async function groesse(repo) {
  const out = await gitText(['count-objects', '-v'], { cwd: repo }).catch(() => '');
  const kb = (k) => Number((new RegExp(`^${k}: (\\d+)`, 'm').exec(out) || [])[1] || 0);
  return (kb('size') + kb('size-pack')) * 1024;
}
