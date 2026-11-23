import path from 'node:path';
import { AppError } from '@acs/shared';

/** Vrai si `child` est strictement à l'intérieur de `parent` (après résolution). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Garde-fou avant toute écriture : la sortie doit être dans le dossier de
 * travail autorisé et ne jamais pointer sur le fichier source.
 */
export function assertSafeOutputPath(output: string, allowedDir: string, sourcePath: string) {
  const out = path.resolve(output);
  if (out === path.resolve(sourcePath)) {
    throw new AppError('UNSAFE_OUTPUT_PATH', 'La sortie ne peut pas être le fichier original');
  }
  if (!isInside(allowedDir, out)) {
    throw new AppError('UNSAFE_OUTPUT_PATH', 'Sortie en dehors du dossier de travail autorisé', {
      details: { output: out, allowedDir: path.resolve(allowedDir) },
    });
  }
}
