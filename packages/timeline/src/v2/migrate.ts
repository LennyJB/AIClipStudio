/**
 * Migration du document v1 (étape 6) vers v2 (étape 7). Fonction PURE : les révisions v1
 * stockées ne sont jamais réécrites, elles sont migrées à la lecture.
 *
 * La fenêtre éditable d'un projet existant est CELLE DE SON MANIFESTE D'INTÉGRITÉ (fournie par
 * l'appelant, qui la lit en base) : elle n'est jamais élargie automatiquement (décision 3).
 */
import { ProjectError, type ClipProject } from '../project';
import { checkInvariants } from './invariants';
import { byStartThenId } from './keys';
import {
  ClipProjectV2Schema,
  PROJECT_SCHEMA_VERSION_V2,
  type ClipProjectV2,
  type EffectV2,
} from './schema';

export interface MigrationContext {
  /** Fenêtre couverte par le manifeste `source.integrityManifestId` du document v1. */
  manifestWindow: { srcStartMs: number; srcEndMs: number };
}

/** Identifiant stable d'un masque v1 (sans identifiant) : l'ordre d'origine est conservé. */
export const v1MaskId = (index: number) => `mask-${String(index).padStart(3, '0')}`;

export function migrateV1ToV2(v1: ClipProject, ctx: MigrationContext): ClipProjectV2 {
  for (const s of v1.segments) {
    if (s.kind === 'source' && s.speed !== 1) {
      throw new ProjectError('VALIDATION_FAILED', 'Vitesse ≠ 1 non prise en charge (étape 7)');
    }
  }
  const effects: EffectV2[] = v1.effects
    .map((e) => ({
      id: e.id,
      type: e.type,
      params: e.type === 'caption_emphasis' ? {} : e.params,
      region: null,
      timing: e.timing,
      enabled: e.enabled,
      origin: e.origin,
      reason: e.reason,
      signals: e.signals,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const doc: ClipProjectV2 = {
    schemaVersion: PROJECT_SCHEMA_VERSION_V2,
    origin: v1.origin,
    source: {
      fingerprint: v1.source.fingerprint,
      durationMs: v1.source.durationMs,
      width: v1.source.width,
      height: v1.source.height,
      fps: v1.source.fps,
      container: v1.source.container,
      editWindow: {
        srcStartMs: ctx.manifestWindow.srcStartMs,
        srcEndMs: ctx.manifestWindow.srcEndMs,
        integrityManifestId: v1.source.integrityManifestId,
      },
    },
    segments: v1.segments.map((s) =>
      s.kind === 'source'
        ? { id: s.id, kind: 'source', srcStartMs: s.srcStartMs, srcEndMs: s.srcEndMs, speed: 1 }
        : { id: s.id, kind: 'freeze', srcAtMs: s.srcAtMs, editDurMs: s.editDurMs },
    ),
    anchors: v1.anchors,
    layout: {
      preset: v1.layout.preset,
      gameplayRect: v1.layout.gameplayRect,
      facecamRect: v1.layout.facecamRect,
      framingProfile: v1.layout.framingProfile,
      focusX: v1.layout.focusX,
      facecamShare: v1.layout.facecamShare,
      layers: [],
      background: '#000000',
      overrides: [],
    },
    // Masques du profil : permanents, mode conservé (opaque, ou désactivé avec confirmation).
    masks: v1.layout.masks.map((m, i) => ({
      id: v1MaskId(i),
      rect: m.rect,
      label: m.label,
      mode: m.mode,
      srcRange: null,
    })),
    // Ordre canonique des items (début, identifiant) : les mots ne changent pas.
    captions: {
      ...v1.captions,
      items: [...v1.captions.items].sort(byStartThenId),
      overrides: [],
      manual: [],
    },
    effects,
    overlays: [],
    audio: {
      tracks: v1.audio.tracks.map((t) => ({ ...t, automation: [] })),
      silent: v1.audio.silent,
      loudnorm: v1.audio.loudnorm,
      sfx: [],
    },
    mode: v1.mode,
    durationPolicy: v1.durationPolicy,
  };
  const parsed = ClipProjectV2Schema.parse(doc);
  const issues = checkInvariants(parsed);
  if (issues.length) {
    throw new ProjectError(
      'VALIDATION_FAILED',
      `Migration v1 → v2 impossible : ${issues.map((i) => i.message).join(' ; ')}`,
    );
  }
  return parsed;
}
