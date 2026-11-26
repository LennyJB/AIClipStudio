/**
 * Exécution Web Audio du plan audio (`audio-plan.ts`). L'`AudioContext` est l'horloge maître de
 * la lecture. Graphe : extrait (fondus de raccord) → gain de la piste (gain + automatisation) →
 * effets des pistes (atténuation, bips) → mixage (+ tons des bips) → fondus d'entrée et de
 * sortie → sortie. Seules les pistes reçues (autorisées et activées, décidées par le serveur)
 * sont décodées et jouées.
 */
import { BLEEP_LEVEL, dbToGain, type ClipProjectV2 } from '@acs/timeline';
import { automationCurve, effectCurves, planAudio, type StemInfo } from './audio-plan';

export interface LoadedStem extends StemInfo {
  buffer: AudioBuffer;
}

export class AudioEngine {
  private nodes: AudioScheduledSourceNode[] = [];
  private master: GainNode | null = null;

  constructor(readonly ctx: AudioContext) {}

  get now() {
    return this.ctx.currentTime;
  }

  stop() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // déjà arrêté
      }
      n.disconnect();
    }
    this.nodes = [];
    this.master?.disconnect();
    this.master = null;
  }

  /** Démarre la lecture à `fromMs` (temps montage) ; retourne l'instant audio du démarrage. */
  play(
    d: ClipProjectV2,
    allowed: readonly number[],
    stems: readonly LoadedStem[],
    fromMs: number,
  ): number {
    this.stop();
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const plan = planAudio(d, allowed, stems, fromMs);
    const remaining = Math.max(0.01, (plan.totalMs - fromMs) / 1000);
    const curves = effectCurves(plan.effects, fromMs, plan.totalMs);
    const master = ctx.createGain();
    master.gain.setValueCurveAtTime(curves.master, t0, remaining);
    master.connect(ctx.destination);
    this.master = master;
    const sourceFx = ctx.createGain();
    sourceFx.gain.setValueCurveAtTime(curves.source, t0, remaining);
    sourceFx.connect(master);
    const byIndex = new Map(stems.map((s) => [s.audioIndex, s]));
    const automation = new Map(d.audio.tracks.map((t) => [t.audioIndex, t.automation]));
    for (const c of plan.clips) {
      const stem = byIndex.get(c.audioIndex)!;
      const when = t0 + (c.editStartMs - fromMs) / 1000;
      const dur = c.durationMs / 1000;
      const src = ctx.createBufferSource();
      src.buffer = stem.buffer;
      const seg = ctx.createGain();
      // Fondus de raccord (anti-clic), identiques à l'export.
      seg.gain.setValueAtTime(c.fadeInMs ? 0 : 1, when);
      if (c.fadeInMs) seg.gain.linearRampToValueAtTime(1, when + c.fadeInMs / 1000);
      if (c.fadeOutMs) {
        seg.gain.setValueAtTime(1, when + dur - c.fadeOutMs / 1000);
        seg.gain.linearRampToValueAtTime(0, when + dur);
      }
      const track = ctx.createGain();
      const points = automation.get(c.audioIndex) ?? [];
      const base = dbToGain(plan.trackGainDb[c.audioIndex] ?? 0);
      if (points.length) {
        const curve = automationCurve(points, c.srcStartMs, c.durationMs).map((g) => g * base);
        track.gain.setValueCurveAtTime(curve, when, Math.max(0.01, dur));
      } else track.gain.value = base;
      src.connect(seg).connect(track).connect(sourceFx);
      src.start(when, c.offsetMs / 1000, dur);
      this.nodes.push(src);
    }
    // Bips : ton sinusoïdal (même enveloppe que l'export), joint au mixage.
    for (const e of plan.effects) {
      if (e.type !== 'bleep' || e.endS * 1000 <= fromMs) continue;
      const osc = ctx.createOscillator();
      osc.frequency.value = e.params['frequencyHz'] ?? 1000;
      const g = ctx.createGain();
      const tone = effectCurves([{ ...e, type: 'bleep' }], fromMs, plan.totalMs).source.map(
        (v) => (1 - v) * BLEEP_LEVEL,
      );
      g.gain.setValueCurveAtTime(tone, t0, remaining);
      osc.connect(g).connect(master);
      osc.start(t0);
      osc.stop(t0 + remaining);
      this.nodes.push(osc);
    }
    return t0;
  }
}

/** Décode une piste de montage (WAV) lue avec son jeton. */
export async function decodeStem(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return await ctx.decodeAudioData(data);
}
