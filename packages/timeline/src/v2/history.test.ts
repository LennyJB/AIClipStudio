import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertHistoryTarget, historyState, HistoryError, type HistoryEntry } from './history';
import { applyOperation, documentFingerprint, type Operation } from './ops';
import { fixtureV2 } from './test-fixtures';

const e = (
  seq: number,
  kind: HistoryEntry['kind'],
  targetSeq: number | null = null,
): HistoryEntry => ({
  seq,
  kind,
  targetSeq,
});

describe('historyState : historique linéaire déduit du journal', () => {
  it('gestes, annuler, rétablir ; un nouveau geste vide « rétablir »', () => {
    expect(historyState([e(1, 'do'), e(2, 'do')])).toEqual({ undoable: [1, 2], redoable: [] });
    expect(historyState([e(1, 'do'), e(2, 'do'), e(3, 'undo', 2)])).toEqual({
      undoable: [1],
      redoable: [2],
    });
    // L'entrée « redo » devient elle-même annulable.
    expect(historyState([e(1, 'do'), e(2, 'undo', 1), e(3, 'redo', 1)])).toEqual({
      undoable: [3],
      redoable: [],
    });
    expect(historyState([e(1, 'do'), e(2, 'undo', 1), e(3, 'redo', 1), e(4, 'undo', 3)])).toEqual({
      undoable: [],
      redoable: [3],
    });
    expect(historyState([e(1, 'do'), e(2, 'undo', 1), e(3, 'system')])).toEqual({
      undoable: [3],
      redoable: [],
    });
  });

  it('journal invalide : annulation hors du haut de pile, ordre, cible inattendue', () => {
    expect(() => historyState([e(1, 'do'), e(2, 'do'), e(3, 'undo', 1)])).toThrow(HistoryError);
    expect(() => historyState([e(2, 'do'), e(1, 'do')])).toThrow(/ordonné/);
    expect(() => historyState([e(1, 'do', 1)])).toThrow(/Cible/);
    expect(() => historyState([e(1, 'redo', 1)])).toThrow(HistoryError);
  });

  it('plusieurs onglets : annuler vise le haut de pile ACTUEL, sinon HISTORY_CHANGED', () => {
    // Onglet A voit [1] ; l'onglet B ajoute 2 ; A demande « annuler 1 » : refusé, rien n'est annulé.
    const state = historyState([e(1, 'do'), e(2, 'do')]);
    expect(() => assertHistoryTarget(state, 'undo', 1)).toThrow(
      expect.objectContaining({ code: 'HISTORY_CHANGED' }),
    );
    expect(() => assertHistoryTarget(state, 'undo', 2)).not.toThrow();
    expect(() => assertHistoryTarget(state, 'redo', 2)).toThrow(/rétablir/);
  });

  it('propriété : un journal produit par des actions valides est toujours accepté (modèle de référence)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('do', 'undo', 'redo'), { maxLength: 40 }), (actions) => {
        const undo: number[] = [];
        const redo: number[] = [];
        const journal: HistoryEntry[] = [];
        let seq = 0;
        for (const a of actions) {
          if (a === 'do') {
            journal.push(e(++seq, 'do'));
            undo.push(seq);
            redo.length = 0;
          } else if (a === 'undo' && undo.length) {
            const t = undo.pop()!;
            journal.push(e(++seq, 'undo', t));
            redo.push(t);
          } else if (a === 'redo' && redo.length) {
            const t = redo.pop()!;
            journal.push(e(++seq, 'redo', t));
            undo.push(seq);
          }
        }
        expect(historyState(journal)).toEqual({ undoable: undo, redoable: redo });
      }),
    );
  });

  it('rechargement : rejouer le journal (gestes + inverses) redonne le même document', () => {
    const base = fixtureV2();
    // Journal : geste 1 (mode), geste 2 (coupe), annuler 2, rétablir 2.
    const g1: Operation = { type: 'setMode', mode: 'enrichi' };
    const g2: Operation = {
      type: 'splitSegment',
      segmentId: 'seg-0',
      atSrcMs: 120_000,
      newId: 'b',
    };
    const a1 = applyOperation(base, g1);
    const a2 = applyOperation(a1.doc, g2);
    const u2 = applyOperation(a2.doc, a2.inverse);
    const r2 = applyOperation(u2.doc, g2);
    const journal = [
      { entry: e(1, 'do'), ops: [g1] },
      { entry: e(2, 'do'), ops: [g2] },
      { entry: e(3, 'undo', 2), ops: [a2.inverse] },
      { entry: e(4, 'redo', 2), ops: [g2] },
    ];
    // Rechargement : on repart de la base et on rejoue tout le journal.
    let d = base;
    for (const j of journal) for (const op of j.ops) d = applyOperation(d, op).doc;
    expect(documentFingerprint(d)).toBe(documentFingerprint(r2.doc));
    expect(historyState(journal.map((j) => j.entry))).toEqual({ undoable: [1, 4], redoable: [] });
  });
});
