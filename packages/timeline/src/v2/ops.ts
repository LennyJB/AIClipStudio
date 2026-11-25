/**
 * Catalogue d'opérations de l'éditeur (docs/plan-etape-7.md §4 et §6). Code PUR, partagé : le
 * même réducteur s'exécute dans l'interface et sur le serveur, qui compare les empreintes.
 *
 * Chaque opération :
 *  - est validée par un schéma Zod strict (aucune donnée non prévue) ;
 *  - déclare ses LECTURES et ses ÉCRITURES par clé d'état (`keys.ts`), dépendances structurelles
 *    comprises : toute opération dont le résultat dépend des positions en temps montage lit
 *    `segments` ; toute opération qui change la structure écrit `segments` ;
 *  - a pour PRÉCONDITIONS la valeur de chacune de ses clés lues avant application ;
 *  - a pour INVERSE une opération `restore` : elle remet les clés écrites à leur valeur
 *    d'avant, À CONDITION qu'elles aient encore la valeur produite (sinon refus).
 * Après application, le document doit respecter le schéma et les invariants : sinon refus, sans
 * aucune correction silencieuse.
 */
import { z } from 'zod';
import { CAPTION_ROLES, cleanWord, joinWords } from '../captions';
import { canonicalJson, CaptionStyleSchema, RectSchema } from '../project';
import { segmentEditDuration } from '../time';
import { checkInvariants } from './invariants';
import { getKey, keyFingerprint, setKey, type CaptionState, type StateKey } from './keys';
import {
  AudioTrackV2Schema,
  CaptionPositionSchema,
  ClipProjectV2Schema,
  EffectV2Schema,
  LayerSchema,
  LAYOUT_PRESETS_V2,
  LayoutOverrideSchema,
  ManualCaptionSchema,
  MaskSchema,
  OverlaySchema,
  SfxSchema,
  segmentsV2,
  type ClipProjectV2,
  type SegmentV2,
} from './schema';

const ms = z.number().int().nonnegative();
const id = z.string().min(1).max(100);

/* ------------------------------------------------------------------ */
/* Schémas des opérations                                              */
/* ------------------------------------------------------------------ */

const ENTITY_SCHEMAS = {
  mask: MaskSchema,
  effect: EffectV2Schema,
  overlay: OverlaySchema,
  sfx: SfxSchema,
  manual: ManualCaptionSchema,
  layoutOverride: LayoutOverrideSchema,
} as const;
export type EntityCollection = keyof typeof ENTITY_SCHEMAS;
const ENTITY_COLLECTIONS = Object.keys(ENTITY_SCHEMAS) as [EntityCollection, ...EntityCollection[]];

export const OperationSchema = z.discriminatedUnion('type', [
  // Segments
  z.object({ type: z.literal('splitSegment'), segmentId: id, atSrcMs: ms, newId: id }).strict(),
  z
    .object({
      type: z.literal('trimSegment'),
      segmentId: id,
      srcStartMs: ms.optional(),
      srcEndMs: ms.optional(),
      editDurMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('moveSegment'), segmentId: id, toIndex: z.number().int().min(0) })
    .strict(),
  z.object({ type: z.literal('rippleDelete'), segmentId: id }).strict(),
  z.object({ type: z.literal('liftDelete'), segmentId: id, gapId: id }).strict(),
  z
    .object({
      type: z.literal('insertFreeze'),
      segmentId: id,
      atSrcMs: ms,
      freezeId: id,
      newId: id,
      editDurMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('extendWindow'),
      srcStartMs: ms,
      srcEndMs: ms,
      integrityManifestId: id,
    })
    .strict(),
  // Sous-titres
  z
    .object({
      type: z.literal('setCaptionsConfig'),
      enabled: z.boolean().optional(),
      sources: z.array(z.enum(CAPTION_ROLES)).max(3).optional(),
      style: CaptionStyleSchema.partial().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('retimeCaption'),
      itemId: id,
      srcStartMs: ms.nullable(),
      srcEndMs: ms.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('styleCaption'),
      itemId: id,
      style: CaptionStyleSchema.partial().nullable(),
      position: CaptionPositionSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('editCaptionText'),
      itemId: id,
      text: z.string().max(400).nullable(),
      /** Horodatage fourni par l'opération (rejeu déterministe). */
      at: z.string().min(1).max(40),
    })
    .strict(),
  z
    .object({
      type: z.literal('splitCaption'),
      itemId: id,
      atWord: z.number().int().min(1),
      newId: id,
    })
    .strict(),
  z.object({ type: z.literal('mergeCaptions'), firstId: id, secondId: id }).strict(),
  // Éléments placés (masques, effets, calques, effets sonores, sous-titres manuels, surcharges)
  z
    .object({
      type: z.literal('setEntity'),
      collection: z.enum(ENTITY_COLLECTIONS),
      entity: z.record(z.string(), z.unknown()),
      /** Exigé pour passer un masque en `off` (confirmation explicite). */
      acknowledgeMaskRisk: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('removeEntity'),
      collection: z.enum(ENTITY_COLLECTIONS),
      id,
      /** Exigé pour supprimer un masque (même règle que sa désactivation). */
      acknowledgeMaskRisk: z.boolean().optional(),
    })
    .strict(),
  // Mise en page
  z
    .object({
      type: z.literal('setLayout'),
      preset: z.enum(LAYOUT_PRESETS_V2).optional(),
      focusX: z.number().min(0).max(1).optional(),
      facecamShare: z.number().min(0.25).max(0.45).optional(),
      layers: z.array(LayerSchema).max(4).optional(),
      background: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/u)
        .optional(),
      gameplayRect: RectSchema.optional(),
    })
    .strict(),
  // Audio
  z
    .object({
      type: z.literal('setTrack'),
      audioIndex: z.number().int().nonnegative(),
      /** Requis seulement pour AJOUTER une piste absente du projet (rôle fourni par le serveur). */
      role: AudioTrackV2Schema.shape.role.optional(),
      enabled: z.boolean().optional(),
      gainDb: z.number().min(-30).max(12).optional(),
      automation: AudioTrackV2Schema.shape.automation.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('setAudioConfig'),
      silent: z.boolean().optional(),
      loudnorm: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('setMode'), mode: z.enum(['fidele', 'enrichi']) }).strict(),
  // Inverse générique (annuler)
  z
    .object({
      type: z.literal('restore'),
      entries: z
        .array(
          z
            .object({
              key: z.string().min(1).max(120),
              /** Valeur à remettre (null : l'entité n'existait pas). */
              value: z.unknown(),
              /** Empreinte attendue AVANT restauration (canonique ; null : absente). */
              expect: z.string().nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(400),
      /**
       * Exigé si la restauration retire ou désactive un masque opaque (annuler l'ajout d'un
       * masque, par exemple) : aucune protection ne disparaît sans confirmation explicite.
       */
      acknowledgeMaskRisk: z.boolean().optional(),
    })
    .strict(),
]);
export type Operation = z.infer<typeof OperationSchema>;

/* ------------------------------------------------------------------ */
/* Erreurs et contexte                                                 */
/* ------------------------------------------------------------------ */

export type OpErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'EXPORT_CONSENT_REQUIRED'
  | 'MASK_RISK_NOT_ACKNOWLEDGED'
  | 'INVARIANT_VIOLATED';

export class OpError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

/**
 * Contexte fourni par le serveur (et par l'interface, pour un retour immédiat). Quand il est
 * fourni, toute ÉCRITURE qui activerait une piste ou une source de sous-titres non autorisée
 * AUJOURD'HUI est refusée (EXPORT_CONSENT_REQUIRED) — annuler / rétablir compris.
 */
export interface ApplyContext {
  allowedAudioIndexes?: readonly number[];
  allowedCaptionRoles?: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Planification : lectures + nouvelles valeurs                        */
/* ------------------------------------------------------------------ */

interface Plan {
  reads: Set<StateKey>;
  writes: Map<StateKey, unknown>;
  /** Restauration : empreintes attendues avant écriture. */
  expects?: Map<StateKey, string | null>;
}

const clone = <T>(v: T): T => structuredClone(v);

function segIndex(d: ClipProjectV2, segmentId: string): number {
  const i = d.segments.findIndex((s) => s.id === segmentId);
  if (i < 0) throw new OpError('NOT_FOUND', `Segment introuvable : ${segmentId}`);
  return i;
}

function requireAbsentId(d: ClipProjectV2, newId: string) {
  if (d.segments.some((s) => s.id === newId)) {
    throw new OpError('VALIDATION_FAILED', `Identifiant déjà utilisé : ${newId}`);
  }
}

/** Une entité placée en temps MONTAGE dépend de la structure (durée totale) : elle lit `segments`. */
const readsStructure = (e: Record<string, unknown>) =>
  (e['timing'] as { anchor?: string } | undefined)?.anchor === 'edit';

function plan(d: ClipProjectV2, op: Operation): Plan {
  const reads = new Set<StateKey>();
  const writes = new Map<StateKey, unknown>();
  const seg = () => {
    reads.add('segments');
    reads.add('window');
    return clone(d.segments);
  };

  switch (op.type) {
    case 'splitSegment': {
      const segs = seg();
      const i = segIndex(d, op.segmentId);
      const s = segs[i]!;
      if (s.kind !== 'source' || !(s.srcStartMs < op.atSrcMs && op.atSrcMs < s.srcEndMs)) {
        throw new OpError('VALIDATION_FAILED', 'Coupe hors du segment source');
      }
      requireAbsentId(d, op.newId);
      segs.splice(
        i,
        1,
        { ...s, srcEndMs: op.atSrcMs },
        { ...s, id: op.newId, srcStartMs: op.atSrcMs },
      );
      writes.set('segments', segs);
      // La surcharge de disposition du segment coupé s'applique aux deux moitiés.
      const ov = `layoutOverride:${op.segmentId}`;
      reads.add(ov);
      reads.add(`layoutOverride:${op.newId}`);
      const existing = getKey(d, ov) as { layers: unknown } | undefined;
      if (existing) writes.set(`layoutOverride:${op.newId}`, { ...clone(existing), id: op.newId });
      break;
    }
    case 'trimSegment': {
      const segs = seg();
      const i = segIndex(d, op.segmentId);
      const s = segs[i]!;
      if (s.kind === 'source') {
        if (op.editDurMs !== undefined)
          throw new OpError('VALIDATION_FAILED', 'Durée réservée aux arrêts et vides');
        segs[i] = {
          ...s,
          srcStartMs: op.srcStartMs ?? s.srcStartMs,
          srcEndMs: op.srcEndMs ?? s.srcEndMs,
        };
      } else {
        if (
          op.srcStartMs !== undefined ||
          op.srcEndMs !== undefined ||
          op.editDurMs === undefined
        ) {
          throw new OpError(
            'VALIDATION_FAILED',
            'Un arrêt sur image ou un vide se règle par sa durée',
          );
        }
        segs[i] = { ...s, editDurMs: op.editDurMs };
      }
      writes.set('segments', segs);
      break;
    }
    case 'moveSegment': {
      const segs = seg();
      const i = segIndex(d, op.segmentId);
      const [s] = segs.splice(i, 1);
      segs.splice(Math.min(op.toIndex, segs.length), 0, s!);
      writes.set('segments', segs);
      break;
    }
    case 'rippleDelete':
    case 'liftDelete': {
      const segs = seg();
      const i = segIndex(d, op.segmentId);
      const s = segs[i]!;
      if (op.type === 'rippleDelete') {
        segs.splice(i, 1);
      } else {
        requireAbsentId(d, op.gapId);
        // Sans décalage : un vide de MÊME durée de montage remplace le segment.
        segs.splice(i, 1, {
          id: op.gapId,
          kind: 'gap',
          editDurMs: segmentEditDuration(segmentsV2([s])[0]!),
        });
      }
      writes.set('segments', segs);
      const ov = `layoutOverride:${op.segmentId}`;
      reads.add(ov);
      if (getKey(d, ov) !== undefined) writes.set(ov, undefined);
      break;
    }
    case 'insertFreeze': {
      const segs = seg();
      const i = segIndex(d, op.segmentId);
      const s = segs[i]!;
      if (s.kind !== 'source' || !(s.srcStartMs < op.atSrcMs && op.atSrcMs < s.srcEndMs)) {
        throw new OpError('VALIDATION_FAILED', 'Arrêt sur image hors du segment source');
      }
      requireAbsentId(d, op.freezeId);
      requireAbsentId(d, op.newId);
      if (op.freezeId === op.newId)
        throw new OpError('VALIDATION_FAILED', 'Identifiants identiques');
      const freeze: SegmentV2 = {
        id: op.freezeId,
        kind: 'freeze',
        srcAtMs: op.atSrcMs,
        editDurMs: op.editDurMs,
      };
      segs.splice(i, 1, { ...s, srcEndMs: op.atSrcMs }, freeze, {
        ...s,
        id: op.newId,
        srcStartMs: op.atSrcMs,
      });
      writes.set('segments', segs);
      // La surcharge de disposition du segment s'applique aussi à l'arrêt et à la partie après.
      const ov = `layoutOverride:${op.segmentId}`;
      reads.add(ov);
      reads.add(`layoutOverride:${op.freezeId}`);
      reads.add(`layoutOverride:${op.newId}`);
      const existing = getKey(d, ov) as { layers: unknown } | undefined;
      if (existing) {
        writes.set(`layoutOverride:${op.freezeId}`, { ...clone(existing), id: op.freezeId });
        writes.set(`layoutOverride:${op.newId}`, { ...clone(existing), id: op.newId });
      }
      break;
    }
    case 'extendWindow': {
      reads.add('window');
      const w = d.source.editWindow;
      if (op.srcStartMs > w.srcStartMs || op.srcEndMs < w.srcEndMs) {
        throw new OpError('VALIDATION_FAILED', 'La nouvelle fenêtre doit contenir l’actuelle');
      }
      if (op.integrityManifestId === w.integrityManifestId) {
        throw new OpError('VALIDATION_FAILED', 'Élargir la fenêtre exige un nouveau manifeste');
      }
      if (d.source.durationMs !== null && op.srcEndMs > d.source.durationMs) {
        throw new OpError('VALIDATION_FAILED', 'La fenêtre dépasse la fin de l’enregistrement');
      }
      writes.set('window', {
        srcStartMs: op.srcStartMs,
        srcEndMs: op.srcEndMs,
        integrityManifestId: op.integrityManifestId,
      });
      break;
    }
    case 'setCaptionsConfig': {
      reads.add('captions.config');
      const cur = getKey(d, 'captions.config') as Pick<
        ClipProjectV2['captions'],
        'enabled' | 'sources' | 'style'
      >;
      writes.set('captions.config', {
        enabled: op.enabled ?? cur.enabled,
        sources: op.sources ?? cur.sources,
        style: { ...cur.style, ...(op.style ?? {}) },
      });
      break;
    }
    case 'retimeCaption':
    case 'styleCaption': {
      const key = `caption:${op.itemId}`;
      reads.add(key);
      const cur = getKey(d, key) as CaptionState | undefined;
      if (!cur) throw new OpError('NOT_FOUND', `Sous-titre introuvable : ${op.itemId}`);
      const base = cur.override ?? {
        id: op.itemId,
        srcStartMs: null,
        srcEndMs: null,
        style: null,
        position: null,
      };
      const next =
        op.type === 'retimeCaption'
          ? { ...base, srcStartMs: op.srcStartMs, srcEndMs: op.srcEndMs }
          : { ...base, style: op.style, position: op.position };
      const empty =
        next.srcStartMs === null &&
        next.srcEndMs === null &&
        next.style === null &&
        next.position === null;
      writes.set(key, { ...clone(cur), override: empty ? null : next });
      break;
    }
    case 'editCaptionText': {
      const key = `caption:${op.itemId}`;
      reads.add(key);
      const cur = getKey(d, key) as CaptionState | undefined;
      if (!cur) throw new OpError('NOT_FOUND', `Sous-titre introuvable : ${op.itemId}`);
      const original = joinWords(cur.item.words);
      const text = op.text === null ? null : cleanWord(op.text);
      if (text !== null && (text.length < 1 || text.length > 200)) {
        throw new OpError('VALIDATION_FAILED', 'Texte corrigé : 1 à 200 caractères');
      }
      const correction =
        text === null || text === original
          ? null
          : {
              itemId: op.itemId,
              originalText: original,
              correctedText: text,
              revision: cur.correction?.revision ?? 1,
              at: op.at,
            };
      writes.set(key, { ...clone(cur), correction });
      break;
    }
    case 'splitCaption': {
      const key = `caption:${op.itemId}`;
      const newKey = `caption:${op.newId}`;
      reads.add(key);
      reads.add(newKey);
      reads.add(`manual:${op.newId}`); // identifiants partagés avec les sous-titres manuels
      const cur = getKey(d, key) as CaptionState | undefined;
      if (!cur) throw new OpError('NOT_FOUND', `Sous-titre introuvable : ${op.itemId}`);
      if (getKey(d, newKey) !== undefined || getKey(d, `manual:${op.newId}`) !== undefined) {
        throw new OpError('VALIDATION_FAILED', `Identifiant déjà utilisé : ${op.newId}`);
      }
      if (cur.correction || cur.override) {
        throw new OpError(
          'PRECONDITION_FAILED',
          'Annulez la correction ou le réglage d’affichage avant de découper',
        );
      }
      const words = cur.item.words;
      if (op.atWord >= words.length)
        throw new OpError('VALIDATION_FAILED', 'Découpe hors des mots');
      const a = words.slice(0, op.atWord);
      const b = words.slice(op.atWord);
      writes.set(key, {
        item: { ...cur.item, words: a, srcEndMs: a.at(-1)!.srcEndMs },
        correction: null,
        override: null,
      });
      writes.set(newKey, {
        item: { ...cur.item, id: op.newId, words: b, srcStartMs: b[0]!.srcStartMs },
        correction: null,
        override: null,
      });
      break;
    }
    case 'mergeCaptions': {
      const k1 = `caption:${op.firstId}`;
      const k2 = `caption:${op.secondId}`;
      reads.add(k1);
      reads.add(k2);
      const a = getKey(d, k1) as CaptionState | undefined;
      const b = getKey(d, k2) as CaptionState | undefined;
      if (!a || !b || op.firstId === op.secondId)
        throw new OpError('NOT_FOUND', 'Sous-titres introuvables');
      if (a.item.speakerRole !== b.item.speakerRole) {
        throw new OpError('VALIDATION_FAILED', 'Fusion impossible : sources différentes');
      }
      if (a.correction || b.correction || a.override || b.override) {
        throw new OpError(
          'PRECONDITION_FAILED',
          'Annulez corrections et réglages avant de fusionner',
        );
      }
      if (b.item.srcStartMs < a.item.srcEndMs) {
        throw new OpError('VALIDATION_FAILED', 'Le second sous-titre doit suivre le premier');
      }
      if (a.item.words.length + b.item.words.length > 200) {
        throw new OpError('VALIDATION_FAILED', 'Sous-titre fusionné trop long');
      }
      writes.set(k1, {
        item: { ...a.item, words: [...a.item.words, ...b.item.words], srcEndMs: b.item.srcEndMs },
        correction: null,
        override: null,
      });
      writes.set(k2, undefined);
      break;
    }
    case 'setEntity': {
      const parsed = ENTITY_SCHEMAS[op.collection].safeParse(op.entity);
      if (!parsed.success) {
        throw new OpError(
          'VALIDATION_FAILED',
          `Élément invalide (${op.collection})`,
          parsed.error.issues,
        );
      }
      const entity = parsed.data as { id: string } & Record<string, unknown>;
      const key = `${op.collection}:${entity.id}`;
      if (op.collection === 'mask') {
        reads.add(key);
        reads.add('window');
        const prev = getKey(d, key) as { mode: string } | undefined;
        // Désactiver un masque (ou en créer un désactivé) exige une confirmation explicite.
        if (entity['mode'] === 'off' && prev?.mode !== 'off' && op.acknowledgeMaskRisk !== true) {
          throw new OpError(
            'MASK_RISK_NOT_ACKNOWLEDGED',
            'Désactiver un masque exige de confirmer le risque',
          );
        }
      }
      if (op.collection === 'manual') {
        // Identifiants partagés avec les items de transcription.
        reads.add(`caption:${entity.id}`);
        if (getKey(d, `caption:${entity.id}`) !== undefined) {
          throw new OpError('VALIDATION_FAILED', `Identifiant déjà utilisé : ${entity.id}`);
        }
      }
      if (op.collection === 'layoutOverride') {
        reads.add('segments');
        if (!d.segments.some((s) => s.id === entity.id)) {
          throw new OpError('NOT_FOUND', `Segment introuvable : ${entity.id}`);
        }
      }
      if (readsStructure(entity)) reads.add('segments');
      writes.set(key, entity);
      break;
    }
    case 'removeEntity': {
      const key = `${op.collection}:${op.id}`;
      reads.add(key);
      if (getKey(d, key) === undefined)
        throw new OpError('NOT_FOUND', `Élément introuvable : ${op.id}`);
      // Supprimer un masque retire une protection : confirmation explicite, comme sa désactivation.
      if (op.collection === 'mask' && op.acknowledgeMaskRisk !== true) {
        throw new OpError(
          'MASK_RISK_NOT_ACKNOWLEDGED',
          'Supprimer un masque exige de confirmer le risque',
        );
      }
      writes.set(key, undefined);
      break;
    }
    case 'setLayout': {
      reads.add('layout');
      const cur = clone(getKey(d, 'layout') as Omit<ClipProjectV2['layout'], 'overrides'>);
      const preset = op.preset ?? cur.preset;
      const layers = op.layers ?? (preset === 'custom' ? cur.layers : []);
      if (preset === 'custom' && !layers.length) {
        throw new OpError('VALIDATION_FAILED', 'Disposition personnalisée sans calque');
      }
      if (preset !== 'custom' && op.layers?.length) {
        throw new OpError('VALIDATION_FAILED', 'Calques réservés à la disposition personnalisée');
      }
      if (preset === 'facecam_top' && !cur.facecamRect) {
        throw new OpError('VALIDATION_FAILED', 'Disposition facecam sans facecam dans le cadrage');
      }
      writes.set('layout', {
        ...cur,
        preset,
        layers: preset === 'custom' ? layers : [],
        focusX: op.focusX ?? cur.focusX,
        facecamShare: op.facecamShare ?? cur.facecamShare,
        background: op.background ?? cur.background,
        gameplayRect: op.gameplayRect ?? cur.gameplayRect,
      });
      break;
    }
    case 'setTrack': {
      const key = `track:${op.audioIndex}`;
      reads.add(key);
      const cur = getKey(d, key) as ClipProjectV2['audio']['tracks'][number] | undefined;
      if (!cur && !op.role)
        throw new OpError('VALIDATION_FAILED', 'Rôle requis pour ajouter une piste');
      const base = cur ?? {
        audioIndex: op.audioIndex,
        role: op.role!,
        gainDb: 0,
        enabled: true,
        automation: [],
      };
      writes.set(key, {
        ...clone(base),
        enabled: op.enabled ?? base.enabled,
        gainDb: op.gainDb ?? base.gainDb,
        automation: op.automation ?? base.automation,
      });
      break;
    }
    case 'setAudioConfig': {
      reads.add('audio.config');
      const cur = getKey(d, 'audio.config') as Pick<ClipProjectV2['audio'], 'silent' | 'loudnorm'>;
      writes.set('audio.config', {
        silent: op.silent ?? cur.silent,
        loudnorm:
          op.loudnorm === undefined ? cur.loudnorm : { enabled: op.loudnorm, targetLufs: -14 },
      });
      break;
    }
    case 'setMode':
      writes.set('mode', op.mode);
      break;
    case 'restore': {
      const expects = new Map<StateKey, string | null>();
      for (const e of op.entries) {
        if (writes.has(e.key)) throw new OpError('VALIDATION_FAILED', `Clé en double : ${e.key}`);
        reads.add(e.key);
        expects.set(e.key, e.expect);
        writes.set(e.key, e.value === null ? undefined : e.value);
        const before = e.key.startsWith('mask:')
          ? (getKey(d, e.key) as { mode: string } | undefined)
          : undefined;
        const after = e.value as { mode?: string } | null;
        if (
          before?.mode === 'opaque' &&
          after?.mode !== 'opaque' &&
          op.acknowledgeMaskRisk !== true
        ) {
          throw new OpError(
            'MASK_RISK_NOT_ACKNOWLEDGED',
            'Cette annulation retire ou désactive un masque : confirmez le risque',
          );
        }
      }
      return { reads, writes, expects };
    }
  }
  return { reads, writes };
}

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

export interface AppliedOp {
  doc: ClipProjectV2;
  /** Clés lues (dépendances structurelles comprises). */
  reads: StateKey[];
  /** Clés écrites. */
  writes: StateKey[];
  /** Empreinte de chaque clé lue AVANT application (null : absente). */
  preconditions: Record<StateKey, string | null>;
  /** Opération qui annule celle-ci (si les clés écrites n'ont pas changé entre-temps). */
  inverse: Extract<Operation, { type: 'restore' }>;
}

function checkAuthorization(d: ClipProjectV2, writes: Map<StateKey, unknown>, ctx: ApplyContext) {
  for (const [key, value] of writes) {
    if (ctx.allowedAudioIndexes && key.startsWith('track:') && value !== undefined) {
      const t = value as { audioIndex: number; enabled: boolean };
      if (t.enabled && !ctx.allowedAudioIndexes.includes(t.audioIndex)) {
        throw new OpError(
          'EXPORT_CONSENT_REQUIRED',
          `Piste ${t.audioIndex} non autorisée à l’export`,
        );
      }
    }
    if (ctx.allowedCaptionRoles && key === 'captions.config') {
      const v = value as { sources: string[] };
      const refused = v.sources.filter((r) => !ctx.allowedCaptionRoles!.includes(r));
      if (refused.length) {
        throw new OpError(
          'EXPORT_CONSENT_REQUIRED',
          `Sous-titres non autorisés : ${refused.join(', ')}`,
        );
      }
    }
  }
  void d;
}

/**
 * Applique une opération. Lève `OpError` si elle est invalide, si une précondition échoue
 * (restauration), si une autorisation manque ou si un invariant serait violé.
 */
export function applyOperation(
  doc: ClipProjectV2,
  rawOp: unknown,
  ctx: ApplyContext = {},
): AppliedOp {
  const parsedOp = OperationSchema.safeParse(rawOp);
  if (!parsedOp.success) {
    throw new OpError('VALIDATION_FAILED', 'Opération invalide', parsedOp.error.issues);
  }
  const op = parsedOp.data;
  const p = plan(doc, op);
  if (p.expects) {
    for (const [key, expected] of p.expects) {
      if (keyFingerprint(doc, key) !== expected) {
        throw new OpError('PRECONDITION_FAILED', `L’état a changé depuis (${key})`, { key });
      }
    }
  }
  checkAuthorization(doc, p.writes, ctx);

  const preconditions: Record<StateKey, string | null> = {};
  for (const key of p.reads) preconditions[key] = keyFingerprint(doc, key);
  const before = new Map<StateKey, unknown>();
  for (const key of p.writes.keys()) before.set(key, getKey(doc, key));

  const draft = clone(doc);
  for (const [key, value] of p.writes) setKey(draft, key, clone(value));

  const parsed = ClipProjectV2Schema.safeParse(draft);
  if (!parsed.success) {
    throw new OpError(
      'VALIDATION_FAILED',
      'Document invalide après l’opération',
      parsed.error.issues,
    );
  }
  const issues = checkInvariants(parsed.data);
  if (issues.length) {
    throw new OpError('INVARIANT_VIOLATED', issues.map((i) => i.message).join(' ; '), issues);
  }
  const next = parsed.data;
  return {
    doc: next,
    reads: [...p.reads].sort(),
    writes: [...p.writes.keys()].sort(),
    preconditions,
    inverse: {
      type: 'restore',
      entries: [...p.writes.keys()].sort().map((key) => ({
        key,
        value: before.get(key) === undefined ? null : clone(before.get(key)),
        expect: keyFingerprint(next, key),
      })),
    },
  };
}

/** Applique une suite d'opérations (un lot) ; tout ou rien. */
export function applyBatch(
  doc: ClipProjectV2,
  ops: readonly unknown[],
  ctx: ApplyContext = {},
): { doc: ClipProjectV2; applied: AppliedOp[] } {
  let cur = doc;
  const applied: AppliedOp[] = [];
  for (const op of ops) {
    const a = applyOperation(cur, op, ctx);
    applied.push(a);
    cur = a.doc;
  }
  return { doc: cur, applied };
}

/** Inverse d'un lot : inverses dans l'ordre inverse. */
export function inverseOfBatch(applied: readonly AppliedOp[]): Operation[] {
  return [...applied].reverse().map((a) => a.inverse);
}

/** Les préconditions d'un lot sont-elles vraies sur ce document ? */
export function preconditionsHold(
  doc: ClipProjectV2,
  preconditions: Record<StateKey, string | null>,
): boolean {
  return Object.entries(preconditions).every(([k, v]) => keyFingerprint(doc, k) === v);
}

/** Empreinte canonique comparable d'un document. */
export const documentFingerprint = (d: ClipProjectV2) => canonicalJson(d);
