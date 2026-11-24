/**
 * Ouverture sûre d'un fichier dérivé à servir par HTTP. Le chemin ne vient JAMAIS de la requête :
 * il est lu en base (rel_path du dérivé), puis vérifié ici avant toute lecture.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@acs/shared';

export interface OpenedFile {
  handle: FileHandle;
  size: number;
}

/**
 * Le fichier doit être STRICTEMENT dans `allowedDir` (après résolution des liens), ne pas être
 * un lien symbolique, être un fichier ordinaire et porter l'extension attendue. Il est ouvert une
 * seule fois ; la taille vient de ce même descripteur (aucun écart entre vérification et lecture).
 * Les messages d'erreur ne divulguent jamais le chemin.
 */
export async function openServableFile(
  absPath: string,
  allowedDir: string,
  extension: string,
): Promise<OpenedFile> {
  const refuse = () =>
    new AppError('NOT_READY', 'Fichier d’écoute indisponible : préparez-le à nouveau');
  const resolved = path.resolve(absPath);
  if (path.extname(resolved).toLowerCase() !== extension) throw refuse();
  let root: string;
  let real: string;
  try {
    root = await realpath(allowedDir);
    const st = await lstat(resolved);
    if (st.isSymbolicLink() || !st.isFile()) throw refuse();
    real = await realpath(resolved);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw refuse();
  }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw refuse();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(real, flags);
  } catch {
    throw refuse();
  }
  const st = await handle.stat();
  if (!st.isFile()) {
    await handle.close();
    throw refuse();
  }
  return { handle, size: st.size };
}
