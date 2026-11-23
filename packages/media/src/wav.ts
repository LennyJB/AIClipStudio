import { open } from 'node:fs/promises';
import { AppError } from '@acs/shared';

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSec: number;
}

/** Lit l'en-tête RIFF/WAVE (parcourt les chunks : FFmpeg ajoute parfois LIST). */
export async function readWavInfo(filePath: string): Promise<WavInfo> {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(64 * 1024, size));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new AppError('MEDIA_EXTRACT_FAILED', `Fichier WAV invalide : ${filePath}`);
    }
    let offset = 12;
    let fmt: Omit<WavInfo, 'dataBytes' | 'durationSec'> | null = null;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ') {
        fmt = {
          channels: buf.readUInt16LE(body + 2),
          sampleRate: buf.readUInt32LE(body + 4),
          bitsPerSample: buf.readUInt16LE(body + 14),
        };
      } else if (id === 'data') {
        if (!fmt) break;
        // Taille réelle sur disque (fiable même si l'en-tête n'a pas été finalisé).
        const dataBytes = Math.min(chunkSize, size - body);
        const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
        return { ...fmt, dataBytes, durationSec: dataBytes / bytesPerSecond };
      }
      offset = body + chunkSize + (chunkSize % 2);
    }
    throw new AppError('MEDIA_EXTRACT_FAILED', `En-tête WAV incomplet : ${filePath}`);
  } finally {
    await fh.close();
  }
}
