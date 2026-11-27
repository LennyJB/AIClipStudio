/**
 * Segmentation effective et son usage par l'analyse (étape 9).
 *
 * Règle : la correction du créateur l'emporte TOUJOURS sur la détection automatique (elle la
 * remplace entièrement, confiance 1). Sans correction, la détection automatique s'applique.
 * Sans aucune segmentation (enregistrement jamais analysé), l'analyse se comporte exactement
 * comme avant l'étape 9 (gaming).
 */
import {
  AppError,
  CONTENT_TYPE_LABELS,
  type ContentProfile,
  type ContentSegmentInput,
  type ContentType,
  type SegmentContentType,
} from '@acs/shared';
import { formatClock } from '../analysis/format';
import type { TimeRange } from '../analysis/types';
import { LOCAL_SCORE_WEIGHTS, type LocalScoreWeights, type WeightsAt } from '../analysis/windows';

export interface EffectiveContentSegment {
  startMs: number;
  endMs: number;
  type: SegmentContentType;
  confidence: number;
  source: 'auto' | 'manual';
}

/** Tolérance sur la fin du dernier segment (durée arrondie côté interface). */
const END_TOLERANCE_MS = 1000;

/**
 * Valide une correction : segments contigus qui couvrent tout l'enregistrement, sans
 * chevauchement ni trou. Les voisins de même type sont fusionnés.
 */
export function normalizeManualSegments(
  input: readonly ContentSegmentInput[],
  durationMs: number,
): EffectiveContentSegment[] {
  if (input.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Au moins un segment est requis');
  }
  const sorted = [...input].sort((a, b) => a.startMs - b.startMs);
  if (sorted[0]!.startMs !== 0) {
    throw new AppError('VALIDATION_FAILED', 'Le premier segment doit commencer à 0');
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startMs !== sorted[i - 1]!.endMs) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Segments non contigus à ${formatClock(sorted[i - 1]!.endMs, false)} (trou ou chevauchement)`,
      );
    }
  }
  const last = sorted.at(-1)!;
  if (Math.abs(last.endMs - durationMs) > END_TOLERANCE_MS) {
    throw new AppError('VALIDATION_FAILED', "Les segments doivent couvrir tout l'enregistrement", {
      details: { endMs: last.endMs, durationMs },
    });
  }
  const out: EffectiveContentSegment[] = [];
  for (const s of sorted) {
    const prev = out.at(-1);
    if (prev && prev.type === s.type) prev.endMs = s.endMs;
    else
      out.push({
        startMs: s.startMs,
        endMs: s.endMs,
        type: s.type,
        confidence: s.type === 'unknown' ? 0 : 1,
        source: 'manual',
      });
  }
  out.at(-1)!.endMs = durationMs;
  return out;
}

/** Type au temps donné (segment qui le contient ; le dernier pour la fin exacte). */
export function contentTypeAt(
  segments: readonly EffectiveContentSegment[],
  ms: number,
): SegmentContentType {
  for (const s of segments) if (ms >= s.startMs && ms < s.endMs) return s.type;
  return segments.at(-1)?.type ?? 'unknown';
}

/**
 * La segmentation change-t-elle l'analyse ? Seulement si un passage est d'un format connu autre
 * que le gaming : un enregistrement entièrement gaming (ou indéterminé) est analysé à l'identique.
 */
export function contentMatters(segments: readonly EffectiveContentSegment[] | null): boolean {
  return !!segments?.some((s) => s.type !== 'gaming' && s.type !== 'unknown');
}

/** Pondération du repérage local selon le format de chaque case. */
export function contentWeightsAt(
  segments: readonly EffectiveContentSegment[],
  profiles: Readonly<Record<ContentType, ContentProfile>>,
): WeightsAt {
  const of = (t: SegmentContentType): LocalScoreWeights =>
    t === 'unknown' ? LOCAL_SCORE_WEIGHTS : (profiles[t].localWeights ?? LOCAL_SCORE_WEIGHTS);
  // Le format d'une case est celui de son milieu.
  return (binStartMs) => of(contentTypeAt(segments, binStartMs + 2500));
}

const describeConfidence = (s: EffectiveContentSegment) =>
  s.type === 'unknown'
    ? 'format non établi : ne présumer d’aucun format'
    : s.source === 'manual'
      ? 'confirmé par le créateur'
      : `détection automatique, confiance ${s.confidence.toFixed(2)}`;

/**
 * Bloc de contexte ajouté au message de l'analyse éditoriale pour un passage. C'est un
 * CONTEXTE : il oriente les critères (ce qui fait un bon moment dans ce format), il ne prouve
 * rien et ne remplace jamais ce que disent la transcription et les images.
 */
export function contentContextBlock(
  range: TimeRange,
  segments: readonly EffectiveContentSegment[],
  profiles: Readonly<Record<ContentType, ContentProfile>>,
): string {
  const hit = segments.filter((s) => s.endMs > range.startMs && s.startMs < range.endMs);
  const lines = [
    'Type de contenu de ce passage (contexte seulement, jamais une preuve ; en cas de contradiction, la transcription prime) :',
  ];
  for (const s of hit) {
    lines.push(
      `- ${formatClock(Math.max(s.startMs, range.startMs), false)}–${formatClock(Math.min(s.endMs, range.endMs), false)} ${CONTENT_TYPE_LABELS[s.type]} (${describeConfidence(s)})`,
    );
  }
  const types = [...new Set(hit.map((s) => s.type))].filter(
    (t): t is ContentType => t !== 'unknown',
  );
  if (hit.some((s) => s.type !== 'gaming')) {
    lines.push(
      'La section « Jeu » des consignes ne concerne que les passages de jeu ; les images éventuelles montrent la zone cadrée de l’écran, pas forcément du gameplay.',
    );
  }
  for (const t of types) {
    const p = profiles[t];
    lines.push(`Format ${p.displayName} : ${p.context}`);
    for (const h of p.analysisHints) lines.push(`  · ${h}`);
  }
  return lines.join('\n');
}
