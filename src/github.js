// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// GitHub-Zugang (1.8.0, Betreiber 20.11.2026: „einmal github hinterlegen und bei spiegel dann das repo in github auswählen“).
// Ein Token für alle GitHub-Spiegel; diese Datei spricht nur mit der GitHub-API (fester Host, kein frei wählbares Ziel).
// Was und wann übertragen wird, entscheidet der Betreiber am Spiegel (siehe spiegel.js).

export const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NEU_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const fehler = (text, status = 400) => Object.assign(new Error(text), { status, klar: true });

/** „owner/name“ prüfen; „.“/„..“ und „.git“-Endungen sind keine Repos. */
export function repoPruefen(repo) {
  const r = String(repo || '').trim();
  if (!REPO_NAME.test(r) || r.split('/').some((t) => t === '.' || t === '..') || /\.git$/i.test(r)) throw fehler('Ungültiges GitHub-Repo (erwartet: besitzer/name)');
  return r;
}

/** Name für ein neues Repo prüfen. */
export function neuNamePruefen(name) {
  const n = String(name || '').trim();
  if (!NEU_NAME.test(n) || n === '.' || n === '..' || /\.git$/i.test(n)) throw fehler('Repo-Name: nur Buchstaben, Ziffern, Punkt, Minus und Unterstrich');
  return n;
}

export class GitHub {
  /** @param {{api?: string, web?: string}} o api = REST-API, web = Adresse für git push (nur Tests biegen beides um) */
  constructor({ api = 'https://api.github.com', web = 'https://github.com', uploads = 'https://uploads.github.com' } = {}) {
    this.api = api.replace(/\/+$/, '');
    this.web = web.replace(/\/+$/, '');
    this.uploads = uploads.replace(/\/+$/, '');
  }

  pushAdresse(repo) { return `${this.web}/${repoPruefen(repo)}.git`; }

  async anfrage(token, methode, weg, daten) {
    let r;
    try {
      r = await fetch(this.api + weg, {
        method: methode,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'FAH-Git',
          ...(daten ? { 'Content-Type': 'application/json' } : {}) },
        body: daten ? JSON.stringify(daten) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw fehler('GitHub nicht erreichbar – Netz prüfen', 502);
    }
    if (r.status === 401) throw fehler('GitHub hat den Token abgelehnt – abgelaufen oder falsch? Unter Einstellungen → GitHub neu hinterlegen');
    if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') throw fehler('GitHub-Abfragegrenze erreicht – in einer Stunde wieder', 429);
    if (r.status === 403 || r.status === 429) {
      // „secondary rate limit“: zu viele Anlege-/Löschvorgänge kurz hintereinander – GitHub sperrt das Anlegen kurzzeitig
      const text = await r.clone().text().catch(() => '');
      if (/secondary rate limit|abuse/i.test(text) || r.status === 429) throw fehler('GitHub bremst gerade (zu viele Vorgänge kurz hintereinander) – in einigen Minuten noch einmal versuchen', 429);
    }
    return r;
  }

  /** Token prüfen → Kontoname. */
  async konto(token) {
    const r = await this.anfrage(token, 'GET', '/user');
    if (!r.ok) throw fehler(`GitHub antwortet mit ${r.status}`, 502);
    const d = await r.json();
    if (!d || typeof d.login !== 'string') throw fehler('GitHub hat kein Konto gemeldet', 502);
    return { login: d.login, name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 100) : d.login };
  }

  /** Alle Repos, an die der Token herankommt (eigene, als Mitarbeiter, aus Organisationen). */
  async repos(token) {
    const liste = [];
    for (let seite = 1; seite <= 30; seite++) {
      const r = await this.anfrage(token, 'GET', `/user/repos?per_page=100&page=${seite}&sort=full_name&affiliation=owner,collaborator,organization_member`);
      if (!r.ok) throw fehler(`GitHub antwortet mit ${r.status}`, 502);
      const d = await r.json();
      if (!Array.isArray(d)) break;
      for (const x of d) {
        if (!x || typeof x.full_name !== 'string' || !REPO_NAME.test(x.full_name)) continue;
        liste.push({ repo: x.full_name, privat: !!x.private, standard: x.default_branch || '', schreiben: !x.permissions || x.permissions.push !== false,
          beschreibung: String(x.description || '').slice(0, 200), archiviert: !!x.archived });
      }
      if (d.length < 100) break;
    }
    return liste.sort((a, b) => a.repo.localeCompare(b.repo));
  }

  /** Sichtbarkeit eines Repos → {privat}. */
  async repoInfo(token, repo) {
    const r = await this.anfrage(token, 'GET', `/repos/${repoPruefen(repo)}`);
    if (r.status === 404) throw fehler(`Repo ${repo} auf GitHub nicht gefunden oder der Token sieht es nicht`, 404);
    if (!r.ok) throw fehler(`GitHub antwortet mit ${r.status}`, 502);
    const d = await r.json();
    return { privat: d.private !== false };
  }

  /** Repo öffentlich oder privat stellen (1.9.0, nur für bereinigte Spiegel). */
  async sichtbarkeitSetzen(token, repo, oeffentlich) {
    const r = await this.anfrage(token, 'PATCH', `/repos/${repoPruefen(repo)}`, { private: !oeffentlich });
    if (r.status === 403 || r.status === 404) throw fehler('Der Token darf die Sichtbarkeit nicht ändern (klassisch: „repo“; fein: „Administration: Lesen und Schreiben“)');
    if (!r.ok) throw fehler(`GitHub antwortet mit ${r.status}`, 502);
    const d = await r.json();
    return { privat: d.private !== false };
  }

  /**
   * Release anlegen (1.9.2, Betreiber: „für Mac-Apps nur die fertige App auf GitHub“) → {id, upload, url}.
   * Der Tag entsteht auf dem angegebenen Zweig (dem bereinigten Stand).
   */
  async releaseAnlegen(token, repo, { tag, name, text, zweig }) {
    const r = await this.anfrage(token, 'POST', `/repos/${repoPruefen(repo)}/releases`, { tag_name: tag, name: name || tag, body: text || '', target_commitish: zweig, draft: false, prerelease: false });
    if (r.status === 422) throw fehler(`Version „${tag}“ gibt es auf GitHub schon – andere Versionsnummer wählen`, 409);
    if (r.status === 403 || r.status === 404) throw fehler('Der Token darf hier keine Releases anlegen (klassisch: „repo“; fein: „Contents: Lesen und Schreiben“)');
    if (!r.ok) throw fehler(`GitHub antwortet mit ${r.status}`, 502);
    const d = await r.json();
    const upload = String(d.upload_url || '').replace(/\{[^}]*\}$/, '');
    if (!upload.startsWith(`${this.uploads}/`)) throw fehler('GitHub hat eine unerwartete Upload-Adresse gemeldet', 502);
    return { id: d.id, upload, url: d.html_url };
  }

  /**
   * Nur das neueste Release behalten (1.10.0, Betreiber 23.11.2026: „alte releases dürfen niemals auf github bleiben“):
   * alle anderen Releases UND alle Tags außer `behalten` löschen – ein gelöschtes Release lässt seinen Tag sonst stehen.
   * Nur für „Öffentlicher Stand“: dort überträgt FAH-Git nie eigene Git-Tags, es gibt nur Release-Tags. Fehler werden
   * einzeln gesammelt (das neue Release steht da schon). → {releases: [tag…], tags: [name…], fehler: [text…]}
   */
  async aeltereReleasesEntfernen(token, repo, behalten) {
    const r = repoPruefen(repo);
    const aus = { releases: [], tags: [], fehler: [] };
    const liste = await this.anfrage(token, 'GET', `/repos/${r}/releases?per_page=100`);
    if (!liste.ok) { aus.fehler.push(`Releases nicht lesbar (${liste.status})`); return aus; }
    for (const x of await liste.json()) {
      if (!x || x.tag_name === behalten || !Number.isInteger(x.id)) continue;
      const d = await this.anfrage(token, 'DELETE', `/repos/${r}/releases/${x.id}`);
      if (d.status === 204 || d.status === 404) aus.releases.push(String(x.tag_name)); else aus.fehler.push(`Release ${x.tag_name}: ${d.status}`);
    }
    const tags = await this.anfrage(token, 'GET', `/repos/${r}/tags?per_page=100`);
    if (!tags.ok) { aus.fehler.push(`Tags nicht lesbar (${tags.status})`); return aus; }
    for (const t of await tags.json()) {
      const name = String((t && t.name) || '');
      if (!name || name === behalten) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(name) || name.includes('..')) { aus.fehler.push(`Tag „${name}“: ungewöhnlicher Name, nicht gelöscht`); continue; }
      const d = await this.anfrage(token, 'DELETE', `/repos/${r}/git/refs/tags/${name.split('/').map(encodeURIComponent).join('/')}`);
      if (d.status === 204 || d.status === 404 || d.status === 422) aus.tags.push(name); else aus.fehler.push(`Tag ${name}: ${d.status}`);
    }
    return aus;
  }

  /** Ein gerade angelegtes Release samt Tag wieder löschen (z. B. wenn sich die Datei während des Hochladens änderte). */
  async releaseLoeschen(token, repo, id, tag) {
    const r = repoPruefen(repo);
    await this.anfrage(token, 'DELETE', `/repos/${r}/releases/${Number(id)}`).catch(() => {});
    if (tag) await this.anfrage(token, 'DELETE', `/repos/${r}/git/refs/tags/${String(tag).split('/').map(encodeURIComponent).join('/')}`).catch(() => {});
  }

  /** Datei als Strom an ein Release hängen (ohne Zwischendatei). */
  async releaseDatei(token, upload, dateiname, strom, groesse, typ = 'application/octet-stream') {
    if (!upload.startsWith(`${this.uploads}/`)) throw fehler('Unerwartete Upload-Adresse', 400);
    let r;
    try {
      r = await fetch(`${upload}?name=${encodeURIComponent(dateiname)}`, {
        method: 'POST', body: strom, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(3 * 60 * 60_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'FAH-Git', 'Content-Type': typ, 'Content-Length': String(groesse) },
      });
    } catch { throw fehler('Hochladen zu GitHub abgebrochen – Netz prüfen', 502); }
    if (!r.ok) throw fehler(`GitHub hat die Datei abgelehnt (${r.status})`, 502);
    const d = await r.json();
    return { url: d.browser_download_url || '' };
  }

  /** Neues PRIVATES Repo im eigenen Konto anlegen (leer, ohne README). */
  async anlegen(token, name, beschreibung = '') {
    const n = neuNamePruefen(name);
    const r = await this.anfrage(token, 'POST', '/user/repos', { name: n, private: true, auto_init: false, description: String(beschreibung || '').slice(0, 300) });
    if (r.status === 422) throw fehler(`Auf GitHub gibt es „${n}“ schon – bitte aus der Liste wählen`, 409);
    if (r.status === 403 || r.status === 404) throw fehler('Der Token darf keine Repos anlegen (klassisch: Recht „repo“; fein: „Administration: Lesen und Schreiben“)');
    if (!r.ok) throw fehler(`GitHub antwortet mit ${r.status}`, 502);
    const d = await r.json();
    return { repo: repoPruefen(d.full_name) };
  }
}

/** GitHub-eigene Ablehnungsgründe beim Push in Alltagssprache, sonst null. */
export function githubGrund(text) {
  const t = String(text || '');
  if (/refusing to allow .* to create or update workflow|without [`']?workflow[`']? scope/i.test(t)) return 'GitHub nimmt Änderungen an .github/workflows nur mit Token-Recht „workflow“';
  if (/remote:.*\bGH001\b|exceeds GitHub's file size limit|Large files detected/i.test(t)) return 'GitHub nimmt keine Dateien über 100 MB';
  if (/remote:.*\bGH013\b|Push cannot contain secrets/i.test(t)) return 'GitHub hat ein Geheimnis (Schlüssel/Kennwort) im Code erkannt und blockiert (Push Protection) – oder eine Repo-Regel verbietet den Push';
  if (/Repository not found/i.test(t)) return 'Repo auf GitHub nicht gefunden oder der Token sieht es nicht';
  if (/Permission to .* denied|403/i.test(t) && /github/i.test(t)) return 'Der Token darf in dieses Repo nicht schreiben';
  return null;
}
