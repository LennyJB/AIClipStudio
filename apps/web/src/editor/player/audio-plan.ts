/**
 * Plan audio de l'aperçu (docs/plan-etape-7.md §3.3, §5.3) : fonction PURE, exécutée ensuite par
 * Web Audio. Mêmes règles que l'export :
 *  - seules les pistes AUTORISÉES par le serveur ET activées dans le document sont jouées
 *    (décision 5) ; une piste non autorisée n'est jamais chargée ni jouée ;
 *  - silence des pistes de l'enregistrement pendant un arrêt sur image et un vide ;
 *  - fondu de RACCORD_FADE_MS aux seuls raccords internes ;
 *  - gain de la piste + automatisation (temps source) ; atténuation, bips et fondus (temps
 *    montage) évalués par les fonctions partagées avec FFmpeg ;
 *  - export sans son ⇒ aperçu muet.
 */
import {
  audioEffectGainsAt,
  automationGainDb,
  dbToGain,
  EFFECT_CATALOG,
  placeSegments,
  RACCORD_FADE_MS,
  resolvedEffects,
  segmentsV2,
  totalEditDuration,
  type AudioEffectWindow,
  type ClipProjectV2,
} from '@acs/timeline';

export interface StemInfo {
  audioIndex: number;
  /** Début de la piste de montage (temps source, ms). */
  srcStartMs: number;
  durationMs: number;
}

export interface AudioClipPlan {
  audioIndex: number;
  /** Instant montage du début (ms). */
  editStartMs: number;
  /** Position dans la piste de montage (ms). */
  offsetMs: number;
  durationMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Instant source du début (ms), pour l'automatisation. */
  srcStartMs: number;
}

export interface AudioPlan {
  clips: AudioClipPlan[];
  /** Gain constant de chaque piste (dB). */
  trackGainDb: Record<number, number>;
  /** Fenêtres des effets audio actifs (s, temps montage). */
  effects: AudioEffectWindow[];
  totalMs: number;
}

/**
 * Pistes jouées : activées dans le document, autorisées par le serveur, et dont la piste de
 * montage est disponible.
 */
export function playableTracks(
  d: ClipProjectV2,
  allowed: readonly number[],
  stems: readonly StemInfo[],
): number[] {
  if (d.audio.silent) return [];
  const have = new Set(stems.map((s) => s.audioIndex));
  return d.audio.tracks
    .filter((t) => t.enabled && allowed.includes(t.audioIndex) && have.has(t.audioIndex))
    .map((t) => t.audioIndex);
}

export function planAudio(
  d: ClipProjectV2,
  allowed: readonly number[],
  stems: readonly StemInfo[],
  fromMs = 0,
): AudioPlan {
  const segments = segmentsV2(d.segments);
  const placed = placeSegments(segments);
  const tracks = playableTracks(d, allowed, stems);
  const byIndex = new Map(stems.map((s) => [s.audioIndex, s]));
  const clips: AudioClipPlan[] = [];
  placed.forEach((p, k) => {
    const s = p.segment;
    if (s.kind !== 'source') return; // arrêt sur image et vide : silence
    if (p.editEndMs <= fromMs) return;
    const dur = p.editEndMs - p.editStartMs;
    const fade = Math.min(RACCORD_FADE_MS, dur / 2);
    for (const audioIndex of tracks) {
      const stem = byIndex.get(audioIndex)!;
      const skip = Math.max(0, fromMs - p.editStartMs);
      const srcStart = s.srcStartMs + skip;
      const offset = srcStart - stem.srcStartMs;
      if (offset < 0 || offset >= stem.durationMs) continue;
      clips.push({
        audioIndex,
        editStartMs: p.editStartMs + skip,
        offsetMs: offset,
        durationMs: Math.min(dur - skip, stem.durationMs - offset),
        fadeInMs: k > 0 && skip === 0 ? fade : 0,
        fadeOutMs: k < placed.length - 1 ? fade : 0,
        srcStartMs: srcStart,
      });
    }
  });
  const effects = resolvedEffects(d)
    .filter((e) => EFFECT_CATALOG[e.type].category === 'audio')
    .map((e) => ({ ...e, type: e.type as AudioEffectWindow['type'] }));
  return {
    clips,
    trackGainDb: Object.fromEntries(d.audio.tracks.map((t) => [t.audioIndex, t.gainDb])),
    effects,
    totalMs: totalEditDuration(segments),
  };
}

/** Courbe de gain d'automatisation (facteurs linéaires) d'un extrait, pas de `stepMs`. */
export function automationCurve(
  points: readonly { srcMs: number; gainDb: number }[],
  srcStartMs: number,
  durationMs: number,
  stepMs = 10,
): Float32Array {
  const n = Math.max(2, Math.ceil(durationMs / stepMs) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = dbToGain(automationGainDb(points, srcStartMs + (i * durationMs) / (n - 1)));
  }
  return out;
}

/** Courbes des effets (pistes de l'enregistrement, mixage) sur [fromMs, totalMs[, pas de `stepMs`. */
export function effectCurves(
  effects: readonly AudioEffectWindow[],
  fromMs: number,
  totalMs: number,
  stepMs = 5,
): { source: Float32Array; master: Float32Array } {
  const dur = Math.max(stepMs, totalMs - fromMs);
  const n = Math.max(2, Math.ceil(dur / stepMs) + 1);
  const source = new Float32Array(n);
  const master = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = audioEffectGainsAt(effects, (fromMs + (i * dur) / (n - 1)) / 1000);
    source[i] = g.source;
    master[i] = g.master;
  }
  return { source, master };
}
