/**
 * Comptages simples des décisions, PAR MOMENT (jamais par proposition ni par événement).
 * Aucun apprentissage : ces chiffres servent à l'affichage ; l'étape 6 calculera les statistiques.
 */
import { REJECT_REASONS, type RejectReason } from './reasons';
import type { EffectiveDecision } from './review';

export interface DecisionSummary {
  moments: number;
  toReview: number;
  accepted: number;
  rejected: number;
  byReason: Record<RejectReason, number>;
}

/** `allMomentIds` : tous les moments considérés ; ceux sans décision effective sont à examiner. */
export function summarizeDecisions(
  allMomentIds: Iterable<string>,
  effective: ReadonlyMap<string, EffectiveDecision>,
): DecisionSummary {
  const byReason = Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as Record<
    RejectReason,
    number
  >;
  const s: DecisionSummary = { moments: 0, toReview: 0, accepted: 0, rejected: 0, byReason };
  for (const id of new Set(allMomentIds)) {
    s.moments += 1;
    const d = effective.get(id);
    if (!d || d.status === 'pending') s.toReview += 1;
    else if (d.status === 'accepted') s.accepted += 1;
    else {
      s.rejected += 1;
      for (const r of d.reasons) byReason[r] += 1;
    }
  }
  return s;
}
