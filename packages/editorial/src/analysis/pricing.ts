/**
 * Tarifs Claude API et estimation des jetons.
 *
 * Tarifs vérifiés le 23/11/2026 sur la page officielle (source ci-dessous), en dollars par
 * million de jetons. Ils sont versionnés : chaque analyse enregistre la version utilisée.
 * Un modèle absent de cette table bloque l'analyse : sans tarif, le plafond ne peut pas
 * être garanti. Les jetons de réflexion sont comptés comme jetons de SORTIE.
 */
import { AppError } from '@acs/shared';

export const PRICING_VERSION = '2026-11-23';
export const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

export interface RateCard {
  input: number;
  output: number;
  /** Écriture en cache (durée 5 min). */
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelPricing extends RateCard {
  /** Au-delà de ce nombre de jetons d'entrée (cache compris), un autre tarif s'applique. */
  longPrompt?: { aboveTokens: number } & RateCard;
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    longPrompt: {
      aboveTokens: 100_000,
      input: 0.5,
      output: 2.5,
      cacheWrite: 0.625,
      cacheRead: 0.05,
    },
  },
};

export function pricingFor(model: string): ModelPricing {
  const p = PRICING[model];
  if (!p) {
    throw new AppError(
      'PRICING_UNKNOWN',
      `Tarif inconnu pour le modèle « ${model} » : le plafond budgétaire ne peut pas être garanti. ` +
        `Modèles connus : ${Object.keys(PRICING).join(', ')}.`,
    );
  }
  return p;
}

export interface TokenUsage {
  /** Jetons d'entrée facturés au tarif normal. */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Sortie, réflexion comprise. */
  outputTokens: number;
}

/** Coût en dollars d'un appel, d'après son usage. */
export function costUsd(model: string, u: TokenUsage): number {
  const p = pricingFor(model);
  const promptTokens = u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;
  const r: RateCard = p.longPrompt && promptTokens > p.longPrompt.aboveTokens ? p.longPrompt : p;
  return (
    (u.inputTokens * r.input +
      u.cacheWriteTokens * r.cacheWrite +
      u.cacheReadTokens * r.cacheRead +
      u.outputTokens * r.output) /
    1_000_000
  );
}

/**
 * Estimation LOCALE du nombre de jetons d'un texte (sans appel réseau) : 1 jeton pour
 * 3 octets UTF-8, prudent pour du français avec le tokenizer actuel. Elle sera recalée sur
 * les comptes réels à l'étape 4b ; le budget, lui, applique en plus une marge de 20 %.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/** Coût d'une image : ⌈largeur/28⌉ × ⌈hauteur/28⌉ jetons (documentation « Vision »). */
export function imageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}
