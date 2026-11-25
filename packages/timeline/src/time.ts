/**
 * Modèle temporel du montage.
 *
 *  - SourceMs : temps dans l'enregistrement original (transcription, dérivés, FFmpeg).
 *  - EditMs   : temps dans le clip monté (0 = première image exportée).
 *
 * Les SEGMENTS sont le seul pont entre les deux. Les positions en temps montage
 * sont toujours DÉDUITES (somme cumulée), jamais stockées.
 */
import { z } from 'zod';

declare const sourceBrand: unique symbol;
declare const editBrand: unique symbol;

/** Temps dans l'original, en millisecondes entières. */
export type SourceMs = number & { readonly [sourceBrand]: true };
/** Temps dans le clip monté, en millisecondes entières. */
export type EditMs = number & { readonly [editBrand]: true };

function assertMs(n: number, label: string) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`${label} doit être un entier positif (reçu ${n})`);
  }
}

export function sourceMs(n: number): SourceMs {
  assertMs(n, 'SourceMs');
  return n as SourceMs;
}

export function editMs(n: number): EditMs {
  assertMs(n, 'EditMs');
  return n as EditMs;
}

/* ------------------------------------------------------------------ */
/* Segments                                                            */
/* ------------------------------------------------------------------ */

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export interface SourceSegment {
  id: string;
  kind: 'source';
  srcStartMs: SourceMs;
  srcEndMs: SourceMs;
  /** 1 = vitesse normale ; 2 = deux fois plus rapide (durée de montage divisée par 2). */
  speed: number;
}

/** Arrêt sur image : le temps montage avance, le temps source reste figé. */
export interface FreezeSegment {
  id: string;
  kind: 'freeze';
  srcAtMs: SourceMs;
  editDurMs: number;
}

/**
 * Vide (suppression « sans décalage », étape 7) : le temps montage avance, sans AUCUN temps
 * source. Image = fond de la mise en page ; son = silence sur les pistes de l'enregistrement.
 */
export interface GapSegment {
  id: string;
  kind: 'gap';
  editDurMs: number;
}

export type Segment = SourceSegment | FreezeSegment | GapSegment;

const msInt = z.number().int().nonnegative();

/** Schéma de validation (utilisé par le futur schéma du projet de clip). */
export const SegmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('source'),
      srcStartMs: msInt,
      srcEndMs: msInt,
      speed: z.number().min(MIN_SPEED).max(MAX_SPEED).default(1),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('freeze'),
      srcAtMs: msInt,
      editDurMs: z.number().int().positive(),
    })
    .strict(),
]);

/** Durée d'un segment en temps montage. */
export function segmentEditDuration(seg: Segment): number {
  return seg.kind === 'source'
    ? Math.round((seg.srcEndMs - seg.srcStartMs) / seg.speed)
    : seg.editDurMs;
}

export interface PlacedSegment {
  segment: Segment;
  index: number;
  editStartMs: EditMs;
  /** Exclusif. */
  editEndMs: EditMs;
}

/** Positionne les segments en temps montage (somme cumulée). */
export function placeSegments(segments: readonly Segment[]): PlacedSegment[] {
  let cursor = 0;
  return segments.map((segment, index) => {
    const start = cursor;
    cursor += segmentEditDuration(segment);
    return { segment, index, editStartMs: start as EditMs, editEndMs: cursor as EditMs };
  });
}

export function totalEditDuration(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + segmentEditDuration(s), 0);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface TimelineIssue {
  segmentId?: string;
  code:
    | 'EMPTY'
    | 'DUPLICATE_ID'
    | 'NOT_INTEGER'
    | 'INVALID_RANGE'
    | 'OUT_OF_SOURCE'
    | 'INVALID_SPEED'
    | 'ZERO_DURATION';
  message: string;
}

/**
 * Vérifie les invariants. Les chevauchements de plages source sont AUTORISÉS
 * (replays). Il ne peut pas y avoir de trou en temps montage (par construction).
 */
export function validateSegments(
  segments: readonly Segment[],
  sourceDurationMs?: number | null,
): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  if (!segments.length) issues.push({ code: 'EMPTY', message: 'Aucun segment' });
  const ids = new Set<string>();
  for (const s of segments) {
    const push = (code: TimelineIssue['code'], message: string) =>
      issues.push({ segmentId: s.id, code, message });
    if (ids.has(s.id)) push('DUPLICATE_ID', `Identifiant en double : ${s.id}`);
    ids.add(s.id);

    const times =
      s.kind === 'source'
        ? [s.srcStartMs, s.srcEndMs]
        : s.kind === 'freeze'
          ? [s.srcAtMs, s.editDurMs]
          : [s.editDurMs];
    if (times.some((t) => !Number.isInteger(t) || t < 0)) {
      push('NOT_INTEGER', 'Les temps doivent être des millisecondes entières positives');
      continue;
    }
    if (s.kind === 'source') {
      if (s.srcStartMs >= s.srcEndMs) push('INVALID_RANGE', 'Le début doit précéder la fin');
      if (!(s.speed >= MIN_SPEED && s.speed <= MAX_SPEED)) {
        push('INVALID_SPEED', `Vitesse hors limites (${MIN_SPEED} à ${MAX_SPEED})`);
      }
      if (sourceDurationMs != null && s.srcEndMs > sourceDurationMs) {
        push('OUT_OF_SOURCE', 'Le segment dépasse la fin de l’enregistrement');
      }
    } else if (s.kind === 'freeze' && sourceDurationMs != null && s.srcAtMs >= sourceDurationMs) {
      push('OUT_OF_SOURCE', 'L’image figée est au-delà de la fin de l’enregistrement');
    }
    if (segmentEditDuration(s) < 1) push('ZERO_DURATION', 'Durée de montage nulle');
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Conversions                                                         */
/* ------------------------------------------------------------------ */

export interface SourcePosition {
  kind: 'source';
  srcMs: SourceMs;
  segmentId: string;
  /** Vrai pendant un arrêt sur image. */
  frozen: boolean;
}

function findPlacedAt(placed: readonly PlacedSegment[], t: number): PlacedSegment | null {
  let lo = 0;
  let hi = placed.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = placed[mid]!;
    if (t < p.editStartMs) hi = mid - 1;
    else if (t >= p.editEndMs) lo = mid + 1;
    else return p;
  }
  return null;
}

/** Position dans un vide (`gap`) : AUCUN temps source n'y correspond. */
export interface GapPosition {
  kind: 'gap';
  segmentId: string;
}

/**
 * Temps montage → position. Type de retour EXACT :
 *  - `null`                        : hors du clip (t < 0 ou t ≥ durée totale), uniquement ;
 *  - `{ kind: 'gap', segmentId }`  : dans un vide ; il n'existe aucun temps source ;
 *  - `{ kind: 'source', … }`       : dans un segment source, ou pendant un arrêt sur image
 *                                    (`frozen: true`, `srcMs` = image figée).
 * Un appelant qui a besoin d'un temps source doit donc traiter explicitement les trois cas.
 */
export function editToSource(
  segments: readonly Segment[],
  t: EditMs,
): SourcePosition | GapPosition | null {
  const p = findPlacedAt(placeSegments(segments), t);
  if (!p) return null;
  const seg = p.segment;
  if (seg.kind === 'gap') return { kind: 'gap', segmentId: seg.id };
  if (seg.kind === 'freeze') {
    return { kind: 'source', srcMs: seg.srcAtMs, segmentId: seg.id, frozen: true };
  }
  const offset = Math.round((t - p.editStartMs) * seg.speed);
  const src = Math.min(seg.srcStartMs + offset, seg.srcEndMs - 1);
  return { kind: 'source', srcMs: src as SourceMs, segmentId: seg.id, frozen: false };
}

export interface EditPosition {
  editMs: EditMs;
  segmentId: string;
}

/** Position en temps montage d'un instant source à l'intérieur d'un segment placé. */
function sourceOffsetToEdit(p: PlacedSegment & { segment: SourceSegment }, s: number): number {
  const offset = Math.round((s - p.segment.srcStartMs) / p.segment.speed);
  // L'arrondi ne doit jamais faire déborder sur le segment suivant.
  return Math.min(p.editStartMs + offset, p.editEndMs - 1);
}

/**
 * Temps source → toutes ses positions en temps montage.
 *  - liste vide : le passage est coupé ;
 *  - plusieurs positions : le passage est rejoué (replay).
 * Les arrêts sur image ne sont pas des lectures du contenu : ils sont exclus ici
 * (voir sourceRangeToEditRanges pour l'affichage des éléments pendant un arrêt).
 */
export function sourceToEdit(segments: readonly Segment[], s: SourceMs): EditPosition[] {
  const out: EditPosition[] = [];
  for (const p of placeSegments(segments)) {
    const seg = p.segment;
    if (seg.kind !== 'source' || s < seg.srcStartMs || s >= seg.srcEndMs) continue;
    out.push({
      editMs: sourceOffsetToEdit(p as PlacedSegment & { segment: SourceSegment }, s) as EditMs,
      segmentId: seg.id,
    });
  }
  return out;
}

export interface EditRange {
  editStartMs: EditMs;
  /** Exclusif. */
  editEndMs: EditMs;
  segmentId: string;
  frozen: boolean;
}

/**
 * Plage source [start, end[ → morceaux visibles en temps montage, dans l'ordre.
 * Une plage peut être découpée (coupes), répétée (replays) ou absente.
 * Un arrêt sur image dont l'image figée est dans la plage est inclus en entier
 * (`frozen: true`) : l'élément reste affiché, figé, pendant l'arrêt.
 */
export function sourceRangeToEditRanges(
  segments: readonly Segment[],
  start: SourceMs,
  end: SourceMs,
): EditRange[] {
  if (end <= start) return [];
  const out: EditRange[] = [];
  for (const p of placeSegments(segments)) {
    const seg = p.segment;
    // Un vide ne montre aucun contenu source : rien n'y est placé.
    if (seg.kind === 'gap') continue;
    if (seg.kind === 'freeze') {
      if (seg.srcAtMs >= start && seg.srcAtMs < end) {
        out.push({
          editStartMs: p.editStartMs,
          editEndMs: p.editEndMs,
          segmentId: seg.id,
          frozen: true,
        });
      }
      continue;
    }
    const a = Math.max(start, seg.srcStartMs);
    const b = Math.min(end, seg.srcEndMs);
    if (a >= b) continue;
    const sp = p as PlacedSegment & { segment: SourceSegment };
    const editStart = sourceOffsetToEdit(sp, a);
    const editEnd =
      b === seg.srcEndMs ? p.editEndMs : Math.max(editStart + 1, sourceOffsetToEdit(sp, b));
    out.push({
      editStartMs: editStart as EditMs,
      editEndMs: editEnd as EditMs,
      segmentId: seg.id,
      frozen: false,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ancrage des éléments                                                */
/* ------------------------------------------------------------------ */

/** Placement d'un élément : au contenu (suit les coupes) ou à la structure du montage. */
export type Timing =
  | { anchor: 'source'; srcStartMs: SourceMs; srcEndMs: SourceMs }
  | {
      anchor: 'edit';
      /** 'start' : offset depuis le début ; 'end' : distance entre la fin de l'élément et la fin du clip. */
      from: 'start' | 'end';
      offsetMs: number;
      durMs: number;
    };

export type OccurrencePolicy = 'all' | 'first';

export interface ResolvedRange {
  editStartMs: number;
  editEndMs: number;
  /** Absent pour un élément ancré au montage. */
  segmentId?: string;
  frozen: boolean;
}

export interface ResolvedTiming {
  ranges: ResolvedRange[];
  /** Élément ancré au montage qui sort du clip : signalé, jamais déplacé. */
  outOfBounds: boolean;
}

/** Calcule où un élément apparaît dans le montage. */
export function resolveTiming(
  segments: readonly Segment[],
  timing: Timing,
  occurrences: OccurrencePolicy = 'all',
): ResolvedTiming {
  if (timing.anchor === 'source') {
    const ranges = sourceRangeToEditRanges(segments, timing.srcStartMs, timing.srcEndMs);
    if (occurrences === 'all' || !ranges.length) return { ranges, outOfBounds: false };
    // « first » : seulement la première occurrence d'un segment donné (pas les replays).
    const firstSeg = ranges[0]!.segmentId;
    return { ranges: ranges.filter((r) => r.segmentId === firstSeg), outOfBounds: false };
  }
  const total = totalEditDuration(segments);
  const start = timing.from === 'start' ? timing.offsetMs : total - timing.offsetMs - timing.durMs;
  const end = start + timing.durMs;
  return {
    ranges: [{ editStartMs: start, editEndMs: end, frozen: false }],
    outOfBounds: start < 0 || end > total,
  };
}

/* ------------------------------------------------------------------ */
/* Opérations de base sur les segments (pures, immuables)              */
/* ------------------------------------------------------------------ */

/** Déplace un segment à une nouvelle position dans la liste. */
export function moveSegment(segments: readonly Segment[], id: string, toIndex: number): Segment[] {
  const from = segments.findIndex((s) => s.id === id);
  if (from < 0) throw new RangeError(`Segment introuvable : ${id}`);
  const copy = [...segments];
  const [seg] = copy.splice(from, 1);
  copy.splice(Math.max(0, Math.min(toIndex, copy.length)), 0, seg!);
  return copy;
}

/** Remplace un segment (rognage, vitesse, durée d'un arrêt). */
export function updateSegment(
  segments: readonly Segment[],
  id: string,
  patch:
    | Partial<Omit<SourceSegment, 'id' | 'kind'>>
    | Partial<Omit<FreezeSegment, 'id' | 'kind'>>
    | Partial<Omit<GapSegment, 'id' | 'kind'>>,
): Segment[] {
  let found = false;
  const next = segments.map((s) => {
    if (s.id !== id) return s;
    found = true;
    return { ...s, ...patch } as Segment;
  });
  if (!found) throw new RangeError(`Segment introuvable : ${id}`);
  return next;
}
