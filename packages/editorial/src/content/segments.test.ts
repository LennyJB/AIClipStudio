import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ContentProfile, ContentType } from '@acs/shared';
import { computeSignals } from '../analysis/signals';
import { exchange, seg } from '../analysis/test-helpers';
import { LOCAL_SCORE_WEIGHTS, buildCandidateWindows, scoreBins } from '../analysis/windows';
import { loadContentProfiles } from '../profiles';
import {
  contentContextBlock,
  contentMatters,
  contentTypeAt,
  contentWeightsAt,
  normalizeManualSegments,
  type EffectiveContentSegment,
} from './segments';

const PROFILES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../profiles',
);
let profiles: Record<ContentType, ContentProfile>;
beforeAll(async () => {
  profiles = await loadContentProfiles(PROFILES_DIR);
});
const MIN = 60_000;

describe('corrections du créateur', () => {
  it('segments contigus couvrant tout l’enregistrement : acceptés, voisins identiques fusionnés, confiance 1', () => {
    const out = normalizeManualSegments(
      [
        { startMs: 10 * MIN, endMs: 20 * MIN, type: 'gaming' },
        { startMs: 0, endMs: 5 * MIN, type: 'just_chatting' },
        { startMs: 5 * MIN, endMs: 10 * MIN, type: 'gaming' },
        { startMs: 20 * MIN, endMs: 30 * MIN - 400, type: 'unknown' },
      ],
      30 * MIN,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 5 * MIN, type: 'just_chatting', confidence: 1, source: 'manual' },
      { startMs: 5 * MIN, endMs: 20 * MIN, type: 'gaming', confidence: 1, source: 'manual' },
      { startMs: 20 * MIN, endMs: 30 * MIN, type: 'unknown', confidence: 0, source: 'manual' },
    ]);
  });

  it('trou, chevauchement, début non nul ou couverture incomplète : refus explicite', () => {
    const cases = [
      [{ startMs: MIN, endMs: 10 * MIN, type: 'gaming' as const }],
      [
        { startMs: 0, endMs: 4 * MIN, type: 'gaming' as const },
        { startMs: 5 * MIN, endMs: 10 * MIN, type: 'irl' as const },
      ],
      [
        { startMs: 0, endMs: 6 * MIN, type: 'gaming' as const },
        { startMs: 5 * MIN, endMs: 10 * MIN, type: 'irl' as const },
      ],
      [{ startMs: 0, endMs: 8 * MIN, type: 'gaming' as const }],
      [],
    ];
    for (const c of cases) {
      expect(() => normalizeManualSegments(c, 10 * MIN)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });
});

describe('usage par l’analyse', () => {
  const mixed: EffectiveContentSegment[] = [
    { startMs: 0, endMs: 2 * MIN, type: 'just_chatting', confidence: 0.8, source: 'auto' },
    { startMs: 2 * MIN, endMs: 4 * MIN, type: 'gaming', confidence: 1, source: 'manual' },
    { startMs: 4 * MIN, endMs: 6 * MIN, type: 'unknown', confidence: 0, source: 'auto' },
  ];

  it('type à un instant donné', () => {
    expect(contentTypeAt(mixed, 0)).toBe('just_chatting');
    expect(contentTypeAt(mixed, 2 * MIN)).toBe('gaming');
    expect(contentTypeAt(mixed, 6 * MIN)).toBe('unknown');
  });

  it('seul un format connu autre que gaming change l’analyse', () => {
    expect(contentMatters(null)).toBe(false);
    expect(contentMatters([{ ...mixed[1]!, startMs: 0 }])).toBe(false);
    expect(contentMatters([mixed[1]!, mixed[2]!])).toBe(false);
    expect(contentMatters(mixed)).toBe(true);
  });

  it('pondération : gaming et indéterminé gardent EXACTEMENT la pondération historique', () => {
    const at = contentWeightsAt(mixed, profiles);
    expect(at(0)).toEqual(profiles.just_chatting.localWeights);
    expect(at(2 * MIN)).toBe(LOCAL_SCORE_WEIGHTS);
    expect(at(5 * MIN)).toBe(LOCAL_SCORE_WEIGHTS);
    expect(profiles.gaming.localWeights).toBeUndefined();
  });

  it('enregistrement gaming : fenêtres et scores identiques avec ou sans segmentation', () => {
    const segments = [...exchange(10_000, 8), seg('creator', 60_000, 64_000, 'je loot la zone')];
    const signals = computeSignals({
      durationMs: 120_000,
      segments,
      energy: [],
      gameTerms: ['loot'],
    });
    const allGaming: EffectiveContentSegment[] = [
      { startMs: 0, endMs: 120_000, type: 'gaming', confidence: 0.9, source: 'auto' },
    ];
    const opts = {
      durationMs: 120_000,
      minScore: 0.35,
      contextBeforeMs: 20_000,
      contextAfterMs: 10_000,
      farContextMs: 60_000,
      maxCoreMs: 80_000,
    };
    expect(
      buildCandidateWindows(segments, signals, {
        ...opts,
        weightsAt: contentWeightsAt(allGaming, profiles),
      }),
    ).toEqual(buildCandidateWindows(segments, signals, opts));
  });

  it('Just Chatting : un rire seul (monologue) pèse plus qu’en gaming', () => {
    const segments = [
      seg('creator', 10_000, 14_000, 'mdr non mais c’est pas possible !'),
      seg('creator', 14_500, 18_000, 'ptdr la vache'),
    ];
    const signals = computeSignals({ durationMs: 60_000, segments, energy: [], gameTerms: [] });
    const chat: EffectiveContentSegment[] = [
      { startMs: 0, endMs: 60_000, type: 'just_chatting', confidence: 1, source: 'manual' },
    ];
    const base = Math.max(...scoreBins(60_000, segments, signals).map((b) => b.score));
    const adapted = Math.max(
      ...scoreBins(60_000, segments, signals, contentWeightsAt(chat, profiles)).map((b) => b.score),
    );
    expect(adapted).toBeGreaterThan(base);
    expect(adapted).toBeGreaterThanOrEqual(0.35);
    expect(base).toBeLessThan(0.35);
  });

  it('tous formats : un pic sonore seul ne crée jamais de fenêtre, même avec un seuil minimal', () => {
    const energy = [
      {
        speaker: 'creator' as const,
        audioIndex: 1,
        pointsPerSecond: 10,
        peaks: Int8Array.from({ length: 1200 }, (_, i) =>
          i >= 600 && i < 640 ? (i % 2 ? 127 : -127) : i % 2 ? 4 : -4,
        ),
      },
    ];
    const signals = computeSignals({ durationMs: 60_000, segments: [], energy, gameTerms: [] });
    expect(signals.some((s) => s.kind === 'loudness_peak')).toBe(true);
    for (const type of ['just_chatting', 'reaction', 'podcast', 'irl'] as const) {
      const at = contentWeightsAt(
        [{ startMs: 0, endMs: 60_000, type, confidence: 1, source: 'manual' }],
        profiles,
      );
      const w = buildCandidateWindows([], signals, {
        durationMs: 60_000,
        minScore: 0.01,
        contextBeforeMs: 0,
        contextAfterMs: 0,
        farContextMs: 0,
        maxCoreMs: 80_000,
        weightsAt: at,
      });
      expect(w).toEqual([]);
    }
  });

  it('bloc de contexte : formats du passage, provenance et critères, jamais présenté comme une preuve', () => {
    const text = contentContextBlock({ startMs: MIN, endMs: 5 * MIN }, mixed, profiles);
    expect(text).toContain('jamais une preuve');
    expect(text).toContain(
      '00:01:00–00:02:00 Just Chatting (détection automatique, confiance 0.80)',
    );
    expect(text).toContain('00:02:00–00:04:00 Gaming (confirmé par le créateur)');
    expect(text).toContain('Indéterminé (format non établi');
    expect(text).toContain(`Format Just Chatting : ${profiles.just_chatting.context}`);
    expect(text).toContain(profiles.just_chatting.analysisHints[0]);
  });
});
