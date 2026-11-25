/**
 * Extraction d'images de la vidéo à un instant précis (SourceMs), pour l'analyse.
 *
 * Confidentialité : les zones à masquer (pseudos, incrustations, facecam sans accord) sont
 * recouvertes d'un APLAT OPAQUE sur l'image complète, AVANT le recadrage. Un aplat ne laisse
 * rien deviner, contrairement à un flou. L'original n'est jamais modifié.
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@acs/shared';
import { isSpawnNotFound, runProcess } from './process';
import { assertSafeOutputPath } from './safe-path';

/** Version du générateur d'images (incrémentée si le rendu change : invalide le cache). */
export const FRAME_GENERATOR_VERSION = 1;

/** Rectangle normalisé (0..1) de l'image source. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const even = (n: number) => Math.max(2, 2 * Math.floor(n / 2));

/** Convertit un rectangle normalisé en pixels (dimensions paires, toujours dans l'image). */
export function toPixelRect(r: NormalizedRect, width: number, height: number): PixelRect {
  const x = Math.min(width - 2, Math.max(0, Math.floor(r.x * width)));
  const y = Math.min(height - 2, Math.max(0, Math.floor(r.y * height)));
  const w = even(Math.min(width - x, Math.ceil(r.w * width)));
  const h = even(Math.min(height - y, Math.ceil(r.h * height)));
  return { x, y, w, h };
}

/** Taille de sortie : largeur ≤ maxWidth, proportions conservées, dimensions paires. */
export function outputSize(crop: PixelRect, maxWidth: number): { width: number; height: number } {
  const width = even(Math.min(maxWidth, crop.w));
  return { width, height: even(Math.round((crop.h * width) / crop.w)) };
}

export interface ExtractFrameOptions {
  ffmpegPath: string;
  inputPath: string;
  outputPath: string;
  allowedDir: string;
  /** Instant en ms sur la timeline de l'enregistrement. */
  atMs: number;
  videoWidth: number;
  videoHeight: number;
  /** Zone conservée. */
  crop: NormalizedRect;
  /** Zones recouvertes d'un aplat opaque (avant recadrage). */
  masks: readonly NormalizedRect[];
  maxWidth: number;
  /** Contours colorés (aperçu de cadrage) : dessinés, pas masqués. */
  outlines?: readonly { rect: NormalizedRect; color: string }[];
  signal?: AbortSignal;
}

export interface ExtractedFrame {
  outputPath: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Aplats noirs OPAQUES recouvrant les zones sensibles, en pixels de l'image SOURCE. À placer
 * avant tout recadrage : la zone ne peut réapparaître dans aucun calque. Partagé avec le rendu.
 */
export function opaqueMaskFilters(
  masks: readonly NormalizedRect[],
  width: number,
  height: number,
): string[] {
  return masks.map((m) => {
    const p = toPixelRect(m, width, height);
    return `drawbox=x=${p.x}:y=${p.y}:w=${p.w}:h=${p.h}:color=black@1:t=fill`;
  });
}

export function frameFilter(
  o: Pick<
    ExtractFrameOptions,
    'videoWidth' | 'videoHeight' | 'crop' | 'masks' | 'maxWidth' | 'outlines'
  >,
): {
  filter: string;
  width: number;
  height: number;
} {
  const W = o.videoWidth;
  const H = o.videoHeight;
  const parts: string[] = [...opaqueMaskFilters(o.masks, W, H)];
  for (const l of o.outlines ?? []) {
    const p = toPixelRect(l.rect, W, H);
    const t = Math.max(2, Math.round(W / 320));
    parts.push(`drawbox=x=${p.x}:y=${p.y}:w=${p.w}:h=${p.h}:color=${l.color}@1:t=${t}`);
  }
  const c = toPixelRect(o.crop, W, H);
  const size = outputSize(c, o.maxWidth);
  parts.push(
    `crop=${c.w}:${c.h}:${c.x}:${c.y}`,
    `scale=${size.width}:${size.height}`,
    'format=yuvj420p',
  );
  return { filter: parts.join(','), ...size };
}

export async function extractFrame(opts: ExtractFrameOptions): Promise<ExtractedFrame> {
  if (!(Number.isInteger(opts.atMs) && opts.atMs >= 0)) {
    throw new AppError('VALIDATION_FAILED', 'Instant d’image invalide');
  }
  if (!(opts.videoWidth > 1 && opts.videoHeight > 1)) {
    throw new AppError('MEDIA_UNSUPPORTED', 'Dimensions de la vidéo inconnues');
  }
  assertSafeOutputPath(opts.outputPath, opts.allowedDir, opts.inputPath);
  const { filter, width, height } = frameFilter(opts);
  const part = `${opts.outputPath}.part`;
  await mkdir(path.dirname(opts.outputPath), { recursive: true });
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    // Recherche AVANT l'entrée : rapide sur les gros fichiers, et précise (décodage jusqu'à l'instant).
    '-ss',
    (opts.atMs / 1000).toFixed(3),
    '-i',
    opts.inputPath,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    filter,
    '-q:v',
    '3',
    '-f',
    'image2',
    '-c:v',
    'mjpeg',
    part,
  ];
  let result;
  try {
    result = await runProcess(opts.ffmpegPath, args, opts.signal ? { signal: opts.signal } : {});
  } catch (err) {
    if (isSpawnNotFound(err)) {
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${opts.ffmpegPath})`, { cause: err });
    }
    throw err;
  }
  if (result.aborted) {
    await rm(part, { force: true });
    throw new AppError('CANCELLED', 'Extraction d’image annulée');
  }
  const size = await stat(part).catch(() => null);
  if (result.exitCode !== 0 || !size || size.size === 0) {
    await rm(part, { force: true });
    throw new AppError(
      'MEDIA_EXTRACT_FAILED',
      `Échec de l’extraction de l’image à ${opts.atMs} ms`,
      {
        details: { stderr: result.stderrTail.slice(-2000) },
      },
    );
  }
  await rename(part, opts.outputPath);
  return { outputPath: opts.outputPath, width, height, sizeBytes: size.size };
}
