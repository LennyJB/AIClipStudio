/**
 * Découpage d'une piste en blocs pour la transcription.
 *
 *   |<- chevauchement ->|<-------- zone centrale -------->|<- chevauchement ->|
 *   readStart           coreStart = checkpoint            coreEnd             readEnd
 *
 * - Whisper transcrit [readStart, readEnd[ : les paroles proches des frontières
 *   sont entendues en entier, avec leur contexte.
 * - Un segment appartient au bloc dont la ZONE CENTRALE contient son point central
 *   (milieu entre début et fin) : chaque phrase est attribuée à un seul bloc.
 *   Tolérance : Whisper peut décaler un même passage de quelques centaines de ms
 *   d'un bloc à l'autre. Un point central à moins de `boundaryToleranceMs` de la
 *   zone centrale est donc aussi accepté ; s'il a déjà été enregistré par le bloc
 *   voisin, la déduplication temporelle l'écarte. Résultat : ni perte, ni doublon.
 * - Après enregistrement, le checkpoint avance jusqu'à coreEnd.
 * - Condition : le chevauchement doit dépasser la durée du plus long segment
 *   (Whisper : 30 s au plus), sinon une phrase peut être coupée par la fenêtre lue.
 * Tous les temps sont en millisecondes du temps SOURCE (SourceMs).
 */

export interface ChunkingOptions {
  /** Durée de la zone centrale (ms). */
  coreMs: number;
  /** Chevauchement avant ET après la zone centrale (ms). */
  overlapMs: number;
  /** Marge d'attribution autour de la zone centrale (ms). */
  boundaryToleranceMs: number;
}

export interface BlockPlan {
  coreStartMs: number;
  coreEndMs: number;
  readStartMs: number;
  readEndMs: number;
  isLast: boolean;
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
  /** Probabilité BRUTE fournie par Whisper (non calibrée). */
  probability: number;
}

export interface RawSegment {
  startMs: number;
  endMs: number;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
  words: WordTiming[];
}

export function validateChunking(o: ChunkingOptions) {
  if (!Number.isInteger(o.coreMs) || o.coreMs < 10_000)
    throw new RangeError('coreMs doit être ≥ 10 000 ms');
  if (!Number.isInteger(o.overlapMs) || o.overlapMs < 0 || o.overlapMs >= o.coreMs) {
    throw new RangeError('overlapMs doit être ≥ 0 et < coreMs');
  }
  if (
    !Number.isInteger(o.boundaryToleranceMs) ||
    o.boundaryToleranceMs < 0 ||
    2 * o.boundaryToleranceMs > o.overlapMs
  ) {
    throw new RangeError('boundaryToleranceMs doit être ≥ 0 et ≤ overlapMs / 2');
  }
}

/** Bloc à traiter à partir du checkpoint, ou null si la piste est terminée. */
export function planBlock(
  checkpointMs: number,
  durationMs: number,
  o: ChunkingOptions,
): BlockPlan | null {
  validateChunking(o);
  if (checkpointMs >= durationMs) return null;
  const coreEndMs = Math.min(checkpointMs + o.coreMs, durationMs);
  return {
    coreStartMs: checkpointMs,
    coreEndMs,
    readStartMs: Math.max(0, checkpointMs - o.overlapMs),
    readEndMs: Math.min(durationMs, coreEndMs + o.overlapMs),
    isLast: coreEndMs >= durationMs,
  };
}

/** Tous les blocs d'une piste (progression, tests). */
export function planAllBlocks(durationMs: number, o: ChunkingOptions): BlockPlan[] {
  const out: BlockPlan[] = [];
  let checkpoint = 0;
  for (let b = planBlock(checkpoint, durationMs, o); b; b = planBlock(checkpoint, durationMs, o)) {
    out.push(b);
    checkpoint = b.coreEndMs;
  }
  return out;
}

export const midpointMs = (s: { startMs: number; endMs: number }) => (s.startMs + s.endMs) / 2;

/**
 * Segments attribués au bloc : point central dans [coreStart − tolérance, coreEnd + tolérance[
 * (bornes de la piste exclues de la tolérance). Les segments vides ou de durée nulle sont
 * écartés ; le résultat est trié chronologiquement. À compléter par dedupeSegments().
 */
export function selectCoreSegments<T extends RawSegment>(
  segments: readonly T[],
  block: BlockPlan,
  toleranceMs: number,
): T[] {
  const from = block.coreStartMs - toleranceMs;
  const to = block.isLast ? Infinity : block.coreEndMs + toleranceMs;
  return segments
    .filter((s) => s.text.trim() !== '' && s.endMs > s.startMs)
    .filter((s) => {
      const m = midpointMs(s);
      return m >= from && m < to;
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/* ------------------------------------------------------------------ */
/* Déduplication temporelle approximative                              */
/* ------------------------------------------------------------------ */

export interface DedupOptions {
  /** Chevauchement minimal (rapporté à la durée du plus court) pour envisager un doublon. */
  minOverlapRatio: number;
  /** Similarité de texte minimale quand le chevauchement est seulement partiel. */
  minTextSimilarity: number;
  /** Chevauchement quasi total : un texte réécrit par Whisper suffit… */
  strongOverlapRatio: number;
  /** …à condition de partager au moins ce niveau de similarité (jamais un texte totalement différent). */
  minTextSimilarityStrong: number;
}

export const DEFAULT_DEDUP: DedupOptions = {
  minOverlapRatio: 0.5,
  minTextSimilarity: 0.5,
  strongOverlapRatio: 0.85,
  minTextSimilarityStrong: 0.2,
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Similarité de Dice sur les mots normalisés (0 à 1). */
export function textSimilarity(a: string, b: string): number {
  const ta = normalizeText(a).split(' ').filter(Boolean);
  const tb = normalizeText(b).split(' ').filter(Boolean);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  return (2 * common) / (ta.length + tb.length);
}

export function overlapRatio(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
) {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  const shortest = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return overlap > 0 && shortest > 0 ? overlap / shortest : 0;
}

export function isDuplicate(
  candidate: { startMs: number; endMs: number; text: string },
  existing: { startMs: number; endMs: number; text: string },
  o: DedupOptions = DEFAULT_DEDUP,
): boolean {
  const ratio = overlapRatio(candidate, existing);
  if (ratio < o.minOverlapRatio) return false;
  const sim = textSimilarity(candidate.text, existing.text);
  // Deux répliques DIFFÉRENTES ne sont jamais confondues, même très proches dans le temps.
  return (
    sim >= o.minTextSimilarity ||
    (ratio >= o.strongOverlapRatio && sim >= o.minTextSimilarityStrong)
  );
}

/**
 * Écarte les candidats qui doublonnent un segment déjà enregistré (ou un candidat
 * déjà retenu). Filet de sécurité : l'attribution par point central évite déjà
 * l'essentiel des doublons, mais Whisper peut décaler un même passage d'un bloc à l'autre.
 */
export function dedupeSegments<T extends { startMs: number; endMs: number; text: string }>(
  candidates: readonly T[],
  existing: readonly { startMs: number; endMs: number; text: string }[],
  o: DedupOptions = DEFAULT_DEDUP,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  const reference = [...existing];
  for (const c of candidates) {
    if (reference.some((e) => isDuplicate(c, e, o))) dropped.push(c);
    else {
      kept.push(c);
      reference.push(c);
    }
  }
  return { kept, dropped };
}
