/**
 * @acs/transcription — transcription locale avec Faster-Whisper.
 *  - chunking   : blocs avec zone centrale et chevauchements, attribution par point central,
 *                 déduplication temporelle approximative ;
 *  - suspicion  : score heuristique de suspicion (pas une probabilité) ;
 *  - protocol / worker-client : pilotage du worker Python (./python/worker.py).
 * Tous les temps sont en millisecondes du temps SOURCE.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './chunking';
export * from './protocol';
export * from './suspicion';
export * from './worker-client';

/** Chemin du script Python du worker. */
export const WORKER_SCRIPT = path.resolve(
  fileURLToPath(new URL('../python/worker.py', import.meta.url)),
);
