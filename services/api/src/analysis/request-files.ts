/**
 * Fichiers `requetes/*.json` : la requête EXACTE (prompt système, message, schéma, paramètres ;
 * images remplacées par leur empreinte) telle qu'elle est — ou serait — envoyée à Claude.
 * Les mêmes fonctions servent au dry-run et à l'analyse réelle, pour que les deux soient
 * directement comparables.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { requestHash, toReviewBody, type ModelRequest } from '@acs/editorial';

export interface RequestFile {
  stage: ModelRequest['stage'];
  model: string;
  promptVersion: string;
  requestHash: string;
  body: unknown;
}

/** Nom de fichier d'une requête de repérage (tranche) ou d'analyse (fenêtre). */
export const triageRequestName = (index: number) =>
  `reperage-${String(index).padStart(2, '0')}.json`;
export const deepRequestName = (rank: number) => `fenetre-${String(rank).padStart(3, '0')}.json`;
/** Seuls ces noms peuvent être lus par l'API (aucun chemin arbitraire). */
export const REQUEST_FILE_RE = /^(reperage-\d{2}|fenetre-\d{3})\.json$/;

export function requestFileContent(req: ModelRequest): RequestFile {
  return {
    stage: req.stage,
    model: req.model,
    promptVersion: req.promptVersion,
    requestHash: requestHash(req),
    body: toReviewBody(req),
  };
}

/** Écrit le fichier et renvoie l'empreinte de la requête. */
export async function writeRequestFile(absPath: string, req: ModelRequest): Promise<string> {
  const content = requestFileContent(req);
  await writeFile(absPath, JSON.stringify(content, null, 2));
  return content.requestHash;
}

/** Empreinte enregistrée dans un fichier de requête (null s'il n'existe pas ou est illisible). */
export async function recordedHash(absPath: string): Promise<string | null> {
  if (!existsSync(absPath)) return null;
  try {
    const v = JSON.parse(await readFile(absPath, 'utf8')) as Partial<RequestFile>;
    return typeof v.requestHash === 'string' ? v.requestHash : null;
  } catch {
    return null;
  }
}
