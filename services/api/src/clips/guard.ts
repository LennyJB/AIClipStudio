/**
 * Garde de décision (docs/plan-etape-6.md §6.7) : la décision effective d'une proposition est
 * TOUJOURS recalculée depuis proposal_reviews (source de vérité de l'étape 5), jamais copiée ni
 * mise en cache. Appelée à la création d'un projet et dans chaque transaction d'écriture.
 */
import { AppError } from '@acs/shared';
import type { ReviewService } from '../review/service';

export interface EffectiveDecisionView {
  status: 'pending' | 'accepted' | 'rejected';
  /** Proposition dont émane la décision (elle-même ou une autre du même moment). */
  sourceProposalId: string | null;
  inherited: boolean;
  merged: boolean;
}

export class DecisionGuard {
  constructor(private readonly review: ReviewService) {}

  effective(proposalId: string): EffectiveDecisionView {
    const d = this.review.detail(proposalId);
    return {
      status: d.effective.status,
      sourceProposalId: d.effective.sourceProposalId,
      inherited: d.effective.inherited,
      merged: d.proposal.mergedIntoId !== null,
    };
  }

  /** Lève PROPOSAL_NOT_ACCEPTED si la décision effective n'est pas « acceptée ». */
  assertAccepted(proposalId: string): EffectiveDecisionView {
    const e = this.effective(proposalId);
    if (e.merged || e.status !== 'accepted') {
      throw new AppError(
        'PROPOSAL_NOT_ACCEPTED',
        e.merged
          ? 'Proposition fusionnée dans une autre : utilisez la proposition retenue'
          : e.status === 'rejected'
            ? 'Proposition refusée : aucun clip ne peut en être produit'
            : 'Proposition non acceptée : validez-la d’abord (étape 5)',
        { details: { status: e.status } },
      );
    }
    return e;
  }
}
