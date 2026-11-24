/**
 * Motifs de refus d'une proposition (mémoire éditoriale v1).
 * La liste est fermée : elle sert aux statistiques de l'étape 6.
 */
import { z } from 'zod';

export const REJECT_REASONS = [
  'pas_drole',
  'manque_de_contexte',
  'chute_coupee',
  'trop_long',
  'trop_court',
  'deja_vu',
  'gameplay_sans_interet',
  'audio_inaudible',
  'contenu_a_eviter',
  'autre',
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export const RejectReasonSchema = z.enum(REJECT_REASONS);

export const REJECT_REASON_LABELS: Readonly<Record<RejectReason, string>> = {
  pas_drole: 'Pas drôle',
  manque_de_contexte: 'Manque de contexte',
  chute_coupee: 'Chute coupée',
  trop_long: 'Trop long',
  trop_court: 'Trop court',
  deja_vu: 'Déjà vu',
  gameplay_sans_interet: 'Gameplay sans intérêt',
  audio_inaudible: 'Audio inaudible',
  contenu_a_eviter: 'Contenu à éviter',
  autre: 'Autre',
};

/** Motifs triés dans l'ordre canonique, sans doublon (comparaison et stockage stables). */
export function canonicalReasons(reasons: readonly RejectReason[]): RejectReason[] {
  const set = new Set(reasons);
  return REJECT_REASONS.filter((r) => set.has(r));
}
