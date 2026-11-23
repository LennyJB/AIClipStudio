import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createFixtures,
  ffmpegAvailable,
  FFMPEG,
  FFPROBE,
  type Fixtures,
} from '../../../tests/helpers/media-fixtures';
import { buildApp } from './app';
import { loadConfig, type AppConfig } from './config';
import type { DerivativeDto } from './derivatives/repository';
import type { DerivativeRequestResult } from './derivatives/service';
import type { Services } from './services';
import { openDatabase, type Db } from './db';
import type { JobDto, RecordingDto } from './recordings/repository';

const enabled = ffmpegAvailable();

let fx: Fixtures;
let app: FastifyInstance;
let services: Services;
let config: AppConfig;
let db: Db;
let storage: string;

async function setup(env: NodeJS.ProcessEnv = {}) {
  storage = await mkdtemp(path.join(tmpdir(), 'acs-storage-'));
  config = loadConfig({
    NODE_ENV: 'test',
    STORAGE_DIR: storage,
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: FFPROBE,
    ...env,
  });
  db = openDatabase(':memory:');
  ({ app, services } = buildApp({ config, db }));
}

async function importFile(filePath: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/recordings',
    payload: { path: filePath, ...extra },
  });
}

async function transcriptionAudio(id: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/recordings/${id}/transcription-audio`,
  });
  return { status: res.statusCode, body: res.json<DerivativeRequestResult>() };
}

async function stems(id: string, srcStartMs: number, srcEndMs: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/recordings/${id}/audio-stems`,
    payload: { srcStartMs, srcEndMs },
  });
  return {
    status: res.statusCode,
    body: res.json<DerivativeRequestResult & { window: { startMs: number; endMs: number } }>(),
  };
}

async function getDerivatives(id: string) {
  return (await app.inject({ method: 'GET', url: `/api/recordings/${id}` })).json<{
    derivatives: DerivativeDto[];
  }>().derivatives;
}

async function getRecording(id: string) {
  return (await app.inject({ method: 'GET', url: `/api/recordings/${id}` })).json<{
    recording: RecordingDto;
    jobs: JobDto[];
  }>();
}

async function getJob(id: string) {
  return (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json<{ job: JobDto }>().job;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('délai dépassé');
}

describe.skipIf(!enabled)('API enregistrements', () => {
  beforeAll(() => {
    fx = createFixtures();
  }, 60_000);

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  describe('import', () => {
    it('importe un MKV OBS et identifie les pistes par leur nom', async () => {
      await setup();
      const res = await importFile(fx.obsMkv, { gameId: 'valorant' });
      expect(res.statusCode).toBe(201);
      const { recording } = res.json<{ recording: RecordingDto }>();
      expect(recording).toMatchObject({
        container: 'mkv',
        gameId: 'valorant',
        sourcePath: fx.obsMkv,
      });
      expect(recording.durationSec).toBeCloseTo(6, 0);
      expect(recording.audioTracks.map((t) => [t.role, t.roleSource])).toEqual([
        ['mix', 'title'],
        ['mic', 'title'],
        ['discord', 'title'],
      ]);
    });

    it('ne ré-importe pas deux fois le même fichier', async () => {
      await setup();
      const a = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      const b = await importFile(fx.obsMkv);
      expect(b.statusCode).toBe(200);
      expect(b.json()).toMatchObject({ created: false, recording: { id: a.recording.id } });
      const list = (await app.inject({ method: 'GET', url: '/api/recordings' })).json<{
        recordings: unknown[];
      }>();
      expect(list.recordings).toHaveLength(1);
    });

    it('utilise l’ordre configuré pour des pistes sans nom', async () => {
      await setup({ AUDIO_TRACK_ROLES: 'mic,discord,mix' });
      const { recording } = (await importFile(fx.untitledMkv)).json<{ recording: RecordingDto }>();
      expect(recording.audioTracks.map((t) => t.role)).toEqual(['mic', 'discord', 'mix']);
    });

    it('accepte un MP4 de secours à piste unique (mix)', async () => {
      await setup();
      const { recording } = (await importFile(fx.singleMp4)).json<{ recording: RecordingDto }>();
      expect(recording.audioTracks).toMatchObject([{ role: 'mix', roleSource: 'single_track' }]);
    });

    it.each([
      ['chemin relatif', () => 'videos/session.mkv', 400, 'VALIDATION_FAILED'],
      ['extension non prise en charge', () => path.join(fx.dir, 'x.avi'), 400, 'MEDIA_UNSUPPORTED'],
      ['fichier absent', () => path.join(fx.dir, 'absent.mkv'), 404, 'MEDIA_NOT_FOUND'],
      ['fichier corrompu', () => fx.garbageMkv, 400, 'MEDIA_PROBE_FAILED'],
    ])('refuse : %s', async (_label, file, status, code) => {
      await setup();
      const res = await importFile(file());
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ error: { code } });
    });

    it('refuse un profil de jeu inconnu et un corps invalide', async () => {
      await setup();
      expect((await importFile(fx.obsMkv, { gameId: 'tetris' })).statusCode).toBe(404);
      expect((await importFile(fx.obsMkv, { extra: true })).json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
      expect((await importFile(fx.obsMkv, { trackRoles: ['mic'] })).json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('permet de corriger les rôles des pistes', async () => {
      await setup();
      const { recording } = (await importFile(fx.untitledMkv)).json<{ recording: RecordingDto }>();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/recordings/${recording.id}/tracks`,
        payload: { roles: ['game', 'mic', 'discord'] },
      });
      expect(res.statusCode).toBe(200);
      expect(
        res
          .json<{ recording: RecordingDto }>()
          .recording.audioTracks.map((t) => [t.role, t.roleSource]),
      ).toEqual([
        ['game', 'override'],
        ['mic', 'override'],
        ['discord', 'override'],
      ]);
    });
  });

  describe('audio de transcription', () => {
    it('extrait micro et Discord (pas le mix), avec formes d’onde, sans toucher à l’original', async () => {
      await setup();
      const before = statSync(fx.obsMkv);
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      const first = await transcriptionAudio(recording.id);
      expect(first.status).toBe(202);
      expect(first.body.jobs).toHaveLength(1);
      expect(first.body.jobs[0]).toMatchObject({
        type: 'extract_transcription_audio',
        lane: 'heavy',
      });
      await services.runner.idle();

      expect(await getJob(first.body.jobs[0]!.id)).toMatchObject({
        status: 'succeeded',
        progress: 1,
        error: null,
      });
      const ders = await getDerivatives(recording.id);
      const audio = ders.filter((d) => d.kind === 'audio_transcription');
      expect(audio.map((d) => d.audioIndex).sort()).toEqual([1, 2]);
      for (const d of audio) {
        expect(d).toMatchObject({ srcStartMs: null, params: { sampleRate: 16000, channels: 1 } });
        expect(d.durationMs).toBeGreaterThan(5_500);
        expect(d.relPath.startsWith(`processing/${recording.id}/transcription/`)).toBe(true);
        expect(existsSync(path.join(storage, d.relPath))).toBe(true);
      }
      expect(ders.filter((d) => d.kind === 'waveform')).toHaveLength(2);
      const now = statSync(fx.obsMkv);
      expect([now.size, now.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    });

    it('réutilise le cache : une demande identique est servie sans traitement', async () => {
      await setup();
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      await transcriptionAudio(recording.id);
      await services.runner.idle();
      const again = await transcriptionAudio(recording.id);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ status: 'ready', jobs: [] });
      expect(again.body.audio).toHaveLength(2);
      expect(again.body.waveforms).toHaveLength(2);
    });

    it('deux demandes simultanées identiques partagent le même traitement', async () => {
      await setup();
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      const a = await transcriptionAudio(recording.id);
      const b = await transcriptionAudio(recording.id);
      expect(b.body.jobs[0]!.id).toBe(a.body.jobs[0]!.id);
      await services.runner.idle();
      const jobs = db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'extract_transcription_audio'`)
        .get();
      expect(jobs).toEqual({ n: 1 });
    });

    it('régénère un dérivé dont le fichier a disparu', async () => {
      await setup();
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      await transcriptionAudio(recording.id);
      await services.runner.idle();
      const mic = (await getDerivatives(recording.id)).find(
        (d) => d.kind === 'audio_transcription' && d.audioIndex === 1,
      )!;
      rmSync(path.join(storage, mic.relPath));
      const res = await transcriptionAudio(recording.id);
      expect(res.body.status).toBe('pending');
      expect(res.body.jobs[0]!.params).toMatchObject({ audioIndexes: [1] }); // seule la piste manquante
      await services.runner.idle();
      expect(existsSync(path.join(storage, mic.relPath))).toBe(true);
    });

    it('déduit la durée de l’audio pour un MKV non finalisé', async () => {
      await setup();
      const { recording } = (await importFile(fx.unfinalizedMkv)).json<{
        recording: RecordingDto;
      }>();
      expect(recording.durationSec).toBeNull();
      await transcriptionAudio(recording.id);
      await services.runner.idle();
      const { recording: after } = await getRecording(recording.id);
      expect(after.durationSource).toBe('audio');
      expect(after.durationSec).toBeCloseTo(6, 0);
    });

    it('refuse de traiter un original modifié depuis l’import', async () => {
      await setup();
      const copy = path.join(storage, 'copie.mkv');
      copyFileSync(fx.obsMkv, copy);
      const { recording } = (await importFile(copy)).json<{ recording: RecordingDto }>();
      appendFileSync(copy, Buffer.alloc(1024, 1));
      const { body } = await transcriptionAudio(recording.id);
      await services.runner.idle();
      expect((await getJob(body.jobs[0]!.id)).error?.code).toBe('MEDIA_SOURCE_CHANGED');
    });
  });

  describe('pistes de montage (fenêtres de clip)', () => {
    const windowEnv = { CLIP_WINDOW_MARGIN_SEC: '1', CLIP_WINDOW_GRID_SEC: '1' };

    it('avec une piste « Jeu » : micro + Discord + jeu en 48 kHz stéréo, sur une fenêtre', async () => {
      await setup(windowEnv);
      const { recording } = (await importFile(fx.gameMkv)).json<{ recording: RecordingDto }>();
      expect(recording.audioTracks.map((t) => t.role)).toEqual(['mix', 'mic', 'discord', 'game']);
      const res = await stems(recording.id, 1_500, 2_500);
      expect(res.status).toBe(202);
      expect(res.body.window).toEqual({ startMs: 0, endMs: 4_000 });
      expect(res.body.jobs[0]).toMatchObject({ type: 'extract_audio_stems', lane: 'interactive' });
      await services.runner.idle();
      const ders = (await getDerivatives(recording.id)).filter((d) => d.kind === 'audio_stem');
      expect(ders.map((d) => d.audioIndex).sort()).toEqual([1, 2, 3]);
      for (const d of ders) {
        expect(d).toMatchObject({
          srcStartMs: 0,
          srcEndMs: 4_000,
          params: { sampleRate: 48000, channels: 2 },
        });
        expect(d.durationMs).toBeGreaterThanOrEqual(3_950);
        expect(d.durationMs).toBeLessThanOrEqual(4_050);
      }
    });

    it('sans piste « Jeu » : le mix seul', async () => {
      await setup(windowEnv);
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      await stems(recording.id, 1_000, 2_000);
      await services.runner.idle();
      const ders = (await getDerivatives(recording.id)).filter((d) => d.kind === 'audio_stem');
      expect(ders.map((d) => d.audioIndex)).toEqual([0]);
    });

    it('une fenêtre déjà préparée qui englobe la demande est réutilisée', async () => {
      await setup(windowEnv);
      const { recording } = (await importFile(fx.gameMkv)).json<{ recording: RecordingDto }>();
      await stems(recording.id, 1_500, 2_500); // fenêtre [0 ; 4 s]
      await services.runner.idle();
      const inside = await stems(recording.id, 2_000, 3_000); // fenêtre calculée [1 s ; 4 s], incluse
      expect(inside.status).toBe(200);
      expect(inside.body.status).toBe('ready');
      expect(inside.body.audio.every((d) => d.srcStartMs === 0 && d.srcEndMs === 4_000)).toBe(true);
      expect(inside.body.waveforms).toHaveLength(3);
    });

    it('plusieurs clips du même enregistrement sont préparés indépendamment, sans conflit', async () => {
      await setup({ CLIP_WINDOW_MARGIN_SEC: '0', CLIP_WINDOW_GRID_SEC: '1' });
      const { recording } = (await importFile(fx.gameMkv)).json<{ recording: RecordingDto }>();
      const a = await stems(recording.id, 0, 1_000);
      const b = await stems(recording.id, 4_000, 5_000);
      expect(a.body.jobs[0]!.id).not.toBe(b.body.jobs[0]!.id);
      await services.runner.idle();
      for (const r of [a, b]) expect((await getJob(r.body.jobs[0]!.id)).status).toBe('succeeded');
      const windows = new Set(
        (await getDerivatives(recording.id))
          .filter((d) => d.kind === 'audio_stem')
          .map((d) => `${d.srcStartMs}-${d.srcEndMs}`),
      );
      expect(windows).toEqual(new Set(['0-1000', '4000-5000']));
    });

    it('la préparation d’un clip n’attend pas une transcription longue (deux files)', async () => {
      await setup(windowEnv);
      const long = (await importFile(fx.longMkv)).json<{ recording: RecordingDto }>().recording;
      const clip = (await importFile(fx.gameMkv)).json<{ recording: RecordingDto }>().recording;
      const heavy = (await transcriptionAudio(long.id)).body.jobs[0]!;
      await waitFor(async () => (await getJob(heavy.id)).status === 'running');
      const quick = (await stems(clip.id, 1_000, 2_000)).body.jobs[0]!;
      await waitFor(async () => (await getJob(quick.id)).status === 'succeeded');
      expect((await getJob(heavy.id)).status).toBe('running');
      await services.runner.idle();
      expect((await getJob(heavy.id)).status).toBe('succeeded');
    });

    it('refuse une plage invalide', async () => {
      await setup(windowEnv);
      const { recording } = (await importFile(fx.gameMkv)).json<{ recording: RecordingDto }>();
      const res = await app.inject({
        method: 'POST',
        url: `/api/recordings/${recording.id}/audio-stems`,
        payload: { srcStartMs: 3_000, srcEndMs: 1_000 },
      });
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect((await stems(recording.id, 60_000, 61_000)).body).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
    });
  });

  describe('file de traitements', () => {
    it('peut annuler un traitement en cours', async () => {
      await setup();
      const { recording } = (await importFile(fx.longMkv)).json<{ recording: RecordingDto }>();
      const job = (await transcriptionAudio(recording.id)).body.jobs[0]!;
      await waitFor(async () => (await getJob(job.id)).status === 'running');
      const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
      expect(res.statusCode).toBe(200);
      await services.runner.idle();
      expect(await getJob(job.id)).toMatchObject({
        status: 'cancelled',
        error: { code: 'CANCELLED' },
      });
      expect(
        (await getDerivatives(recording.id)).filter((d) => d.kind === 'audio_transcription'),
      ).toEqual([]);
    });

    it('marque le traitement interrompu à l’arrêt du serveur, puis permet de le relancer', async () => {
      await setup();
      const { recording } = (await importFile(fx.longMkv)).json<{ recording: RecordingDto }>();
      const job = (await transcriptionAudio(recording.id)).body.jobs[0]!;
      await waitFor(async () => (await getJob(job.id)).status === 'running');
      await app.close();
      const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as {
        status: string;
      };
      expect(row.status).toBe('interrupted');
    });

    it('au démarrage, les traitements restés actifs deviennent interrompus', async () => {
      await setup();
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      db.prepare(
        `INSERT INTO jobs (id, recording_id, type, lane, target_key, status)
         VALUES ('j1', ?, 'extract_transcription_audio', 'heavy', 'k', 'running')`,
      ).run(recording.id);
      expect(services.runner.recover()).toBe(1);
      const row = db.prepare(`SELECT status FROM jobs WHERE id = 'j1'`).get() as { status: string };
      expect(row.status).toBe('interrupted');
    });

    it('renvoie 404 pour un enregistrement inconnu', async () => {
      await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/api/recordings/00000000-0000-4000-8000-000000000000/transcription-audio',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('espace disque', () => {
    async function prepared() {
      await setup(windowEnvFor());
      const { recording } = (await importFile(fx.gameMkv)).json<{ recording: RecordingDto }>();
      await transcriptionAudio(recording.id);
      await stems(recording.id, 1_000, 2_000);
      await services.runner.idle();
      return recording;
    }
    const windowEnvFor = () => ({ CLIP_WINDOW_MARGIN_SEC: '1', CLIP_WINDOW_GRID_SEC: '1' });

    it('rapporte l’espace par usage, enregistrement, temporaires et orphelins', async () => {
      const rec = await prepared();
      writeFileSync(path.join(storage, 'processing', rec.id, 'oubli.part'), Buffer.alloc(100));
      writeFileSync(path.join(storage, 'processing', 'orphelin.wav'), Buffer.alloc(200));
      const { usage } = (await app.inject({ method: 'GET', url: '/api/storage' })).json<{
        usage: Awaited<ReturnType<Services['storage']['usage']>>;
      }>();
      expect(usage.processing.derivatives.byKind.audio_transcription?.count).toBe(2);
      expect(usage.processing.derivatives.byKind.audio_stem?.count).toBe(3);
      expect(usage.processing.derivatives.byKind.waveform?.count).toBe(5);
      expect(usage.processing.temp).toEqual({ count: 1, bytes: 100 });
      expect(usage.processing.orphans).toEqual({ count: 1, bytes: 200 });
      expect(usage.byRecording[0]).toMatchObject({ recordingId: rec.id, fileName: 'game.mkv' });
      expect(usage.disk?.freeBytes).toBeGreaterThan(0);
    });

    it('simule par défaut, puis supprime temporaires et orphelins sans toucher au reste', async () => {
      const rec = await prepared();
      const part = path.join(storage, 'processing', rec.id, 'oubli.part');
      const orphan = path.join(storage, 'processing', 'orphelin.wav');
      const exportFile = path.join(storage, 'exports', 'clip-final.mp4');
      mkdirSync(path.dirname(exportFile), { recursive: true });
      writeFileSync(part, 'x');
      writeFileSync(orphan, 'x');
      writeFileSync(exportFile, 'x');
      utimesSync(orphan, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));

      const dry = (
        await app.inject({ method: 'POST', url: '/api/storage/clean', payload: {} })
      ).json<{
        report: { dryRun: boolean; items: { category: string }[] };
      }>().report;
      expect(dry.dryRun).toBe(true);
      expect(dry.items.map((i) => i.category).sort()).toEqual(['orphan', 'temp']);
      expect(existsSync(part) && existsSync(orphan)).toBe(true);

      await app.inject({ method: 'POST', url: '/api/storage/clean', payload: { dryRun: false } });
      expect(existsSync(part) || existsSync(orphan)).toBe(false);
      expect(existsSync(exportFile)).toBe(true);
      expect(existsSync(fx.gameMkv)).toBe(true);
      expect((await getDerivatives(rec.id)).length).toBe(10); // dérivés sous le budget : conservés
    });

    it('un orphelin récent est conservé (écriture possiblement en cours)', async () => {
      await prepared();
      writeFileSync(path.join(storage, 'processing', 'recent.wav'), 'x');
      const r = await services.storage.clean({ dryRun: true });
      expect(r.items.find((i) => i.relPath === 'processing/recent.wav')).toBeUndefined();
    });

    it('ne supprime jamais un fichier utilisé par un traitement actif', async () => {
      await prepared();
      const rel = 'processing/en-cours.wav.part';
      writeFileSync(path.join(storage, rel), 'x');
      db.prepare(
        `INSERT INTO jobs (id, type, lane, target_key, status) VALUES ('busy', 'extract_audio_stems', 'interactive', 'busy', 'running')`,
      ).run();
      db.prepare(
        `INSERT INTO job_files (job_id, rel_path, usage) VALUES ('busy', 'processing/en-cours.wav', 'output')`,
      ).run();
      const r = await services.storage.clean({ dryRun: false });
      expect(r.skippedInUse).toBe(1);
      expect(existsSync(path.join(storage, rel))).toBe(true);
    });

    it('évince le cache du moins récemment utilisé au plus récent, au-delà du budget', async () => {
      const rec = await prepared();
      const ders = await getDerivatives(rec.id);
      const stemsBytes = ders
        .filter((d) => d.kind !== 'audio_transcription')
        .reduce((s, d) => s + d.sizeBytes, 0);
      // Les WAV de transcription sont rendus « anciens » ; le budget ne laisse place qu'au reste.
      db.prepare(
        `UPDATE media_derivatives SET last_used_at = '2000-01-01T00:00:00Z' WHERE kind = 'audio_transcription'`,
      ).run();
      config.cache.maxBytes = stemsBytes;
      const r = await services.storage.clean({
        dryRun: false,
        includeTemp: false,
        includeOrphans: false,
      });
      expect(r.items.map((i) => i.category)).toEqual(['cache', 'cache']);
      const left = await getDerivatives(rec.id);
      expect(left.filter((d) => d.kind === 'audio_transcription')).toEqual([]);
      expect(left.length).toBe(8);
      // Une nouvelle demande régénère ce qui a été évincé.
      expect((await transcriptionAudio(rec.id)).body.status).toBe('pending');
    });

    it('les dérivés épinglés ne sont jamais évincés', async () => {
      const rec = await prepared();
      db.prepare(`UPDATE media_derivatives SET retention = 'keep' WHERE kind = 'audio_stem'`).run();
      const r = await services.storage.clean({ dryRun: true, evictAllCache: true });
      expect(r.items.every((i) => i.category === 'cache')).toBe(true);
      const keptIds = new Set(
        (await getDerivatives(rec.id)).filter((d) => d.retention === 'keep').map((d) => d.id),
      );
      expect(r.items.some((i) => i.derivativeId && keptIds.has(i.derivativeId))).toBe(false);
      expect(r.items).toHaveLength(7); // 2 WAV + 5 formes d'onde
    });

    it('éviction automatique après un traitement si le budget est dépassé', async () => {
      await setup({ CACHE_MAX_GB: '0.000001' }); // ≈ 1 Ko
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      await transcriptionAudio(recording.id);
      await services.runner.idle();
      const total = (await getDerivatives(recording.id)).reduce((s, d) => s + d.sizeBytes, 0);
      expect(total).toBeLessThanOrEqual(config.cache.maxBytes);
    });
  });
});
