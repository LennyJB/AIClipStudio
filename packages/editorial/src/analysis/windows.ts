/**
 * Fenêtres candidates à partir des signaux locaux.
 *
 * Le score local sert UNIQUEMENT à repérer et ordonner des zones à examiner ; il ne juge
 * pas l'intérêt éditorial. Pondération : les interactions humaines (tours de parole,
 * questions suivies d'une réponse, parole simultanée) pèsent beaucoup plus que le volume
 * sonore ou les termes du jeu. Un pic sonore seul ne crée JAMAIS de fenêtre.
 * Une remarque ironique dite calmement ne produit souvent aucun signal : c'est le rôle du
 * repérage global sur le texte (étape 4b) de la trouver.
 */
import { mergeIntervals, type Signal } from './signals';
import type { AnalysisSegment, TimeRange } from './types';

export const BIN_MS = 5000;
/** Chaque case est évaluée sur ±1 case (15 s) : une interaction s'étale dans le temps. */
const SPAN_BINS = 1;

export const LOCAL_SCORE_WEIGHTS = {
  exchange: 0.3, //          tours de parole (3 en 15 s = maximum)
  answeredQuestion: 0.15, // question suivie d'une prise de parole de l'autre interlocuteur
  simultaneous: 0.1, //      parole simultanée (2 s = maximum)
  laughter: 0.15, //         mots liés au rire transcrits (2 = maximum)
  interjection: 0.1, //      interjections ou exclamations transcrites (2 = maximum)
  density: 0.1, //           proportion de temps de parole
  loudness: 0.05, //         pic sonore (+15 dB = maximum)
  gameTerm: 0.05, //         termes du jeu
} as const;

export type LocalScoreWeights = Record<keyof typeof LOCAL_SCORE_WEIGHTS, number>;

/**
 * Pondération par case (étape 9) : le type de contenu du passage choisit ses critères (un rire
 * pèse plus en Just Chatting, une question suivie d'une réponse en podcast). Absente : la
 * pondération historique s'applique partout (gaming, comportement identique à l'étape 4a).
 */
export type WeightsAt = (binStartMs: number) => LocalScoreWeights;

export interface BinScore {
  startMs: number;
  score: number;
  components: Record<keyof typeof LOCAL_SCORE_WEIGHTS, number>;
}

export interface CandidateWindow {
  /** Début du contexte lointain (texte seul). */
  farStartMs: number;
  /** Fenêtre avec contexte proche. */
  startMs: number;
  /** Zone d'intérêt. */
  coreStartMs: number;
  coreEndMs: number;
  endMs: number;
  /** Score local 0..1 (repérage uniquement). */
  score: number;
  /** Signaux présents dans la fenêtre (contexte proche inclus). */
  signals: Signal[];
}

export interface WindowOptions {
  durationMs: number;
  minScore: number;
  contextBeforeMs: number;
  contextAfterMs: number;
  farContextMs: number;
  /** Longueur maximale d'une zone d'intérêt (durée maximale d'un clip). */
  maxCoreMs: number;
  /** Pondération selon le type de contenu du passage (voir `WeightsAt`). */
  weightsAt?: WeightsAt;
}

const overlapMs = (a: TimeRange, b: TimeRange) =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/** Score de chaque case de 5 s (linéaire en nombre de signaux : 8 h de stream restent rapides). */
export function scoreBins(
  durationMs: number,
  segments: readonly AnalysisSegment[],
  signals: readonly Signal[],
  weightsAt?: WeightsAt,
): BinScore[] {
  const n = Math.max(1, Math.ceil(durationMs / BIN_MS));
  const zeros = () => new Float64Array(n);
  const acc = {
    turns: zeros(),
    answered: zeros(),
    simultaneousMs: zeros(),
    laughter: zeros(),
    interjection: zeros(),
    gameTerm: zeros(),
    loudness: zeros(),
    speechMs: zeros(),
  };
  const binOf = (ms: number) => Math.min(n - 1, Math.max(0, Math.floor(ms / BIN_MS)));
  /** Répartit une durée sur les cases qu'elle recouvre. */
  const spread = (arr: Float64Array, r: TimeRange) => {
    for (let b = binOf(r.startMs); b <= binOf(Math.max(r.startMs, r.endMs - 1)); b++) {
      arr[b]! += overlapMs(r, { startMs: b * BIN_MS, endMs: (b + 1) * BIN_MS });
    }
  };

  const speech = mergeIntervals(
    segments.flatMap((s) =>
      s.words.length
        ? s.words.map((w) => ({ startMs: w.startMs, endMs: w.endMs }))
        : [{ startMs: s.startMs, endMs: s.endMs }],
    ),
    250,
  );
  for (const r of speech) spread(acc.speechMs, r);

  const turns = signals
    .filter((s) => s.kind === 'turn_taking')
    .sort((a, b) => a.startMs - b.startMs);
  for (const sig of signals) {
    const b = binOf(sig.startMs);
    switch (sig.kind) {
      case 'turn_taking':
        acc.turns[b]! += 1;
        break;
      case 'question': {
        // Question suivie, dans les 6 s, d'une prise de parole de l'autre interlocuteur.
        if (sig.speaker !== 'creator' && sig.speaker !== 'teammates') break;
        const hit = turns.some(
          (t) =>
            t.speaker !== sig.speaker &&
            t.startMs >= sig.endMs - 500 &&
            t.startMs <= sig.endMs + 6000,
        );
        if (hit) acc.answered[b]! += 1;
        break;
      }
      case 'simultaneous_speech':
        spread(acc.simultaneousMs, sig);
        break;
      case 'transcribed_laughter':
        acc.laughter[b]! += sig.value;
        break;
      case 'interjection':
        acc.interjection[b]! += sig.value;
        break;
      case 'game_term':
        acc.gameTerm[b]! += sig.value;
        break;
      case 'loudness_peak':
        for (let k = b; k <= binOf(Math.max(sig.startMs, sig.endMs - 1)); k++) {
          acc.loudness[k] = Math.max(acc.loudness[k]!, sig.value);
        }
        break;
      default:
        break;
    }
  }

  const bins: BinScore[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - SPAN_BINS);
    const hi = Math.min(n - 1, i + SPAN_BINS);
    const spanSum = (arr: Float64Array) => {
      let t = 0;
      for (let k = lo; k <= hi; k++) t += arr[k]!;
      return t;
    };
    let loud = 0;
    for (let k = lo; k <= hi; k++) loud = Math.max(loud, acc.loudness[k]!);
    const spanLen = Math.max(1, Math.min(durationMs, (hi + 1) * BIN_MS) - lo * BIN_MS);
    const components = {
      exchange: Math.min(1, spanSum(acc.turns) / 3),
      answeredQuestion: Math.min(1, spanSum(acc.answered)),
      simultaneous: Math.min(1, spanSum(acc.simultaneousMs) / 2000),
      laughter: Math.min(1, spanSum(acc.laughter) / 2),
      interjection: Math.min(1, spanSum(acc.interjection) / 2),
      density: Math.min(1, spanSum(acc.speechMs) / spanLen),
      loudness: Math.min(1, loud / 15),
      gameTerm: Math.min(1, spanSum(acc.gameTerm)),
    };
    const weights = weightsAt ? weightsAt(i * BIN_MS) : LOCAL_SCORE_WEIGHTS;
    let score = (Object.keys(LOCAL_SCORE_WEIGHTS) as (keyof typeof LOCAL_SCORE_WEIGHTS)[]).reduce(
      (a, k) => a + weights[k] * components[k],
      0,
    );
    // Pondérations par format : le volume peut peser davantage (réaction, IRL), mais un pic
    // sonore SEUL ne crée toujours pas de fenêtre, quel que soit le seuil configuré.
    if (weightsAt && score - weights.loudness * components.loudness <= 0) score = 0;
    bins.push({ startMs: i * BIN_MS, score: Math.round(score * 1000) / 1000, components });
  }
  return bins;
}

/** Découpe une zone trop longue aux plus grands silences, en morceaux ≤ maxMs. */
function splitCore(core: TimeRange, speech: readonly TimeRange[], maxMs: number): TimeRange[] {
  const out: TimeRange[] = [];
  let start = core.startMs;
  while (core.endMs - start > maxMs) {
    const lo = start + Math.round(maxMs * 0.6);
    const hi = start + maxMs;
    // Silences (écarts entre paroles) dans [lo, hi] : on coupe au milieu du plus long.
    let best: { at: number; len: number } | null = null;
    for (let i = 1; i < speech.length; i++) {
      const gs = speech[i - 1]!.endMs;
      const ge = speech[i]!.startMs;
      const at = Math.round((gs + ge) / 2);
      if (ge > gs && at > lo && at < hi && (!best || ge - gs > best.len))
        best = { at, len: ge - gs };
    }
    const cut = best?.at ?? hi;
    out.push({ startMs: start, endMs: cut });
    start = cut;
  }
  if (core.endMs > start) out.push({ startMs: start, endMs: core.endMs });
  return out;
}

export function buildCandidateWindows(
  segments: readonly AnalysisSegment[],
  signals: readonly Signal[],
  opts: WindowOptions,
): CandidateWindow[] {
  let durationMs = Math.max(1, opts.durationMs);
  for (const seg of segments) durationMs = Math.max(durationMs, seg.endMs);
  const bins = scoreBins(durationMs, segments, signals, opts.weightsAt);
  const speech = mergeIntervals(
    segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs })),
    0,
  );

  // 1. Cases au-dessus du seuil, regroupées (écart ≤ 10 s).
  const seeds = bins.filter((b) => b.score >= opts.minScore && b.score > 0);
  const groups = mergeIntervals(
    seeds.map((b) => ({ startMs: b.startMs, endMs: Math.min(durationMs, b.startMs + BIN_MS) })),
    2 * BIN_MS,
  );

  // 2. Bornes calées sur les phrases (on ne commence pas au milieu d'une phrase), puis découpage.
  const SNAP_MAX_MS = 10_000;
  const cores: TimeRange[] = [];
  for (const g of groups) {
    let s = g.startMs;
    let e = g.endMs;
    for (const r of speech) {
      if (r.startMs < s && r.endMs > s && s - r.startMs <= SNAP_MAX_MS) s = r.startMs;
      if (r.startMs < e && r.endMs > e && r.endMs - e <= SNAP_MAX_MS) e = r.endMs;
    }
    cores.push(
      ...splitCore(
        { startMs: Math.max(0, s), endMs: Math.min(durationMs, e) },
        speech,
        opts.maxCoreMs,
      ),
    );
  }

  // 3. Fenêtres (contexte proche et lointain), fusion des fenêtres qui se recouvrent
  //    tant que la zone d'intérêt fusionnée reste ≤ maxCoreMs.
  const scoreOf = (c: TimeRange) => {
    let best = 0;
    const last = Math.min(bins.length - 1, Math.floor((c.endMs - 1) / BIN_MS));
    for (let b = Math.max(0, Math.floor(c.startMs / BIN_MS)); b <= last; b++) {
      best = Math.max(best, bins[b]!.score);
    }
    return best;
  };
  type W = TimeRange & { score: number };
  const merged: W[] = [];
  for (const c of [...cores].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1);
    const lastWinEnd = last ? Math.min(durationMs, last.endMs + opts.contextAfterMs) : -1;
    const winStart = Math.max(0, c.startMs - opts.contextBeforeMs);
    if (last && winStart < lastWinEnd && c.endMs - last.startMs <= opts.maxCoreMs) {
      last.endMs = Math.max(last.endMs, c.endMs);
      last.score = Math.max(last.score, scoreOf(c));
    } else {
      merged.push({ ...c, score: scoreOf(c) });
    }
  }

  return merged.map((c) => {
    const startMs = Math.max(0, c.startMs - opts.contextBeforeMs);
    const endMs = Math.min(durationMs, c.endMs + opts.contextAfterMs);
    return {
      farStartMs: Math.max(0, startMs - opts.farContextMs),
      startMs,
      coreStartMs: c.startMs,
      coreEndMs: c.endMs,
      endMs,
      score: Math.min(1, Math.round(c.score * 1000) / 1000),
      signals: signals.filter((s) => s.startMs < endMs && s.endMs > startMs),
    };
  });
}

/** Ordre de priorité : score décroissant, puis chronologique. Rang 1 = le plus prioritaire. */
export function rankWindows<T extends { score: number; startMs: number }>(
  windows: readonly T[],
): (T & { rank: number })[] {
  return [...windows]
    .sort((a, b) => b.score - a.score || a.startMs - b.startMs)
    .map((w, i) => ({ ...w, rank: i + 1 }));
}
