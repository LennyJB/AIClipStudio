import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@acs/shared';
import { isSpawnNotFound, runProcess } from './process';
import { assertSafeOutputPath } from './safe-path';
import { readWavInfo, type WavInfo } from './wav';

/** Format attendu par Faster-Whisper : mono, 16 kHz, PCM 16 bits. */
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;

export interface ExtractTarget {
  /** Index de la piste parmi les pistes audio (0-based). */
  audioIndex: number;
  outputPath: string;
}

export interface ExtractAudioOptions {
  ffmpegPath: string;
  inputPath: string;
  /** Pistes à extraire : toutes en UN SEUL passage (le fichier source n'est lu qu'une fois). */
  targets: readonly ExtractTarget[];
  /** Dossier dans lequel l'écriture est autorisée (storage/processing). */
  allowedDir: string;
  /** Durée attendue, pour calculer la progression (peut être inconnue). */
  expectedDurationSec?: number | null;
  signal?: AbortSignal;
  onProgress?: (ratio: number, processedSec: number) => void;
}

export interface ExtractAudioResult extends WavInfo {
  audioIndex: number;
  outputPath: string;
}

const partPath = (p: string) => `${p}.part`;

/** Construit les arguments FFmpeg (tableau, aucun shell). Exporté pour les tests. */
export function buildExtractArgs(inputPath: string, targets: readonly ExtractTarget[]) {
  if (!targets.length) throw new AppError('VALIDATION_FAILED', 'Aucune piste à extraire');
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-nostats',
    '-i',
    inputPath,
  ];
  for (const t of targets) {
    if (!Number.isInteger(t.audioIndex) || t.audioIndex < 0) {
      throw new AppError('VALIDATION_FAILED', `Index de piste invalide : ${t.audioIndex}`);
    }
    args.push(
      '-map',
      `0:a:${t.audioIndex}`,
      '-vn',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      // Aligne le WAV sur la timeline de la vidéo : comble les trous (images perdues)
      // et conserve le décalage initial de la piste par du silence.
      '-af',
      'aresample=async=1:first_pts=0',
      '-ac',
      '1',
      '-ar',
      String(TRANSCRIPTION_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '-y', // ne concerne que le fichier temporaire .part (vérifié en amont)
      partPath(t.outputPath),
    );
  }
  return args;
}

async function cleanup(targets: readonly ExtractTarget[]) {
  await Promise.all(targets.map((t) => rm(partPath(t.outputPath), { force: true })));
}

/**
 * Extrait une ou plusieurs pistes audio en WAV mono 16 kHz, en un seul passage.
 * Écrit d'abord dans des fichiers `.part`, renommés seulement si TOUT a réussi :
 * un traitement interrompu ne laisse jamais de fichier final incomplet.
 */
export async function extractAudioTracks(opts: ExtractAudioOptions): Promise<ExtractAudioResult[]> {
  const outputs = new Set<string>();
  for (const t of opts.targets) {
    assertSafeOutputPath(t.outputPath, opts.allowedDir, opts.inputPath);
    if (outputs.has(path.resolve(t.outputPath))) {
      throw new AppError('VALIDATION_FAILED', 'Deux pistes ne peuvent pas avoir la même sortie');
    }
    outputs.add(path.resolve(t.outputPath));
    await mkdir(path.dirname(t.outputPath), { recursive: true });
  }
  await cleanup(opts.targets);

  const total =
    opts.expectedDurationSec && opts.expectedDurationSec > 0 ? opts.expectedDurationSec : null;
  const onLine = (line: string) => {
    const m = /^out_time_us=(\d+)$/.exec(line);
    if (!m || !opts.onProgress) return;
    const sec = Number(m[1]) / 1e6;
    opts.onProgress(total ? Math.min(0.999, sec / total) : 0, sec);
  };

  let result;
  try {
    result = await runProcess(opts.ffmpegPath, buildExtractArgs(opts.inputPath, opts.targets), {
      captureStdout: false,
      onStdoutLine: onLine,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    await cleanup(opts.targets);
    if (isSpawnNotFound(err)) {
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${opts.ffmpegPath})`, { cause: err });
    }
    throw err;
  }

  if (result.aborted) {
    await cleanup(opts.targets);
    throw new AppError('CANCELLED', 'Extraction annulée');
  }
  if (result.exitCode !== 0) {
    await cleanup(opts.targets);
    const list = opts.targets.map((t) => t.audioIndex + 1).join(', ');
    throw new AppError('MEDIA_EXTRACT_FAILED', `Échec de l'extraction des pistes audio ${list}`, {
      details: { exitCode: result.exitCode, stderr: result.stderrTail.slice(-2000) },
    });
  }

  const results: ExtractAudioResult[] = [];
  try {
    for (const t of opts.targets) {
      const info = await readWavInfo(partPath(t.outputPath));
      if (info.dataBytes === 0) {
        throw new AppError('MEDIA_EXTRACT_FAILED', `Piste audio ${t.audioIndex + 1} vide`);
      }
      results.push({ ...info, audioIndex: t.audioIndex, outputPath: t.outputPath });
    }
  } catch (err) {
    await cleanup(opts.targets);
    throw err;
  }
  for (const t of opts.targets) await rename(partPath(t.outputPath), t.outputPath);
  opts.onProgress?.(1, Math.max(...results.map((r) => r.durationSec)));
  return results;
}

/** Raccourci pour une seule piste. */
export async function extractAudioTrack(
  opts: Omit<ExtractAudioOptions, 'targets'> & ExtractTarget,
): Promise<ExtractAudioResult> {
  const { audioIndex, outputPath, ...rest } = opts;
  const [res] = await extractAudioTracks({ ...rest, targets: [{ audioIndex, outputPath }] });
  return res!;
}
