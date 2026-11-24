import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBoundaries, insideWord } from './boundaries';
import { seg } from './test-helpers';
import type { AnalysisSegment } from './types';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 300) });

const clip = { minSeconds: 20, maxSeconds: 80, preferredLeadInSeconds: 8 };
const words = (segs: readonly AnalysisSegment[]) =>
  segs
    .flatMap((s) => s.words.map((w) => ({ startMs: w.startMs, endMs: w.endMs })))
    .sort((a, b) => a.startMs - b.startMs);

describe('computeBoundaries', () => {
  it('inclut mise en place, chute et réaction ; durée dans les limites', () => {
    const segs = Array.from({ length: 30 }, (_, i) =>
      seg('creator', i * 4_000, i * 4_000 + 3_000, 'une phrase de test ici'),
    );
    const b = computeBoundaries({
      setup: segs[10]!,
      punchline: segs[12]!,
      reactionEnd: segs[13]!,
      segments: segs,
      range: { startMs: 0, endMs: 120_000 },
      clip,
    });
    expect(b.flags).toEqual([]);
    expect(b.startMs).toBeLessThanOrEqual(segs[10]!.startMs);
    expect(b.endMs).toBeGreaterThanOrEqual(segs[13]!.endMs);
    expect(b.endMs - b.startMs).toBeGreaterThanOrEqual(20_000);
    expect(b.endMs - b.startMs).toBeLessThanOrEqual(80_000);
  });

  it('contexte nécessaire > 80 s : alerte, la mise en place n’est jamais retirée', () => {
    const segs = Array.from({ length: 40 }, (_, i) =>
      seg('creator', i * 4_000, i * 4_000 + 3_000, 'texte'),
    );
    const b = computeBoundaries({
      setup: segs[0]!,
      punchline: segs[30]!,
      reactionEnd: segs[31]!,
      segments: segs,
      range: { startMs: 0, endMs: 200_000 },
      clip,
    });
    expect(b.flags).toContain('contexte_trop_long');
    expect(b.startMs).toBeLessThanOrEqual(segs[0]!.startMs);
  });

  it('enregistrement trop court : alerte « trop court »', () => {
    const segs = [seg('creator', 0, 2_000, 'salut'), seg('creator', 2_500, 4_000, 'ok')];
    const b = computeBoundaries({
      setup: segs[0]!,
      punchline: segs[1]!,
      reactionEnd: segs[1]!,
      segments: segs,
      range: { startMs: 0, endMs: 6_000 },
      clip,
    });
    expect(b.flags).toContain('trop_court');
  });

  it('respecte la durée d’un profil de jeu (30 à 60 s)', () => {
    const segs = Array.from({ length: 50 }, (_, i) =>
      seg('creator', i * 3_000, i * 3_000 + 2_500, 'a b c'),
    );
    const b = computeBoundaries({
      setup: segs[20]!,
      punchline: segs[21]!,
      reactionEnd: segs[21]!,
      segments: segs,
      range: { startMs: 0, endMs: 150_000 },
      clip: { minSeconds: 30, maxSeconds: 60, preferredLeadInSeconds: 5 },
    });
    expect(b.endMs - b.startMs).toBeGreaterThanOrEqual(30_000);
    expect(b.endMs - b.startMs).toBeLessThanOrEqual(60_000);
  });

  it('propriété : jamais au milieu d’un mot ; contient le moment ; durée correcte ou alerte', () => {
    const segArb = fc.array(
      fc.record({
        start: fc.integer({ min: 0, max: 290_000 }),
        len: fc.integer({ min: 300, max: 8_000 }),
        n: fc.integer({ min: 1, max: 8 }),
        speaker: fc.constantFrom('creator' as const, 'teammates' as const),
      }),
      { minLength: 3, maxLength: 60 },
    );
    fc.assert(
      fc.property(segArb, fc.nat(), fc.nat(), fc.nat(), (raw, a, b, c) => {
        const segs = raw
          .map((r) =>
            seg(
              r.speaker,
              r.start,
              Math.min(300_000, r.start + r.len),
              Array(r.n).fill('mot').join(' '),
            ),
          )
          .sort((x, y) => x.startMs - y.startMs);
        const pick = [segs[a % segs.length]!, segs[b % segs.length]!, segs[c % segs.length]!].sort(
          (x, y) => x.startMs - y.startMs,
        );
        const [setup, punchline, reactionEnd] = pick as [
          AnalysisSegment,
          AnalysisSegment,
          AnalysisSegment,
        ];
        const range = { startMs: 0, endMs: 300_000 };
        const r = computeBoundaries({ setup, punchline, reactionEnd, segments: segs, range, clip });
        const w = words(segs);
        expect(insideWord(w, r.startMs)).toBeNull();
        expect(insideWord(w, r.endMs)).toBeNull();
        expect(r.startMs).toBeLessThanOrEqual(setup.startMs);
        expect(r.endMs).toBeGreaterThanOrEqual(reactionEnd.endMs);
        expect(r.startMs).toBeGreaterThanOrEqual(0);
        expect(r.endMs).toBeLessThanOrEqual(300_000);
        if (r.flags.length === 0) {
          expect(r.endMs - r.startMs).toBeGreaterThanOrEqual(20_000);
          expect(r.endMs - r.startMs).toBeLessThanOrEqual(80_000);
        }
        // Déterministe : mêmes entrées → mêmes bornes.
        expect(
          computeBoundaries({ setup, punchline, reactionEnd, segments: segs, range, clip }),
        ).toEqual(r);
      }),
    );
  });
});
