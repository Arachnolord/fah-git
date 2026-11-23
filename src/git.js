// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Git-Aufrufe: immer als Argumentliste (nie über eine Shell), ohne Rückfragen, mit Zeit- und Größenbegrenzung.

import { spawn } from 'node:child_process';

export const GIT_UMGEBUNG = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
  LANG: 'C',
});

export class GitFehler extends Error {
  constructor(text, { code, stderr } = {}) {
    super(text);
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Git ausführen. `ausgabeMax` begrenzt die gelesene Ausgabe (Bytes); `eingabe` wird nach stdin geschrieben.
 * @returns {Promise<{stdout: Buffer, stderr: string, abgeschnitten: boolean}>}
 */
export function git(args, { cwd, eingabe, env, zeitlimitMs = 120_000, ausgabeMax = 64 * 1024 * 1024, erlaubteCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const kind = spawn('git', args, { cwd, env: { ...process.env, ...GIT_UMGEBUNG, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const teile = []; let laenge = 0; let abgeschnitten = false; let stderr = '';
    const uhr = setTimeout(() => { kind.kill('SIGKILL'); }, zeitlimitMs);
    kind.stdout.on('data', (d) => {
      if (laenge >= ausgabeMax) { abgeschnitten = true; return; }
      const rest = ausgabeMax - laenge;
      if (d.length > rest) { teile.push(d.subarray(0, rest)); laenge = ausgabeMax; abgeschnitten = true; kind.kill('SIGTERM'); return; }
      teile.push(d); laenge += d.length;
    });
    kind.stderr.on('data', (d) => { if (stderr.length < 64 * 1024) stderr += d.toString('utf8'); });
    kind.on('error', (e) => { clearTimeout(uhr); reject(new GitFehler(`git konnte nicht starten: ${e.message}`)); });
    kind.on('close', (code, signal) => {
      clearTimeout(uhr);
      const stdout = Buffer.concat(teile);
      if (abgeschnitten) return resolve({ stdout, stderr, abgeschnitten });
      if (signal) return reject(new GitFehler(`git ${args[0]} abgebrochen (${signal})`, { stderr }));
      if (!erlaubteCodes.includes(code)) return reject(new GitFehler(`git ${args[0]} fehlgeschlagen: ${stderr.trim().split('\n').pop() || code}`, { code, stderr }));
      resolve({ stdout, stderr, abgeschnitten });
    });
    kind.stdin.on('error', () => {});
    if (eingabe != null) kind.stdin.end(eingabe); else kind.stdin.end();
  });
}

/** Git ausführen und stdout als Text liefern. */
export async function gitText(args, optionen) {
  return (await git(args, optionen)).stdout.toString('utf8');
}

/** Alle Zweige und Tags eines Repos: Map ref → sha. */
export async function refs(repo) {
  const out = await gitText(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags'], { cwd: repo });
  const m = new Map();
  for (const zeile of out.split('\n')) {
    if (!zeile) continue;
    const [ref, sha] = zeile.split(' ');
    m.set(ref, sha);
  }
  return m;
}
