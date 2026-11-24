/**
 * Réservation budgétaire d'un appel : son coût dans le PIRE cas, calculé AVANT l'envoi.
 *
 *  - entrée : jetons comptés par l'API (+10 %) ou estimés localement (+20 %), plus le schéma
 *    de réponse ; tous comptés au tarif le plus cher entre l'entrée et l'écriture en cache ;
 *  - au-delà du seuil « prompt long » d'un modèle (Haiku : 100 000 jetons), tarif long ;
 *  - sortie : `max_tokens`, réflexion comprise (la sortie facturée ne peut pas le dépasser).
 *
 * Si le coût réel dépassait malgré tout la réservation, l'analyse s'arrête (voir l'API).
 */
import { estimateTextTokens, pricingFor } from './pricing';

export const COUNTED_INPUT_MARGIN = 1.1;
export const LOCAL_INPUT_MARGIN = 1.2;

export interface ReservationInput {
  model: string;
  /** Jetons d'entrée comptés par l'API (`count_tokens`), ou null s'il a échoué. */
  countedInputTokens: number | null;
  /** Estimation locale de secours (texte + images). */
  localInputTokens: number;
  /** Schéma de réponse (ajouté par l'API au prompt). */
  schemaJson: string;
  maxOutputTokens: number;
}

export function reservedInputTokens(r: ReservationInput): number {
  const base =
    r.countedInputTokens !== null
      ? Math.ceil(r.countedInputTokens * COUNTED_INPUT_MARGIN)
      : Math.ceil(r.localInputTokens * LOCAL_INPUT_MARGIN);
  return base + estimateTextTokens(r.schemaJson);
}

/** Montant à réserver (dollars), arrondi vers le haut au millionième. */
export function reservationUsd(r: ReservationInput): number {
  const p = pricingFor(r.model);
  const input = reservedInputTokens(r);
  const rates = p.longPrompt && input > p.longPrompt.aboveTokens ? p.longPrompt : p;
  const inputRate = Math.max(rates.input, rates.cacheWrite, rates.cacheRead);
  const usd = (input * inputRate + r.maxOutputTokens * rates.output) / 1_000_000;
  return Math.ceil(usd * 1_000_000) / 1_000_000;
}
