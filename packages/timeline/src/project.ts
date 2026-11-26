/**
 * Projet de clip (ClipProject v1) : document source de vérité d'un clip, créé à partir d'une
 * proposition ACCEPTÉE (étape 5) et lu par le moteur de rendu (étape 6b) puis par l'éditeur
 * (étape 7). Code pur, partagé : aucune entrée/sortie, aucune dépendance Node.
 *
 * Voir docs/plan-etape-6.md §5.1. Règles clés :
 *  - segments, sous-titres et repères en temps SOURCE ; le temps montage est toujours déduit ;
 *  - la décision de revue n'est JAMAIS copiée ici (recalculée côté serveur) ;
 *  - le texte de la transcription n'est jamais modifié (corrections à part, tracées) ;
 *  - les pistes et sources de sous-titres sont bornées par la règle d'audio exporté, revérifiée
 *    au rendu quel que soit le contenu du document.
 */
import { z } from 'zod';
import {
  CAPTION_ROLES,
  cleanWord,
  DEFAULT_GROUP_OPTIONS,
  groupWords,
  joinWords,
  type CaptionCorrection,
  type CaptionItem,
  type CaptionRole,
  type RoleWords,
} from './captions';
import { SegmentSchema, totalEditDuration, type Segment, type SourceMs } from './time';

export const PROJECT_SCHEMA_VERSION = 1;
/** Bornes absolues de durée d'un clip (décision validée : 5 à 180 s). */
export const ABS_MIN_DURATION_MS = 5_000;
export const ABS_MAX_DURATION_MS = 180_000;
/** Décalage maximal des bornes par rapport à la proposition (±10 s). */
export const MAX_BOUND_SHIFT_MS = 10_000;
/** Au-delà, la frontière de mot la plus proche est jugée trop loin : pas de calage. */
export const MAX_SNAP_MS = 1_000;

export const LAYOUT_PRESETS = ['facecam_top', 'gameplay_crop', 'blurred_fit'] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];
export const CAPTION_FONTS = ['Montserrat ExtraBold', 'Inter'] as const;
export const EFFECT_TYPES = ['caption_emphasis', 'punch_zoom', 'reaction_hold'] as const;
export const AUDIO_ROLES = ['mic', 'discord', 'game', 'mix', 'unknown'] as const;
export type AudioRole = (typeof AUDIO_ROLES)[number];

/* ------------------------------------------------------------------ */
/* Schéma                                                              */
/* ------------------------------------------------------------------ */

const ms = z.number().int().nonnegative();
const id = z.string().min(1).max(100);
const EPS = 1e-9;
const unit = z.number().min(0).max(1);
export const RectSchema = z
  .object({ x: unit, y: unit, w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .strict()
  .refine((r) => r.x + r.w <= 1 + EPS && r.y + r.h <= 1 + EPS, 'le rectangle sort de l’image');
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'couleur #RRGGBB attendue');

export const CaptionWordSchema = z
  .object({ text: z.string().min(1).max(200), srcStartMs: ms, srcEndMs: ms })
  .strict();
export const CaptionItemSchema = z
  .object({
    id,
    speakerRole: z.enum(CAPTION_ROLES),
    srcStartMs: ms,
    srcEndMs: ms,
    words: z.array(CaptionWordSchema).min(1).max(200),
  })
  .strict()
  .refine((c) => c.srcStartMs < c.srcEndMs, 'ligne de durée nulle');

export const CaptionStyleSchema = z
  .object({
    font: z.enum(CAPTION_FONTS),
    sizePx: z.number().int().min(40).max(120),
    color: hexColor,
    highlightColor: hexColor,
    outlineColor: hexColor,
    outlinePx: z.number().int().min(0).max(12),
    shadow: z.boolean(),
    position: z.enum(['top', 'middle', 'bottom_safe']),
    uppercase: z.boolean(),
    maxCharsPerLine: z.number().int().min(16).max(42),
    maxLines: z.union([z.literal(1), z.literal(2)]),
    karaoke: z.boolean(),
    emphasizePunchline: z.boolean(),
  })
  .strict();
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: 'Montserrat ExtraBold',
  sizePx: 72,
  color: '#FFFFFF',
  highlightColor: '#FFD400',
  outlineColor: '#000000',
  outlinePx: 6,
  shadow: true,
  position: 'bottom_safe',
  uppercase: false,
  maxCharsPerLine: DEFAULT_GROUP_OPTIONS.maxCharsPerLine,
  maxLines: 2,
  karaoke: true,
  emphasizePunchline: true,
};

export const CorrectionSchema = z
  .object({
    itemId: id,
    originalText: z.string().max(2000),
    correctedText: z.string().min(1).max(200),
    revision: z.number().int().min(1),
    at: z.string().min(1),
  })
  .strict();

export const EffectSchema = z
  .object({
    id,
    type: z.enum(EFFECT_TYPES),
    params: z.record(z.string(), z.number()),
    timing: z.object({ anchor: z.literal('source'), srcStartMs: ms, srcEndMs: ms }).strict(),
    enabled: z.boolean(),
    origin: z.enum(['auto', 'creator']),
    reason: z.string().max(300),
    signals: z.record(z.string(), z.number()),
  })
  .strict();

export const ClipProjectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    origin: z
      .object({
        proposalId: id,
        recordingId: id,
        runId: id,
        momentId: id.nullable(),
        createdFrom: z.literal('proposal'),
        proposalBounds: z.object({ srcStartMs: ms, srcEndMs: ms }).strict(),
      })
      .strict(),
    source: z
      .object({
        fingerprint: z.string().min(1),
        durationMs: ms.nullable(),
        width: z.number().int().positive().nullable(),
        height: z.number().int().positive().nullable(),
        fps: z.number().positive().nullable(),
        container: z.string().min(1),
        integrityManifestId: id,
      })
      .strict(),
    segments: z.array(SegmentSchema).min(1).max(200),
    anchors: z.object({ setupStartMs: ms, punchlineMs: ms, reactionEndMs: ms }).strict(),
    layout: z
      .object({
        preset: z.enum(LAYOUT_PRESETS),
        gameplayRect: RectSchema,
        facecamRect: RectSchema.nullable(),
        framingProfile: z
          .object({ id, hash: z.string().min(1) })
          .strict()
          .nullable(),
        focusX: unit,
        facecamShare: z.number().min(0.25).max(0.45),
        masks: z
          .array(
            z
              .object({
                rect: RectSchema,
                label: z.string().max(60),
                mode: z.enum(['opaque', 'off']),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    captions: z
      .object({
        enabled: z.boolean(),
        sources: z.array(z.enum(CAPTION_ROLES)).max(3),
        style: CaptionStyleSchema,
        pseudonymize: z.literal(true),
        items: z.array(CaptionItemSchema).max(2000),
        corrections: z.array(CorrectionSchema).max(2000),
      })
      .strict(),
    effects: z.array(EffectSchema).max(20),
    audio: z
      .object({
        tracks: z
          .array(
            z
              .object({
                audioIndex: z.number().int().nonnegative(),
                role: z.enum(AUDIO_ROLES),
                gainDb: z.number().min(-30).max(12),
                enabled: z.boolean(),
              })
              .strict(),
          )
          .max(16),
        /** Export volontairement sans son (choix explicite du créateur, jamais un repli). */
        silent: z.boolean(),
        loudnorm: z.object({ enabled: z.boolean(), targetLufs: z.literal(-14) }).strict(),
      })
      .strict(),
    mode: z.enum(['fidele', 'enrichi']),
    durationPolicy: z
      .object({
        minMs: ms,
        maxMs: ms,
        outOfRangeConfirmedForRevision: z.number().int().min(1).nullable(),
      })
      .strict(),
  })
  .strict();
export type ClipProject = z.infer<typeof ClipProjectSchema>;

/* ------------------------------------------------------------------ */
/* Avertissements                                                      */
/* ------------------------------------------------------------------ */

export type ProjectWarningCode =
  | 'FRAMING_NOT_VALIDATED'
  | 'DURATION_OUT_OF_RANGE'
  | 'CONTEXT_MAY_BE_CUT'
  | 'REACTION_MAY_BE_CUT'
  | 'WORD_CUT'
  | 'MASKS_DISABLED'
  | 'NO_CAPTIONS'
  | 'AUDIO_UNAVAILABLE';

export interface ProjectWarning {
  code: ProjectWarningCode;
  message: string;
}

export class ProjectError extends Error {
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'DURATION_OUT_OF_RANGE' | 'EXPORT_CONSENT_REQUIRED',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

/* ------------------------------------------------------------------ */
/* Durée et bornes                                                     */
/* ------------------------------------------------------------------ */

export function projectBounds(p: Pick<ClipProject, 'segments'>): {
  startMs: number;
  endMs: number;
} {
  const src = p.segments.filter((s) => s.kind === 'source');
  return {
    startMs: Math.min(...src.map((s) => s.srcStartMs)),
    endMs: Math.max(...src.map((s) => s.srcEndMs)),
  };
}

/** Segments typés (SourceMs / EditMs marqués) d'un document validé. */
export function projectSegments(p: Pick<ClipProject, 'segments'>): Segment[] {
  return p.segments as Segment[];
}

export function projectDurationMs(p: Pick<ClipProject, 'segments'>): number {
  return totalEditDuration(p.segments as Segment[]);
}

/** Plage dans laquelle les bornes peuvent être déplacées (proposition ±10 s, dans la source). */
export function adjustableWindow(
  proposalBounds: { srcStartMs: number; srcEndMs: number },
  sourceDurationMs: number | null,
): { startMs: number; endMs: number } {
  return {
    startMs: Math.max(0, proposalBounds.srcStartMs - MAX_BOUND_SHIFT_MS),
    endMs:
      sourceDurationMs == null
        ? proposalBounds.srcEndMs + MAX_BOUND_SHIFT_MS
        : Math.min(sourceDurationMs, proposalBounds.srcEndMs + MAX_BOUND_SHIFT_MS),
  };
}

function durationWarnings(p: ClipProject, revision: number | null): ProjectWarning[] {
  const d = projectDurationMs(p);
  const { minMs, maxMs, outOfRangeConfirmedForRevision } = p.durationPolicy;
  if (d >= minMs && d <= maxMs) return [];
  const confirmed = revision !== null && outOfRangeConfirmedForRevision === revision;
  return [
    {
      code: 'DURATION_OUT_OF_RANGE',
      message: `Durée ${(d / 1000).toFixed(1)} s hors de la plage ${minMs / 1000}–${maxMs / 1000} s${
        confirmed ? ' (confirmée)' : ' : confirmation explicite requise avant le rendu'
      }`,
    },
  ];
}

/** Vrai si la durée est conforme, ou confirmée pour CETTE révision (toute modification l'annule). */
export function durationAccepted(p: ClipProject, revision: number): boolean {
  const d = projectDurationMs(p);
  if (d < ABS_MIN_DURATION_MS || d > ABS_MAX_DURATION_MS) return false;
  return (
    (d >= p.durationPolicy.minMs && d <= p.durationPolicy.maxMs) ||
    p.durationPolicy.outOfRangeConfirmedForRevision === revision
  );
}

function assertAbsoluteDuration(startMs: number, endMs: number) {
  const d = endMs - startMs;
  if (d < ABS_MIN_DURATION_MS || d > ABS_MAX_DURATION_MS) {
    throw new ProjectError(
      'DURATION_OUT_OF_RANGE',
      `Durée ${(d / 1000).toFixed(1)} s hors des limites absolues (${ABS_MIN_DURATION_MS / 1000}–${
        ABS_MAX_DURATION_MS / 1000
      } s)`,
      { durationMs: d, minMs: ABS_MIN_DURATION_MS, maxMs: ABS_MAX_DURATION_MS },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Calage sur les mots                                                 */
/* ------------------------------------------------------------------ */

export interface WordSpan {
  srcStartMs: number;
  srcEndMs: number;
}

/**
 * Cale un instant sur une frontière de mot : s'il tombe à l'intérieur d'un mot (de n'importe quel
 * locuteur : le timing seul n'expose aucun contenu), il est déplacé vers la frontière la plus
 * proche. Si cette frontière est à plus de MAX_SNAP_MS, l'instant est gardé et `cut` vaut vrai.
 */
export function snapToWordBoundary(
  t: number,
  words: readonly WordSpan[],
  allowed: { min: number; max: number },
): { ms: number; cut: boolean } {
  const inside = words.filter((w) => t > w.srcStartMs && t < w.srcEndMs);
  if (!inside.length) return { ms: t, cut: false };
  // Plusieurs mots chevauchants : on cherche la frontière la plus proche qui ne coupe aucun mot.
  const candidates = inside
    .flatMap((w) => [w.srcStartMs, w.srcEndMs])
    .filter((c) => c >= allowed.min && c <= allowed.max)
    .filter((c) => !words.some((w) => c > w.srcStartMs && c < w.srcEndMs))
    .sort((a, b) => Math.abs(a - t) - Math.abs(b - t) || a - b);
  const best = candidates[0];
  if (best === undefined || Math.abs(best - t) > MAX_SNAP_MS) return { ms: t, cut: true };
  return { ms: best, cut: false };
}

/* ------------------------------------------------------------------ */
/* Création depuis une proposition                                     */
/* ------------------------------------------------------------------ */

export interface ProposalInput {
  id: string;
  runId: string;
  recordingId: string;
  momentId: string | null;
  srcStartMs: number;
  srcEndMs: number;
  punchlineMs: number;
  setupStartMs: number;
  reactionEndMs: number;
  /** editingHint.mode de la proposition (enum validé), ou null. */
  editingMode: 'fidele' | 'enrichi' | null;
}

export interface FramingInput {
  id: string;
  hash: string;
  gameplay: z.infer<typeof RectSchema>;
  facecam: z.infer<typeof RectSchema> | null;
  masks: { label: string; x: number; y: number; w: number; h: number }[];
}

export interface AudioSelectionInput {
  /** Pistes retenues par la règle d'audio exporté (gain 0, activées). */
  tracks: { audioIndex: number; role: AudioRole }[];
  /** Rôles dont les sous-titres peuvent être affichés (mêmes règles que l'audio). */
  captionRoles: readonly CaptionRole[];
}

export interface CreateProjectInput {
  proposal: ProposalInput;
  source: ClipProject['source'];
  /** Profil de cadrage VALIDÉ et à jour pour cet enregistrement, sinon null. */
  framing: FramingInput | null;
  /** Mots horodatés de la transcription, par locuteur. */
  words: readonly RoleWords[];
  audio: AudioSelectionInput;
  defaults: { mode: 'fidele' | 'enrichi'; minMs: number; maxMs: number };
  makeId: (kind: string, index: number) => string;
  /**
   * Plage où les sous-titres sont préparés (étape 7 : fenêtre éditable du projet). Par défaut, la
   * fenêtre ajustable de l'étape 6 (proposition ±10 s).
   */
  captionsWindow?: { startMs: number; endMs: number };
}

const FULL_FRAME = { x: 0, y: 0, w: 1, h: 1 };

export function projectFromProposal(input: CreateProjectInput): {
  project: ClipProject;
  warnings: ProjectWarning[];
} {
  const { proposal: pr, framing } = input;
  if (!(pr.srcStartMs < pr.srcEndMs)) {
    throw new ProjectError('VALIDATION_FAILED', 'Bornes de la proposition invalides');
  }
  assertAbsoluteDuration(pr.srcStartMs, pr.srcEndMs);
  const warnings: ProjectWarning[] = [];
  if (!framing) {
    warnings.push({
      code: 'FRAMING_NOT_VALIDATED',
      message: 'Aucun profil de cadrage validé : disposition plein cadre flouté par défaut',
    });
  }
  const win = adjustableWindow(
    { srcStartMs: pr.srcStartMs, srcEndMs: pr.srcEndMs },
    input.source.durationMs,
  );

  // Sous-titres : préparés sur toute la fenêtre ajustable, ou éditable (les corrections survivent
  // aux changements de bornes) ; affichés seulement pour les rôles autorisés et sélectionnés.
  const capWin = input.captionsWindow ?? win;
  const items: CaptionItem[] = [];
  for (const rw of input.words) {
    items.push(
      ...groupWords(rw, capWin.startMs, capWin.endMs, (role, i) => input.makeId(`cap-${role}`, i)),
    );
  }
  items.sort((a, b) => a.srcStartMs - b.srcStartMs || (a.id < b.id ? -1 : 1));
  const hasRole = (r: CaptionRole) => items.some((i) => i.speakerRole === r);
  // Micro par défaut ; Discord seulement sur activation explicite du créateur (jamais ici).
  const sources: CaptionRole[] = (['mic', 'mix'] as const)
    .filter((r) => input.audio.captionRoles.includes(r) && hasRole(r))
    .slice(0, 1);
  if (!sources.length) {
    warnings.push({
      code: 'NO_CAPTIONS',
      message: 'Aucun sous-titre affichable (transcription absente ou piste non autorisée)',
    });
  }
  if (!input.audio.tracks.length) {
    warnings.push({
      code: 'AUDIO_UNAVAILABLE',
      message:
        'Aucune piste audio exportable : déclarez la composition des pistes ou donnez les accords nécessaires',
    });
  }

  const project: ClipProject = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    origin: {
      proposalId: pr.id,
      recordingId: pr.recordingId,
      runId: pr.runId,
      momentId: pr.momentId,
      createdFrom: 'proposal',
      proposalBounds: { srcStartMs: pr.srcStartMs, srcEndMs: pr.srcEndMs },
    },
    source: input.source,
    segments: [
      {
        id: input.makeId('seg', 0),
        kind: 'source',
        srcStartMs: pr.srcStartMs as SourceMs,
        srcEndMs: pr.srcEndMs as SourceMs,
        speed: 1,
      },
    ],
    anchors: {
      setupStartMs: pr.setupStartMs,
      punchlineMs: pr.punchlineMs,
      reactionEndMs: pr.reactionEndMs,
    },
    layout: {
      preset: framing?.facecam ? 'facecam_top' : 'blurred_fit',
      gameplayRect: framing?.gameplay ?? FULL_FRAME,
      facecamRect: framing?.facecam ?? null,
      framingProfile: framing ? { id: framing.id, hash: framing.hash } : null,
      focusX: 0.5,
      facecamShare: 0.33,
      masks: (framing?.masks ?? []).map((m) => ({
        rect: { x: m.x, y: m.y, w: m.w, h: m.h },
        label: m.label,
        mode: 'opaque' as const,
      })),
    },
    captions: {
      enabled: sources.length > 0,
      sources,
      style: DEFAULT_CAPTION_STYLE,
      pseudonymize: true,
      items,
      corrections: [],
    },
    // Le catalogue d'effets est évalué par le moteur de rendu (étape 6b).
    effects: [],
    audio: {
      tracks: input.audio.tracks.map((t) => ({ ...t, gainDb: 0, enabled: true })),
      silent: false,
      loudnorm: { enabled: true, targetLufs: -14 },
    },
    mode: pr.editingMode ?? input.defaults.mode,
    durationPolicy: {
      minMs: input.defaults.minMs,
      maxMs: input.defaults.maxMs,
      outOfRangeConfirmedForRevision: null,
    },
  };
  const parsed = ClipProjectSchema.parse(project);
  warnings.push(...durationWarnings(parsed, null));
  return { project: parsed, warnings };
}

/* ------------------------------------------------------------------ */
/* Ajustement des bornes                                               */
/* ------------------------------------------------------------------ */

export function adjustBounds(
  p: ClipProject,
  wanted: { startMs?: number | undefined; endMs?: number | undefined },
  words: readonly WordSpan[],
): {
  project: ClipProject;
  warnings: ProjectWarning[];
  snapped: { startMs: number; endMs: number };
} {
  const segs = p.segments.filter((s) => s.kind === 'source');
  if (segs.length !== 1 || p.segments.length !== 1) {
    throw new ProjectError(
      'VALIDATION_FAILED',
      'L’ajustement simple des bornes ne s’applique qu’à un clip d’un seul segment',
    );
  }
  const win = adjustableWindow(p.origin.proposalBounds, p.source.durationMs);
  const cur = projectBounds(p);
  const startWanted = wanted.startMs ?? cur.startMs;
  const endWanted = wanted.endMs ?? cur.endMs;
  for (const [label, v] of [
    ['début', startWanted],
    ['fin', endWanted],
  ] as const) {
    if (!Number.isInteger(v) || v < win.startMs || v > win.endMs) {
      throw new ProjectError(
        'VALIDATION_FAILED',
        `La ${label} doit rester à ±${MAX_BOUND_SHIFT_MS / 1000} s de la proposition (${win.startMs}–${win.endMs} ms)`,
        { window: win },
      );
    }
  }
  const bounds = { min: win.startMs, max: win.endMs };
  const s =
    wanted.startMs === undefined
      ? { ms: cur.startMs, cut: false }
      : snapToWordBoundary(startWanted, words, bounds);
  const e =
    wanted.endMs === undefined
      ? { ms: cur.endMs, cut: false }
      : snapToWordBoundary(endWanted, words, bounds);
  if (!(s.ms < e.ms)) throw new ProjectError('VALIDATION_FAILED', 'Le début doit précéder la fin');
  assertAbsoluteDuration(s.ms, e.ms);

  const seg = segs[0]!;
  const next: ClipProject = {
    ...p,
    segments: [{ ...seg, srcStartMs: s.ms as SourceMs, srcEndMs: e.ms as SourceMs }],
    // Toute modification des bornes annule une confirmation de durée hors plage.
    durationPolicy: { ...p.durationPolicy, outOfRangeConfirmedForRevision: null },
  };
  return {
    project: ClipProjectSchema.parse(next),
    warnings: boundsWarnings(next, s.cut || e.cut),
    snapped: { startMs: s.ms, endMs: e.ms },
  };
}

function boundsWarnings(p: ClipProject, wordCut: boolean): ProjectWarning[] {
  const { startMs, endMs } = projectBounds(p);
  const out: ProjectWarning[] = [];
  if (startMs > p.anchors.setupStartMs) {
    out.push({
      code: 'CONTEXT_MAY_BE_CUT',
      message: 'Le début est après la mise en place : le contexte risque d’être coupé',
    });
  }
  if (endMs < p.anchors.reactionEndMs) {
    out.push({
      code: 'REACTION_MAY_BE_CUT',
      message: 'La fin est avant la fin de la réaction : la chute risque d’être coupée',
    });
  }
  if (wordCut) {
    out.push({
      code: 'WORD_CUT',
      message: 'Aucune frontière de mot proche : un mot peut être coupé',
    });
  }
  return out;
}

/** Avertissements courants d'un projet (affichage, rendu). */
export function projectWarnings(p: ClipProject, revision: number): ProjectWarning[] {
  const out = [...boundsWarnings(p, false), ...durationWarnings(p, revision)];
  if (!p.layout.framingProfile) {
    out.push({ code: 'FRAMING_NOT_VALIDATED', message: 'Aucun profil de cadrage validé' });
  }
  if (!p.audio.silent && !p.audio.tracks.some((t) => t.enabled)) {
    out.push({
      code: 'AUDIO_UNAVAILABLE',
      message:
        'Aucune piste audio active : déclarez la composition des pistes ou donnez les accords nécessaires',
    });
  }
  if (p.layout.masks.some((m) => m.mode === 'off')) {
    out.push({
      code: 'MASKS_DISABLED',
      message: 'Des zones sensibles ne sont pas masquées dans ce clip',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Réglages (PATCH)                                                    */
/* ------------------------------------------------------------------ */

const correctionText = z
  .string()
  .transform((s) => cleanWord(s))
  .pipe(z.string().min(1).max(200));

export const RenderOptionsPatchSchema = z
  .object({
    layout: z
      .object({
        preset: z.enum(LAYOUT_PRESETS).optional(),
        focusX: unit.optional(),
        facecamShare: z.number().min(0.25).max(0.45).optional(),
      })
      .strict()
      .optional(),
    masks: z
      .object({
        modes: z
          .array(
            z
              .object({ index: z.number().int().min(0).max(19), mode: z.enum(['opaque', 'off']) })
              .strict(),
          )
          .max(20),
        acknowledgeMaskRisk: z.boolean().optional(),
      })
      .strict()
      .optional(),
    captions: z
      .object({
        enabled: z.boolean().optional(),
        sources: z.array(z.enum(CAPTION_ROLES)).max(3).optional(),
        style: CaptionStyleSchema.partial().optional(),
      })
      .strict()
      .optional(),
    corrections: z
      .array(z.object({ itemId: id, text: correctionText.nullable() }).strict())
      .max(200)
      .optional(),
    audio: z
      .object({
        tracks: z
          .array(
            z
              .object({
                audioIndex: z.number().int().nonnegative(),
                enabled: z.boolean().optional(),
                gainDb: z.number().min(-30).max(12).optional(),
              })
              .strict(),
          )
          .max(16)
          .optional(),
        silent: z.boolean().optional(),
        loudnorm: z.boolean().optional(),
      })
      .strict()
      .optional(),
    effects: z
      .array(z.object({ id, enabled: z.boolean() }).strict())
      .max(20)
      .optional(),
    bounds: z.object({ startMs: ms.optional(), endMs: ms.optional() }).strict().optional(),
    confirmDuration: z.boolean().optional(),
    mode: z.enum(['fidele', 'enrichi']).optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'aucun réglage demandé');
export type RenderOptionsPatch = z.infer<typeof RenderOptionsPatchSchema>;

export interface PatchContext {
  /** Révision qui sera créée par ce changement. */
  nextRevision: number;
  now: string;
  /** Mots (tous locuteurs) pour le calage des bornes. */
  words: readonly WordSpan[];
  /** Rôles de sous-titres autorisés par la règle d'audio exporté au moment du changement. */
  allowedCaptionRoles: readonly CaptionRole[];
  /**
   * Pistes exportables au moment du changement (sélection de la règle d'audio exporté : jamais
   * « tout » avec des pistes séparées). Seules elles peuvent être ajoutées ou réactivées.
   */
  allowedAudioTracks: readonly { audioIndex: number; role: AudioRole }[];
}

const MIX_LIKE: readonly AudioRole[] = ['mix', 'unknown'];

/**
 * Applique des réglages et renvoie le nouveau document (immuable), un résumé lisible des
 * changements et les avertissements. Toute demande interdite lève une ProjectError.
 */
export function applyRenderOptions(
  p: ClipProject,
  patch: RenderOptionsPatch,
  ctx: PatchContext,
): { project: ClipProject; summary: string[]; warnings: ProjectWarning[] } {
  let next: ClipProject = structuredClone(p);
  const summary: string[] = [];
  let boundsWarn: ProjectWarning[] = [];

  if (patch.layout) {
    const l = patch.layout;
    next.layout = {
      ...next.layout,
      ...(l.preset !== undefined ? { preset: l.preset } : {}),
      ...(l.focusX !== undefined ? { focusX: l.focusX } : {}),
      ...(l.facecamShare !== undefined ? { facecamShare: l.facecamShare } : {}),
    };
    if (patch.layout.preset === 'facecam_top' && !next.layout.facecamRect) {
      throw new ProjectError(
        'VALIDATION_FAILED',
        'Aucune facecam définie dans le profil de cadrage validé',
      );
    }
    summary.push(`disposition : ${next.layout.preset}`);
  }
  if (patch.masks) {
    const masks = next.layout.masks.map((m) => ({ ...m }));
    for (const { index, mode } of patch.masks.modes) {
      const m = masks[index];
      if (!m) throw new ProjectError('VALIDATION_FAILED', `Zone masquée inconnue : ${index}`);
      m.mode = mode;
    }
    if (masks.some((m) => m.mode === 'off') && patch.masks.acknowledgeMaskRisk !== true) {
      throw new ProjectError(
        'VALIDATION_FAILED',
        'Désactiver un masquage exige de confirmer le risque (acknowledgeMaskRisk)',
      );
    }
    next.layout.masks = masks;
    summary.push(`masques : ${masks.filter((m) => m.mode === 'off').length} désactivé(s)`);
  }
  if (patch.captions) {
    if (patch.captions.sources) {
      const refused = patch.captions.sources.filter((r) => !ctx.allowedCaptionRoles.includes(r));
      if (refused.length) {
        throw new ProjectError(
          'EXPORT_CONSENT_REQUIRED',
          `Sous-titres non autorisés pour : ${refused.join(', ')}`,
          { roles: refused },
        );
      }
      next.captions.sources = [...new Set(patch.captions.sources)];
    }
    if (patch.captions.enabled !== undefined) next.captions.enabled = patch.captions.enabled;
    if (patch.captions.style) {
      next.captions.style = CaptionStyleSchema.parse({
        ...next.captions.style,
        ...patch.captions.style,
      });
    }
    summary.push('sous-titres');
  }
  if (patch.corrections) {
    const byId = new Map(next.captions.items.map((i) => [i.id, i]));
    let corrections = [...next.captions.corrections];
    for (const c of patch.corrections) {
      const item = byId.get(c.itemId);
      if (!item)
        throw new ProjectError('VALIDATION_FAILED', `Ligne de sous-titre inconnue : ${c.itemId}`);
      corrections = corrections.filter((x) => x.itemId !== c.itemId);
      const original = joinWords(item.words);
      if (c.text !== null && c.text !== original) {
        corrections.push({
          itemId: c.itemId,
          originalText: original,
          correctedText: c.text,
          revision: ctx.nextRevision,
          at: ctx.now,
        });
        summary.push(`sous-titre ${c.itemId} corrigé`);
      } else {
        summary.push(`sous-titre ${c.itemId} rétabli`);
      }
    }
    next.captions.corrections = corrections.sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  }
  if (patch.audio) {
    if (patch.audio.tracks) {
      for (const t of patch.audio.tracks) {
        const allowed = ctx.allowedAudioTracks.find((x) => x.audioIndex === t.audioIndex);
        let cur = next.audio.tracks.find((x) => x.audioIndex === t.audioIndex);
        if (!cur) {
          // Piste devenue exportable après la création (ex. micro déclaré) : ajout explicite.
          if (!allowed) {
            throw new ProjectError(
              'EXPORT_CONSENT_REQUIRED',
              `Piste ${t.audioIndex} non autorisée à l’export : elle ne peut pas être ajoutée`,
            );
          }
          cur = { audioIndex: allowed.audioIndex, role: allowed.role, gainDb: 0, enabled: true };
          next.audio.tracks.push(cur);
          next.audio.tracks.sort((a, b) => a.audioIndex - b.audioIndex);
        }
        if (t.enabled !== false && !allowed) {
          throw new ProjectError(
            'EXPORT_CONSENT_REQUIRED',
            `Piste ${t.audioIndex} non autorisée à l’export`,
          );
        }
        if (t.enabled !== undefined) cur.enabled = t.enabled;
        if (t.gainDb !== undefined) cur.gainDb = t.gainDb;
      }
      const active = next.audio.tracks.filter((x) => x.enabled);
      if (
        active.some((x) => MIX_LIKE.includes(x.role)) &&
        active.some((x) => !MIX_LIKE.includes(x.role))
      ) {
        throw new ProjectError(
          'VALIDATION_FAILED',
          'La piste « tout » ne peut jamais être superposée à des pistes séparées (voix doublées)',
        );
      }
    }
    if (patch.audio.silent !== undefined) next.audio.silent = patch.audio.silent;
    if (patch.audio.loudnorm !== undefined)
      next.audio.loudnorm = { enabled: patch.audio.loudnorm, targetLufs: -14 };
    summary.push('audio');
  }
  if (patch.effects) {
    for (const e of patch.effects) {
      const cur = next.effects.find((x) => x.id === e.id);
      if (!cur) throw new ProjectError('VALIDATION_FAILED', `Effet inconnu : ${e.id}`);
      cur.enabled = e.enabled;
    }
    summary.push('effets');
  }
  if (patch.mode) {
    next.mode = patch.mode;
    summary.push(`mode : ${patch.mode}`);
  }
  if (patch.bounds) {
    const r = adjustBounds(next, patch.bounds, ctx.words);
    next = r.project;
    boundsWarn = r.warnings;
    summary.push(`bornes : ${r.snapped.startMs} → ${r.snapped.endMs} ms`);
  }
  if (patch.confirmDuration) {
    next.durationPolicy = {
      ...next.durationPolicy,
      outOfRangeConfirmedForRevision: ctx.nextRevision,
    };
    summary.push('durée hors plage confirmée');
  }
  const parsed = ClipProjectSchema.parse(next);
  const warnings = [
    ...boundsWarn.filter((w) => w.code === 'WORD_CUT'),
    ...projectWarnings(parsed, ctx.nextRevision),
  ];
  return { project: parsed, summary, warnings };
}

/* ------------------------------------------------------------------ */
/* Sérialisation canonique                                             */
/* ------------------------------------------------------------------ */

/** JSON à clés triées : même document ⇒ même texte ⇒ même empreinte. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Relit un document stocké, en appliquant les migrations de schéma futures. */
export function migrateProject(raw: unknown): ClipProject {
  const v = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (v !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectError('VALIDATION_FAILED', `Version de document inconnue : ${String(v)}`);
  }
  return ClipProjectSchema.parse(raw);
}

export type { CaptionCorrection };
