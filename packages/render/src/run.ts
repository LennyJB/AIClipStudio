/**
 * Exécution d'un plan de rendu : SEUL module du paquet qui lance un processus.
 *  - FFmpeg sans shell, arguments en tableau ;
 *  - dossier de travail dédié (cwd) : `subs.ass` et `fonts/` y sont copiés, le graphe ne les
 *    désigne que par ces noms relatifs (aucun chemin Windows `C:\…` à échapper) ;
 *  - la sortie est un fichier `.part` fourni par l'appelant (renommé seulement après contrôle) ;
 *  - l'original n'est ouvert qu'en lecture (`-i`).
 */
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSpawnNotFound, probeMedia, runProcess } from '@acs/media';
import { AppError } from '@acs/shared';
import { buildFrameArgs, buildRenderArgs, parseProgressLine } from './ffmpeg-args';
import type { RenderPlan } from './plan';

export interface RunRenderOptions {
  ffmpegPath: string;
  plan: RenderPlan;
  sourcePath: string;
  /** Fichier de sortie (`.part`), chemin absolu. */
  outputPath: string;
  /** Dossier de travail vide, propre à ce rendu. */
  workDir: string;
  /** Dossier des polices fournies (assets/fonts). */
  fontsDir: string;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

/** Retire de la sortie d'erreur tout chemin absolu connu (jamais affiché ni stocké). */
export function sanitizeStderr(text: string, paths: readonly string[]): string {
  let out = text;
  for (const p of paths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(p).join('<chemin>');
  }
  return out.slice(-2000);
}

async function prepareWorkDir(o: Pick<RunRenderOptions, 'workDir' | 'fontsDir' | 'plan'>) {
  await mkdir(path.join(o.workDir, 'fonts'), { recursive: true });
  for (const f of await readdir(o.fontsDir)) {
    if (/\.(ttf|otf)$/iu.test(f))
      await copyFile(path.join(o.fontsDir, f), path.join(o.workDir, 'fonts', f));
  }
  if (o.plan.ass !== null) await writeFile(path.join(o.workDir, 'subs.ass'), o.plan.ass, 'utf8');
}

async function run(
  ffmpegPath: string,
  args: string[],
  o: { cwd: string; signal?: AbortSignal; onLine?: (l: string) => void; paths: string[] },
) {
  let r;
  try {
    r = await runProcess(ffmpegPath, args, {
      cwd: o.cwd,
      captureStdout: false,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onLine ? { onStdoutLine: o.onLine } : {}),
    });
  } catch (err) {
    if (isSpawnNotFound(err)) {
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${ffmpegPath})`, { cause: err });
    }
    throw err;
  }
  if (r.aborted) throw new AppError('CANCELLED', 'Rendu annulé');
  if (r.exitCode !== 0) {
    throw new AppError('RENDER_FAILED', 'Le rendu FFmpeg a échoué', {
      details: { exitCode: r.exitCode, stderr: sanitizeStderr(r.stderrTail, o.paths) },
    });
  }
}

export async function runRender(o: RunRenderOptions): Promise<void> {
  await prepareWorkDir(o);
  const args = buildRenderArgs(o.plan, { sourcePath: o.sourcePath, outputPath: o.outputPath });
  await run(o.ffmpegPath, args, {
    cwd: o.workDir,
    ...(o.signal ? { signal: o.signal } : {}),
    onLine: (line) => {
      const p = parseProgressLine(line, o.plan.durationMs);
      if (p !== null) o.onProgress?.(p);
    },
    paths: [o.sourcePath, o.outputPath, o.workDir, o.fontsDir],
  });
}

export async function runFrame(o: Omit<RunRenderOptions, 'onProgress'> & { atEditMs: number }) {
  await prepareWorkDir({ ...o, plan: { ...o.plan, ass: null } });
  const args = buildFrameArgs(o.plan, o.atEditMs, {
    sourcePath: o.sourcePath,
    outputPath: o.outputPath,
  });
  await run(o.ffmpegPath, args, {
    cwd: o.workDir,
    ...(o.signal ? { signal: o.signal } : {}),
    paths: [o.sourcePath, o.outputPath, o.workDir, o.fontsDir],
  });
}

export interface OutputCheck {
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
  fps: number | null;
}

/**
 * Contrôle de la sortie avant publication : flux attendus, dimensions exactes, durée à une image
 * près (plus la marge d'arrondi de l'encodeur audio).
 */
export async function checkOutput(
  ffprobePath: string,
  file: string,
  plan: RenderPlan,
): Promise<OutputCheck> {
  const info = await probeMedia(ffprobePath, file);
  const v = info.video;
  const durationMs = Math.round((info.durationSec ?? 0) * 1000);
  const frameMs = 1000 / plan.fps;
  const problems: string[] = [];
  if (!v || v.width !== plan.preset.width || v.height !== plan.preset.height) {
    problems.push(
      `dimensions ${v?.width}×${v?.height} au lieu de ${plan.preset.width}×${plan.preset.height}`,
    );
  }
  if (plan.hasAudio !== info.audioTracks.length > 0)
    problems.push('piste audio inattendue ou absente');
  if (Math.abs(durationMs - plan.durationMs) > frameMs + 30) {
    problems.push(`durée ${durationMs} ms au lieu de ${plan.durationMs} ms`);
  }
  if (problems.length) {
    throw new AppError('RENDER_FAILED', `Sortie de rendu non conforme : ${problems.join(' ; ')}`);
  }
  return { width: v!.width!, height: v!.height!, durationMs, hasAudio: plan.hasAudio, fps: v!.fps };
}
