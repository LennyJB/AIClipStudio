/**
 * Espace disque occupé et nettoyage.
 *
 *   npm run storage                         rapport
 *   npm run storage -- --clean              simulation : liste ce qui serait supprimé
 *   npm run storage -- --clean --yes        exécute le nettoyage (temporaires, orphelins, excédent de cache)
 *   npm run storage -- --clean --all-cache  inclut TOUT le cache (régénérable), simulation sauf --yes
 *
 * Ne supprime jamais : enregistrements originaux, projets, exports, base de données,
 * fichiers utilisés par un traitement en cours.
 */
import { parseArgs } from 'node:util';
import { loadConfig, loadEnvFile } from '../services/api/src/config';
import { openDatabase } from '../services/api/src/db';
import { createLogger } from '../services/api/src/logger';
import { createServices } from '../services/api/src/services';
import { ensureStorageLayout } from '../services/api/src/storage/layout';

const { values } = parseArgs({
  options: {
    clean: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'all-cache': { type: 'boolean', default: false },
  },
});

const mb = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} Go` : `${(b / 1024 ** 2).toFixed(1)} Mo`;

loadEnvFile();
const config = loadConfig(process.env);
await ensureStorageLayout(config.paths);
const db = openDatabase(config.paths.database, undefined, { storageDir: config.paths.storage });
const log = createLogger(process.env.LOG_LEVEL ? config : { ...config, logLevel: 'warn' });
const { storage } = createServices({ config, db, log });

try {
  const u = await storage.usage();
  console.log(`\nStockage : ${u.storageDir}`);
  if (u.disk)
    console.log(`  disque          ${mb(u.disk.freeBytes)} libres sur ${mb(u.disk.totalBytes)}`);
  console.log(`  base de données ${mb(u.databaseBytes)}`);
  console.log(`  exports         ${mb(u.exportsBytes)}  (jamais supprimés automatiquement)`);
  console.log(
    `  dérivés         ${mb(u.processing.derivatives.bytes)} (${u.processing.derivatives.count} fichiers)`,
  );
  console.log(
    `    cache         ${mb(u.processing.derivatives.cacheBytes)} / ${mb(u.cacheMaxBytes)} max`,
  );
  console.log(`    épinglés      ${mb(u.processing.derivatives.keepBytes)}`);
  for (const [kind, v] of Object.entries(u.processing.derivatives.byKind)) {
    console.log(`    ${kind.padEnd(20)} ${mb(v.bytes)} (${v.count})`);
  }
  console.log(`  temporaires     ${mb(u.processing.temp.bytes)} (${u.processing.temp.count})`);
  console.log(
    `  orphelins       ${mb(u.processing.orphans.bytes)} (${u.processing.orphans.count})`,
  );
  if (u.byRecording.length) {
    console.log('  par enregistrement :');
    for (const r of u.byRecording)
      console.log(`    ${mb(r.bytes).padStart(10)}  ${r.fileName ?? r.recordingId}`);
  }

  if (values.clean) {
    const dryRun = !values.yes;
    const report = await storage.clean({ dryRun, evictAllCache: values['all-cache'] });
    console.log(
      `\n${dryRun ? 'Simulation — rien n’a été supprimé' : 'Nettoyage effectué'} : ${report.items.length} fichier(s), ${mb(report.totalBytes)}`,
    );
    for (const i of report.items)
      console.log(`  [${i.category}] ${mb(i.bytes).padStart(10)}  ${i.relPath}`);
    if (report.skippedInUse)
      console.log(
        `  ${report.skippedInUse} fichier(s) ignoré(s) : utilisés par un traitement en cours`,
      );
    if (dryRun && report.items.length) console.log('\nPour supprimer réellement : ajoutez --yes');
  }
} finally {
  db.close();
}
