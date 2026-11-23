import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

const SAMPLE_BYTES = 1024 * 1024;

export interface FileFingerprint {
  sizeBytes: number;
  mtimeMs: number;
  /** sha256(taille + 1er Mo + dernier Mo) : rapide même sur un fichier de 50 Go. */
  hash: string;
}

/**
 * Empreinte légère d'un fichier, pour détecter un doublon à l'import ou un
 * original modifié/déplacé avant traitement. Lecture seule.
 */
export async function fingerprintFile(filePath: string): Promise<FileFingerprint> {
  const st = await stat(filePath);
  const hash = createHash('sha256');
  hash.update(String(st.size));
  const fh = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, st.size));
    await fh.read(head, 0, head.length, 0);
    hash.update(head);
    if (st.size > SAMPLE_BYTES) {
      const tailLen = Math.min(SAMPLE_BYTES, st.size - SAMPLE_BYTES);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, st.size - tailLen);
      hash.update(tail);
    }
  } finally {
    await fh.close();
  }
  return { sizeBytes: st.size, mtimeMs: Math.trunc(st.mtimeMs), hash: hash.digest('hex') };
}
