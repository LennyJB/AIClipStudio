/**
 * Réapplication d'un lot local après des modifications distantes (§6.3) : vérification dans les
 * deux sens, préconditions dans les deux ordres, comparaison des empreintes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbOperation } from './arbitraries';
import { applyBatch, applyOperation, documentFingerprint, OpError, type Operation } from './ops';
import { decideReapply } from './rebase';
import type { ClipProjectV2 } from './schema';
import { fixtureV2 } from './test-fixtures';

const base = applyOperation(fixtureV2(), {
  type: 'splitSegment',
  segmentId: 'seg-0',
  atSrcMs: 120_000,
  newId: 'b',
}).doc;
const first = base.captions.items[0]!;
const second = base.captions.items.find((i, k) => k > 0 && i.speakerRole === first.speakerRole)!;
const overlayEnd = (id: string): Operation => ({
  type: 'setEntity',
  collection: 'overlay',
  entity: {
    id,
    kind: 'text',
    assetId: null,
    text: 'Fin',
    timing: { anchor: 'edit', from: 'end', offsetMs: 2_000, durMs: 1_000 },
    frame: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 },
    opacity: 1,
    z: 1,
  },
});
const doEntry = (...ops: Operation[]) => ({ kind: 'do' as const, ops });
const tryDocs = (d: ClipProjectV2, ops: readonly unknown[]) => {
  try {
    return applyBatch(d, ops).doc;
  } catch (e) {
    if (e instanceof OpError) return null;
    throw e;
  }
};

describe('réapplication acceptée seulement si l’indépendance est démontrée', () => {
  it('indépendants (mode distant, correction locale) : acceptée, même document dans les deux ordres', () => {
    const r = decideReapply(
      base,
      [doEntry({ type: 'setMode', mode: 'enrichi' })],
      [{ type: 'editCaptionText', itemId: first.id, text: 'Salut', at: 't' }],
    );
    expect(r.ok).toBe(true);
  });

  it('identifiants différents mais structure écrite des deux côtés : refus (condition 1)', () => {
    const r = decideReapply(
      base,
      [doEntry({ type: 'moveSegment', segmentId: 'b', toIndex: 0 })],
      [{ type: 'trimSegment', segmentId: 'seg-0', srcStartMs: 111_000 }],
    );
    expect(r).toMatchObject({ ok: false, reason: 'C1_REMOTE_WRITE_VS_LOCAL', keys: ['segments'] });
  });

  it('écriture distante contre lecture locale : refus (condition 1)', () => {
    // Distant : suppression avec décalage (écrit la structure) ; local : calque « 2 s avant la fin »
    // (lit la structure).
    const r = decideReapply(
      base,
      [doEntry({ type: 'trimSegment', segmentId: 'b', srcEndMs: 130_000 })],
      [overlayEnd('ov-1')],
    );
    expect(r).toMatchObject({ ok: false, reason: 'C1_REMOTE_WRITE_VS_LOCAL', keys: ['segments'] });
  });

  it('LECTURE distante contre écriture locale : refus (condition 2), même si les deux ordres coïncident', () => {
    // Distant : calque « 2 s avant la fin » (lit la durée totale) ; local : rognage (écrit la structure).
    const remote = [doEntry(overlayEnd('ov-1'))];
    const local: Operation[] = [{ type: 'trimSegment', segmentId: 'b', srcEndMs: 130_000 }];
    const r = decideReapply(base, remote, local);
    expect(r).toMatchObject({
      ok: false,
      reason: 'C2_REMOTE_READ_VS_LOCAL_WRITE',
      keys: ['segments'],
    });
    // Les deux ordres donnent ici le même document : seule la condition 2 protège l'intention
    // distante (placement calculé sur une autre durée).
    const dThenL = tryDocs(base, [...remote[0]!.ops, ...local]);
    const lThenD = tryDocs(base, [...local, ...remote[0]!.ops]);
    expect(documentFingerprint(dThenL!)).toBe(documentFingerprint(lThenD!));
  });

  it('lecture distante contre écriture locale : surcharge de disposition vs déplacement (condition 2)', () => {
    const layers = [
      {
        id: 'l1',
        role: 'gameplay',
        crop: { x: 0, y: 0, w: 1, h: 1 },
        frame: { x: 0, y: 0, w: 1, h: 1 },
        z: 0,
      },
    ];
    const r = decideReapply(
      base,
      [doEntry({ type: 'setEntity', collection: 'layoutOverride', entity: { id: 'b', layers } })],
      [{ type: 'moveSegment', segmentId: 'b', toIndex: 0 }],
    );
    expect(r).toMatchObject({ ok: false, reason: 'C2_REMOTE_READ_VS_LOCAL_WRITE' });
  });

  it('fusion distante de deux sous-titres et correction locale du second : refus', () => {
    const r = decideReapply(
      base,
      [doEntry({ type: 'mergeCaptions', firstId: first.id, secondId: second.id })],
      [{ type: 'editCaptionText', itemId: second.id, text: 'Correction', at: 't' }],
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ keys: expect.arrayContaining([`caption:${second.id}`]) });
  });

  it('annulation distante touchant une clé du lot : refus (condition 3)', () => {
    const a = applyOperation(base, { type: 'setMode', mode: 'enrichi' });
    const r = decideReapply(
      a.doc,
      [{ kind: 'undo', ops: [a.inverse] }],
      [{ type: 'setMode', mode: 'fidele' }],
    );
    expect(r.ok).toBe(false);
  });

  it('masques et audio : jamais réappliqués automatiquement (condition 7)', () => {
    const remote = [doEntry({ type: 'setMode', mode: 'enrichi' })];
    expect(
      decideReapply(base, remote, [{ type: 'setTrack', audioIndex: 1, gainDb: -3 }]),
    ).toMatchObject({ ok: false, reason: 'C7_SENSITIVE', keys: ['track:1'] });
    expect(
      decideReapply(base, remote, [
        {
          type: 'setEntity',
          collection: 'mask',
          entity: {
            id: 'm2',
            rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
            label: 'x',
            mode: 'opaque',
            srcRange: null,
          },
        },
      ]),
    ).toMatchObject({ ok: false, reason: 'C7_SENSITIVE', keys: ['mask:m2'] });
  });

  it('lot local invalide sur la base : refus (aucune réapplication à l’aveugle)', () => {
    expect(decideReapply(base, [], [{ type: 'rippleDelete', segmentId: 'inconnu' }])).toMatchObject(
      {
        ok: false,
        reason: 'LOCAL_INVALID',
      },
    );
  });
});

describe('propriétés de la réapplication (fast-check)', () => {
  const arbOp = arbOperation(base);
  const arbCase = fc.record({ dOp: arbOp, lOp: arbOp });

  it('sûreté : réapplication acceptée ⇒ les deux ordres donnent exactement le même document', () => {
    let accepted = 0;
    fc.assert(
      fc.property(arbCase, ({ dOp, lOp }) => {
        const r = decideReapply(base, [doEntry(dOp)], [lOp]);
        if (!r.ok) return;
        accepted++;
        const dThenL = tryDocs(base, [dOp, lOp]);
        const lThenD = tryDocs(base, [lOp, dOp]);
        expect(dThenL).not.toBeNull();
        expect(lThenD).not.toBeNull();
        expect(documentFingerprint(dThenL!)).toBe(documentFingerprint(lThenD!));
        expect(documentFingerprint(r.doc)).toBe(documentFingerprint(dThenL!));
      }),
      { numRuns: 600 },
    );
    expect(accepted).toBeGreaterThan(30);
  }, 60_000);

  it('refus : si l’ordre change le résultat (ou si un ordre échoue), la réapplication est refusée', () => {
    let orderDependent = 0;
    fc.assert(
      fc.property(arbCase, ({ dOp, lOp }) => {
        if (!tryDocs(base, [dOp]) || !tryDocs(base, [lOp])) return;
        const dThenL = tryDocs(base, [dOp, lOp]);
        const lThenD = tryDocs(base, [lOp, dOp]);
        const differs =
          !dThenL || !lThenD || documentFingerprint(dThenL) !== documentFingerprint(lThenD);
        if (!differs) return;
        orderDependent++;
        expect(decideReapply(base, [doEntry(dOp)], [lOp]).ok).toBe(false);
      }),
      { numRuns: 2_000 },
    );
    expect(orderDependent).toBeGreaterThan(30);
  }, 60_000);
});
