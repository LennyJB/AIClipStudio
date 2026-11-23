import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeSignals, type Signal } from './signals';
import { exchange, seg } from './test-helpers';
import type { AnalysisSegment } from './types';
import { BIN_MS, buildCandidateWindows, rankWindows, scoreBins } from './windows';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 200) });

const opts = {
  durationMs: 600_000,
  minScore: 0.35,
  contextBeforeMs: 45_000,
  contextAfterMs: 20_000,
  farContextMs: 180_000,
  maxCoreMs: 80_000,
};
const signalsFor = (segments: AnalysisSegment[], extra: Signal[] = []) => [
  ...computeSignals({ durationMs: opts.durationMs, segments, energy: [], gameTerms: [] }),
  ...extra,
];
const loud = (startMs: number, value = 30): Signal => ({
  kind: 'loudness_peak',
  source: 'audio_energy',
  nature: 'mesure',
  startMs,
  endMs: startMs + 3000,
  speaker: 'creator',
  value,
});

describe('fenêtres candidates', () => {
  it('un échange animé crée une fenêtre avec son contexte proche et lointain', () => {
    const segments = [seg('creator', 10_000, 15_000, 'bon on y va'), ...exchange(300_000, 10)];
    const w = buildCandidateWindows(segments, signalsFor(segments), opts);
    expect(w).toHaveLength(1);
    const c = w[0]!;
    expect(c.coreStartMs).toBeLessThanOrEqual(300_000);
    expect(c.coreEndMs).toBeGreaterThanOrEqual(318_000);
    expect(c.startMs).toBe(c.coreStartMs - 45_000);
    expect(c.endMs).toBe(Math.min(600_000, c.coreEndMs + 20_000));
    expect(c.farStartMs).toBe(c.startMs - 180_000);
    expect(c.signals.length).toBeGreaterThan(0);
  });

  it('un pic sonore seul (même extrême, avec parole) ne crée jamais de fenêtre', () => {
    const segments = [
      seg('creator', 100_000, 115_000, 'je joue tranquillement et je parle beaucoup'),
    ];
    const w = buildCandidateWindows(segments, signalsFor(segments, [loud(105_000, 60)]), opts);
    expect(w).toEqual([]);
  });

  it('propriété : le volume seul ne surpasse jamais un échange avec question répondue', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 80 }), fc.integer({ min: 2, max: 6 }), (db, turns) => {
        const ex = exchange(100_000, turns);
        const loudSegs = [seg('creator', 300_000, 310_000, 'je parle seul pendant longtemps ici')];
        const segments = [...ex, ...loudSegs];
        const bins = scoreBins(
          opts.durationMs,
          segments,
          signalsFor(segments, [loud(302_000, db)]),
        );
        const exBest = Math.max(
          ...bins.slice(100_000 / BIN_MS, 100_000 / BIN_MS + 4).map((b) => b.score),
        );
        const loudBest = Math.max(
          ...bins.slice(300_000 / BIN_MS - 1, 310_000 / BIN_MS + 1).map((b) => b.score),
        );
        expect(loudBest).toBeLessThan(exBest);
      }),
    );
  });

  it('une zone active très longue est découpée en zones ≤ durée maximale d’un clip', () => {
    const segments = exchange(60_000, 120); // 4 minutes d'échange continu
    const w = buildCandidateWindows(segments, signalsFor(segments), opts);
    expect(w.length).toBeGreaterThanOrEqual(3);
    for (const c of w) expect(c.coreEndMs - c.coreStartMs).toBeLessThanOrEqual(80_000);
  });

  it('propriété : fenêtres bornées, ordonnées, cœurs disjoints et contenus dans leur contexte', () => {
    const segArb = fc
      .record({
        speaker: fc.constantFrom('creator' as const, 'teammates' as const, 'mixed' as const),
        start: fc.integer({ min: 0, max: 590_000 }),
        len: fc.integer({ min: 200, max: 9_000 }),
        text: fc.constantFrom(
          'ok',
          'quoi ?',
          'mdr',
          'mais non !',
          'on rush B',
          'haha t’es sérieux ?',
        ),
      })
      .map((r) => seg(r.speaker, r.start, Math.min(600_000, r.start + r.len), r.text));
    fc.assert(
      fc.property(
        fc.array(segArb, { maxLength: 300 }),
        fc.array(fc.integer({ min: 0, max: 597_000 }), { maxLength: 5 }),
        fc.double({ min: 0.05, max: 0.9, noNaN: true }),
        (segments, peaks, minScore) => {
          const o = { ...opts, minScore };
          const w = buildCandidateWindows(
            segments,
            signalsFor(
              segments,
              peaks.map((p) => loud(p)),
            ),
            o,
          );
          let prevCoreEnd = -1;
          for (const c of w) {
            expect(c.farStartMs).toBeGreaterThanOrEqual(0);
            expect(c.farStartMs).toBeLessThanOrEqual(c.startMs);
            expect(c.startMs).toBeLessThanOrEqual(c.coreStartMs);
            expect(c.coreStartMs).toBeLessThan(c.coreEndMs);
            expect(c.coreEndMs).toBeLessThanOrEqual(c.endMs);
            expect(c.endMs).toBeLessThanOrEqual(600_000);
            expect(c.coreEndMs - c.coreStartMs).toBeLessThanOrEqual(o.maxCoreMs);
            expect(c.startMs).toBe(Math.max(0, c.coreStartMs - o.contextBeforeMs));
            expect(c.coreStartMs).toBeGreaterThanOrEqual(prevCoreEnd);
            expect(c.score).toBeGreaterThanOrEqual(minScore);
            expect(c.score).toBeLessThanOrEqual(1);
            prevCoreEnd = c.coreEndMs;
          }
        },
      ),
    );
  });

  it('aucune parole : aucune fenêtre', () => {
    expect(buildCandidateWindows([], [], opts)).toEqual([]);
  });

  it('reste rapide sur 8 h de stream', () => {
    const segments: AnalysisSegment[] = [];
    for (let t = 0; t < 8 * 3600_000; t += 20_000) segments.push(...exchange(t, 3));
    const signals = signalsFor(segments);
    const started = performance.now();
    buildCandidateWindows(segments, signals, { ...opts, durationMs: 8 * 3600_000 });
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('rankWindows', () => {
  it('classe par score décroissant puis par ordre chronologique', () => {
    const r = rankWindows([
      { startMs: 3, score: 0.5 },
      { startMs: 1, score: 0.9 },
      { startMs: 2, score: 0.5 },
    ]);
    expect(r.map((w) => [w.startMs, w.rank])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });
});
