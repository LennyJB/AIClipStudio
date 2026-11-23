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
import { createExtractAudioHandler } from '../services/api/src/jobs/extract-audio';
import { JobRunner } from '../services/api/src/jobs/runner';
import { createLogger } from '../services/api/src/logger';
import { importRecording } from '../services/api/src/recordings/import';
import { JobRepository, RecordingRepository } from '../services/api/src/recordings/repository';
import { ensureStorageLayout } from '../services/api/src/storage';

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
  const db = openDatabase(config.paths.database);
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
    if (recording.warnings.length)
      console.log(`  avertissements : ${recording.warnings.join(', ')}`);

    if (values['no-extract']) return 0;

    const runner = new JobRunner(ctx, { extract_audio: createExtractAudioHandler(ctx) });
    runner.recover();
    process.once('SIGINT', () => {
      console.log('\nInterruption demandée…');
      void runner.stop();
    });

    const { job } = runner.enqueue(recording.id, 'extract_audio');
    const jobs = new JobRepository(db);
    const started = Date.now();
    const timer = setInterval(() => {
      const j = jobs.get(job.id);
      if (j?.status === 'running') {
        process.stdout.write(
          `\r  extraction… ${(j.progress * 100).toFixed(1)} %  (${Math.round((Date.now() - started) / 1000)} s)`,
        );
      }
    }, 500);
    await runner.idle();
    clearInterval(timer);

    const final = jobs.get(job.id)!;
    console.log(
      `\n\nExtraction : ${final.status}${final.error ? ` — ${final.error.code} : ${final.error.message}` : ''}`,
    );
    const after = new RecordingRepository(db).get(recording.id)!;
    for (const t of after.audioTracks.filter((x) => x.extracted)) {
      console.log(
        `  piste ${t.audioIndex + 1} (${t.role}) → ${t.extracted!.path} [${fmtDuration(t.extracted!.durationSec)}]`,
      );
    }
    console.log(`  durée totale : ${Math.round((Date.now() - started) / 1000)} s`);
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
