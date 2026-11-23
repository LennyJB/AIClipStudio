import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@acs/shared';
import { partPath } from './extract';
import { assertSafeOutputPath } from './safe-path';
import { readWavInfo } from './wav';

/**
 * Formes d'onde au format binaire « .dat » version 1 d'audiowaveform (BBC),
 * en 8 bits : en-tête de 20 octets puis une paire (min, max) int8 par point.
 * Calculées en lecture continue d'un WAV déjà extrait (aucune relecture de l'original).
 */
export const WAVEFORM_GENERATOR_VERSION = 1;
export const DEFAULT_POINTS_PER_SECOND = 100;
const HEADER_BYTES = 20;

export interface WaveformInfo {
  sampleRate: number;
  samplesPerPoint: number;
  length: number;
  pointsPerSecond: number;
}

export interface WaveformData extends WaveformInfo {
  /** Paires min/max entrelacées, valeurs de -128 à 127. */
  data: Int8Array;
}

export interface ComputeWaveformOptions {
  wavPath: string;
  outputPath: string;
  allowedDir: string;
  pointsPerSecond?: number;
  signal?: AbortSignal;
}

export async function computeWaveform(
  opts: ComputeWaveformOptions,
): Promise<WaveformInfo & { outputPath: string; sizeBytes: number }> {
  assertSafeOutputPath(opts.outputPath, opts.allowedDir, opts.wavPath);
  const wav = await readWavInfo(opts.wavPath);
  if (wav.bitsPerSample !== 16) {
    throw new AppError(
      'MEDIA_EXTRACT_FAILED',
      'Forme d’onde : seul le PCM 16 bits est pris en charge',
    );
  }
  const pps = opts.pointsPerSecond ?? DEFAULT_POINTS_PER_SECOND;
  const samplesPerPoint = Math.max(1, Math.round(wav.sampleRate / pps));
  const frameBytes = wav.channels * 2;
  const totalFrames = Math.floor(wav.dataBytes / frameBytes);
  const length = Math.ceil(totalFrames / samplesPerPoint);
  const out = new Int8Array(length * 2);

  let frameIndex = 0;
  let min = 0;
  let max = 0;
  let carry: Buffer = Buffer.alloc(0);
  const stream = createReadStream(opts.wavPath, {
    start: wav.dataOffset,
    end: wav.dataOffset + totalFrames * frameBytes - 1,
    highWaterMark: 1 << 20,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % frameBytes);
      for (let off = 0; off < usable; off += frameBytes) {
        for (let c = 0; c < wav.channels; c++) {
          const v = buf.readInt16LE(off + c * 2);
          if (v < min) min = v;
          if (v > max) max = v;
        }
        frameIndex++;
        if (frameIndex % samplesPerPoint === 0) {
          const p = frameIndex / samplesPerPoint - 1;
          out[p * 2] = min >> 8;
          out[p * 2 + 1] = max >> 8;
          min = 0;
          max = 0;
        }
      }
      carry = buf.subarray(usable);
    }
  } catch (err) {
    if (opts.signal?.aborted) throw new AppError('CANCELLED', 'Calcul de forme d’onde annulé');
    throw err;
  }
  if (frameIndex % samplesPerPoint !== 0) {
    const p = Math.floor(frameIndex / samplesPerPoint);
    out[p * 2] = min >> 8;
    out[p * 2 + 1] = max >> 8;
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeInt32LE(1, 0); // version
  header.writeUInt32LE(1, 4); // drapeau : données 8 bits
  header.writeInt32LE(wav.sampleRate, 8);
  header.writeInt32LE(samplesPerPoint, 12);
  header.writeUInt32LE(length, 16);

  await mkdir(path.dirname(opts.outputPath), { recursive: true });
  const tmp = partPath(opts.outputPath);
  const fh = await open(tmp, 'w');
  try {
    await fh.write(header);
    await fh.write(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  } catch (err) {
    await fh.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  await rename(tmp, opts.outputPath);
  return {
    outputPath: opts.outputPath,
    sizeBytes: HEADER_BYTES + out.byteLength,
    sampleRate: wav.sampleRate,
    samplesPerPoint,
    length,
    pointsPerSecond: wav.sampleRate / samplesPerPoint,
  };
}

/** Lit un fichier .dat (8 bits). */
export async function readWaveform(filePath: string): Promise<WaveformData> {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    if (size < HEADER_BYTES || buf.readInt32LE(0) !== 1 || (buf.readUInt32LE(4) & 1) !== 1) {
      throw new AppError('MEDIA_EXTRACT_FAILED', `Forme d’onde illisible : ${filePath}`);
    }
    const sampleRate = buf.readInt32LE(8);
    const samplesPerPoint = buf.readInt32LE(12);
    const length = buf.readUInt32LE(16);
    if (size !== HEADER_BYTES + length * 2) {
      throw new AppError('MEDIA_EXTRACT_FAILED', `Forme d’onde tronquée : ${filePath}`);
    }
    return {
      sampleRate,
      samplesPerPoint,
      length,
      pointsPerSecond: sampleRate / samplesPerPoint,
      data: new Int8Array(buf.buffer, buf.byteOffset + HEADER_BYTES, length * 2),
    };
  } finally {
    await fh.close();
  }
}
