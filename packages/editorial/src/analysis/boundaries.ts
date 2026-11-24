/**
 * Bornes d'un clip, calées sur les mots (SourceMs).
 *  - début : la mise en place, avec au moins l'amorce du profil avant la chute ;
 *  - fin : la fin de la réaction, plus une courte traîne dans le silence ;
 *  - jamais au milieu d'un mot ;
 *  - trop court : élargi avec les phrases voisines ; trop long : rogné sans jamais retirer
 *    la mise en place ; impossible → alerte (le moment ne pourra être que « secondaire »).
 *
 * Toutes les boucles de recalage sont strictement monotones (un instant ne revient jamais en
 * arrière), donc elles se terminent toujours, même si une limite de la plage tombe à
 * l'intérieur d'un mot qui la déborde.
 */
import type { AnalysisSegment, TimeRange } from './types';

export type BoundaryFlag = 'trop_court' | 'contexte_trop_long' | 'mot_coupe';

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

export interface Snap {
  ms: number;
  /** Faux si aucun instant hors d'un mot n'existe dans la plage autour de `t`. */
  ok: boolean;
}

/**
 * Cale un instant hors de tout mot, sans sortir de [lo, hi].
 *  - `backward` : recule jusqu'au début du mot ; si ce mot commence avant `lo`, avance après lui.
 *  - `forward` : avance jusqu'à la fin du mot ; si ce mot finit après `hi`, recule avant lui.
 * Chaque phase est strictement monotone et bornée par la plage : la fonction se termine
 * toujours. Si les deux sens sont bloqués, renvoie l'instant borné avec `ok: false`.
 */
export function snapOutsideWord(
  words: readonly TimeRange[],
  t: number,
  lo: number,
  hi: number,
  prefer: 'backward' | 'forward',
): Snap {
  const start = Math.min(hi, Math.max(lo, Math.round(t)));
  const back = (): number | null => {
    let x = start;
    for (let w = insideWord(words, x); w; w = insideWord(words, x)) {
      if (w.startMs < lo) return null;
      x = w.startMs; // strictement < x
    }
    return x;
  };
  const fwd = (): number | null => {
    let x = start;
    for (let w = insideWord(words, x); w; w = insideWord(words, x)) {
      if (w.endMs > hi) return null;
      x = w.endMs; // strictement > x
    }
    return x;
  };
  const r = prefer === 'backward' ? (back() ?? fwd()) : (fwd() ?? back());
  return r === null ? { ms: start, ok: false } : { ms: r, ok: true };
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
  // La plage contient toujours le moment lui-même (mise en place → fin de la réaction).
  const lo = Math.max(0, Math.min(range.startMs, setup.startMs));
  const hi = Math.max(range.endMs, reactionEnd.endMs);

  // Le début reste dans [lo, début de la mise en place] et la fin dans [fin de la réaction, hi] :
  // un recalage ne retire jamais une partie du moment.
  /** Recule hors d'un mot (vers son début) ; repli vers l'avant sans dépasser la mise en place. */
  const snapStart = (t: number) => snapOutsideWord(words, t, lo, setup.startMs, 'backward').ms;
  /** Avance hors d'un mot (vers sa fin) ; repli vers l'arrière sans entamer la réaction. */
  const snapEnd = (t: number) => snapOutsideWord(words, t, reactionEnd.endMs, hi, 'forward').ms;

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
    const [s0, e0] = [start, end];
    if (prevLen <= nextLen && end - prev!.startMs <= maxMs) start = snapStart(prev!.startMs);
    else if (next && next.endMs - start <= maxMs) end = snapEnd(next.endMs);
    else if (prev && end - prev.startMs <= maxMs) start = snapStart(prev.startMs);
    else break;
    // Garde-fou : chaque tour doit élargir strictement, sinon on s'arrête.
    if (start > s0 || end < e0) [start, end] = [s0, e0];
    if (start === s0 && end === e0) break;
  }
  if (end - start < minMs) {
    // Un recalage ne doit jamais rétrécir le clip ni retirer une partie du moment.
    start = Math.min(start, snapStart(Math.max(lo, end - minMs)));
    if (end - start < minMs) end = Math.max(end, snapEnd(Math.min(hi, start + minMs)));
    if (end - start < minMs) flags.push('trop_court');
  }

  // 5. Contrôle final : un recalage sur un mot ne doit jamais faire dépasser la durée.
  if (!flags.length && end - start > maxMs) {
    const s = snapOutsideWord(words, end - maxMs, lo, setup.startMs, 'forward');
    if (s.ok && s.ms <= setup.startMs && end - s.ms <= maxMs) start = s.ms;
    else flags.push('contexte_trop_long');
  }
  if (!flags.length && end - start < minMs) flags.push('trop_court');
  // Une limite de la plage coupe un mot et aucun recalage n'est possible : jamais un clip.
  if (insideWord(words, start) || insideWord(words, end)) flags.push('mot_coupe');
  return { startMs: start, endMs: end, flags };
}
