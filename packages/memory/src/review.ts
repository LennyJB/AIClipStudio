/**
 * Décision du créateur sur une proposition : validation des entrées et machine d'états.
 *
 * Règles (plan de l'étape 5, § 8) :
 *  - refus : au moins un motif ; « autre » exige un commentaire ; commentaire ≤ 2 000 caractères ;
 *  - acceptation : aucun motif, commentaire facultatif ;
 *  - réinitialisation (« à examiner ») : ni motif ni commentaire ;
 *  - un état identique à l'état effectif ne produit rien (`noop`) ;
 *  - seule la proposition SOURCE de la décision effective de son moment peut la modifier
 *    librement ; ailleurs, accepter ou refuser exige une réévaluation explicite et
 *    réinitialiser est refusé (on ne défait jamais en silence la décision d'une autre proposition).
 */
import { z } from 'zod';
import { canonicalReasons, RejectReasonSchema, type RejectReason } from './reasons';

export const REVIEW_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MAX_COMMENT_LENGTH = 2000;

export const DecisionInputSchema = z
  .object({
    decision: z.enum(REVIEW_STATUSES),
    reasons: z.array(RejectReasonSchema).max(10).optional(),
    comment: z.string().max(MAX_COMMENT_LENGTH).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const reasons = v.reasons ?? [];
    const comment = v.comment?.trim() ?? '';
    if (v.decision === 'rejected' && reasons.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'Au moins un motif de refus' });
    }
    if (v.decision !== 'rejected' && reasons.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasons'],
        message: 'Les motifs ne concernent que les refus',
      });
    }
    if (v.decision === 'rejected' && reasons.includes('autre') && comment === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'Un commentaire est obligatoire avec le motif « autre »',
      });
    }
    if (v.decision === 'pending' && comment !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'Une réinitialisation ne porte pas de commentaire',
      });
    }
  });

export type DecisionInput = z.input<typeof DecisionInputSchema>;

/** État d'une décision, normalisé (motifs canoniques, commentaire vide → null). */
export interface DecisionState {
  status: ReviewStatus;
  reasons: RejectReason[];
  comment: string | null;
}

export function normalizeDecision(input: DecisionInput): DecisionState {
  const v = DecisionInputSchema.parse(input);
  const comment = v.comment?.trim() ? v.comment.trim() : null;
  return {
    status: v.decision,
    reasons: v.decision === 'rejected' ? canonicalReasons(v.reasons ?? []) : [],
    comment: v.decision === 'pending' ? null : comment,
  };
}

export const PENDING_STATE: DecisionState = Object.freeze({
  status: 'pending',
  reasons: [],
  comment: null,
}) as DecisionState;

export function sameState(a: DecisionState, b: DecisionState): boolean {
  return (
    a.status === b.status &&
    a.comment === b.comment &&
    a.reasons.length === b.reasons.length &&
    a.reasons.every((r, i) => r === b.reasons[i])
  );
}

export type FeedbackEventType = 'proposal_accepted' | 'proposal_rejected' | 'proposal_reset';

export function eventTypeFor(status: ReviewStatus): FeedbackEventType {
  return status === 'accepted'
    ? 'proposal_accepted'
    : status === 'rejected'
      ? 'proposal_rejected'
      : 'proposal_reset';
}

/** Décision effective du moment auquel appartient la proposition. */
export interface EffectiveDecision extends DecisionState {
  /** Proposition dont l'événement fait foi ; null si le moment est « à examiner ». */
  sourceProposalId: string | null;
  /** Événement qui fait foi ; null si aucune décision n'a jamais été prise. */
  eventId: string | null;
}

export type DecisionPlan =
  | { kind: 'noop' }
  | {
      kind: 'apply';
      eventType: FeedbackEventType;
      previousStatus: ReviewStatus;
      next: DecisionState;
      /** Événement remplacé lors d'une réévaluation explicite. */
      reevaluatesEventId: string | null;
    }
  | { kind: 'refused'; code: 'ALREADY_REVIEWED' | 'DECISION_ELSEWHERE' };

/**
 * Ce qu'il faut faire d'une demande de décision sur `proposalId`, sachant la décision effective
 * de son moment. Fonction pure : ne lit ni n'écrit rien.
 */
export function planDecision(p: {
  proposalId: string;
  target: DecisionState;
  effective: EffectiveDecision;
  reevaluate: boolean;
}): DecisionPlan {
  const { target, effective } = p;
  const decided = effective.status !== 'pending';
  const isSource = decided && effective.sourceProposalId === p.proposalId;

  if (decided && !isSource) {
    // La décision actuelle a été prise sur une AUTRE proposition du moment.
    if (target.status === 'pending') return { kind: 'refused', code: 'DECISION_ELSEWHERE' };
    if (!p.reevaluate) return { kind: 'refused', code: 'ALREADY_REVIEWED' };
    if (sameState(target, effective)) return { kind: 'noop' };
    return {
      kind: 'apply',
      eventType: eventTypeFor(target.status),
      previousStatus: effective.status,
      next: target,
      reevaluatesEventId: effective.eventId,
    };
  }

  // Moment « à examiner », ou proposition source de la décision actuelle.
  const current: DecisionState = decided ? effective : PENDING_STATE;
  if (sameState(target, current)) return { kind: 'noop' };
  return {
    kind: 'apply',
    eventType: eventTypeFor(target.status),
    previousStatus: current.status,
    next: target,
    reevaluatesEventId: null,
  };
}
