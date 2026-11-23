/**
 * Score HEURISTIQUE de suspicion d'un segment (0 = rien à signaler, 1 = très suspect).
 * Ce n'est PAS une probabilité calibrée : il combine des règles simples sur les
 * métriques brutes de Whisper, qui sont conservées telles quelles par ailleurs.
 * Aucun segment n'est supprimé : il est seulement signalé.
 */
import { normalizeText } from './chunking';

export type SuspicionReason = 'no_speech' | 'low_logprob' | 'repetition' | 'known_hallucination';

export interface SuspicionInput {
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
}

/** Seuils (repris des valeurs par défaut de Whisper pour la détection d'échec de décodage). */
export const SUSPICION_RULES = {
  noSpeech: { noSpeechProbAbove: 0.6, avgLogprobBelow: -1.0, weight: 0.6 },
  lowLogprob: { avgLogprobBelow: -1.0, weight: 0.3 },
  repetition: { compressionRatioAbove: 2.4, weight: 0.5 },
  knownHallucination: { weight: 0.6 },
} as const;

/**
 * Phrases que Whisper invente fréquemment sur du silence ou du bruit
 * (issues des sous-titres de ses données d'entraînement). Comparaison sur texte normalisé.
 */
export const KNOWN_HALLUCINATIONS: readonly string[] = [
  "sous-titres realises par la communaute d'amara.org",
  'sous titrage st 501',
  'sous titrage societe radio canada',
  'sous titres fait par sous titres',
  'merci d avoir regarde cette video',
  'abonnez vous a la chaine',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'subtitles by the amara org community',
].map(normalizeText);

export function computeSuspicion(s: SuspicionInput): { score: number; reasons: SuspicionReason[] } {
  const reasons: SuspicionReason[] = [];
  const weights: number[] = [];
  const r = SUSPICION_RULES;
  if (s.noSpeechProb > r.noSpeech.noSpeechProbAbove && s.avgLogprob < r.noSpeech.avgLogprobBelow) {
    reasons.push('no_speech');
    weights.push(r.noSpeech.weight);
  } else if (s.avgLogprob < r.lowLogprob.avgLogprobBelow) {
    reasons.push('low_logprob');
    weights.push(r.lowLogprob.weight);
  }
  if (s.compressionRatio > r.repetition.compressionRatioAbove) {
    reasons.push('repetition');
    weights.push(r.repetition.weight);
  }
  const norm = normalizeText(s.text);
  if (
    norm &&
    KNOWN_HALLUCINATIONS.some((h) => norm === h || (h.length >= 12 && norm.includes(h)))
  ) {
    reasons.push('known_hallucination');
    weights.push(r.knownHallucination.weight);
  }
  const score = 1 - weights.reduce((acc, w) => acc * (1 - w), 1);
  return { score: Math.round(score * 1000) / 1000, reasons };
}
