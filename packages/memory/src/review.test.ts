import { describe, expect, it } from 'vitest';
import { canonicalReasons, REJECT_REASON_LABELS, REJECT_REASONS } from './reasons';
import {
  DecisionInputSchema,
  normalizeDecision,
  planDecision,
  type DecisionState,
  type EffectiveDecision,
} from './review';

const PENDING: EffectiveDecision = {
  status: 'pending',
  reasons: [],
  comment: null,
  sourceProposalId: null,
  eventId: null,
};
const eff = (
  s: Partial<EffectiveDecision> & Pick<EffectiveDecision, 'status'>,
): EffectiveDecision => ({ ...PENDING, ...s });
const accept = (comment: string | null = null): DecisionState => ({
  status: 'accepted',
  reasons: [],
  comment,
});

describe('motifs de refus', () => {
  it('exactement les 10 motifs demandés, avec un libellé chacun', () => {
    expect(REJECT_REASONS).toEqual([
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
    ]);
    for (const r of REJECT_REASONS) expect(REJECT_REASON_LABELS[r]).toBeTruthy();
  });

  it('ordre canonique et sans doublon', () => {
    expect(canonicalReasons(['autre', 'pas_drole', 'autre', 'trop_long'])).toEqual([
      'pas_drole',
      'trop_long',
      'autre',
    ]);
  });
});

describe('validation d’une décision', () => {
  const ok = (v: unknown) => DecisionInputSchema.safeParse(v).success;

  it('refus : au moins un motif ; plusieurs possibles', () => {
    expect(ok({ decision: 'rejected' })).toBe(false);
    expect(ok({ decision: 'rejected', reasons: [] })).toBe(false);
    expect(ok({ decision: 'rejected', reasons: ['pas_drole', 'trop_long'] })).toBe(true);
  });

  it('« autre » exige un commentaire non vide', () => {
    expect(ok({ decision: 'rejected', reasons: ['autre'] })).toBe(false);
    expect(ok({ decision: 'rejected', reasons: ['autre'], comment: '   ' })).toBe(false);
    expect(ok({ decision: 'rejected', reasons: ['autre'], comment: 'son saturé' })).toBe(true);
  });

  it('motifs interdits hors refus ; commentaire interdit à la réinitialisation', () => {
    expect(ok({ decision: 'accepted', reasons: ['pas_drole'] })).toBe(false);
    expect(ok({ decision: 'accepted', comment: 'top' })).toBe(true);
    expect(ok({ decision: 'pending', comment: 'x' })).toBe(false);
    expect(ok({ decision: 'pending' })).toBe(true);
  });

  it('commentaire limité à 2 000 caractères ; motif inconnu et champ inconnu refusés', () => {
    expect(ok({ decision: 'accepted', comment: 'a'.repeat(2000) })).toBe(true);
    expect(ok({ decision: 'accepted', comment: 'a'.repeat(2001) })).toBe(false);
    expect(ok({ decision: 'rejected', reasons: ['nul'] })).toBe(false);
    expect(ok({ decision: 'accepted', extra: 1 })).toBe(false);
  });

  it('normalisation : motifs canoniques, commentaire rogné, vide → null', () => {
    expect(
      normalizeDecision({
        decision: 'rejected',
        reasons: ['trop_long', 'pas_drole'],
        comment: ' ',
      }),
    ).toEqual({ status: 'rejected', reasons: ['pas_drole', 'trop_long'], comment: null });
    expect(normalizeDecision({ decision: 'accepted', comment: '  bien  ' })).toEqual(
      accept('bien'),
    );
  });
});

describe('machine d’états (planDecision)', () => {
  it('moment à examiner → acceptation, refus ; réinitialiser = noop', () => {
    expect(
      planDecision({ proposalId: 'A', target: accept(), effective: PENDING, reevaluate: false }),
    ).toMatchObject({ kind: 'apply', eventType: 'proposal_accepted', previousStatus: 'pending' });
    expect(
      planDecision({
        proposalId: 'A',
        target: { status: 'rejected', reasons: ['pas_drole'], comment: null },
        effective: PENDING,
        reevaluate: false,
      }),
    ).toMatchObject({ kind: 'apply', eventType: 'proposal_rejected' });
    expect(
      planDecision({
        proposalId: 'A',
        target: { status: 'pending', reasons: [], comment: null },
        effective: PENDING,
        reevaluate: false,
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('source : changement d’avis, modification des motifs, réinitialisation, état identique = noop', () => {
    const accepted = eff({ status: 'accepted', sourceProposalId: 'A', eventId: 'e1' });
    expect(
      planDecision({
        proposalId: 'A',
        target: { status: 'rejected', reasons: ['trop_long'], comment: null },
        effective: accepted,
        reevaluate: false,
      }),
    ).toMatchObject({ kind: 'apply', previousStatus: 'accepted', reevaluatesEventId: null });
    expect(
      planDecision({
        proposalId: 'A',
        target: { status: 'pending', reasons: [], comment: null },
        effective: accepted,
        reevaluate: false,
      }),
    ).toMatchObject({ kind: 'apply', eventType: 'proposal_reset' });
    expect(
      planDecision({ proposalId: 'A', target: accept(), effective: accepted, reevaluate: false }),
    ).toEqual({ kind: 'noop' });
    const rejected = eff({
      status: 'rejected',
      reasons: ['pas_drole'],
      sourceProposalId: 'A',
      eventId: 'e2',
    });
    expect(
      planDecision({
        proposalId: 'A',
        target: { status: 'rejected', reasons: ['trop_long'], comment: null },
        effective: rejected,
        reevaluate: false,
      }),
    ).toMatchObject({ kind: 'apply', eventType: 'proposal_rejected' });
  });

  it('décision prise ailleurs : réinitialiser est refusé, même avec reevaluate', () => {
    const elsewhere = eff({ status: 'accepted', sourceProposalId: 'A', eventId: 'e1' });
    for (const reevaluate of [false, true]) {
      expect(
        planDecision({
          proposalId: 'B',
          target: { status: 'pending', reasons: [], comment: null },
          effective: elsewhere,
          reevaluate,
        }),
      ).toEqual({ kind: 'refused', code: 'DECISION_ELSEWHERE' });
    }
  });

  it('décision prise ailleurs : réévaluation explicite obligatoire, liée à l’événement remplacé', () => {
    const elsewhere = eff({ status: 'accepted', sourceProposalId: 'A', eventId: 'e1' });
    const reject: DecisionState = { status: 'rejected', reasons: ['deja_vu'], comment: null };
    expect(
      planDecision({ proposalId: 'B', target: reject, effective: elsewhere, reevaluate: false }),
    ).toEqual({ kind: 'refused', code: 'ALREADY_REVIEWED' });
    expect(
      planDecision({ proposalId: 'B', target: reject, effective: elsewhere, reevaluate: true }),
    ).toMatchObject({ kind: 'apply', reevaluatesEventId: 'e1', previousStatus: 'accepted' });
    // Réévaluation qui ne change rien : aucun événement.
    expect(
      planDecision({ proposalId: 'B', target: accept(), effective: elsewhere, reevaluate: true }),
    ).toEqual({ kind: 'noop' });
  });
});
