import { describe, expect, it } from 'vitest';
import { mergeTriageZones } from './triage-merge';
import type { CandidateWindow } from './windows';

const opts = {
  durationMs: 3_600_000,
  minScore: 0.35,
  contextBeforeMs: 45_000,
  contextAfterMs: 20_000,
  farContextMs: 180_000,
  maxCoreMs: 80_000,
};
const win = (core: number, score: number): CandidateWindow => ({
  farStartMs: Math.max(0, core - 225_000),
  startMs: core - 45_000,
  coreStartMs: core,
  coreEndMs: core + 20_000,
  endMs: core + 40_000,
  score,
  signals: [],
});

describe('mergeTriageZones', () => {
  it('une zone repérée sans aucun signal devient une fenêtre « triage »', () => {
    const r = mergeTriageZones(
      [],
      [{ startMs: 1_000_000, endMs: 1_030_000, strength: 'fort' }],
      [],
      opts,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      origin: 'triage',
      coreStartMs: 1_000_000,
      coreEndMs: 1_030_000,
      rank: 1,
      score: 0,
    });
    expect(r[0]!.startMs).toBe(955_000);
  });

  it('zone qui recoupe une fenêtre à signaux : origine « both », priorité relevée', () => {
    const r = mergeTriageZones(
      [win(500_000, 0.4)],
      [{ startMs: 505_000, endMs: 512_000, strength: 'fort' }],
      [],
      opts,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ origin: 'both' });
    expect(r[0]!.priority).toBeCloseTo(0.9);
  });

  it('zone trop longue bornée à la durée maximale ; priorités ordonnées', () => {
    const r = mergeTriageZones(
      [win(100_000, 0.5)],
      [
        { startMs: 2_000_000, endMs: 2_300_000, strength: 'moyen' },
        { startMs: 3_000_000, endMs: 3_010_000, strength: 'fort' },
      ],
      [],
      opts,
    );
    expect(r.map((w) => [w.origin, w.priority])).toEqual([
      ['triage', 0.8],
      ['signals', 0.5],
      ['triage', 0.5],
    ]);
    const long = r.find((w) => w.coreStartMs === 2_000_000)!;
    expect(long.coreEndMs - long.coreStartMs).toBe(80_000);
  });
});
