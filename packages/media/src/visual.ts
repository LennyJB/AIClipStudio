/**
 * Activité visuelle (étape 9) : mesure LOCALE et peu coûteuse de « combien l'image change ».
 * Seules les images clés sont décodées (`-skip_frame nokey`), réduites à 64×36 en niveaux de
 * gris, puis le filtre `scdet` de FFmpeg mesure la différence absolue moyenne (`mafd`, 0..100)
 * entre deux images clés successives. On n'utilise PAS son score de coupe (`lavfi.scd.score`),
 * qui ne réagit qu'aux changements brusques : une image qui bouge en continu (jeu) a un score de
 * coupe faible mais une différence moyenne élevée. Ce n'est PAS une reconnaissance d'image : un jeu, une vidéo
 * regardée ou une caméra en mouvement changent beaucoup ; une webcam fixe ou un plateau, peu.
 *
 * Lecture seule de l'original, sans shell ; aucune image n'est écrite ni conservée.
 */
import { AppError } from '@acs/shared';
import { isSpawnNotFound, runProcess } from './process';

export interface VisualActivitySample {
  /** Temps source (ms) de l'image clé. */
  tMs: number;
  /** Différence moyenne avec l'image clé précédente (0..100). */
  score: number;
}

/** Arguments FFmpeg (exposés pour les tests). */
export function visualActivityArgs(file: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-skip_frame',
    'nokey',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    // `threshold=100` : aucune coupe signalée, seule la différence mesurée nous intéresse.
    'scale=64:36,format=gray,scdet=threshold=100,metadata=mode=print:file=-',
    '-f',
    'null',
    '-',
  ];
}

/** Lit la sortie de `metadata=mode=print` (paires `pts_time` / `lavfi.scd.mafd`). */
export function parseVisualActivity(stdout: string): VisualActivitySample[] {
  const out: VisualActivitySample[] = [];
  let t: number | null = null;
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    const pts = /pts_time:(-?[\d.]+)/u.exec(line);
    if (pts) {
      t = Number(pts[1]);
      continue;
    }
    const sc = /^lavfi\.scd\.mafd=([\d.]+)$/u.exec(line);
    if (sc && t !== null && Number.isFinite(t)) {
      const tMs = Math.max(0, Math.round(t * 1000));
      out.push({ tMs, score: Math.min(100, Math.max(0, Number(sc[1]))) });
      t = null;
    }
  }
  return out;
}

/**
 * Mesure l'activité visuelle de la première piste vidéo. FFmpeg ramène les horodatages au début
 * du fichier : les temps renvoyés sont donc sur la timeline source (SourceMs), décalage d'une
 * piste vidéo qui commence après le son compris.
 */
export async function scanVisualActivity(
  ffmpegPath: string,
  file: string,
  opts: { signal?: AbortSignal } = {},
): Promise<VisualActivitySample[]> {
  let r;
  try {
    r = await runProcess(ffmpegPath, visualActivityArgs(file), {
      ...(opts.signal ? { signal: opts.signal } : {}),
      captureStdout: true,
    });
  } catch (err) {
    if (isSpawnNotFound(err))
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${ffmpegPath})`);
    throw err;
  }
  if (r.aborted) throw new AppError('CANCELLED', 'Mesure visuelle annulée');
  if (r.exitCode !== 0) {
    // Les messages de FFmpeg peuvent contenir des chemins : on ne les relaie pas.
    throw new AppError('MEDIA_EXTRACT_FAILED', 'Mesure de l’activité visuelle impossible');
  }
  return parseVisualActivity(r.stdout);
}
