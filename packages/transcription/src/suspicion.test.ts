import { describe, expect, it } from 'vitest';
import { computeSuspicion } from './suspicion';

const base = {
  text: 'on push B maintenant',
  avgLogprob: -0.25,
  noSpeechProb: 0.02,
  compressionRatio: 1.3,
};

describe('computeSuspicion', () => {
  it('segment normal : score 0, aucune raison', () => {
    expect(computeSuspicion(base)).toEqual({ score: 0, reasons: [] });
  });
  it('probablement pas de parole', () => {
    const r = computeSuspicion({ ...base, noSpeechProb: 0.9, avgLogprob: -1.4 });
    expect(r.reasons).toEqual(['no_speech']);
    expect(r.score).toBeCloseTo(0.6);
  });
  it('faible logprob seule', () => {
    expect(computeSuspicion({ ...base, avgLogprob: -1.2 }).reasons).toEqual(['low_logprob']);
  });
  it('répétition (taux de compression élevé)', () => {
    expect(computeSuspicion({ ...base, compressionRatio: 3.1 }).reasons).toEqual(['repetition']);
  });
  it('hallucination connue, insensible à la casse, aux accents et à la ponctuation', () => {
    const r = computeSuspicion({
      ...base,
      text: "Sous-titres réalisés par la communauté d'Amara.org",
    });
    expect(r.reasons).toEqual(['known_hallucination']);
  });
  it('raisons cumulées : score plus élevé mais borné à 1', () => {
    const r = computeSuspicion({
      text: 'Thanks for watching!',
      avgLogprob: -1.5,
      noSpeechProb: 0.95,
      compressionRatio: 2.8,
    });
    expect(r.reasons).toEqual(['no_speech', 'repetition', 'known_hallucination']);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});
