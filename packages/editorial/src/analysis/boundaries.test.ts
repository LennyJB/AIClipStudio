import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBoundaries, insideWord, snapOutsideWord } from './boundaries';
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

  describe('limite de plage à l’intérieur d’un mot (aucune boucle infinie)', () => {
    it('mot commencé avant range.startMs et fini après : le début passe après ce mot', () => {
      // Un coéquipier parle d'un seul long mot de 0 à 12 s ; la plage commence à 5 s.
      const long = seg('teammates', 0, 12_000, 'mooooot');
      const setup = seg('creator', 20_000, 23_000, 'alors bon voilà');
      const punch = seg('creator', 24_000, 26_000, 'et là boum');
      const reac = seg('teammates', 26_000, 28_000, 'non mais');
      const b = computeBoundaries({
        setup,
        punchline: punch,
        reactionEnd: reac,
        segments: [long, setup, punch, reac],
        range: { startMs: 5_000, endMs: 60_000 },
        clip,
      });
      expect(b.startMs).toBe(12_000);
      expect(b.startMs).toBeGreaterThanOrEqual(5_000);
      expect(b.endMs).toBeGreaterThanOrEqual(reac.endMs);
      expect(b.flags).toEqual([]);
      expect(b.endMs - b.startMs).toBeGreaterThanOrEqual(20_000);
    });

    it('mot commencé avant range.endMs et fini après : la fin recule avant ce mot', () => {
      const setup = seg('creator', 10_000, 13_000, 'alors bon voilà');
      const punch = seg('creator', 14_000, 16_000, 'et là boum');
      const reac = seg('teammates', 16_000, 18_000, 'non mais');
      // Long mot de 30 s à 90 s ; la plage s'arrête à 40 s, au milieu.
      const long = seg('teammates', 30_000, 90_000, 'mooooot');
      const b = computeBoundaries({
        setup,
        punchline: punch,
        reactionEnd: reac,
        segments: [setup, punch, reac, long],
        range: { startMs: 0, endMs: 40_000 },
        clip,
      });
      expect(b.endMs).toBeLessThanOrEqual(40_000);
      expect(insideWord([{ startMs: 30_000, endMs: 90_000 }], b.endMs)).toBeNull();
      expect(b.startMs).toBeLessThanOrEqual(setup.startMs);
      expect(b.endMs).toBeGreaterThanOrEqual(reac.endMs);
      expect(b.flags).toEqual([]);
    });

    it('aucun recalage possible dans la plage : alerte « mot_coupe », jamais un clip', () => {
      // Un mot de fond couvre toute la plage et la déborde des deux côtés.
      const bg = seg('teammates', 0, 100_000, 'bourdonnement');
      const setup = seg('creator', 20_000, 23_000, 'alors bon voilà');
      const punch = seg('creator', 24_000, 26_000, 'et là boum');
      const reac = seg('creator', 26_000, 28_000, 'voilà quoi');
      const b = computeBoundaries({
        setup,
        punchline: punch,
        reactionEnd: reac,
        segments: [bg, setup, punch, reac],
        range: { startMs: 10_000, endMs: 50_000 },
        clip,
      });
      expect(b.flags).toContain('mot_coupe');
      expect(b.startMs).toBeGreaterThanOrEqual(10_000);
      expect(b.endMs).toBeLessThanOrEqual(50_000);
      expect(b.startMs).toBeLessThanOrEqual(setup.startMs);
      expect(b.endMs).toBeGreaterThanOrEqual(reac.endMs);
    });

    it('snapOutsideWord : recul, repli vers l’avant, avance, repli vers l’arrière, échec', () => {
      const w = [{ startMs: 900, endMs: 1_500 }];
      expect(snapOutsideWord(w, 1_200, 0, 5_000, 'backward')).toEqual({ ms: 900, ok: true });
      expect(snapOutsideWord(w, 1_200, 1_000, 5_000, 'backward')).toEqual({ ms: 1_500, ok: true });
      expect(snapOutsideWord(w, 1_200, 0, 5_000, 'forward')).toEqual({ ms: 1_500, ok: true });
      expect(snapOutsideWord(w, 1_200, 0, 1_400, 'forward')).toEqual({ ms: 900, ok: true });
      expect(snapOutsideWord(w, 1_200, 1_000, 1_400, 'backward')).toEqual({
        ms: 1_200,
        ok: false,
      });
      expect(snapOutsideWord(w, 1_200, 1_000, 1_400, 'forward')).toEqual({
        ms: 1_200,
        ok: false,
      });
      // Mots qui se chevauchent (deux locuteurs) : la chaîne est suivie jusqu'au bout.
      const chain = [
        { startMs: 100, endMs: 600 },
        { startMs: 500, endMs: 1_000 },
        { startMs: 900, endMs: 1_400 },
      ];
      expect(snapOutsideWord(chain, 1_200, 0, 5_000, 'backward')).toEqual({ ms: 100, ok: true });
      expect(snapOutsideWord(chain, 200, 0, 5_000, 'forward')).toEqual({ ms: 1_400, ok: true });
      expect(snapOutsideWord(chain, 1_200, 300, 5_000, 'backward')).toEqual({
        ms: 1_400,
        ok: true,
      });
    });

    it('propriété : plage quelconque (limites dans des mots) → se termine, jamais au milieu d’un mot sans alerte', () => {
      const segArb = fc.array(
        fc.record({
          start: fc.integer({ min: 0, max: 290_000 }),
          len: fc.integer({ min: 300, max: 40_000 }),
          n: fc.integer({ min: 1, max: 6 }),
          speaker: fc.constantFrom('creator' as const, 'teammates' as const),
        }),
        { minLength: 3, maxLength: 40 },
      );
      fc.assert(
        fc.property(
          segArb,
          fc.nat(),
          fc.nat(),
          fc.nat(),
          fc.integer({ min: 0, max: 300_000 }),
          fc.integer({ min: 0, max: 300_000 }),
          (raw, a, b, c, r1, r2) => {
            const segs = raw
              .map((r) =>
                seg(r.speaker, r.start, r.start + r.len, Array(r.n).fill('mot').join(' ')),
              )
              .sort((x, y) => x.startMs - y.startMs);
            const pick = [segs[a % segs.length]!, segs[b % segs.length]!, segs[c % segs.length]!];
            pick.sort((x, y) => x.startMs - y.startMs);
            const [setup, punchline, reactionEnd] = pick as [
              AnalysisSegment,
              AnalysisSegment,
              AnalysisSegment,
            ];
            const range = { startMs: Math.min(r1, r2), endMs: Math.max(r1, r2) };
            const r = computeBoundaries({
              setup,
              punchline,
              reactionEnd,
              segments: segs,
              range,
              clip,
            });
            const inRange = segs.filter((s) => s.endMs > range.startMs && s.startMs < range.endMs);
            const w = words(inRange);
            const cut = insideWord(w, r.startMs) || insideWord(w, r.endMs);
            if (cut) expect(r.flags).toContain('mot_coupe');
            else expect(r.flags).not.toContain('mot_coupe');
            expect(r.startMs).toBeLessThanOrEqual(setup.startMs);
            expect(r.endMs).toBeGreaterThanOrEqual(reactionEnd.endMs);
            expect(r.startMs).toBeGreaterThanOrEqual(Math.min(range.startMs, setup.startMs));
            expect(r.endMs).toBeLessThanOrEqual(Math.max(range.endMs, reactionEnd.endMs));
            if (r.flags.length === 0) {
              expect(r.endMs - r.startMs).toBeGreaterThanOrEqual(20_000);
              expect(r.endMs - r.startMs).toBeLessThanOrEqual(80_000);
            }
          },
        ),
      );
    });
  });
});
