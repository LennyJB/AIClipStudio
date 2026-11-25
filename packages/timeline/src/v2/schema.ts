/**
 * ClipProject v2 (étape 7, docs/plan-etape-7.md §3) : document de l'éditeur avec timeline.
 *
 * Règles reprises de la v1 et de l'étape 6 :
 *  - segments, sous-titres, masques et repères en temps SOURCE ; le temps montage est déduit ;
 *  - masques de confidentialité TOUJOURS opaques (aplat) ; `blur_region` est un EFFET créatif,
 *    jamais une protection ;
 *  - items de sous-titres issus de la transcription : mots immuables (seuls leur découpage, leurs
 *    horaires d'affichage et leur style changent) ; corrections tracées à part ;
 *  - pistes audio bornées par la règle d'audio exporté, revérifiée par le serveur.
 *
 * Collections d'entités triées par identifiant : deux ajouts indépendants donnent le même
 * document quel que soit leur ordre (nécessaire à la réapplication sûre, §6.3).
 */
import { z } from 'zod';
import { CAPTION_ROLES } from '../captions';
import type { Segment } from '../time';
import {
  CaptionItemSchema,
  CaptionStyleSchema,
  CorrectionSchema,
  LAYOUT_PRESETS,
  AUDIO_ROLES,
  RectSchema,
} from '../project';

export const PROJECT_SCHEMA_VERSION_V2 = 2;

const ms = z.number().int().nonnegative();
const id = z.string().min(1).max(100);
const unit = z.number().min(0).max(1);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'couleur #RRGGBB attendue');

/* ------------------------------------------------------------------ */
/* Segments                                                            */
/* ------------------------------------------------------------------ */

/** Vitesse ≠ 1 hors périmètre de l'étape 7 : refusée explicitement par le schéma. */
export const SegmentV2Schema = z.discriminatedUnion('kind', [
  z
    .object({
      id,
      kind: z.literal('source'),
      srcStartMs: ms,
      srcEndMs: ms,
      speed: z.literal(1),
    })
    .strict(),
  z
    .object({ id, kind: z.literal('freeze'), srcAtMs: ms, editDurMs: z.number().int().positive() })
    .strict(),
  z.object({ id, kind: z.literal('gap'), editDurMs: z.number().int().positive() }).strict(),
]);
export type SegmentV2 = z.infer<typeof SegmentV2Schema>;

/**
 * Segments validés → segments typés du modèle temporel (`SourceMs`). Le schéma garantit des
 * millisecondes entières positives : la conversion est sûre (même principe que `projectSegments`).
 */
export const segmentsV2 = (segments: readonly SegmentV2[]): Segment[] =>
  segments as unknown as Segment[];

/* ------------------------------------------------------------------ */
/* Placement temporel des éléments                                     */
/* ------------------------------------------------------------------ */

/** Ancrage au contenu (suit les coupes) ou à la structure du montage. */
export const TimingV2Schema = z.discriminatedUnion('anchor', [
  z.object({ anchor: z.literal('source'), srcStartMs: ms, srcEndMs: ms }).strict(),
  z
    .object({
      anchor: z.literal('edit'),
      from: z.enum(['start', 'end']),
      offsetMs: ms,
      durMs: z.number().int().positive(),
    })
    .strict(),
]);
export type TimingV2 = z.infer<typeof TimingV2Schema>;

/* ------------------------------------------------------------------ */
/* Mise en page                                                        */
/* ------------------------------------------------------------------ */

export const LAYER_ROLES = ['gameplay', 'facecam'] as const;

export const LayerSchema = z
  .object({
    id,
    role: z.enum(LAYER_ROLES),
    /** Zone de l'image SOURCE (normalisée). */
    crop: RectSchema,
    /** Zone de l'image de SORTIE 9:16 (normalisée). */
    frame: RectSchema,
    z: z.number().int().min(0).max(20),
  })
  .strict();
export type Layer = z.infer<typeof LayerSchema>;

export const LAYOUT_PRESETS_V2 = [...LAYOUT_PRESETS, 'custom'] as const;

/** Surcharge de mise en page pour un segment (identifiant = celui du segment). */
export const LayoutOverrideSchema = z
  .object({ id, layers: z.array(LayerSchema).min(1).max(4) })
  .strict();
export type LayoutOverride = z.infer<typeof LayoutOverrideSchema>;

/* ------------------------------------------------------------------ */
/* Masques de confidentialité (TOUJOURS opaques)                       */
/* ------------------------------------------------------------------ */

export const MaskSchema = z
  .object({
    id,
    rect: RectSchema,
    label: z.string().max(60),
    /** `opaque` (aplat plein) ou `off` (désactivé, confirmation explicite). Aucun flou. */
    mode: z.enum(['opaque', 'off']),
    /** null : masque permanent ; sinon plage en temps SOURCE (masque temporel). */
    srcRange: z.object({ srcStartMs: ms, srcEndMs: ms }).strict().nullable(),
  })
  .strict()
  .refine((m) => !m.srcRange || m.srcRange.srcStartMs < m.srcRange.srcEndMs, 'plage vide');
export type Mask = z.infer<typeof MaskSchema>;

/* ------------------------------------------------------------------ */
/* Sous-titres                                                         */
/* ------------------------------------------------------------------ */

export const CaptionPositionSchema = z.object({ x: unit, y: unit }).strict();

/** Réglages d'affichage d'un item (les mots ne changent jamais). */
export const CaptionOverrideSchema = z
  .object({
    id,
    /** Horaires d'affichage (temps source), à ±2 s au plus des mots de l'item. */
    srcStartMs: ms.nullable(),
    srcEndMs: ms.nullable(),
    style: CaptionStyleSchema.partial().nullable(),
    position: CaptionPositionSchema.nullable(),
  })
  .strict();
export type CaptionOverride = z.infer<typeof CaptionOverrideSchema>;

/** Sous-titre écrit par le créateur (pseudonymisé à l'affichage, comme les autres). */
export const ManualCaptionSchema = z
  .object({
    id,
    origin: z.literal('creator'),
    text: z.string().trim().min(1).max(200),
    srcStartMs: ms,
    srcEndMs: ms,
    style: CaptionStyleSchema.partial().nullable(),
    position: CaptionPositionSchema.nullable(),
  })
  .strict()
  .refine((c) => c.srcStartMs < c.srcEndMs, 'durée nulle');
export type ManualCaption = z.infer<typeof ManualCaptionSchema>;

/* ------------------------------------------------------------------ */
/* Effets (catalogue v2 : données ; rendu aux PR 7c et 7i)             */
/* ------------------------------------------------------------------ */

export const VISUAL_EFFECTS = [
  'caption_emphasis',
  'punch_zoom',
  'reaction_hold',
  'zoom',
  'flash',
  'shake',
  'blur_region',
] as const;
export const AUDIO_EFFECTS = ['fade_in', 'fade_out', 'duck', 'bleep'] as const;
export const EFFECT_TYPES_V2 = [...VISUAL_EFFECTS, ...AUDIO_EFFECTS] as const;
export type EffectTypeV2 = (typeof EFFECT_TYPES_V2)[number];

const factor = z.number().min(1).max(1.3);
const gainDb = z.number().min(-60).max(12);

/**
 * Paramètres validés par type. Aucun texte : uniquement des nombres bornés et, pour les effets
 * localisés, une zone normalisée. `blur_region` est rangé avec les effets visuels créatifs.
 */
export const EFFECT_PARAMS_SCHEMAS = {
  caption_emphasis: z.object({}).strict(),
  punch_zoom: z.object({ factor }).strict(),
  reaction_hold: z.object({ factor }).strict(),
  zoom: z.object({ factor: z.number().min(1).max(3) }).strict(),
  flash: z.object({ intensity: unit }).strict(),
  shake: z.object({ amplitude: z.number().min(0).max(0.05) }).strict(),
  blur_region: z.object({ sigma: z.number().min(1).max(60) }).strict(),
  fade_in: z.object({}).strict(),
  fade_out: z.object({}).strict(),
  duck: z.object({ gainDb }).strict(),
  bleep: z.object({ frequencyHz: z.number().int().min(200).max(4000) }).strict(),
} satisfies Record<EffectTypeV2, z.ZodType>;

/** Effets qui exigent une zone (`region`, image source normalisée). */
export const REGION_EFFECTS: readonly EffectTypeV2[] = ['zoom', 'blur_region'];

export const EffectV2Schema = z
  .object({
    id,
    type: z.enum(EFFECT_TYPES_V2),
    params: z.record(z.string(), z.number()),
    region: RectSchema.nullable(),
    timing: TimingV2Schema,
    enabled: z.boolean(),
    origin: z.enum(['auto', 'creator']),
    reason: z.string().max(300),
    signals: z.record(z.string(), z.number()),
  })
  .strict()
  .superRefine((e, ctx) => {
    const r = EFFECT_PARAMS_SCHEMAS[e.type].safeParse(e.params);
    if (!r.success) ctx.addIssue({ code: 'custom', message: `paramètres invalides (${e.type})` });
    if (REGION_EFFECTS.includes(e.type) !== (e.region !== null)) {
      ctx.addIssue({ code: 'custom', message: `zone ${e.region ? 'inattendue' : 'requise'}` });
    }
  });
export type EffectV2 = z.infer<typeof EffectV2Schema>;

/* ------------------------------------------------------------------ */
/* Calques et effets sonores                                           */
/* ------------------------------------------------------------------ */

const assetId = z.string().regex(/^[0-9a-f]{64}$/u, 'identifiant de média (sha256) attendu');

/** Images fixes uniquement à l'étape 7 (GIF animés plus tard). */
export const OverlaySchema = z
  .object({
    id,
    kind: z.enum(['image', 'meme', 'text']),
    assetId: assetId.nullable(),
    text: z.string().trim().min(1).max(120).nullable(),
    timing: TimingV2Schema,
    frame: RectSchema,
    opacity: unit,
    z: z.number().int().min(0).max(20),
  })
  .strict()
  .refine(
    (o) =>
      o.kind === 'text'
        ? o.text !== null && o.assetId === null
        : o.assetId !== null && o.text === null,
    'texte pour un calque texte, média pour une image',
  );
export type Overlay = z.infer<typeof OverlaySchema>;

export const SfxSchema = z.object({ id, assetId, timing: TimingV2Schema, gainDb }).strict();
export type Sfx = z.infer<typeof SfxSchema>;

export const AutomationPointSchema = z.object({ srcMs: ms, gainDb }).strict();

export const AudioTrackV2Schema = z
  .object({
    audioIndex: z.number().int().nonnegative(),
    role: z.enum(AUDIO_ROLES),
    gainDb: z.number().min(-30).max(12),
    enabled: z.boolean(),
    /** Points de gain en temps source, triés, instants distincts. */
    automation: z.array(AutomationPointSchema).max(200),
  })
  .strict()
  .refine(
    (t) => t.automation.every((p, i, a) => i === 0 || a[i - 1]!.srcMs < p.srcMs),
    'automatisation : instants croissants et distincts',
  );
export type AudioTrackV2 = z.infer<typeof AudioTrackV2Schema>;

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

const sortedById = <T extends { id: string }>(a: readonly T[]) =>
  a.every((x, i) => i === 0 || a[i - 1]!.id < x.id);

export const ClipProjectV2Schema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION_V2),
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
        /**
         * Fenêtre éditable : tous les segments y restent. Couverte par le manifeste
         * d'intégrité référencé ; l'élargir exige un NOUVEAU manifeste (manifestes figés).
         */
        editWindow: z
          .object({ srcStartMs: ms, srcEndMs: ms, integrityManifestId: id })
          .strict()
          .refine((w) => w.srcStartMs < w.srcEndMs, 'fenêtre vide'),
      })
      .strict(),
    segments: z.array(SegmentV2Schema).min(1).max(200),
    anchors: z.object({ setupStartMs: ms, punchlineMs: ms, reactionEndMs: ms }).strict(),
    layout: z
      .object({
        preset: z.enum(LAYOUT_PRESETS_V2),
        gameplayRect: RectSchema,
        facecamRect: RectSchema.nullable(),
        framingProfile: z
          .object({ id, hash: z.string().min(1) })
          .strict()
          .nullable(),
        focusX: unit,
        facecamShare: z.number().min(0.25).max(0.45),
        /** Calques de la disposition `custom` (vide sinon). */
        layers: z.array(LayerSchema).max(4),
        background: hex,
        overrides: z.array(LayoutOverrideSchema).max(200).refine(sortedById, 'tri par id'),
      })
      .strict()
      .refine(
        (l) => (l.preset === 'custom') === l.layers.length > 0,
        'calques ⇔ disposition custom',
      ),
    masks: z.array(MaskSchema).max(50).refine(sortedById, 'tri par id'),
    captions: z
      .object({
        enabled: z.boolean(),
        sources: z.array(z.enum(CAPTION_ROLES)).max(3),
        style: CaptionStyleSchema,
        pseudonymize: z.literal(true),
        items: z.array(CaptionItemSchema).max(2000),
        corrections: z.array(CorrectionSchema).max(2000),
        overrides: z.array(CaptionOverrideSchema).max(2000).refine(sortedById, 'tri par id'),
        manual: z.array(ManualCaptionSchema).max(500).refine(sortedById, 'tri par id'),
      })
      .strict(),
    effects: z.array(EffectV2Schema).max(50).refine(sortedById, 'tri par id'),
    overlays: z.array(OverlaySchema).max(50).refine(sortedById, 'tri par id'),
    audio: z
      .object({
        tracks: z.array(AudioTrackV2Schema).max(16),
        silent: z.boolean(),
        loudnorm: z.object({ enabled: z.boolean(), targetLufs: z.literal(-14) }).strict(),
        sfx: z.array(SfxSchema).max(100).refine(sortedById, 'tri par id'),
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
export type ClipProjectV2 = z.infer<typeof ClipProjectV2Schema>;
