/**
 * Fusion des zones signalées par le repérage global avec les fenêtres à signaux locaux.
 * Une zone repérée sans aucun signal (ironie calme…) devient une fenêtre à part entière.
 */
import { mergeIntervals, type Signal } from './signals';
import type { TimeRange } from './types';
import type { CandidateWindow, WindowOptions } from './windows';

export interface TriageZone extends TimeRange {
  strength: 'fort' | 'moyen';
}

export type MergedWindow = CandidateWindow & {
  origin: 'signals' | 'triage' | 'both';
  /** Priorité de traitement (0..1) : signaux locaux et repérage combinés. */
  priority: number;
  rank: number;
};

const STRENGTH = { fort: 0.8, moyen: 0.5 } as const;
const NEAR_MS = 5_000;

export function mergeTriageZones(
  signalWindows: readonly CandidateWindow[],
  zones: readonly TriageZone[],
  signals: readonly Signal[],
  opts: WindowOptions,
): MergedWindow[] {
  const windows: (CandidateWindow & { origin: MergedWindow['origin']; triage: number })[] =
    signalWindows.map((w) => ({ ...w, origin: 'signals' as const, triage: 0 }));

  // Zones qui se recouvrent : regroupées (force maximale conservée).
  const sorted = [...zones].sort((a, b) => a.startMs - b.startMs);
  const groups: TriageZone[] = [];
  for (const z of sorted) {
    const last = groups.at(-1);
    if (last && z.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, z.endMs);
      if (z.strength === 'fort') last.strength = 'fort';
    } else groups.push({ ...z });
  }

  for (const z of groups) {
    const coreStart = Math.max(0, z.startMs);
    const coreEnd = Math.min(
      opts.durationMs,
      Math.max(coreStart + 1, Math.min(z.endMs, coreStart + opts.maxCoreMs)),
    );
    const hit = windows.find(
      (w) => w.coreStartMs - NEAR_MS < coreEnd && coreStart < w.coreEndMs + NEAR_MS,
    );
    if (hit) {
      if (hit.origin === 'signals') hit.origin = 'both';
      hit.triage = Math.max(hit.triage, STRENGTH[z.strength]);
      continue;
    }
    const startMs = Math.max(0, coreStart - opts.contextBeforeMs);
    const endMs = Math.min(opts.durationMs, coreEnd + opts.contextAfterMs);
    windows.push({
      farStartMs: Math.max(0, startMs - opts.farContextMs),
      startMs,
      coreStartMs: coreStart,
      coreEndMs: coreEnd,
      endMs,
      score: 0,
      signals: signals.filter((s) => s.startMs < endMs && s.endMs > startMs),
      origin: 'triage',
      triage: STRENGTH[z.strength],
    });
  }
  return windows
    .map(({ triage, ...w }) => ({
      ...w,
      priority: Math.min(1, Math.max(w.score, triage) + (w.origin === 'both' ? 0.1 : 0)),
    }))
    .sort((a, b) => b.priority - a.priority || a.startMs - b.startMs)
    .map((w, i) => ({ ...w, rank: i + 1 }));
}

/** Plage couverte par des intervalles (utilitaire des tests). */
export const coverage = (r: readonly TimeRange[]) => mergeIntervals(r, 0);
