import { isAppError } from '@acs/shared';
import { buildApp } from './app';
import { loadConfig, loadEnvFile } from './config';
import { openDatabase } from './db';
import { ensureStorageLayout } from './storage/layout';

async function main() {
  loadEnvFile();
  const config = loadConfig(process.env);
  await ensureStorageLayout(config.paths);
  const db = openDatabase(config.paths.database, undefined, { storageDir: config.paths.storage });
  const { app, services } = buildApp({ config, db });
  // Rendus interrompus en pleine publication : revérifiés (décision, accords, confidentialité,
  // plan) AVANT d'accepter la moindre requête.
  await services.renders.recoverFinalizing();
  // Après recover() (dans buildApp) : aucun traitement n'est actif, les .part sont obsolètes.
  await services.storage.removeStaleTempFiles();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Arrêt en cours');
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.server.host, port: config.server.port });
  if (!config.claude.apiKey) {
    app.log.warn(
      'ANTHROPIC_API_KEY absente : la préparation locale fonctionne ; les appels à Claude (étape 4b) seront indisponibles.',
    );
  }
}

main().catch((err: unknown) => {
  if (isAppError(err)) {
    console.error(`[${err.code}] ${err.message}`, err.details ?? '');
  } else {
    console.error(err);
  }
  process.exit(1);
});
