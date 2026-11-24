import { describe, expect, it } from 'vitest';
import { buildSnapshot } from './snapshot';

const base = {
  tier: 'clip' as const,
  title: 'Le plan infaillible',
  categories: ['humour'],
  relevance: 84,
  reliability: 90,
  flags: [],
  srcStartMs: 110_000,
  srcEndMs: 133_800,
  punchlineMs: 125_000,
  standalone: true,
  promptVersion: 'triage-v1+deep-v1',
  models: { triage: 'claude-haiku-5-5', deep: 'claude-opus-5-5' },
  pipelineVersion: 2,
  memoryVersion: null,
};

describe('copie de la proposition', () => {
  it('durée calculée, déterministe, copie indépendante de l’entrée', () => {
    const s = buildSnapshot(base);
    expect(s.durationMs).toBe(23_800);
    expect(buildSnapshot(base)).toEqual(s);
    base.categories.push('mutation');
    expect(s.categories).toEqual(['humour']);
  });

  it('champ inconnu ou valeur hors bornes refusés', () => {
    expect(() => buildSnapshot({ ...base, relevance: 101 })).toThrow();
    expect(() => buildSnapshot({ ...base, extra: 1 } as typeof base)).toThrow();
  });
});
