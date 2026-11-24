import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reservationUsd, reservedInputTokens } from './budget';
import { costUsd } from './pricing';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 300) });

describe('réservation budgétaire', () => {
  it('propriété : le coût réel ne dépasse jamais la réservation (entrée ≤ réservée, sortie ≤ max_tokens)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('claude-opus-5-5', 'claude-haiku-5-5'),
        fc.integer({ min: 0, max: 400_000 }),
        fc.integer({ min: 100, max: 64_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (model, counted, maxOut, inFrac, writeShare, readShare, outFrac) => {
          const r = {
            model,
            countedInputTokens: counted,
            localInputTokens: 0,
            schemaJson: '{}',
            maxOutputTokens: maxOut,
          };
          const reservedIn = reservedInputTokens(r);
          // Répartition arbitraire de l'entrée réelle entre normal / écriture / lecture du cache.
          const total = Math.floor(reservedIn * inFrac);
          const w = Math.floor(total * writeShare);
          const rd = Math.floor((total - w) * readShare);
          const actual = costUsd(model, {
            inputTokens: total - w - rd,
            cacheWriteTokens: w,
            cacheReadTokens: rd,
            outputTokens: Math.floor(maxOut * outFrac),
          });
          expect(actual).toBeLessThanOrEqual(reservationUsd(r) + 1e-12);
        },
      ),
    );
  });

  it('marges : +10 % si compté par l’API, +20 % sinon ; schéma ajouté', () => {
    const base = {
      model: 'claude-opus-5-5',
      localInputTokens: 1000,
      schemaJson: 'x'.repeat(300),
      maxOutputTokens: 0,
    };
    expect(reservedInputTokens({ ...base, countedInputTokens: 1000 })).toBe(1100 + 100);
    expect(reservedInputTokens({ ...base, countedInputTokens: null })).toBe(1200 + 100);
  });

  it('inclut la sortie maximale (réflexion comprise) au tarif de sortie', () => {
    const r = {
      model: 'claude-opus-5-5',
      countedInputTokens: 0,
      localInputTokens: 0,
      schemaJson: '',
      maxOutputTokens: 12_000,
    };
    expect(reservationUsd(r)).toBeCloseTo(0.24, 6);
  });

  it('Haiku : tarif long si l’entrée réservée dépasse 100 000 jetons', () => {
    const small = reservationUsd({
      model: 'claude-haiku-5-5',
      countedInputTokens: 50_000,
      localInputTokens: 0,
      schemaJson: '',
      maxOutputTokens: 0,
    });
    const big = reservationUsd({
      model: 'claude-haiku-5-5',
      countedInputTokens: 95_000,
      localInputTokens: 0,
      schemaJson: '',
      maxOutputTokens: 0,
    });
    expect(small).toBeCloseTo((55_000 * 0.125) / 1e6, 5); // arrondi au millionième supérieur
    expect(big).toBeCloseTo((104_500 * 0.625) / 1e6, 5);
  });
});
