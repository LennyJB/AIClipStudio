/**
 * Invariants du document v2, vérifiés après CHAQUE opération (côté interface et côté serveur).
 * Une opération qui en viole un est refusée : le document n'est jamais corrigé en silence.
 */
import { ABS_MAX_DURATION_MS, ABS_MIN_DURATION_MS } from '../project';
import { totalEditDuration } from '../time';
import { segmentsV2, type ClipProjectV2 } from './schema';

export type InvariantCode =
  | 'DURATION_BOUNDS'
  | 'OUT_OF_WINDOW'
  | 'DUPLICATE_ID'
  | 'GAP_AT_EDGE'
  | 'UNKNOWN_REFERENCE'
  | 'INVALID_RANGE';

export interface InvariantIssue {
  code: InvariantCode;
  message: string;
}

/** Marge autorisée pour les horaires d'affichage d'un sous-titre autour de ses mots. */
export const CAPTION_RETIME_MARGIN_MS = 2_000;

export function checkInvariants(d: ClipProjectV2): InvariantIssue[] {
  const out: InvariantIssue[] = [];
  const push = (code: InvariantCode, message: string) => out.push({ code, message });

  // Durée : bornes absolues 5–180 s (la plage du profil reste un avertissement, étape 6).
  const total = totalEditDuration(segmentsV2(d.segments));
  if (total < ABS_MIN_DURATION_MS || total > ABS_MAX_DURATION_MS) {
    push('DURATION_BOUNDS', `Durée ${total} ms hors des bornes absolues (5–180 s)`);
  }

  // Segments : identifiants uniques, dans la fenêtre éditable, pas de vide en bord de clip.
  const w = d.source.editWindow;
  const segIds = new Set<string>();
  for (const s of d.segments) {
    if (segIds.has(s.id)) push('DUPLICATE_ID', `Segment en double : ${s.id}`);
    segIds.add(s.id);
    if (s.kind === 'source') {
      if (s.srcStartMs >= s.srcEndMs) push('INVALID_RANGE', `Segment ${s.id} : plage vide`);
      if (s.srcStartMs < w.srcStartMs || s.srcEndMs > w.srcEndMs) {
        push('OUT_OF_WINDOW', `Segment ${s.id} hors de la fenêtre éditable`);
      }
    } else if (s.kind === 'freeze' && (s.srcAtMs < w.srcStartMs || s.srcAtMs >= w.srcEndMs)) {
      push('OUT_OF_WINDOW', `Arrêt sur image ${s.id} hors de la fenêtre éditable`);
    }
  }
  if (d.segments[0]?.kind === 'gap' || d.segments.at(-1)?.kind === 'gap') {
    push('GAP_AT_EDGE', 'Un clip ne peut ni commencer ni finir par un vide');
  }

  // Références : surcharges de mise en page → segments ; sous-titres → items existants.
  for (const o of d.layout.overrides) {
    if (!segIds.has(o.id)) push('UNKNOWN_REFERENCE', `Surcharge pour un segment absent : ${o.id}`);
  }
  const items = new Map(d.captions.items.map((i) => [i.id, i]));
  const manualIds = new Set(d.captions.manual.map((m) => m.id));
  const allCaptionIds = new Set<string>();
  for (const i of d.captions.items) {
    if (allCaptionIds.has(i.id)) push('DUPLICATE_ID', `Sous-titre en double : ${i.id}`);
    allCaptionIds.add(i.id);
  }
  for (const m of manualIds) {
    if (allCaptionIds.has(m)) push('DUPLICATE_ID', `Sous-titre en double : ${m}`);
  }
  for (const c of d.captions.corrections) {
    if (!items.has(c.itemId)) push('UNKNOWN_REFERENCE', `Correction orpheline : ${c.itemId}`);
  }
  for (const o of d.captions.overrides) {
    const item = items.get(o.id);
    if (!item) {
      push('UNKNOWN_REFERENCE', `Réglage d'affichage orphelin : ${o.id}`);
      continue;
    }
    const start = o.srcStartMs ?? item.srcStartMs;
    const end = o.srcEndMs ?? item.srcEndMs;
    if (start >= end) push('INVALID_RANGE', `Sous-titre ${o.id} : horaires vides`);
    if (
      start < item.srcStartMs - CAPTION_RETIME_MARGIN_MS ||
      end > item.srcEndMs + CAPTION_RETIME_MARGIN_MS
    ) {
      push('INVALID_RANGE', `Sous-titre ${o.id} : horaires à plus de 2 s de ses mots`);
    }
  }

  // Identifiants uniques DANS chaque collection (les clés d'état sont typées par collection).
  for (const [name, list] of [
    ['masque', d.masks],
    ['effet', d.effects],
    ['calque', d.overlays],
    ['effet sonore', d.audio.sfx],
  ] as const) {
    const seen = new Set<string>();
    for (const e of list) {
      if (seen.has(e.id)) push('DUPLICATE_ID', `${name} en double : ${e.id}`);
      seen.add(e.id);
    }
  }
  for (const m of d.masks) {
    if (
      m.srcRange &&
      (m.srcRange.srcEndMs <= w.srcStartMs || m.srcRange.srcStartMs >= w.srcEndMs)
    ) {
      push('OUT_OF_WINDOW', `Masque ${m.id} entièrement hors de la fenêtre éditable`);
    }
  }
  const tracks = new Set<number>();
  for (const t of d.audio.tracks) {
    if (tracks.has(t.audioIndex)) push('DUPLICATE_ID', `Piste en double : ${t.audioIndex}`);
    tracks.add(t.audioIndex);
  }
  return out;
}
