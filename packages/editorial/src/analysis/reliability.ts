/**
 * Fiabilité (0 à 100) d'un moment : calculée LOCALEMENT, jamais par Claude.
 * Elle mesure la solidité des éléments utilisés, pas l'intérêt du moment (pertinence).
 */
import type { TransmissionPolicy } from './payload';
import { isTransmittable } from './payload';
import { DOUBTFUL_SUSPICION, type Signal } from './signals';
import type { AnalysisSegment } from './types';
import { looksLikeInstruction } from './untrusted';
import type { VerifiedMoment } from './verify';

export interface Reliability {
  score: number;
  components: {
    transcription: number;
    quotes: number;
    structure: number;
    context: number;
  };
  reasons: string[];
}

/** Plafond appliqué si une preuve repose sur une transcription douteuse : jamais un clip. */
export const DOUBTFUL_CAP = 55;

export function computeReliability(input: {
  verified: VerifiedMoment;
  /** Segments locaux recouvrant le clip (toutes pistes). */
  segmentsInClip: readonly AnalysisSegment[];
  signalsInClip: readonly Signal[];
  policy: TransmissionPolicy;
  segmentsById: ReadonlyMap<number, AnalysisSegment>;
}): Reliability {
  const v = input.verified;
  const reasons: string[] = [];
  const evSegs = [...new Set(v.evidence.map((e) => e.segmentId))]
    .map((id) => input.segmentsById.get(id))
    .filter((s): s is AnalysisSegment => Boolean(s));

  const transcription = evSegs.length
    ? evSegs.reduce((acc, s) => {
        const probs = s.words.map((w) => w.probability).filter((p) => Number.isFinite(p));
        const wordQ = probs.length ? probs.reduce((a, p) => a + p, 0) / probs.length : 1;
        return acc + (1 - Math.min(1, s.suspicionScore)) * wordQ;
      }, 0) / evSegs.length
    : 0;
  const quotes = v.quotesProposed ? v.evidence.length / v.quotesProposed : 0;
  if (quotes < 1) reasons.push('certaines citations n’ont pas pu être vérifiées');

  const setupCited =
    v.evidence.some((e) => e.role === 'mise_en_place') || v.setup.id !== v.punchline.id;
  let structure = (setupCited ? 1 : 0.6) * (v.moment.standalone ? 1 : 0.7);
  if (!setupCited) reasons.push('mise en place non identifiée');
  if (!v.moment.standalone) reasons.push('peu compréhensible sans le reste du stream');
  structure = Math.max(0, Math.min(1, structure));

  let context = 1;
  if (input.segmentsInClip.some((s) => !isTransmittable(s.speaker, input.policy))) {
    context *= 0.6;
    reasons.push('réponses des coéquipiers non transmises (accord Discord absent)');
  }
  if (input.signalsInClip.some((s) => s.kind === 'simultaneous_speech')) {
    context *= 0.85;
    reasons.push('parole simultanée : transcription moins sûre');
  }

  let score = 100 * (0.4 * transcription + 0.25 * quotes + 0.2 * structure + 0.15 * context);
  if (evSegs.some((s) => s.suspicionScore >= DOUBTFUL_SUSPICION)) {
    score = Math.min(score, DOUBTFUL_CAP);
    reasons.push('preuve reposant sur une transcription douteuse');
  }
  if (
    v.evidence.some((e) => looksLikeInstruction(e.quote)) ||
    evSegs.some((s) => looksLikeInstruction(s.text))
  ) {
    score -= 30;
    reasons.push('une preuve ressemble à une consigne adressée à l’IA');
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    components: {
      transcription: Math.round(transcription * 100) / 100,
      quotes: Math.round(quotes * 100) / 100,
      structure: Math.round(structure * 100) / 100,
      context: Math.round(context * 100) / 100,
    },
    reasons,
  };
}

/** Niveau d'un moment : clip seulement si pertinence ET fiabilité suffisent, sans alerte. */
export function decideTier(p: {
  suggestedTier: 'clip' | 'secondaire';
  relevance: number;
  reliability: number;
  flags: readonly string[];
  minRelevance: number;
  minReliability: number;
}): 'clip' | 'secondary' | null {
  if (
    p.suggestedTier === 'clip' &&
    p.relevance >= p.minRelevance &&
    p.reliability >= p.minReliability &&
    p.flags.length === 0
  ) {
    return 'clip';
  }
  return p.relevance >= 40 ? 'secondary' : null;
}
