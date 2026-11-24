import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { estimateAnalysis, estimateCall } from './estimate';
import { costUsd, estimateTextTokens, imageTokens, pricingFor } from './pricing';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 200) });

describe('tarifs', () => {
  it('Opus 5.5 : 4 $ en entrée, 20 $ en sortie, cache 5 $ / 0,20 $ par million', () => {
    expect(
      costUsd('claude-opus-5-5', {
        inputTokens: 1e6,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(4);
    expect(
      costUsd('claude-opus-5-5', {
        inputTokens: 0,
        cacheWriteTokens: 1e6,
        cacheReadTokens: 1e6,
        outputTokens: 1e6,
      }),
    ).toBeCloseTo(25.2);
  });

  it('Haiku 5.5 : tarif bas jusqu’à 100 000 jetons de prompt (cache compris), puis tarif long', () => {
    const at = (n: number) =>
      costUsd('claude-haiku-5-5', {
        inputTokens: n,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 1000,
      });
    expect(at(100_000)).toBeCloseTo(0.01 + 0.0005);
    expect(at(100_001)).toBeCloseTo(100_001 * 0.5e-6 + 0.0025);
    expect(
      costUsd('claude-haiku-5-5', {
        inputTokens: 60_000,
        cacheWriteTokens: 0,
        cacheReadTokens: 50_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(60_000 * 0.5e-6 + 50_000 * 0.05e-6);
  });

  it('refuse un modèle sans tarif connu', () => {
    expect(() => pricingFor('claude-inconnu')).toThrow(
      expect.objectContaining({ code: 'PRICING_UNKNOWN' }),
    );
  });

  it('jetons d’image selon la formule officielle', () => {
    expect(imageTokens(1024, 576)).toBe(777);
    expect(imageTokens(1280, 720)).toBe(1196);
  });

  it('estimation locale prudente du texte', () => {
    expect(estimateTextTokens('abc')).toBe(1);
    expect(estimateTextTokens('é')).toBe(1);
  });
});

describe('estimation', () => {
  it('le pire cas inclut la sortie maximale (réflexion comprise) et l’écriture du cache à chaque appel', () => {
    const e = estimateCall({
      model: 'claude-opus-5-5',
      systemTokens: 3000,
      dataTokens: 5000,
      imageTokens: 0,
      typicalOutputTokens: 5000,
      maxOutputTokens: 12000,
      cachedSystem: true,
    });
    const expectedMax = (6000 * 4 + 3600 * 5 + 12000 * 20) / 1e6;
    expect(e.maxUsd).toBeCloseTo(expectedMax, 4);
    expect(e.typicalUsd).toBeCloseTo((5000 * 4 + 3000 * 0.2 + 5000 * 20) / 1e6, 4);
  });

  it('propriété : pire cas ≥ typique, et les fenêtres retenues tiennent sous le budget', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 100, max: 50_000 }), { maxLength: 15 }),
        fc.array(
          fc.record({
            text: fc.integer({ min: 100, max: 20_000 }),
            img: fc.integer({ min: 0, max: 5_000 }),
          }),
          { maxLength: 60 },
        ),
        fc.double({ min: 0.5, max: 20, noNaN: true }),
        fc.constantFrom(
          'low' as const,
          'medium' as const,
          'high' as const,
          'xhigh' as const,
          'max' as const,
        ),
        (chunks, wins, budget, effort) => {
          const e = estimateAnalysis({
            triageModel: 'claude-haiku-5-5',
            deepModel: 'claude-opus-5-5',
            effort,
            budgetUsd: budget,
            maxOutputTokens: 12_000,
            triageMaxOutputTokens: 4_000,
            triageChunkTokens: chunks,
            windows: wins.map((w, i) => ({ rank: i + 1, textTokens: w.text, imageTokens: w.img })),
          });
          for (const w of [...e.windows, ...e.triage.chunks])
            expect(w.maxUsd).toBeGreaterThanOrEqual(w.typicalUsd);
          expect(e.fit.worstCaseWindows).toBeLessThanOrEqual(e.fit.typicalWindows);
          const worst =
            e.triage.maxUsd +
            e.windows.slice(0, e.fit.worstCaseWindows).reduce((a, w) => a + w.maxUsd, 0);
          if (e.fit.worstCaseWindows > 0) expect(worst).toBeLessThanOrEqual(budget + 1e-9);
        },
      ),
    );
  });
});
