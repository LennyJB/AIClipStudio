/**
 * Compatibilité avec l'étape 6 pendant la transition (PR 7b à 7e, décision du créateur) :
 *
 *  - `projectToV1` : projection EXACTE d'un document v2 en document v1, seulement s'il ne
 *    contient que des éléments de l'étape 6. Critère : la migration v1 → v2 de la projection
 *    redonne exactement le document v2 (aller-retour sans perte). Sinon `null` : jamais de
 *    projection approximative. L'interface 6c, le PATCH v1, la proposition d'effets et le moteur
 *    de l'étape 6 lisent cette projection ;
 *  - `diffToRestore` : opération `restore` qui transforme un document v2 en un autre, clé par
 *    clé (utilisée pour enregistrer un PATCH v1 ou une proposition d'effets comme entrée du
 *    journal). Vérifiée : l'appliquer donne exactement le document cible.
 */
import { canonicalJson, ClipProjectSchema, type ClipProject } from '../project';
import { allKeys, getKey, keyFingerprint } from './keys';
import { migrateV1ToV2 } from './migrate';
import { applyOperation, OpError, type ApplyContext, type Operation } from './ops';
import type { ClipProjectV2 } from './schema';

export function projectToV1(d: ClipProjectV2): ClipProject | null {
  const candidate = {
    schemaVersion: 1,
    origin: d.origin,
    source: {
      fingerprint: d.source.fingerprint,
      durationMs: d.source.durationMs,
      width: d.source.width,
      height: d.source.height,
      fps: d.source.fps,
      container: d.source.container,
      integrityManifestId: d.source.editWindow.integrityManifestId,
    },
    segments: d.segments,
    anchors: d.anchors,
    layout: {
      preset: d.layout.preset,
      gameplayRect: d.layout.gameplayRect,
      facecamRect: d.layout.facecamRect,
      framingProfile: d.layout.framingProfile,
      focusX: d.layout.focusX,
      facecamShare: d.layout.facecamShare,
      masks: d.masks.map((m) => ({ rect: m.rect, label: m.label, mode: m.mode })),
    },
    captions: {
      enabled: d.captions.enabled,
      sources: d.captions.sources,
      style: d.captions.style,
      pseudonymize: d.captions.pseudonymize,
      items: d.captions.items,
      corrections: d.captions.corrections,
    },
    effects: d.effects.map((e) => ({
      id: e.id,
      type: e.type,
      params: e.params,
      timing: e.timing,
      enabled: e.enabled,
      origin: e.origin,
      reason: e.reason,
      signals: e.signals,
    })),
    audio: {
      tracks: d.audio.tracks.map((t) => ({
        audioIndex: t.audioIndex,
        role: t.role,
        gainDb: t.gainDb,
        enabled: t.enabled,
      })),
      silent: d.audio.silent,
      loudnorm: d.audio.loudnorm,
    },
    mode: d.mode,
    durationPolicy: d.durationPolicy,
  };
  const parsed = ClipProjectSchema.safeParse(candidate);
  if (!parsed.success) return null;
  // Aller-retour sans perte : sinon le document utilise une fonction de l'éditeur (étape 7).
  try {
    const back = migrateV1ToV2(parsed.data, {
      manifestWindow: {
        srcStartMs: d.source.editWindow.srcStartMs,
        srcEndMs: d.source.editWindow.srcEndMs,
      },
    });
    return canonicalJson(back) === canonicalJson(d) ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Opération `restore` qui transforme `from` en `to` (clés différentes uniquement). Lève une
 * `OpError` si le résultat n'est pas EXACTEMENT `to` (partie du document hors clés, par exemple).
 * `acknowledgeMaskRisk` : à fournir seulement si l'appelant a déjà obtenu la confirmation.
 */
export function diffToRestore(
  from: ClipProjectV2,
  to: ClipProjectV2,
  opts: { acknowledgeMaskRisk?: boolean; ctx?: ApplyContext } = {},
): Operation[] {
  const keys = [...new Set([...allKeys(from), ...allKeys(to)])].sort();
  const entries = keys
    .filter((k) => keyFingerprint(from, k) !== keyFingerprint(to, k))
    .map((k) => ({ key: k, value: getKey(to, k) ?? null, expect: keyFingerprint(from, k) }));
  if (!entries.length) {
    if (canonicalJson(from) !== canonicalJson(to)) {
      throw new OpError('VALIDATION_FAILED', 'Différence hors des clés d’état : non enregistrable');
    }
    return [];
  }
  const op: Operation = {
    type: 'restore',
    entries,
    ...(opts.acknowledgeMaskRisk ? { acknowledgeMaskRisk: true } : {}),
  };
  const applied = applyOperation(from, op, opts.ctx ?? {});
  if (canonicalJson(applied.doc) !== canonicalJson(to)) {
    throw new OpError('VALIDATION_FAILED', 'Différence hors des clés d’état : non enregistrable');
  }
  return [op];
}
