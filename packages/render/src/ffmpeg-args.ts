/**
 * Arguments FFmpeg (tableau, jamais de shell). Les chemins de la source et de la sortie sont des
 * ARGUMENTS : ils n'entrent jamais dans le graphe de filtres, qui ne référence que des noms
 * relatifs fixes (`subs.ass`, `fonts`) résolus dans le dossier de travail (cwd) du processus.
 *
 * Le graphe est lu depuis un FICHIER du dossier de travail (aucune limite de longueur de ligne de
 * commande, 32 Ko sous Windows) : `-/filter_complex fichier` (FFmpeg ≥ 7) ou
 * `-filter_complex_script fichier` (versions antérieures), selon ce que FFmpeg accepte.
 */
import type { FramePlan, RenderPlan } from './plan';

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Nom relatif fixe du fichier de graphe dans le dossier de travail. */
export const GRAPH_FILE = 'graph.txt';

export type FilterScriptSyntax = 'file-option' | 'legacy-script';

export function filterScriptArgs(syntax: FilterScriptSyntax, file = GRAPH_FILE): string[] {
  return syntax === 'file-option' ? ['-/filter_complex', file] : ['-filter_complex_script', file];
}

/** Marge lue après la fin utile d'un segment (images et échantillons complets au raccord). */
export const INPUT_MARGIN_MS = 250;

function inputArgs(plan: RenderPlan, sourcePath: string): string[] {
  const probe = ['-probesize', String(plan.probeBytes)];
  if (!plan.inputs) {
    // Avant -i avec ré-encodage : recherche précise (à l'image près).
    return [...probe, '-ss', sec(plan.srcStartMs), '-i', sourcePath];
  }
  // Une entrée par segment (même fichier) : recherche précise, lecture bornée. Aucun segment
  // n'attend un autre (réordonner les segments ne met aucune image en mémoire tampon).
  return plan.inputs.flatMap((inp) => [
    ...probe,
    '-ss',
    sec(inp.srcStartMs),
    '-t',
    sec(inp.durationMs + INPUT_MARGIN_MS),
    '-i',
    sourcePath,
  ]);
}

export function buildRenderArgs(
  plan: RenderPlan,
  paths: { sourcePath: string; outputPath: string },
  syntax: FilterScriptSyntax,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...inputArgs(plan, paths.sourcePath),
    ...filterScriptArgs(syntax),
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

/** Image exacte (graphe de `buildFramePlan`). Pendant un vide, aucune lecture de la source. */
export function buildFrameArgs(
  frame: FramePlan,
  paths: { sourcePath: string; outputPath: string },
  syntax: FilterScriptSyntax,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...(frame.input
      ? [
          '-probesize',
          String(frame.probeBytes),
          '-ss',
          sec(frame.input.srcMs),
          '-t',
          sec(INPUT_MARGIN_MS),
          '-i',
          paths.sourcePath,
        ]
      : []),
    ...filterScriptArgs(syntax),
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
