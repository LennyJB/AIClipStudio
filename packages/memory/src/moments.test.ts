import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assignMoments,
  effectiveDecisions,
  matchMoment,
  sameMoment,
  type DecisionEvent,
  type ExistingMoment,
  type MomentRef,
  type ProposalToAssign,
} from './moments';
import { summarizeDecisions } from './summary';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 300) });

const ref = (seg: number, punch: number, start: number, end: number): MomentRef => ({
  punchlineSegmentId: seg,
  punchlineMs: punch,
  srcStartMs: start,
  srcEndMs: end,
});

// A ressemble à B, B ressemble à C, mais PAS A à C (chutes à 3 s l'une de l'autre).
const A = ref(1, 10_000, 5_000, 15_000);
const B = ref(2, 11_500, 6_000, 16_000);
const C = ref(3, 13_000, 7_000, 17_000);

const prop = (id: string, r: MomentRef, i: number): ProposalToAssign => ({
  id,
  ref: r,
  createdAt: `2026-11-24T10:00:${String(i).padStart(2, '0')}.000Z`,
});

function run(order: [string, MomentRef][], existing: ExistingMoment[] = []) {
  let n = 0;
  const ids = () => `M${++n}`;
  const res = assignMoments(
    existing,
    order.map(([id, r], i) => prop(id, r, i)),
    ids,
  );
  const groups = new Map<string, string[]>();
  for (const a of res) groups.set(a.momentId, [...(groups.get(a.momentId) ?? []), a.proposalId]);
  return { res, groups: [...groups.values()].map((g) => g.sort().join('')).sort() };
}

describe('rapprochement de deux passages', () => {
  it('même phrase de chute → même moment', () => {
    expect(matchMoment(ref(7, 1_000, 0, 30_000), ref(7, 50_000, 40_000, 70_000))?.kind).toBe(
      'same_punchline',
    );
  });

  it('seuils : 2 000 ms d’écart et 50 % de recouvrement (inclus), juste au-delà → distincts', () => {
    const base = ref(1, 10_000, 0, 20_000);
    expect(sameMoment(base, ref(2, 12_000, 10_000, 30_000))).toBe(true); // 2 000 ms, 50 %
    expect(sameMoment(base, ref(2, 12_001, 10_000, 30_000))).toBe(false); // 2 001 ms
    expect(sameMoment(base, ref(2, 11_000, 10_001, 30_000))).toBe(false); // < 50 %
  });

  it('deux blagues dans des fenêtres qui se chevauchent mais aux chutes éloignées → distinctes', () => {
    expect(sameMoment(ref(1, 10_000, 0, 40_000), ref(2, 30_000, 5_000, 45_000))).toBe(false);
  });

  it('symétrie', () => {
    const arb = fc.record({
      seg: fc.integer({ min: 1, max: 3 }),
      punch: fc.integer({ min: 0, max: 60_000 }),
      start: fc.integer({ min: 0, max: 50_000 }),
      len: fc.integer({ min: 1_000, max: 80_000 }),
    });
    fc.assert(
      fc.property(arb, arb, (a, b) => {
        const ra = ref(a.seg, a.punch, a.start, a.start + a.len);
        const rb = ref(b.seg, b.punch, b.start, b.start + b.len);
        expect(sameMoment(ra, rb)).toBe(sameMoment(rb, ra));
      }),
    );
  });
});

describe('affectation sans effet de chaîne (A-B-C)', () => {
  it('prérequis du cas : A~B, B~C, mais A≁C', () => {
    expect(sameMoment(A, B)).toBe(true);
    expect(sameMoment(B, C)).toBe(true);
    expect(sameMoment(A, C)).toBe(false);
  });

  it('ordre A, B, C → {A,B} et {C} : A et C jamais réunis', () => {
    expect(
      run([
        ['A', A],
        ['B', B],
        ['C', C],
      ]).groups,
    ).toEqual(['AB', 'C']);
  });

  it('ordre C, B, A → {B,C} et {A}', () => {
    expect(
      run([
        ['C', C],
        ['B', B],
        ['A', A],
      ]).groups,
    ).toEqual(['A', 'BC']);
  });

  it('ordre B, A, C → {A,B,C} : A et C ressemblent chacun à la référence B (voulu)', () => {
    expect(
      run([
        ['B', B],
        ['A', A],
        ['C', C],
      ]).groups,
    ).toEqual(['ABC']);
  });

  it('l’ordre change légitimement les regroupements ; dans aucun ordre A et C ne sont seuls ensemble', () => {
    const orders: [string, MomentRef][][] = [
      [
        ['A', A],
        ['B', B],
        ['C', C],
      ],
      [
        ['A', A],
        ['C', C],
        ['B', B],
      ],
      [
        ['B', B],
        ['A', A],
        ['C', C],
      ],
      [
        ['B', B],
        ['C', C],
        ['A', A],
      ],
      [
        ['C', C],
        ['A', A],
        ['B', B],
      ],
      [
        ['C', C],
        ['B', B],
        ['A', A],
      ],
    ];
    const results = orders.map((o) => run(o).groups.join('|'));
    expect(new Set(results).size).toBeGreaterThan(1);
    for (const r of results) {
      for (const g of r.split('|')) expect(g === 'AC').toBe(false);
      // A et C ne partagent un moment que si B en est la référence fondatrice.
    }
  });

  it('chaîne longue A→B→C→D : rattachement à un saut au plus de la référence, jamais de chaîne', () => {
    const D = ref(4, 14_500, 8_000, 18_000);
    expect(sameMoment(C, D)).toBe(true);
    expect(sameMoment(B, D)).toBe(false);
    const { res, groups } = run([
      ['A', A],
      ['B', B],
      ['C', C],
      ['D', D],
    ]);
    expect(groups).toEqual(['AB', 'CD']);
    const byMoment = new Map(res.filter((a) => a.newMoment).map((a) => [a.momentId, a.newMoment!]));
    for (const a of res) {
      const r = byMoment.get(a.momentId)!.ref;
      const own = { A, B, C, D }[a.proposalId as 'A']!;
      expect(sameMoment(own, r)).toBe(true); // chaque membre ressemble à la référence
    }
  });

  it('comparaison à la référence figée d’un moment existant, pas à ses autres membres', () => {
    // M1 existe avec la référence A ; B l'a rejoint autrefois. C ressemble à B, pas à A.
    const existing: ExistingMoment[] = [{ id: 'M1', ref: A, order: 0 }];
    expect(run([['C', C]], existing).res[0]).toMatchObject({ kind: 'founder' });
  });

  it('plusieurs moments candidats : même chute d’abord, puis meilleur recouvrement, puis plus ancien', () => {
    const P = ref(9, 10_000, 5_000, 15_000);
    const existing: ExistingMoment[] = [
      { id: 'OLD', ref: ref(1, 10_500, 5_000, 15_000), order: 0 },
      { id: 'SAME', ref: ref(9, 10_000, 0, 9_000), order: 1 },
    ];
    expect(run([['P', P]], existing).res[0]).toMatchObject({
      momentId: 'SAME',
      kind: 'same_punchline',
    });
    const tie: ExistingMoment[] = [
      { id: 'X2', ref: ref(1, 10_500, 5_000, 15_000), order: 2 },
      { id: 'X1', ref: ref(2, 10_500, 5_000, 15_000), order: 1 },
    ];
    expect(run([['P', P]], tie).res[0]).toMatchObject({ momentId: 'X1', kind: 'overlap' });
  });

  it('déterministe pour un même ordre de traitement ; égalité d’horodatage départagée par id', () => {
    const props = [prop('b', B, 0), prop('a', A, 0), prop('c', C, 1)];
    const once = () => {
      let n = 0;
      return assignMoments([], props, () => `M${++n}`);
    };
    expect(once()).toEqual(once());
    expect(once()[0]).toMatchObject({ proposalId: 'a', kind: 'founder' }); // 'a' < 'b'
    // L'ordre du tableau d'entrée n'a pas d'importance : seul compte (createdAt, id).
    let n = 0;
    expect(assignMoments([], [...props].reverse(), () => `M${++n}`)).toEqual(once());
  });
});

describe('décision effective par moment', () => {
  const members = new Map([
    ['A', 'M'],
    ['B', 'M'],
    ['Z', 'N'],
  ]);
  const ev = (
    seq: number,
    proposalId: string,
    type: DecisionEvent['type'],
    extra: Partial<DecisionEvent> = {},
  ): DecisionEvent => ({
    id: `e${seq}`,
    seq,
    proposalId,
    type,
    reasons: type === 'proposal_rejected' ? ['pas_drole'] : [],
    comment: null,
    ...extra,
  });

  it('A acceptée, B refusée (réévaluation), puis B réinitialisée → moment à examiner ; l’acceptation de A ne réapparaît pas', () => {
    const events = [
      ev(1, 'A', 'proposal_accepted'),
      ev(2, 'B', 'proposal_rejected'),
      ev(3, 'B', 'proposal_reset'),
    ];
    const d = effectiveDecisions(events, members).get('M')!;
    expect(d).toMatchObject({
      status: 'pending',
      sourceProposalId: null,
      reasons: [],
      comment: null,
    });
    const s = summarizeDecisions(['M', 'N'], effectiveDecisions(events, members));
    expect(s).toMatchObject({ moments: 2, toReview: 2, accepted: 0, rejected: 0 });
  });

  it('variante : A redevenue source puis réinitialisée → à examiner ; le refus de B ne réapparaît pas', () => {
    const events = [
      ev(1, 'A', 'proposal_accepted'),
      ev(2, 'B', 'proposal_rejected'),
      ev(3, 'A', 'proposal_accepted'),
      ev(4, 'A', 'proposal_reset'),
    ];
    expect(effectiveDecisions(events, members).get('M')).toMatchObject({ status: 'pending' });
  });

  it('une décision par moment, la plus récente ; l’ordre du tableau est sans importance', () => {
    const events = [
      ev(5, 'B', 'proposal_rejected', { reasons: ['deja_vu'] }),
      ev(2, 'A', 'proposal_accepted'),
      ev(9, 'Z', 'proposal_accepted'),
    ];
    const map = effectiveDecisions(events, members);
    expect(map.get('M')).toMatchObject({
      status: 'rejected',
      sourceProposalId: 'B',
      reasons: ['deja_vu'],
    });
    expect(map.get('N')).toMatchObject({ status: 'accepted', sourceProposalId: 'Z' });
    expect(summarizeDecisions(['M', 'N'], map)).toMatchObject({
      accepted: 1,
      rejected: 1,
      toReview: 0,
    });
  });

  it('détachement : les appartenances actuelles redistribuent les décisions', () => {
    const events = [ev(1, 'A', 'proposal_accepted'), ev(2, 'B', 'proposal_rejected')];
    const detached = new Map([...members, ['B', 'M2']]);
    const map = effectiveDecisions(events, detached);
    expect(map.get('M')).toMatchObject({ status: 'accepted', sourceProposalId: 'A' });
    expect(map.get('M2')).toMatchObject({ status: 'rejected', sourceProposalId: 'B' });
  });

  it('événements d’une proposition sans moment (supprimée) ignorés', () => {
    expect(effectiveDecisions([ev(1, 'X', 'proposal_accepted')], members).size).toBe(0);
  });
});
