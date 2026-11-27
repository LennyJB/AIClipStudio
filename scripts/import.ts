/**
 * Import + extraction audio en ligne de commande, pour tester sur de vrais
 * enregistrements sans interface :
 *
 *   npm run import -- "D:\OBS\2026-11-20 21-03-11.mkv" --game valorant
 *
 * Options :
 *   --game <id>          profil de jeu (valorant, fortnite, minecraft, generic)
 *   --roles a,b,c        rôles des pistes dans l'ordre (mic, discord, game, mix, unknown)
 *   --no-extract         importer seulement (métadonnées), sans extraire l'audio
 */
import { parseArgs } from 'node:util';
import { TrackRoleSchema } from '@acs/shared';
import { selectTranscriptionTracks } from '@acs/media';
import { loadConfig, loadEnvFile } from '../services/api/src/config';
import { openDatabase } from '../services/api/src/db';
import { createLogger } from '../services/api/src/logger';
import { importRecording } from '../services/api/src/recordings/import';
import { JobRepository, RecordingRepository } from '../services/api/src/recordings/repository';
import { createServices } from '../services/api/src/services';
import { ensureStorageLayout } from '../services/api/src/storage/layout';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    game: { type: 'string' },
    roles: { type: 'string' },
    'no-extract': { type: 'boolean', default: false },
  },
});

const fmtDuration = (s: number | null) => {
  if (s === null) return 'inconnue';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
};
const fmtSize = (b: number) => `${(b / 1024 ** 3).toFixed(2)} Go`;

async function main() {
  const filePath = positionals[0];
  if (!filePath) {
    console.error(
      'Usage : npm run import -- "<chemin absolu du fichier>" [--game id] [--roles a,b,c] [--no-extract]',
    );
    return 2;
  }
  loadEnvFile();
  const config = loadConfig(process.env);
  await ensureStorageLayout(config.paths);
  const db = openDatabase(config.paths.database, undefined, { storageDir: config.paths.storage });
  // En CLI, seuls les avertissements s'affichent (sauf LOG_LEVEL explicite) pour garder la progression lisible.
  const log = createLogger(process.env.LOG_LEVEL ? config : { ...config, logLevel: 'warn' });
  const ctx = { config, db, log };

  try {
    const trackRoles = values.roles
      ? values.roles.split(',').map((r) => TrackRoleSchema.parse(r.trim().toLowerCase()))
      : undefined;
    const { recording, created } = await importRecording(ctx, {
      path: filePath,
      gameId: values.game,
      trackRoles,
    });

    console.log(`\n${created ? 'Importé' : 'Déjà importé'} : ${recording.fileName}`);
    console.log(`  id        ${recording.id}`);
    console.log(
      `  format    ${recording.container.toUpperCase()}, ${fmtSize(recording.sizeBytes)}`,
    );
    console.log(`  durée     ${fmtDuration(recording.durationSec)}`);
    if (recording.video) {
      const v = recording.video;
      console.log(`  vidéo     ${v.codec} ${v.width}x${v.height} @ ${v.fps ?? '?'} i/s`);
    }
    console.log(`  jeu       ${recording.gameId}`);
    console.log('  pistes audio :');
    const toTranscribe = new Set(
      selectTranscriptionTracks(recording.audioTracks).map((t) => t.audioIndex),
    );
    for (const t of recording.audioTracks) {
      console.log(
        `    ${t.audioIndex + 1}. ${t.role.padEnd(8)} (${t.roleSource})  titre=${t.title ?? '—'}  ` +
          `${t.codec ?? '?'} ${t.channels ?? '?'}ch ${t.sampleRate ?? '?'} Hz` +
          `${t.startOffsetSec > 0.05 ? `  décalage=${t.startOffsetSec.toFixed(3)} s` : ''}` +
          `${toTranscribe.has(t.audioIndex) ? '  → à transcrire' : ''}`,
      );
    }
    console.log(
      `  état      ${recording.health.status === 'ok' ? 'lisible' : `PARTIELLEMENT EXPLOITABLE (${recording.health.issues.join(', ')})`}` +
        `${recording.durationSource === 'scan' ? ' — durée mesurée en lisant le fichier' : ''}`,
    );
    if (recording.audioTracks.length === 1) {
      console.log('  piste unique : « Tout » (son mixé d’origine, jamais séparé)');
    }
    if (recording.warnings.length)
      console.log(`  avertissements : ${recording.warnings.join(', ')}`);

    if (values['no-extract']) return 0;

    const { runner, derivatives, storage } = createServices(ctx);
    runner.recover();
    await storage.removeStaleTempFiles();
    process.once('SIGINT', () => {
      console.log('\nInterruption demandée…');
      void runner.stop();
    });

    const request = derivatives.requestTranscriptionAudio(recording.id);
    const jobs = new JobRepository(db);
    const started = Date.now();
    if (request.status === 'ready')
      console.log('\nAudio de transcription déjà disponible (cache).');
    const timer = setInterval(() => {
      const running = request.jobs.map((j) => jobs.get(j.id)).find((j) => j?.status === 'running');
      if (running) {
        process.stdout.write(
          `\r  extraction… ${(running.progress * 100).toFixed(1)} %  (${Math.round((Date.now() - started) / 1000)} s)`,
        );
      }
    }, 500);
    await runner.idle();
    clearInterval(timer);

    const finals = request.jobs.map((j) => jobs.get(j.id)!);
    for (const f of finals) {
      console.log(
        `\n\nTraitement ${f.type} : ${f.status}${f.error ? ` — ${f.error.code} : ${f.error.message}` : ''}`,
      );
    }
    console.log('\nFichiers dérivés :');
    const after = new RecordingRepository(db).get(recording.id)!;
    for (const d of derivatives.repo.listForRecording(recording.id)) {
      const track = after.audioTracks.find((t) => t.audioIndex === d.audioIndex);
      console.log(
        `  ${d.kind.padEnd(20)} piste ${(d.audioIndex ?? 0) + 1} (${track?.role ?? '?'})  ` +
          `${(d.sizeBytes / 1e6).toFixed(1)} Mo  ${d.durationMs === null ? '' : fmtDuration(d.durationMs / 1000)}  → ${derivatives.abs(d.relPath)}`,
      );
    }
    console.log(`  durée totale : ${Math.round((Date.now() - started) / 1000)} s`);
    const final = {
      status: finals.every((f) => f.status === 'succeeded') ? 'succeeded' : 'failed',
    };
    return final.status === 'succeeded' ? 0 : 1;
  } finally {
    db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const e = err as { code?: string; message?: string; details?: unknown };
    console.error(`\nÉchec${e.code ? ` [${e.code}]` : ''} : ${e.message ?? String(err)}`);
    if (e.details) console.error(JSON.stringify(e.details, null, 2));
    process.exitCode = 1;
  },
);
