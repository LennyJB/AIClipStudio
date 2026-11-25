/**
 * Annuler / rétablir (docs/plan-etape-7.md §6.2). L'historique est LINÉAIRE PAR PROJET et
 * entièrement déduit du journal en ajout seul : même résultat sur le serveur, dans chaque onglet,
 * après un rechargement ou une fermeture de l'application.
 *
 *  - `do` (geste) et `system` (proposition d'effets, PATCH v1, CLI) : empilés sur « annuler »,
 *    et vident « rétablir » ;
 *  - `undo` : annule EXACTEMENT le haut de la pile « annuler » (sinon journal invalide) ;
 *  - `redo` : rétablit EXACTEMENT le haut de la pile « rétablir » ; l'entrée `redo` devient
 *    elle-même annulable.
 * Aucune entrée n'est jamais modifiée ni supprimée : annuler ajoute une entrée.
 */

export type EntryKind = 'do' | 'undo' | 'redo' | 'system';

export interface HistoryEntry {
  seq: number;
  kind: EntryKind;
  /** Entrée annulée (`undo`) ou rétablie (`redo`) ; null sinon. */
  targetSeq: number | null;
}

export interface HistoryState {
  /** Entrées annulables, de la plus ancienne à la plus récente (haut de pile = dernière). */
  undoable: number[];
  /** Entrées rétablissables (haut de pile = dernière). */
  redoable: number[];
}

export class HistoryError extends Error {
  constructor(
    readonly code: 'HISTORY_CHANGED' | 'INVALID_JOURNAL',
    message: string,
  ) {
    super(message);
    this.name = 'HistoryError';
  }
}

export function historyState(entries: readonly HistoryEntry[]): HistoryState {
  const undoable: number[] = [];
  const redoable: number[] = [];
  let last = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.seq) || e.seq <= last) {
      throw new HistoryError('INVALID_JOURNAL', `Journal non ordonné (seq ${e.seq})`);
    }
    last = e.seq;
    if (e.kind === 'do' || e.kind === 'system') {
      if (e.targetSeq !== null)
        throw new HistoryError('INVALID_JOURNAL', `Cible inattendue (${e.seq})`);
      undoable.push(e.seq);
      redoable.length = 0;
    } else if (e.kind === 'undo') {
      if (e.targetSeq === null || undoable.at(-1) !== e.targetSeq) {
        throw new HistoryError('INVALID_JOURNAL', `Annulation hors du haut de pile (${e.seq})`);
      }
      redoable.push(undoable.pop()!);
    } else {
      if (e.targetSeq === null || redoable.at(-1) !== e.targetSeq) {
        throw new HistoryError('INVALID_JOURNAL', `Rétablissement hors du haut de pile (${e.seq})`);
      }
      redoable.pop();
      undoable.push(e.seq);
    }
  }
  return { undoable, redoable };
}

/**
 * Vérifie qu'une demande d'annulation (ou de rétablissement) vise exactement le haut de la pile
 * ACTUELLE. Sinon `HISTORY_CHANGED` : la pile a changé (autre onglet, CLI) depuis l'affichage, et
 * rien n'est annulé.
 */
export function assertHistoryTarget(
  state: HistoryState,
  kind: 'undo' | 'redo',
  targetSeq: number,
): void {
  const top = (kind === 'undo' ? state.undoable : state.redoable).at(-1);
  if (top !== targetSeq) {
    throw new HistoryError(
      'HISTORY_CHANGED',
      `L’historique a changé : ${kind === 'undo' ? 'annuler' : 'rétablir'} viserait ${top ?? 'rien'}`,
    );
  }
}
