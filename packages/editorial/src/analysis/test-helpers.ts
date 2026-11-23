import type { AnalysisSegment, Speaker } from './types';

let nextId = 1;

/** Segment de test : mots répartis uniformément sur la durée. */
export function seg(
  speaker: Speaker,
  startMs: number,
  endMs: number,
  text: string,
  extra: Partial<AnalysisSegment> = {},
): AnalysisSegment {
  const tokens = text.split(/\s+/).filter(Boolean);
  const step = (endMs - startMs) / Math.max(1, tokens.length);
  return {
    id: nextId++,
    speaker,
    audioIndex: speaker === 'creator' ? 1 : speaker === 'teammates' ? 2 : 0,
    startMs,
    endMs,
    text,
    suspicionScore: 0,
    suspicionReasons: [],
    words: tokens.map((w, i) => ({
      word: ` ${w}`,
      startMs: Math.round(startMs + i * step),
      endMs: Math.round(startMs + (i + 1) * step),
      probability: 0.9,
    })),
    ...extra,
  };
}

/** Échange animé : alternance créateur / coéquipiers toutes les 2 s. */
export function exchange(startMs: number, turns: number): AnalysisSegment[] {
  return Array.from({ length: turns }, (_, i) =>
    seg(
      i % 2 ? 'teammates' : 'creator',
      startMs + i * 2000,
      startMs + i * 2000 + 1800,
      i % 2 ? 'mais non t’es sérieux ?' : 'attends quoi ?',
    ),
  );
}
