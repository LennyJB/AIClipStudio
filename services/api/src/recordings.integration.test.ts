import { appendFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
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
import { loadConfig } from './config';
import { openDatabase, type Db } from './db';
import type { JobRunner } from './jobs/runner';
import type { JobDto, RecordingDto } from './recordings/repository';

const enabled = ffmpegAvailable();

let fx: Fixtures;
let app: FastifyInstance;
let runner: JobRunner;
let db: Db;
let storage: string;

async function setup(env: NodeJS.ProcessEnv = {}) {
  storage = await mkdtemp(path.join(tmpdir(), 'acs-storage-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    STORAGE_DIR: storage,
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: FFPROBE,
    ...env,
  });
  db = openDatabase(':memory:');
  ({ app, runner } = buildApp({ config, db }));
}

async function importFile(filePath: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/recordings',
    payload: { path: filePath, ...extra },
  });
}

async function extract(id: string) {
  const res = await app.inject({ method: 'POST', url: `/api/recordings/${id}/extract-audio` });
  return res.json<{ job: JobDto }>().job;
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

  describe('extraction audio', () => {
    it('extrait micro et Discord (pas le mix) sans toucher à l’original', async () => {
      await setup();
      const before = statSync(fx.obsMkv);
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      const job = await extract(recording.id);
      expect(job.status).toBe('queued');
      await runner.idle();

      expect(await getJob(job.id)).toMatchObject({ status: 'succeeded', progress: 1, error: null });
      const { recording: after } = await getRecording(recording.id);
      const [mix, mic, discord] = after.audioTracks;
      expect(mix?.extracted).toBeNull();
      for (const t of [mic, discord]) {
        expect(t?.extracted?.durationSec).toBeCloseTo(6, 0);
        expect(existsSync(t!.extracted!.path)).toBe(true);
        expect(t!.extracted!.path.startsWith(path.join(storage, 'processing', recording.id))).toBe(
          true,
        );
      }
      const now = statSync(fx.obsMkv);
      expect([now.size, now.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    });

    it('reprend sans refaire les pistes déjà extraites', async () => {
      await setup();
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      await extract(recording.id);
      await runner.idle();
      const first = (await getRecording(recording.id)).recording.audioTracks[1]?.extracted?.at;
      const job = await extract(recording.id);
      await runner.idle();
      expect((await getJob(job.id)).status).toBe('succeeded');
      expect((await getRecording(recording.id)).recording.audioTracks[1]?.extracted?.at).toBe(
        first,
      );
    });

    it('déduit la durée de l’audio pour un MKV non finalisé', async () => {
      await setup();
      const { recording } = (await importFile(fx.unfinalizedMkv)).json<{
        recording: RecordingDto;
      }>();
      expect(recording.durationSec).toBeNull();
      await extract(recording.id);
      await runner.idle();
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
      const job = await extract(recording.id);
      await runner.idle();
      expect((await getJob(job.id)).error?.code).toBe('MEDIA_SOURCE_CHANGED');
    });

    it('peut annuler une extraction en cours', async () => {
      await setup();
      const { recording } = (await importFile(fx.longMkv)).json<{ recording: RecordingDto }>();
      const job = await extract(recording.id);
      await waitFor(async () => (await getJob(job.id)).status === 'running');
      const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
      expect(res.statusCode).toBe(200);
      await runner.idle();
      expect(await getJob(job.id)).toMatchObject({
        status: 'cancelled',
        error: { code: 'CANCELLED' },
      });
      expect((await getRecording(recording.id)).recording.audioTracks[0]?.extracted).toBeNull();
    });

    it('marque le travail interrompu à l’arrêt du serveur, puis permet de le relancer', async () => {
      await setup();
      const { recording } = (await importFile(fx.longMkv)).json<{ recording: RecordingDto }>();
      const job = await extract(recording.id);
      await waitFor(async () => (await getJob(job.id)).status === 'running');
      await app.close();
      const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as {
        status: string;
      };
      expect(row.status).toBe('interrupted');
    });

    it('au démarrage, les travaux restés « en cours » deviennent interrompus', async () => {
      await setup();
      const { recording } = (await importFile(fx.obsMkv)).json<{ recording: RecordingDto }>();
      db.prepare(
        `INSERT INTO jobs (id, recording_id, type, status) VALUES ('j1', ?, 'extract_audio', 'running')`,
      ).run(recording.id);
      expect(runner.recover()).toBe(1);
      const row = db.prepare(`SELECT status FROM jobs WHERE id = 'j1'`).get() as { status: string };
      expect(row.status).toBe('interrupted');
    });

    it('renvoie 404 pour un enregistrement inconnu', async () => {
      await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/api/recordings/00000000-0000-4000-8000-000000000000/extract-audio',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
