/**
 * Calculs purs de la timeline (docs/plan-etape-7.md §4) : conversions pixels ↔ millisecondes,
 * aimantation (tête de lecture, bords de segments, frontières de mots, sous-titres), rognage et
 * déplacement. Aucune règle de montage ici : le résultat devient une opération validée par le
 * réducteur partagé.
 */
import {
  placeSegments,
  resolveTiming,
  segmentsV2,
  sourceToEdit,
  type ClipProjectV2,
  type SegmentV2,
  type SourceMs,
  type Timing,
} from '@acs/timeline';

/** Durée minimale d'un segment créé ou rogné dans l'éditeur (ms). */
export const MIN_SEGMENT_MS = 100;
/** Distance d'aimantation (pixels). */
export const SNAP_PX = 8;

export const msToPx = (ms: number, pxPerSec: number) => (ms * pxPerSec) / 1000;
export const pxToMs = (px: number, pxPerSec: number) => (px * 1000) / pxPerSec;

export type SnapKind = 'playhead' | 'segment' | 'word' | 'caption';
export interface SnapTarget {
  ms: number;
  kind: SnapKind;
}

/** Cibles d'aimantation en temps montage. */
export function snapTargets(d: ClipProjectV2, playheadMs: number): SnapTarget[] {
  const segs = segmentsV2(d.segments);
  const out: SnapTarget[] = [{ ms: playheadMs, kind: 'playhead' }];
  for (const p of placeSegments(segs)) {
    out.push({ ms: p.editStartMs, kind: 'segment' }, { ms: p.editEndMs, kind: 'segment' });
  }
  for (const it of d.captions.items) {
    for (const w of it.words) {
      for (const pos of sourceToEdit(segs, w.srcStartMs as SourceMs))
        out.push({ ms: pos.editMs, kind: 'word' });
      for (const pos of sourceToEdit(segs, w.srcEndMs as SourceMs))
        out.push({ ms: pos.editMs, kind: 'word' });
    }
    const r = resolveTiming(segs, {
      anchor: 'source',
      srcStartMs: it.srcStartMs as SourceMs,
      srcEndMs: it.srcEndMs as SourceMs,
    }).ranges;
    for (const x of r)
      out.push({ ms: x.editStartMs, kind: 'caption' }, { ms: x.editEndMs, kind: 'caption' });
  }
  return out;
}

/** Instant aimanté : la cible la plus proche à moins de SNAP_PX, sinon l'instant tel quel. */
export function snap(
  ms: number,
  targets: readonly SnapTarget[],
  pxPerSec: number,
  enabled = true,
): { ms: number; target: SnapTarget | null } {
  if (!enabled) return { ms, target: null };
  let best: SnapTarget | null = null;
  let dist = Infinity;
  for (const t of targets) {
    const d = Math.abs(msToPx(t.ms - ms, pxPerSec));
    if (d < dist) {
      dist = d;
      best = t;
    }
  }
  return best && dist <= SNAP_PX ? { ms: best.ms, target: best } : { ms, target: null };
}

/** Segment placé contenant l'instant montage `t` (bord de fin exclu). */
export function segmentAt(d: ClipProjectV2, t: number) {
  return (
    placeSegments(segmentsV2(d.segments)).find((p) => p.editStartMs <= t && t < p.editEndMs) ?? null
  );
}

/**
 * Rognage d'un bord : déplacement `deltaMs` (temps montage) du début ou de la fin.
 * Segment source : bornes source dans la fenêtre éditable, durée ≥ MIN_SEGMENT_MS ; arrêt sur
 * image ou vide : durée ≥ MIN_SEGMENT_MS. Retourne les champs de l'opération `trimSegment`.
 */
export function trimFields(
  seg: SegmentV2,
  edge: 'start' | 'end',
  deltaMs: number,
  window: { srcStartMs: number; srcEndMs: number },
): { srcStartMs?: number; srcEndMs?: number; editDurMs?: number } | null {
  const delta = Math.round(deltaMs);
  if (seg.kind === 'source') {
    if (edge === 'start') {
      const v = Math.min(
        seg.srcEndMs - MIN_SEGMENT_MS,
        Math.max(window.srcStartMs, seg.srcStartMs + delta),
      );
      return v === seg.srcStartMs ? null : { srcStartMs: v };
    }
    const v = Math.max(
      seg.srcStartMs + MIN_SEGMENT_MS,
      Math.min(window.srcEndMs, seg.srcEndMs + delta),
    );
    return v === seg.srcEndMs ? null : { srcEndMs: v };
  }
  const dur = Math.max(MIN_SEGMENT_MS, seg.editDurMs + (edge === 'end' ? delta : -delta));
  return dur === seg.editDurMs ? null : { editDurMs: dur };
}

/** Indice de destination d'un segment glissé jusqu'à l'instant montage `t` (milieux des autres). */
export function moveTargetIndex(d: ClipProjectV2, segmentId: string, t: number): number {
  const placed = placeSegments(segmentsV2(d.segments)).filter((p) => p.segment.id !== segmentId);
  let i = 0;
  for (const p of placed) if (t > (p.editStartMs + p.editEndMs) / 2) i++;
  return i;
}

/** Plages montage d'un élément placé (sous-titre, effet, calque). */
export function timingRanges(d: ClipProjectV2, timing: Timing) {
  return resolveTiming(segmentsV2(d.segments), timing).ranges;
}
