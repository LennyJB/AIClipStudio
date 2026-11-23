import { mkdir } from 'node:fs/promises';
import type { AppConfig } from '../config';

/** Crée l'arborescence de stockage local si nécessaire (idempotent). */
export async function ensureStorageLayout(paths: AppConfig['paths']): Promise<void> {
  for (const dir of [paths.originals, paths.processing, paths.exports]) {
    await mkdir(dir, { recursive: true });
  }
}
