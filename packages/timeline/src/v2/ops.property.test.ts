/**
 * Propriétés du catalogue d'opérations (fast-check) :
 *  - toute opération acceptée laisse un document valide (schéma + invariants) ;
 *  - toute opération acceptée s'annule EXACTEMENT par son inverse ;
 *  - une suite d'opérations s'annule exactement par l'inverse du lot ;
 *  - les LECTURES déclarées sont complètes : si une autre opération n'écrit aucune clé lue,
 *    le résultat ne change pas (fondement de la réapplication sûre, §6.3).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbOperation } from './arbitraries';
import { checkInvariants } from './invariants';
import { getKey } from './keys';
import {
  applyOperation,
  documentFingerprint,
  inverseOfBatch,
  applyBatch,
  OpError,
  type AppliedOp,
} from './ops';
import { ClipProjectV2Schema, type ClipProjectV2 } from './schema';
import { fixtureV2 } from './test-fixtures';
import { canonicalJson } from '../project';

const base = fixtureV2();
const tryApply = (d: ClipProjectV2, op: unknown): AppliedOp | null => {
  try {
    return applyOperation(d, op);
  } catch (e) {
    if (e instanceof OpError) return null;
    throw e;
  }
};

/** Document obtenu par une courte suite aléatoire d'opérations acceptées. */
const arbDoc = fc.array(fc.integer({ min: 0, max: 1_000_000 }), { maxLength: 4 }).chain((seeds) => {
  let d = base;
  for (const seed of seeds) {
    const [op] = fc.sample(arbOperation(d), { numRuns: 1, seed });
    const a = tryApply(d, op);
    if (a) d = a.doc;
  }
  return fc.constant(d);
});

describe('propriétés des opérations (étape 7a)', () => {
  it('opération acceptée ⇒ document valide ; inverse ⇒ document identique', () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        arbDoc.chain((d) => fc.tuple(fc.constant(d), arbOperation(d))),
        ([d, op]) => {
          const a = tryApply(d, op);
          if (!a) return;
          accepted++;
          expect(ClipProjectV2Schema.safeParse(a.doc).success).toBe(true);
          expect(checkInvariants(a.doc)).toEqual([]);
          const back = applyOperation(a.doc, a.inverse);
          expect(documentFingerprint(back.doc)).toBe(documentFingerprint(d));
        },
      ),
      { numRuns: 400 },
    );
    expect(accepted).toBeGreaterThan(100);
  });

  it('suite d’opérations ⇒ l’inverse du lot restaure exactement le document', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 8 }),
        (seeds) => {
          let d = base;
          const applied: AppliedOp[] = [];
          for (const seed of seeds) {
            const [op] = fc.sample(arbOperation(d), { numRuns: 1, seed });
            const a = tryApply(d, op);
            if (a) {
              applied.push(a);
              d = a.doc;
            }
          }
          const back = applyBatch(d, inverseOfBatch(applied)).doc;
          expect(documentFingerprint(back)).toBe(documentFingerprint(base));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('lectures complètes : une écriture sur des clés non lues ne change pas le résultat', () => {
    let checked = 0;
    fc.assert(
      fc.property(
        arbDoc.chain((d) => fc.tuple(fc.constant(d), arbOperation(d), arbOperation(d))),
        ([d, opA, opB]) => {
          const a = tryApply(d, opA);
          const b = tryApply(d, opB);
          if (!a || !b) return;
          if (b.writes.some((k) => a.reads.includes(k) || a.writes.includes(k))) return;
          // B d'abord, puis A : les valeurs écrites par A sont les mêmes que sans B.
          const aAfterB = tryApply(b.doc, opA);
          expect(aAfterB).not.toBeNull();
          checked++;
          for (const k of a.writes) {
            expect(canonicalJson(getKey(aAfterB!.doc, k) ?? null)).toBe(
              canonicalJson(getKey(a.doc, k) ?? null),
            );
          }
        },
      ),
      { numRuns: 400 },
    );
    expect(checked).toBeGreaterThan(50);
  });
});
