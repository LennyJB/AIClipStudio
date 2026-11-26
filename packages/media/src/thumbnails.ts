/**
 * Planche de vignettes de la timeline (docs/plan-etape-7.md §5.1) : une image JPEG unique, en
 * grille, une vignette par intervalle régulier de la fenêtre éditable.
 *
 * Confidentialité : les vignettes sont petites, durables et affichées HORS du canvas (sur la
 * timeline). Elles sont donc produites depuis l'image MASQUÉE : aplats opaques sur l'image source
 * COMPLÈTE, avant toute réduction (même règle que l'export, `opaqueMaskFilters`). Une zone
 * sensible ne peut apparaître dans aucune vignette.
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@acs/shared';
import { opaqueMaskFilters, type NormalizedRect } from './frames';
import { isSpawnNotFound, runProcess } from './process';
import { assertSafeOutputPath } from './safe-path';

export const THUMBNAIL_GENERATOR_VERSION = 1;

/** Largeur d'une vignette (px), colonnes de la planche, nombre maximal de vignettes. */
export const THUMBNAIL_PROFILE = {
  tileWidth: 160,
  columns: 10,
  maxTiles: 240,
  minIntervalMs: 1000,
};

export interface ThumbnailLayout {
  /** Instant source de la vignette i : windowStartMs + i × intervalMs. */
  windowStartMs: number;
  intervalMs: number;
  count: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/** Disposition de la planche pour une fenêtre et des dimensions source. Fonction pure. */
export function thumbnailLayout(
  windowStartMs: number,
  windowEndMs: number,
  videoWidth: number,
  videoHeight: number,
): ThumbnailLayout {
  const dur = windowEndMs - windowStartMs;
  if (!(dur > 0)) throw new AppError('VALIDATION_FAILED', 'Fenêtre vide');
  const intervalMs = Math.max(
    THUMBNAIL_PROFILE.minIntervalMs,
    Math.ceil(dur / THUMBNAIL_PROFILE.maxTiles / 100) * 100,
  );
  const count = Math.max(1, Math.ceil(dur / intervalMs));
  const columns = Math.min(THUMBNAIL_PROFILE.columns, count);
  return {
    windowStartMs,
    intervalMs,
    count,
    columns,
    rows: Math.ceil(count / columns),
    tileWidth: THUMBNAIL_PROFILE.tileWidth,
    tileHeight: even((THUMBNAIL_PROFILE.tileWidth * videoHeight) / videoWidth),
  };
}

export interface ThumbnailOptions {
  ffmpegPath: string;
  inputPath: string;
  outputPath: string;
  allowedDir: string;
  windowStartMs: number;
  windowEndMs: number;
  videoWidth: number;
  videoHeight: number;
  /** Zones recouvertes d'un aplat opaque, sur l'image source complète. */
  masks: readonly NormalizedRect[];
  probeBytes?: number;
  signal?: AbortSignal;
}

/** Graphe : aplats sur l'image source, une image par intervalle, réduction, grille. */
export function thumbnailFilter(o: ThumbnailOptions, layout: ThumbnailLayout): string {
  return [
    ...opaqueMaskFilters(o.masks, o.videoWidth, o.videoHeight),
    'setpts=PTS-STARTPTS',
    `fps=1000/${layout.intervalMs}:round=down`,
    `scale=${layout.tileWidth}:${layout.tileHeight}:flags=bicubic`,
    `tile=${layout.columns}x${layout.rows}:nb_frames=${layout.count}`,
    'format=yuvj420p',
  ].join(',');
}

export async function generateThumbnails(
  o: ThumbnailOptions,
): Promise<{ outputPath: string; sizeBytes: number; layout: ThumbnailLayout }> {
  if (!(o.videoWidth > 1 && o.videoHeight > 1)) {
    throw new AppError('MEDIA_UNSUPPORTED', 'Dimensions de la vidéo inconnues');
  }
  assertSafeOutputPath(o.outputPath, o.allowedDir, o.inputPath);
  const layout = thumbnailLayout(o.windowStartMs, o.windowEndMs, o.videoWidth, o.videoHeight);
  const part = `${o.outputPath}.part`;
  await mkdir(path.dirname(o.outputPath), { recursive: true });
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...(o.probeBytes ? ['-probesize', String(o.probeBytes)] : []),
    '-ss',
    (o.windowStartMs / 1000).toFixed(3),
    '-t',
    ((o.windowEndMs - o.windowStartMs) / 1000).toFixed(3),
    '-i',
    o.inputPath,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    thumbnailFilter(o, layout),
    '-frames:v',
    '1',
    '-q:v',
    '4',
    '-f',
    'image2',
    '-c:v',
    'mjpeg',
    part,
  ];
  let result;
  try {
    result = await runProcess(o.ffmpegPath, args, o.signal ? { signal: o.signal } : {});
  } catch (err) {
    if (isSpawnNotFound(err)) {
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${o.ffmpegPath})`, { cause: err });
    }
    throw err;
  }
  if (result.aborted) {
    await rm(part, { force: true });
    throw new AppError('CANCELLED', 'Préparation des vignettes annulée');
  }
  const size = await stat(part).catch(() => null);
  if (result.exitCode !== 0 || !size || size.size === 0) {
    await rm(part, { force: true });
    throw new AppError('MEDIA_EXTRACT_FAILED', 'Échec de la préparation des vignettes', {
      details: { stderr: result.stderrTail.slice(-2000) },
    });
  }
  await rename(part, o.outputPath);
  return { outputPath: o.outputPath, sizeBytes: size.size, layout };
}
