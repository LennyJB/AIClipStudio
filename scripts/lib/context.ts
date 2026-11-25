import { loadConfig, loadEnvFile } from '../../services/api/src/config';
import { openDatabase } from '../../services/api/src/db';
import { createLogger } from '../../services/api/src/logger';
import { RecordingRepository } from '../../services/api/src/recordings/repository';
import { createServices, recoverServices } from '../../services/api/src/services';
import { ensureStorageLayout } from '../../services/api/src/storage/layout';

/** Contexte complet pour un script CLI (configuration, base, services). */
export async function openCliContext() {
  loadEnvFile();
  const config = loadConfig(process.env);
  await ensureStorageLayout(config.paths);
  const db = openDatabase(config.paths.database, undefined, { storageDir: config.paths.storage });
  const log = createLogger(process.env.LOG_LEVEL ? config : { ...config, logLevel: 'warn' });
  const ctx = { config, db, log };
  const services = createServices(ctx);
  recoverServices(services);
  await services.renders.recoverFinalizing();
  const recordings = new RecordingRepository(db);
  return { config, db, ctx, services, recordings };
}

/** « 01:02:03 », « 62:03 » ou « 3723 » (secondes) → millisecondes. */
export function parseClock(v: string): number {
  const parts = v.split(':').map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) {
    throw new Error(`Instant invalide : « ${v} » (attendu hh:mm:ss)`);
  }
  return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0) * 1000);
}

export function runMain(main: () => Promise<number>) {
  main().then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      console.error(`\nÉchec${e.code ? ` [${e.code}]` : ''} : ${e.message ?? String(err)}`);
      process.exitCode = 1;
    },
  );
}
