/**
 * Bornes d'un clip, calées sur les mots (SourceMs).
 *  - début : la mise en place, avec au moins l'amorce du profil avant la chute ;
 *  - fin : la fin de la réaction, plus une courte traîne dans le silence ;
 *  - jamais au milieu d'un mot ;
 *  - trop court : élargi avec les phrases voisines ; trop long : rogné sans jamais retirer
 *    la mise en place ; impossible → alerte (le moment ne pourra être que « secondaire »).
 */
import type { AnalysisSegment, TimeRange } from './types';

export type BoundaryFlag = 'trop_court' | 'contexte_trop_long';

export interface BoundaryInput {
  setup: AnalysisSegment;
  punchline: AnalysisSegment;
  reactionEnd: AnalysisSegment;
  /** Tous les segments locaux (toutes pistes, y compris non transmises). */
  segments: readonly AnalysisSegment[];
  /** Plage autorisée (contexte lointain → fin de la fenêtre). */
  range: TimeRange;
  clip: { minSeconds: number; maxSeconds: number; preferredLeadInSeconds: number };
}

export interface Boundaries {
  startMs: number;
  endMs: number;
  flags: BoundaryFlag[];
}

const TAIL_MS = 800;

function wordIntervals(segments: readonly AnalysisSegment[]): TimeRange[] {
  return segments
    .flatMap((s) =>
      s.words.length
        ? s.words
            .filter((w) => w.endMs > w.startMs)
            .map((w) => ({ startMs: w.startMs, endMs: w.endMs }))
        : [{ startMs: s.startMs, endMs: s.endMs }],
    )
    .sort((a, b) => a.startMs - b.startMs);
}

/** Vrai si l'instant tombe strictement à l'intérieur d'un mot. */
export function insideWord(words: readonly TimeRange[], t: number): TimeRange | null {
  for (const w of words) {
    if (w.startMs >= t) break;
    if (w.startMs < t && t < w.endMs) return w;
  }
  return null;
}

export function computeBoundaries(input: BoundaryInput): Boundaries {
  const { setup, punchline, reactionEnd, range } = input;
  const minMs = input.clip.minSeconds * 1000;
  const maxMs = input.clip.maxSeconds * 1000;
  const leadMs = input.clip.preferredLeadInSeconds * 1000;
  const segs = [...input.segments]
    .filter((s) => s.endMs > range.startMs && s.startMs < range.endMs)
    .sort((a, b) => a.startMs - b.startMs);
  const words = wordIntervals(segs);
  const lo = Math.max(0, range.startMs);
  const hi = range.endMs;

  /** Recule hors d'un mot (vers son début) sans sortir de la plage. */
  const snapStart = (t: number) => {
    let x = Math.max(lo, Math.round(t));
    for (let w = insideWord(words, x); w; w = insideWord(words, x)) x = Math.max(lo, w.startMs);
    return x;
  };
  /** Avance hors d'un mot (vers sa fin) sans sortir de la plage. */
  const snapEnd = (t: number) => {
    let x = Math.min(hi, Math.round(t));
    for (let w = insideWord(words, x); w; w = insideWord(words, x)) x = Math.min(hi, w.endMs);
    return x;
  };

  // 1. Début : la mise en place, et au moins l'amorce avant la chute (calée sur une phrase).
  let start = Math.min(setup.startMs, punchline.startMs - leadMs);
  if (start < setup.startMs) {
    const containing = segs.find((s) => s.startMs < start && start < s.endMs);
    if (containing) start = containing.startMs;
  }
  start = snapStart(Math.max(lo, start));
  if (start > setup.startMs) start = snapStart(setup.startMs);

  // 2. Fin : la réaction, puis une courte traîne dans le silence qui suit.
  const after = words.find((w) => w.startMs >= reactionEnd.endMs);
  const gap = after ? after.startMs - reactionEnd.endMs : TAIL_MS * 2;
  let end = snapEnd(reactionEnd.endMs + Math.min(TAIL_MS, Math.floor(gap / 2)));
  if (end < reactionEnd.endMs) end = snapEnd(reactionEnd.endMs);

  const flags: BoundaryFlag[] = [];

  // 3. Trop long : rogner le début sans jamais retirer la mise en place.
  if (end - start > maxMs) {
    if (end - setup.startMs > maxMs) {
      flags.push('contexte_trop_long');
      start = snapStart(setup.startMs);
    } else {
      const firstOk = segs.find((s) => s.startMs >= end - maxMs && s.startMs <= setup.startMs);
      start = snapStart(firstOk ? firstOk.startMs : setup.startMs);
      if (end - start > maxMs) start = snapStart(setup.startMs);
    }
  }

  // 4. Trop court : ajouter les phrases voisines, puis un peu de silence.
  while (end - start < minMs) {
    const prev = [...segs].reverse().find((s) => s.endMs <= start && s.startMs >= lo);
    const next = segs.find((s) => s.startMs >= end && s.endMs <= hi);
    const prevLen = prev ? start - prev.startMs : Infinity;
    const nextLen = next ? next.endMs - end : Infinity;
    if (prevLen === Infinity && nextLen === Infinity) break;
    if (prevLen <= nextLen && end - prev!.startMs <= maxMs) start = snapStart(prev!.startMs);
    else if (next && next.endMs - start <= maxMs) end = snapEnd(next.endMs);
    else if (prev && end - prev.startMs <= maxMs) start = snapStart(prev.startMs);
    else break;
  }
  if (end - start < minMs) {
    start = snapStart(Math.max(lo, end - minMs));
    if (end - start < minMs) end = snapEnd(Math.min(hi, start + minMs));
    if (end - start < minMs) flags.push('trop_court');
  }

  // 5. Contrôle final : un recalage sur un mot ne doit jamais faire dépasser la durée.
  if (!flags.length && end - start > maxMs) {
    let s = end - maxMs;
    for (let w = insideWord(words, s); w; w = insideWord(words, s)) s = w.endMs;
    if (s <= setup.startMs && end - s <= maxMs) start = s;
    else flags.push('contexte_trop_long');
  }
  if (!flags.length && end - start < minMs) flags.push('trop_court');
  return { startMs: start, endMs: end, flags };
}
