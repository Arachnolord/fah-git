// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rechte je Ordner/Projekt (Betreiber 26.10.2026: Nicht-Admins sahen den ganzen Baum). Administratoren dürfen alles.
// Alle anderen haben Freigaben {pfad, recht}: gilt für den Pfad und alles darunter, das stärkste passende Recht zählt,
// '' = alles. Ohne Freigabe: nichts. Ein Zugangsschlüssel „Nur lesen“ deckelt zusätzlich auf Lesen.

export const KEIN = 0;
export const LESEN = 1;
export const SCHREIBEN = 2;
export const RECHTE = { lesen: LESEN, schreiben: SCHREIBEN };

/** Liegt `pfad` in `basis` (oder ist es)? '' umfasst alles. */
export const liegtIn = (pfad, basis) => !basis || pfad === basis || String(pfad).startsWith(`${basis}/`);

/** Recht eines Nutzers auf einen Ordner- oder Projektpfad: KEIN, LESEN oder SCHREIBEN. */
export function recht(nutzer, pfad) {
  if (!nutzer) return KEIN;
  let r = KEIN;
  if (nutzer.admin) r = SCHREIBEN;
  else for (const f of nutzer.freigaben || []) if (liegtIn(pfad, f.pfad)) r = Math.max(r, RECHTE[f.recht] || KEIN);
  return nutzer.leseSchluessel ? Math.min(r, LESEN) : r;
}

/** Ordner ist nur Weg zu etwas Freigegebenem darunter: sichtbar mit Namen, aber ohne Geschwister und Beschreibung. */
export function istWeg(nutzer, pfad) {
  if (!nutzer) return false;
  if (nutzer.admin || !pfad) return true;
  return (nutzer.freigaben || []).some((f) => f.pfad && f.pfad.startsWith(`${pfad}/`));
}

/** Baum (aus Baum.liste) auf das Sichtbare kürzen. */
export function baumFiltern(knoten, nutzer) {
  if (nutzer && nutzer.admin) return knoten;
  const lauf = (k) => {
    const ordner = [];
    for (const o of k.ordner) {
      if (recht(nutzer, o.pfad) >= LESEN) ordner.push(o);
      else if (istWeg(nutzer, o.pfad)) ordner.push({ ...o, beschreibung: '', weg: true, ...lauf(o) });
    }
    return { ordner, projekte: k.projekte.filter((p) => recht(nutzer, p.pfad) >= LESEN) };
  };
  return lauf(knoten);
}

/** Nach dem Verschieben: Freigaben auf den alten Pfad (oder darunter) zeigen auf den neuen. */
export function freigabenUmziehen(freigaben, alt, neu) {
  let geaendert = false;
  for (const f of freigaben || []) {
    if (f.pfad && liegtIn(f.pfad, alt)) { f.pfad = neu + f.pfad.slice(alt.length); geaendert = true; }
  }
  return geaendert;
}
