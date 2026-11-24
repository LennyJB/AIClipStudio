/** Normalisation de texte pour comparer des citations (casse, accents, ponctuation, espaces). */
export function normalizeForQuote(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** La citation apparaît-elle mot à mot (mots entiers) dans le texte ? */
export function quoteMatches(quote: string, text: string): boolean {
  const q = normalizeForQuote(quote);
  if (q.length < 2) return false;
  return ` ${normalizeForQuote(text)} `.includes(` ${q} `);
}

/** Similarité de Dice sur les mots normalisés (0 à 1). */
export function wordSimilarity(a: string, b: string): number {
  const ta = normalizeForQuote(a).split(' ').filter(Boolean);
  const tb = normalizeForQuote(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common += 1;
      counts.set(t, c - 1);
    }
  }
  return (2 * common) / (ta.length + tb.length);
}
