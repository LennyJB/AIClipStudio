/**
 * Transcription en ligne de commande (essais réels, comparaison des modèles).
 *
 *   npm run transcribe -- <id d'enregistrement | chemin du fichier> [--game valorant]
 *   npm run transcribe -- <…> --model large-v3          autre modèle (comparaison)
 *   npm run transcribe -- <…> --force                   retranscrire malgré une transcription identique
 *   npm run transcribe -- <id> --compare                tableau comparatif, sans transcrire
 *
 * Ctrl+C interrompt proprement : relancer la commande reprend au dernier bloc enregistré.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, loadEnvFile } from '../services/api/src/config';
import { openDatabase } from '../services/api/src/db';
import { createLogger } from '../services/api/src/logger';
import { importRecording } from '../services/api/src/recordings/import';
import { JobRepository, RecordingRepository } from '../services/api/src/recordings/repository';
import { createServices, recoverServices } from '../services/api/src/services';
import { ensureStorageLayout } from '../services/api/src/storage/layout';
import type { TranscriptionDto } from '../services/api/src/transcriptions/repository';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    game: { type: 'string' },
    force: { type: 'boolean', default: false },
    compare: { type: 'boolean', default: false },
  },
});

const ROLE: Record<string, string> = { mic: 'Micro', discord: 'Discord', mix: 'Mix', game: 'Jeu' };
const dur = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const devices = (t: TranscriptionDto) => {
  if (t.devicesUsed.includes('cuda') && t.devicesUsed.includes('cpu'))
    return 'MIXTE GPU+CPU (repli)';
  if (t.devicesUsed.includes('cuda')) return 'GPU (CUDA)';
  if (t.devicesUsed.includes('cpu'))
    return t.fallbackError ? 'CPU (repli après échec CUDA)' : 'CPU';
  return '—';
};

function table(rows: TranscriptionDto[], roleOf: (i: number) => string) {
  console.log(
    '  piste     modèle            état         périphérique réel               langue  segments  traitement  temps réel',
  );
  for (const t of rows) {
    console.log(
      `  ${roleOf(t.audioIndex).padEnd(9)} ${t.model.padEnd(17)} ${t.status.padEnd(12)} ${devices(t).padEnd(31)} ${(t.language ?? '—').padEnd(7)} ${String(t.segmentCount).padStart(8)}  ${dur(t.processingMs).padStart(10)}  ${t.realtimeFactor ? `×${t.realtimeFactor}` : '—'}`,
    );
    if (t.fallbackError)
      console.log(`            ↳ erreur CUDA : ${t.fallbackError.slice(0, 200)}`);
    if (t.error && t.status !== 'completed')
      console.log(`            ↳ ${t.error.code} : ${t.error.message}`);
  }
}

async function main() {
  const target = positionals[0];
  if (!target) {
    console.error(
      'Usage : npm run transcribe -- <id | chemin> [--model m] [--force] [--compare] [--game id]',
    );
    return 2;
  }
  loadEnvFile();
  const config = loadConfig(process.env);
  await ensureStorageLayout(config.paths);
  const db = openDatabase(config.paths.database, undefined, { storageDir: config.paths.storage });
  const log = createLogger(process.env.LOG_LEVEL ? config : { ...config, logLevel: 'warn' });
  const ctx = { config, db, log };
  try {
    const recordings = new RecordingRepository(db);
    let rec = recordings.get(target);
    if (!rec && existsSync(target))
      rec = (await importRecording(ctx, { path: target, gameId: values.game })).recording;
    if (!rec) throw new Error(`Enregistrement introuvable : ${target}`);
    const roleOf = (i: number) =>
      ROLE[rec!.audioTracks.find((t) => t.audioIndex === i)?.role ?? ''] ?? `piste ${i + 1}`;
    const services = createServices(ctx);
    recoverServices(services);

    if (values.compare) {
      const { comparisons } = services.transcriptions.list(rec.id);
      if (!comparisons.length)
        console.log('Aucune comparaison : transcrivez avec au moins deux modèles (--model).');
      for (const g of comparisons) {
        console.log(`\n${roleOf(g.audioIndex)} — même audio, mêmes paramètres :`);
        table(g.transcriptions, roleOf);
        if (!g.sameDevices) {
          console.log(
            '  ⚠ Périphériques différents : durées et facteurs temps réel NON comparables.',
          );
        }
      }
      return 0;
    }

    await services.storage.removeStaleTempFiles();
    process.once('SIGINT', () => {
      console.log('\nInterruption demandée : reprise possible en relançant la commande.');
      void services.runner.stop();
    });
    const res = await services.transcriptions.request(rec.id, {
      ...(values.model ? { model: values.model } : {}),
      ...(values.force ? { force: true } : {}),
    });
    console.log(
      `\n${rec.fileName} — modèle ${values.model ?? config.whisper.model}, périphérique demandé ${config.whisper.device}`,
    );
    if (res.status === 'ready')
      console.log('Déjà transcrit avec ces paramètres (utilisez --force pour retranscrire).');
    const jobs = new JobRepository(db);
    const started = Date.now();
    const timer = setInterval(() => {
      const j = res.job ? jobs.get(res.job.id) : null;
      if (j?.status === 'running') {
        process.stdout.write(
          `\r  transcription… ${(j.progress * 100).toFixed(1)} %  (${Math.round((Date.now() - started) / 1000)} s)`,
        );
      }
    }, 1000);
    await services.runner.idle();
    clearInterval(timer);
    const final = res.job ? jobs.get(res.job.id) : null;
    if (final)
      console.log(
        `\n\nTraitement : ${final.status}${final.error ? ` — ${final.error.code} : ${final.error.message}` : ''}`,
      );
    table(
      res.transcriptions.map((t) => services.transcriptions.repo.get(t.id)!),
      roleOf,
    );
    return !final || final.status === 'succeeded' ? 0 : 1;
  } finally {
    db.close();
  }
}

main().then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    const e = err as { code?: string; message?: string };
    console.error(`\nÉchec${e.code ? ` [${e.code}]` : ''} : ${e.message ?? String(err)}`);
    process.exitCode = 1;
  },
);
