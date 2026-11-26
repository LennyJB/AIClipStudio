/**
 * Avertissements et durée acceptée d'un document v2 : MÊMES règles que l'étape 6 (code partagé,
 * aucune réécriture), appliquées au premier et au dernier segment (docs/plan-etape-7.md §12) :
 * contexte et réaction coupés, durée hors plage (confirmation liée à la version), cadrage non
 * validé, aucune piste active, zones sensibles non masquées.
 */
import {
  durationAccepted,
  projectWarnings,
  type ClipProject,
  type ProjectWarning,
} from '../project';
import type { ClipProjectV2 } from './schema';

/** Vue v1 des seuls champs lus par ces règles (les segments v2 sont lus tels quels). */
function rulesView(d: ClipProjectV2): ClipProject {
  return {
    segments: d.segments,
    anchors: d.anchors,
    durationPolicy: d.durationPolicy,
    layout: {
      framingProfile: d.layout.framingProfile,
      masks: d.masks.map((m) => ({ rect: m.rect, label: m.label, mode: m.mode })),
    },
    audio: { silent: d.audio.silent, tracks: d.audio.tracks },
  } as unknown as ClipProject;
}

export function projectWarningsV2(d: ClipProjectV2, version: number): ProjectWarning[] {
  return projectWarnings(rulesView(d), version);
}

/** Durée conforme, ou hors plage confirmée pour CETTE version (bornes absolues 5–180 s). */
export function durationAcceptedV2(d: ClipProjectV2, version: number): boolean {
  return durationAccepted(rulesView(d), version);
}
