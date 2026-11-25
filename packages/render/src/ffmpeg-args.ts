/**
 * Arguments FFmpeg (tableau, jamais de shell). Les chemins de la source et de la sortie sont des
 * ARGUMENTS : ils n'entrent jamais dans le graphe de filtres, qui ne référence que des noms
 * relatifs fixes (`subs.ass`, `fonts`) résolus dans le dossier de travail (cwd) du processus.
 */
import type { RenderPlan } from './plan';

const sec = (ms: number) => (ms / 1000).toFixed(3);

export function buildRenderArgs(
  plan: RenderPlan,
  paths: { sourcePath: string; outputPath: string },
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-probesize',
    String(plan.probeBytes),
    // Avant -i avec ré-encodage : recherche précise (à l'image près).
    '-ss',
    sec(plan.srcStartMs),
    '-i',
    paths.sourcePath,
    '-filter_complex',
    plan.filterComplex,
    '-map',
    '[v]',
    ...(plan.hasAudio
      ? ['-map', '[a]', '-c:a', 'aac', '-b:a', plan.preset.audioBitrate, '-ar', '48000', '-ac', '2']
      : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    plan.preset.x264Preset,
    '-crf',
    String(plan.preset.crf),
    '-pix_fmt',
    'yuv420p',
    '-t',
    sec(plan.durationMs),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'mp4',
    paths.outputPath,
  ];
}

/** Image fixe de la disposition (même graphe, sans sous-titres ni zoom). */
export function buildFrameArgs(
  plan: RenderPlan,
  atEditMs: number,
  paths: { sourcePath: string; outputPath: string },
): string[] {
  const t = Math.max(0, Math.min(plan.durationMs - 1, atEditMs));
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-probesize',
    String(plan.probeBytes),
    '-ss',
    sec(plan.srcStartMs + t),
    '-i',
    paths.sourcePath,
    '-filter_complex',
    plan.frameGraph,
    '-map',
    '[v]',
    '-frames:v',
    '1',
    '-q:v',
    '3',
    '-f',
    'image2',
    paths.outputPath,
  ];
}

/** Progression lue sur `-progress pipe:1` : ratio 0..1, ou null si la ligne n'en porte pas. */
export function parseProgressLine(line: string, durationMs: number): number | null {
  const m = /^out_time_(us|ms)=(\d+)$/u.exec(line.trim());
  if (!m || durationMs <= 0) return null;
  // FFmpeg écrit des microsecondes dans out_time_ms comme dans out_time_us.
  const ms = Number(m[2]) / 1000;
  return Math.max(0, Math.min(1, ms / durationMs));
}
