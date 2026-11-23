import path from 'node:path';
import { isInside } from '@acs/media';
import { AppError } from '@acs/shared';

/** Chemin relatif au dossier de stockage, toujours avec des « / » (portable Windows/Linux). */
export function toRel(storageDir: string, absPath: string): string {
  if (!isInside(storageDir, absPath)) {
    throw new AppError('UNSAFE_OUTPUT_PATH', `Chemin hors du stockage : ${absPath}`);
  }
  return path.relative(storageDir, absPath).split(path.sep).join('/');
}

/** Chemin absolu à partir d'un chemin relatif stocké en base (refuse toute sortie du stockage). */
export function toAbs(storageDir: string, relPath: string): string {
  const abs = path.resolve(storageDir, ...relPath.split('/'));
  if (!isInside(storageDir, abs)) {
    throw new AppError('UNSAFE_OUTPUT_PATH', `Chemin relatif invalide : ${relPath}`);
  }
  return abs;
}
