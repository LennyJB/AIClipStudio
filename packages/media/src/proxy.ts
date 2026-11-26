/**
 * Proxy vidéo de l'éditeur (docs/plan-etape-7.md §5.1 et §5.2) : H.264 léger de la fenêtre
 * éditable, groupe d'images court (déplacements rapides de la tête de lecture), SANS son (les
 * pistes de montage sont servies à part) et SANS masque (décision 6 : les aplats sont dessinés
 * par l'aperçu, au-dessus du proxy).
 *
 * Le proxy montre l'image source sans aplats : c'est une donnée sensible, écrite uniquement dans
 * `storage/processing/editor/` (vérifié ici), jamais exportée, jamais utilisée par l'export.
 *
 * Alignement : l'instant t du proxy correspond à l'instant source `windowStartMs + t` (même
 * cadence que la source, horodatages remis à zéro à la première image de la fenêtre).
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@acs/shared';
import { isSpawnNotFound, runProcess } from './process';
import { assertSafeOutputPath } from './safe-path';

/** Version du générateur (incrémentée si le proxy change : invalide le cache). */
export const PROXY_GENERATOR_VERSION = 1;

export const PROXY_PROFILE = {
  height: 540,
  /** Cadence plafonnée (la source au-delà de 60 i/s est ramenée à 60). */
  maxFps: 60,
  /** Une image clé toutes les 0,5 s au plus (recherche rapide dans le navigateur). */
  keyframeIntervalSec: 0.5,
  crf: 28,
  x264Preset: 'veryfast',
} as const;

export interface ProxyOptions {
  ffmpegPath: string;
  inputPath: string;
  outputPath: string;
  /** Dossier où le proxy DOIT être écrit (`processing/editor/`). */
  allowedDir: string;
  windowStartMs: number;
  windowEndMs: number;
  /** Cadence de la source (null : inconnue ⇒ 30). */
  sourceFps: number | null;
  probeBytes?: number;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export interface ProxyResult {
  outputPath: string;
  sizeBytes: number;
  durationMs: number;
  fps: number;
}

export function proxyFps(sourceFps: number | null): number {
  if (!sourceFps || !Number.isFinite(sourceFps) || sourceFps <= 0) return 30;
  return Math.min(PROXY_PROFILE.maxFps, Math.round(sourceFps * 1000) / 1000);
}

/** Arguments FFmpeg (tableau, jamais de shell ; chemins en arguments uniquement). */
export function buildProxyArgs(o: ProxyOptions, partPath: string): string[] {
  if (!(Number.isInteger(o.windowStartMs) && o.windowStartMs >= 0)) {
    throw new AppError('VALIDATION_FAILED', 'Début de fenêtre invalide');
  }
  if (!(Number.isInteger(o.windowEndMs) && o.windowEndMs > o.windowStartMs)) {
    throw new AppError('VALIDATION_FAILED', 'Fin de fenêtre invalide');
  }
  const fps = proxyFps(o.sourceFps);
  const gop = Math.max(1, Math.round(fps * PROXY_PROFILE.keyframeIntervalSec));
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...(o.probeBytes ? ['-probesize', String(o.probeBytes)] : []),
    // Recherche précise avant l'entrée ; lecture bornée à la fenêtre.
    '-ss',
    (o.windowStartMs / 1000).toFixed(3),
    '-t',
    ((o.windowEndMs - o.windowStartMs) / 1000).toFixed(3),
    '-i',
    o.inputPath,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `setpts=PTS-STARTPTS,fps=${fps},scale=-2:${PROXY_PROFILE.height}:flags=bicubic,setsar=1,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    PROXY_PROFILE.x264Preset,
    '-crf',
    String(PROXY_PROFILE.crf),
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    '-sc_threshold',
    '0',
    '-movflags',
    '+faststart',
    '-map_metadata',
    '-1',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'mp4',
    partPath,
  ];
}

export async function generateProxy(o: ProxyOptions): Promise<ProxyResult> {
  assertSafeOutputPath(o.outputPath, o.allowedDir, o.inputPath);
  const part = `${o.outputPath}.part`;
  const args = buildProxyArgs(o, part);
  await mkdir(path.dirname(o.outputPath), { recursive: true });
  const durationMs = o.windowEndMs - o.windowStartMs;
  let result;
  try {
    result = await runProcess(o.ffmpegPath, args, {
      captureStdout: false,
      ...(o.signal ? { signal: o.signal } : {}),
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)$/u.exec(line.trim());
        if (m) o.onProgress?.(Math.min(1, Number(m[1]) / 1000 / durationMs));
      },
    });
  } catch (err) {
    if (isSpawnNotFound(err)) {
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${o.ffmpegPath})`, { cause: err });
    }
    throw err;
  }
  if (result.aborted) {
    await rm(part, { force: true });
    throw new AppError('CANCELLED', 'Préparation du proxy annulée');
  }
  const size = await stat(part).catch(() => null);
  if (result.exitCode !== 0 || !size || size.size === 0) {
    await rm(part, { force: true });
    throw new AppError('MEDIA_EXTRACT_FAILED', 'Échec de la préparation du proxy vidéo', {
      details: { stderr: result.stderrTail.slice(-2000) },
    });
  }
  await rename(part, o.outputPath);
  return { outputPath: o.outputPath, sizeBytes: size.size, durationMs, fps: proxyFps(o.sourceFps) };
}
