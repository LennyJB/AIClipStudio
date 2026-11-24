/**
 * Consolidation des propositions d'une analyse : les moments qui se chevauchent ou qui
 * racontent la même blague sont fusionnés dans le meilleur. Aucun quota, et un moment
 * « secondaire » n'est jamais promu en clip.
 */
import { wordSimilarity } from './text';

export interface ConsolidationItem {
  id: string;
  tier: 'clip' | 'secondary';
  relevance: number;
  reliability: number;
  startMs: number;
  endMs: number;
  punchlineMs: number;
  punchlineQuote: string;
}

const DUPLICATE_SIMILARITY = 0.6;
const DUPLICATE_DISTANCE_MS = 10 * 60_000;

function overlapRatio(a: ConsolidationItem, b: ConsolidationItem): number {
  const inter = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const union = Math.max(a.endMs, b.endMs) - Math.min(a.startMs, b.startMs);
  return union > 0 ? inter / union : 0;
}

/** Renvoie, pour chaque proposition fusionnée, l'identifiant de celle qui la remplace. */
export function consolidate(items: readonly ConsolidationItem[]): Map<string, string> {
  const ordered = [...items].sort(
    (a, b) =>
      (a.tier === b.tier ? 0 : a.tier === 'clip' ? -1 : 1) ||
      b.relevance - a.relevance ||
      b.reliability - a.reliability ||
      a.startMs - b.startMs,
  );
  const kept: ConsolidationItem[] = [];
  const mergedInto = new Map<string, string>();
  for (const p of ordered) {
    const target = kept.find(
      (k) =>
        overlapRatio(k, p) >= 0.5 ||
        (k.startMs <= p.punchlineMs && p.punchlineMs <= k.endMs) ||
        (p.startMs <= k.punchlineMs && k.punchlineMs <= p.endMs) ||
        (Math.abs(k.punchlineMs - p.punchlineMs) <= DUPLICATE_DISTANCE_MS &&
          wordSimilarity(k.punchlineQuote, p.punchlineQuote) >= DUPLICATE_SIMILARITY),
    );
    if (target) mergedInto.set(p.id, target.id);
    else kept.push(p);
  }
  return mergedInto;
}
