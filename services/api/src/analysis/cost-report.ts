/**
 * Résumé lisible des coûts d'une analyse (CLI). Distingue toujours :
 *  - le plafond de RÉSERVATION, garanti par l'application avant chaque envoi ;
 *  - le coût RÉEL calculé, qui peut exceptionnellement le dépasser (voir LlmCallRepository).
 */
import type { LlmCallRepository } from './calls';

export type RunCosts = ReturnType<LlmCallRepository['costs']>;

const usd = (n: number) => `${n.toFixed(4)} $`;

export function costSummaryLines(c: RunCosts): string[] {
  const lines = [
    `Coût réel calculé : ${usd(c.realCostUsd)} (${c.calls} appel(s), ${c.reusedCalls} réutilisé(s) à 0 $, ${c.unknownCostCalls} coupé(s) compté(s) au pire cas)`,
    `Plafond de réservation : ${usd(c.budgetUsd)} (aucun appel envoyé si son pire cas estimé ne tient pas dessous)`,
  ];
  if (c.aboveReservationCalls > 0) {
    lines.push(
      `Attention : ${c.aboveReservationCalls} appel(s) ont coûté ${usd(c.aboveReservationUsd)} de plus que leur réservation (estimation d'entrée ou tarif dépassé).`,
    );
  }
  if (c.budgetExceeded) {
    lines.push(
      `DÉPASSEMENT DU PLAFOND : le coût réel calculé dépasse le plafond de ${usd(c.overrunUsd)}. L'analyse a été arrêtée ; aucun nouvel appel n'est possible pour elle.`,
    );
  }
  lines.push(
    'La facture d’Anthropic fait foi (coûts calculés à partir des jetons et des tarifs versionnés).',
  );
  return lines;
}
