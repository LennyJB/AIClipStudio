/**
 * Exécution d'un plan de rendu : SEUL module du paquet qui lance un processus.
 *  - FFmpeg sans shell, arguments en tableau ;
 *  - dossier de travail dédié (cwd) : `graph.txt`, `subs.ass` et `fonts/` y sont écrits ; le graphe
 *    est lu depuis `graph.txt` et ne désigne les autres que par ces noms relatifs (aucun chemin
 *    Windows `C:\…` à échapper, aucune limite de longueur de ligne de commande) ;
 *  - la sortie est un fichier `.part` fourni par l'appelant (renommé seulement après contrôle) ;
 *  - l'original n'est ouvert qu'en lecture (`-i`).
 */
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSpawnNotFound, probeMedia, runProcess } from '@acs/media';
import { AppError } from '@acs/shared';
import {
  buildFrameArgs,
  buildRenderArgs,
  filterScriptArgs,
  GRAPH_FILE,
  parseProgressLine,
  type FilterScriptSyntax,
} from './ffmpeg-args';
import type { FramePlan, RenderPlan } from './plan';

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

async function prepareWorkDir(o: {
  workDir: string;
  fontsDir: string;
  graph: string;
  ass: string | null;
}) {
  await mkdir(path.join(o.workDir, 'fonts'), { recursive: true });
  for (const f of await readdir(o.fontsDir)) {
    if (/\.(ttf|otf)$/iu.test(f))
      await copyFile(path.join(o.fontsDir, f), path.join(o.workDir, 'fonts', f));
  }
  await writeFile(path.join(o.workDir, GRAPH_FILE), o.graph, 'utf8');
  if (o.ass !== null) await writeFile(path.join(o.workDir, 'subs.ass'), o.ass, 'utf8');
}

const syntaxCache = new Map<string, Promise<FilterScriptSyntax>>();

/**
 * Option de lecture du graphe depuis un fichier acceptée par CET exécutable FFmpeg : essai réel
 * de `-/filter_complex` (FFmpeg ≥ 7) sur une source synthétique, sinon `-filter_complex_script`.
 * Résultat mémorisé par chemin d'exécutable.
 */
export function filterScriptSyntax(
  ffmpegPath: string,
  workDir: string,
): Promise<FilterScriptSyntax> {
  let cached = syntaxCache.get(ffmpegPath);
  if (!cached) {
    cached = (async () => {
      const dir = path.join(workDir, 'essai-graphe');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, GRAPH_FILE), '[0:v]null[o]', 'utf8');
      try {
        const r = await runProcess(
          ffmpegPath,
          [
            '-hide_banner',
            '-nostdin',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=s=16x16:d=0.04',
            ...filterScriptArgs('file-option'),
            '-map',
            '[o]',
            '-f',
            'null',
            '-',
          ],
          { cwd: dir, captureStdout: false },
        );
        return r.exitCode === 0 ? 'file-option' : 'legacy-script';
      } catch (err) {
        if (isSpawnNotFound(err)) {
          throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${ffmpegPath})`, { cause: err });
        }
        throw err;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
    syntaxCache.set(ffmpegPath, cached);
    cached.catch(() => syntaxCache.delete(ffmpegPath));
  }
  return cached;
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
  const syntax = await filterScriptSyntax(o.ffmpegPath, o.workDir);
  await prepareWorkDir({ ...o, graph: o.plan.filterComplex, ass: o.plan.ass });
  const args = buildRenderArgs(
    o.plan,
    { sourcePath: o.sourcePath, outputPath: o.outputPath },
    syntax,
  );
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

export interface RunFrameOptions {
  ffmpegPath: string;
  frame: FramePlan;
  sourcePath: string;
  outputPath: string;
  workDir: string;
  fontsDir: string;
  signal?: AbortSignal;
}

/** Image exacte (mêmes aplats, disposition, zooms et sous-titres que l'export). */
export async function runFrame(o: RunFrameOptions) {
  const syntax = await filterScriptSyntax(o.ffmpegPath, o.workDir);
  await prepareWorkDir({ ...o, graph: o.frame.graph, ass: o.frame.ass });
  const args = buildFrameArgs(
    o.frame,
    { sourcePath: o.sourcePath, outputPath: o.outputPath },
    syntax,
  );
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
