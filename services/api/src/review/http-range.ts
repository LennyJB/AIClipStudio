/**
 * Requêtes HTTP partielles (`Range`) pour la lecture audio — RFC 9110, une seule plage d'octets.
 * Fonctions pures : aucune lecture de fichier.
 *
 *  - pas de `Range`, plusieurs plages, syntaxe invalide, ou `If-Range` présent → fichier entier (200) ;
 *  - `bytes=a-b`, `bytes=a-`, `bytes=-n` satisfaisables → 206 ;
 *  - début ≥ taille, suffixe nul, fin < début → 416 (`Content-Range: bytes *\/taille`).
 */
export type RangeDecision =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function decideRange(
  rangeHeader: string | undefined,
  size: number,
  ifRange?: string,
): RangeDecision {
  if (rangeHeader === undefined || ifRange !== undefined) return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(rangeHeader);
  if (!m) return { kind: 'full' }; // unité inconnue : en-tête ignoré
  const spec = m[1]!.trim();
  if (spec.includes(',')) return { kind: 'full' }; // plusieurs plages : non prises en charge
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r) return { kind: 'full' };
  const [, a, b] = r as unknown as [string, string, string];
  if (a === '' && b === '') return { kind: 'full' };
  if ((a !== '' && a.length > 15) || (b !== '' && b.length > 15)) {
    // Nombre démesuré : un début trop grand n'est pas satisfaisable ; sinon on ignore.
    return a !== '' && Number(a) > MAX_SAFE ? { kind: 'unsatisfiable' } : { kind: 'full' };
  }
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return { kind: 'unsatisfiable' };
  if (b === '') return { kind: 'partial', start, end: size - 1 };
  const end = Number(b);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

/** En-têtes propres à la décision (les en-têtes communs sont ajoutés par la route). */
export function rangeHeaders(d: RangeDecision, size: number): Record<string, string> {
  if (d.kind === 'unsatisfiable')
    return { 'content-range': `bytes */${size}`, 'content-length': '0' };
  if (d.kind === 'full') return { 'content-length': String(size) };
  return {
    'content-range': `bytes ${d.start}-${d.end}/${size}`,
    'content-length': String(d.end - d.start + 1),
  };
}
