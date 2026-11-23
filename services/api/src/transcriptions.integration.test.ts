import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createFixtures,
  FFMPEG,
  FFPROBE,
  ffmpegAvailable,
  type Fixtures,
} from '../../../tests/helpers/media-fixtures';
import { buildApp } from './app';
import { loadConfig, ROOT_DIR, type AppConfig } from './config';
import { openDatabase, type Db } from './db';
import type { JobDto, RecordingDto } from './recordings/repository';
import type { Services } from './services';
import type { SegmentDto, TranscriptionDto } from './transcriptions/repository';
import type { TranscriptionRequestResult } from './transcriptions/service';

const FAKE_WORKER = fileURLToPath(
  new URL('../../../tests/helpers/fake-whisper-worker.mjs', import.meta.url),
);
const enabled = ffmpegAvailable();
const MIN = 60_000;

let fx: Fixtures;
let app: FastifyInstance;
let services: Services;
let db: Db;
let config: AppConfig;
let logFile: string;

interface Scenario {
  tracks?: Record<
    string,
    { startMs: number; endMs: number; text: string; noSpeechProb?: number; avgLogprob?: number }[]
  >;
  language?: string;
  cuda?: boolean;
  jitterMs?: number;
  delayMs?: number;
  loadFailsOnCuda?: string;
  crashOnCudaLoad?: boolean;
  inferenceFailsOnCudaAtRequest?: number;
  crashAtRequest?: number;
  crashMarker?: string;
}

function scenario(s: Scenario) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acs-fake-'));
  logFile = path.join(dir, 'commands.jsonl');
  process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({ language: 'fr', ...s, logFile });
  return dir;
}

const commands = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

async function setup(env: NodeJS.ProcessEnv = {}, rootDir = ROOT_DIR, existingDb?: Db) {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-tr-'));
  config = loadConfig(
    {
      NODE_ENV: 'test',
      STORAGE_DIR: storage,
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
      WHISPER_WORKER_COMMAND: JSON.stringify([process.execPath, FAKE_WORKER]),
      ...env,
    },
    rootDir,
  );
  db = existingDb ?? openDatabase(':memory:');
  ({ app, services } = buildApp({ config, db }));
}

const importFile = async (file: string) =>
  (await app.inject({ method: 'POST', url: '/api/recordings', payload: { path: file } })).json<{
    recording: RecordingDto;
  }>().recording;

async function transcribe(id: string, body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/recordings/${id}/transcriptions`,
    payload: body,
  });
  return {
    status: res.statusCode,
    body: res.json<TranscriptionRequestResult & { error?: { code: string } }>(),
  };
}

const getJob = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/jobs/${id}` })).json<{ job: JobDto }>().job;

const list = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/api/recordings/${id}/transcriptions` })).json<{
    transcriptions: TranscriptionDto[];
    comparisons: { audioIndex: number; transcriptions: TranscriptionDto[]; sameDevices: boolean }[];
  }>();

const transcript = async (id: string, query = '') =>
  (await app.inject({ method: 'GET', url: `/api/recordings/${id}/transcript${query}` })).json<{
    transcriptions: TranscriptionDto[];
    segments: SegmentDto[];
  }>();

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('délai dépassé');
}

/** Phrases centrées sur chaque frontière de bloc (toutes les 10 min) + phrases ordinaires. */
function boundaryPhrases() {
  const out = [];
  for (let m = 10; m < 60; m += 10) {
    out.push({
      startMs: m * MIN - 3_000,
      endMs: m * MIN + 3_000,
      text: `frontiere ${m} phrase complete`,
    });
    out.push({
      startMs: m * MIN - 300_000,
      endMs: m * MIN - 296_000,
      text: `milieu ${m} rien de special`,
    });
  }
  return out;
}

describe.skipIf(!enabled)('Transcription (worker simulé)', () => {
  beforeAll(() => {
    fx = createFixtures();
  }, 120_000);

  afterEach(async () => {
    await app?.close();
    db?.close();
    delete process.env.FAKE_WHISPER_SCENARIO;
  });

  it('transcrit micro et Discord séparément, en temps source, par ordre chronologique', async () => {
    scenario({
      cuda: true,
      tracks: {
        '1': [
          { startMs: 500, endMs: 1_800, text: 'Bon on rush B' },
          { startMs: 3_200, endMs: 4_100, text: 'Non mais attends' },
        ],
        '2': [{ startMs: 2_000, endMs: 3_000, text: 'Il est derrière toi' }],
      },
    });
    await setup();
    const rec = await importFile(fx.obsMkv);
    const first = await transcribe(rec.id);
    expect(first.status).toBe(202);
    expect(first.body.transcriptions.map((t) => t.audioIndex)).toEqual([1, 2]);
    expect(first.body.job).toMatchObject({ type: 'transcribe_recording', lane: 'heavy' });
    await services.runner.idle();
    expect(await getJob(first.body.job!.id)).toMatchObject({ status: 'succeeded', progress: 1 });

    const { transcriptions } = await list(rec.id);
    for (const t of transcriptions) {
      expect(t).toMatchObject({
        status: 'completed',
        model: 'large-v3-turbo',
        language: 'fr',
        languageSource: 'detected',
        devicesUsed: ['cuda'],
        fallbackError: null,
      });
      expect(t.checkpointMs).toBe(t.audioDurationMs);
      expect(t.realtimeFactor).toBeGreaterThan(0);
    }
    const { segments } = await transcript(rec.id);
    expect(segments.map((s) => [s.srcStartMs, s.srcEndMs, s.role, s.text])).toEqual([
      [500, 1_800, 'mic', 'Bon on rush B'],
      [2_000, 3_000, 'discord', 'Il est derrière toi'],
      [3_200, 4_100, 'mic', 'Non mais attends'],
    ]);
    // Mots horodatés en temps source, à l'intérieur de leur segment.
    for (const s of segments) {
      expect(s.words.length).toBeGreaterThan(0);
      for (const w of s.words) {
        expect(w.startMs).toBeGreaterThanOrEqual(s.srcStartMs);
        expect(w.endMs).toBeLessThanOrEqual(s.srcEndMs);
      }
    }
    // Métriques brutes conservées ; score de suspicion nommé comme tel ; aucun champ « confidence ».
    expect(segments[0]).toMatchObject({
      avgLogprob: -0.25,
      noSpeechProb: 0.02,
      compressionRatio: 1.3,
      suspicionScore: 0,
    });
    expect(Object.keys(segments[0]!)).not.toContain('confidence');
    // Le worker a lu le WAV dérivé (jamais l'original), avec les réglages par défaut.
    const init = commands().find((c) => c.cmd === 'init')!;
    expect(init).toMatchObject({
      model: 'large-v3-turbo',
      device: 'auto',
      wordTimestamps: true,
      hotwords: null,
    });
    for (const c of commands().filter((x) => x.cmd === 'transcribe')) {
      expect(String(c.wavPath)).toMatch(/processing[\\/].+[\\/]transcription[\\/].+-a\d\.wav$/);
      expect(c.wavPath).not.toBe(fx.obsMkv);
    }
  });

  it('ne retranscrit pas une piste déjà traitée avec les mêmes paramètres ; force relance', async () => {
    scenario({ tracks: { '1': [{ startMs: 500, endMs: 1_000, text: 'salut' }] } });
    await setup();
    const rec = await importFile(fx.obsMkv);
    await transcribe(rec.id);
    await services.runner.idle();
    const blocksBefore = commands().filter((c) => c.cmd === 'transcribe').length;
    const again = await transcribe(rec.id);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'ready', job: null });
    expect(commands().filter((c) => c.cmd === 'transcribe')).toHaveLength(blocksBefore);
    const forced = await transcribe(rec.id, { force: true });
    expect(forced.status).toBe(202);
    await services.runner.idle();
    expect((await list(rec.id)).transcriptions).toHaveLength(4);
  });

  it('deux demandes identiques simultanées partagent le même traitement', async () => {
    scenario({ delayMs: 50, tracks: {} });
    await setup();
    const rec = await importFile(fx.obsMkv);
    const a = await transcribe(rec.id);
    const b = await transcribe(rec.id);
    expect(b.body.job!.id).toBe(a.body.job!.id);
    expect(b.body.transcriptions.map((t) => t.id)).toEqual(a.body.transcriptions.map((t) => t.id));
    await services.runner.idle();
    expect((await list(rec.id)).transcriptions).toHaveLength(2);
  });

  it('frontières de blocs : chaque phrase une seule fois malgré les décalages (60 min, blocs de 10 min)', async () => {
    const phrases = boundaryPhrases();
    scenario({ jitterMs: 300, tracks: { '0': phrases } });
    await setup({ WHISPER_CHUNK_SEC: '600' });
    const rec = await importFile(fx.longMkv);
    await transcribe(rec.id);
    await services.runner.idle();
    const { segments, transcriptions } = await transcript(rec.id);
    expect(transcriptions[0]).toMatchObject({ status: 'completed', checkpointMs: 60 * MIN });
    for (const p of phrases)
      expect(
        segments.filter((s) => s.text === p.text),
        p.text,
      ).toHaveLength(1);
    expect(segments.filter((s) => s.text.includes('(coupé)'))).toEqual([]);
    const blocks = db
      .prepare('SELECT core_start_ms FROM transcription_blocks ORDER BY core_start_ms')
      .all();
    expect(blocks).toHaveLength(6);
    // Les fenêtres lues se chevauchent de 30 s de part et d'autre de chaque zone centrale.
    const reads = commands()
      .filter((c) => c.cmd === 'transcribe')
      .map((c) => [c.startMs, c.endMs]);
    expect(reads[1]).toEqual([10 * MIN - 30_000, 20 * MIN + 30_000]);
  });

  it('reprise après un arrêt brutal du worker : repart du checkpoint, ni perte ni doublon', async () => {
    const phrases = boundaryPhrases();
    const dir = scenario({ jitterMs: 200, crashAtRequest: 3, tracks: { '0': phrases } });
    scenario({
      jitterMs: 200,
      crashAtRequest: 3,
      crashMarker: path.join(dir, 'crashed'),
      tracks: { '0': phrases },
    });
    await setup({ WHISPER_CHUNK_SEC: '600', WHISPER_DEVICE: 'cpu' });
    const rec = await importFile(fx.longMkv);
    const first = await transcribe(rec.id);
    await services.runner.idle();
    expect(await getJob(first.body.job!.id)).toMatchObject({
      status: 'failed',
      error: { code: 'TRANSCRIPTION_WORKER_CRASHED' },
    });
    const failed = (await list(rec.id)).transcriptions[0]!;
    expect(failed).toMatchObject({ status: 'failed', checkpointMs: 20 * MIN }); // 2 blocs enregistrés
    const segmentsAfterCrash = (await transcript(rec.id)).segments.length;

    const resumed = await transcribe(rec.id);
    expect(resumed.body.transcriptions[0]!.id).toBe(failed.id); // même transcription, reprise
    await services.runner.idle();
    const after = (await list(rec.id)).transcriptions[0]!;
    expect(after).toMatchObject({ status: 'completed', checkpointMs: 60 * MIN });
    const { segments } = await transcript(rec.id);
    expect(segments.length).toBeGreaterThan(segmentsAfterCrash);
    for (const p of phrases)
      expect(
        segments.filter((s) => s.text === p.text),
        p.text,
      ).toHaveLength(1);
    // Le second worker a repris au checkpoint (20 min − 30 s de chevauchement), pas au début.
    const inits = commands()
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.cmd === 'init');
    const secondRunFirstRead = commands()
      .slice(inits[1]![1])
      .find((c) => c.cmd === 'transcribe')!;
    expect(secondRunFirstRead.startMs).toBe(20 * MIN - 30_000);
  });

  it('annulation pendant la transcription : checkpoint conservé, puis reprise', async () => {
    scenario({ delayMs: 150, tracks: { '0': boundaryPhrases() } });
    await setup({ WHISPER_CHUNK_SEC: '600' });
    const rec = await importFile(fx.longMkv);
    const first = await transcribe(rec.id);
    await waitFor(
      async () => ((await list(rec.id)).transcriptions[0]?.checkpointMs ?? 0) >= 10 * MIN,
    );
    await app.inject({ method: 'POST', url: `/api/jobs/${first.body.job!.id}/cancel` });
    await services.runner.idle();
    const cancelled = (await list(rec.id)).transcriptions[0]!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.checkpointMs).toBeGreaterThanOrEqual(10 * MIN);
    expect(cancelled.checkpointMs).toBeLessThan(60 * MIN);
    await transcribe(rec.id);
    await services.runner.idle();
    expect((await list(rec.id)).transcriptions[0]).toMatchObject({
      id: cancelled.id,
      status: 'completed',
    });
  });

  it('arrêt du serveur : transcription interrompue, reprise au redémarrage', async () => {
    scenario({ delayMs: 150, tracks: { '0': boundaryPhrases() } });
    await setup({ WHISPER_CHUNK_SEC: '600' });
    const rec = await importFile(fx.longMkv);
    await transcribe(rec.id);
    await waitFor(
      async () => ((await list(rec.id)).transcriptions[0]?.checkpointMs ?? 0) >= 10 * MIN,
    );
    await app.close();
    const row = db.prepare('SELECT status, checkpoint_ms FROM transcriptions').get() as {
      status: string;
      checkpoint_ms: number;
    };
    expect(row.status).toBe('interrupted');
    // Redémarrage sur la même base.
    await setup({ WHISPER_CHUNK_SEC: '600' }, ROOT_DIR, db);
    const res = await transcribe(rec.id);
    expect(res.status).toBe(202);
    await services.runner.idle();
    expect((await list(rec.id)).transcriptions[0]).toMatchObject({
      status: 'completed',
      checkpointMs: 60 * MIN,
    });
  });

  describe('GPU et CPU', () => {
    it('échec CUDA pendant l’inférence : repli CPU visible, jamais présenté comme GPU', async () => {
      scenario({
        cuda: true,
        inferenceFailsOnCudaAtRequest: 1,
        tracks: { '1': [{ startMs: 500, endMs: 900, text: 'ok' }] },
      });
      await setup();
      const rec = await importFile(fx.obsMkv);
      await transcribe(rec.id);
      await services.runner.idle();
      const [mic, discord] = (await list(rec.id)).transcriptions.sort(
        (a, b) => a.audioIndex - b.audioIndex,
      );
      // Pistes traitées dans l'ordre : le micro (piste 2) a subi le repli au 1er bloc.
      expect(mic).toMatchObject({ status: 'completed', devicesUsed: ['cpu'] });
      expect(mic!.fallbackError).toMatch(/cudnn/);
      expect(discord).toMatchObject({ status: 'completed', devicesUsed: ['cpu'] }); // worker resté sur CPU
      const blocks = db.prepare('SELECT device, compute_type FROM transcription_blocks').all();
      expect(blocks).toEqual([
        { device: 'cpu', compute_type: 'int8' },
        { device: 'cpu', compute_type: 'int8' },
      ]);
    });

    it('arrêt brutal au chargement CUDA (DLL cuDNN) : relance sur CPU', async () => {
      scenario({ cuda: true, crashOnCudaLoad: true, tracks: {} });
      await setup();
      const rec = await importFile(fx.obsMkv);
      const res = await transcribe(rec.id);
      await services.runner.idle();
      expect(await getJob(res.body.job!.id)).toMatchObject({ status: 'succeeded' });
      const t = (await list(rec.id)).transcriptions[0]!;
      expect(t.devicesUsed).toEqual(['cpu']);
      expect(t.fallbackError).toMatch(/cudnn_ops64_9/);
    });

    it('repli interdit : l’échec CUDA fait échouer la transcription, explicitement', async () => {
      scenario({ cuda: true, loadFailsOnCuda: 'Library cublas64_12.dll is not found', tracks: {} });
      await setup({ WHISPER_DEVICE: 'cuda', WHISPER_CPU_FALLBACK: 'false' });
      const rec = await importFile(fx.obsMkv);
      const res = await transcribe(rec.id);
      await services.runner.idle();
      expect(await getJob(res.body.job!.id)).toMatchObject({
        status: 'failed',
        error: {
          code: 'TRANSCRIPTION_GPU_UNAVAILABLE',
          message: expect.stringContaining('cublas64_12'),
        },
      });
      for (const t of (await list(rec.id)).transcriptions) {
        expect(t).toMatchObject({
          status: 'failed',
          devicesUsed: [],
          error: { code: 'TRANSCRIPTION_GPU_UNAVAILABLE' },
        });
      }
    });

    it('sans GPU, auto choisit le CPU sans le présenter comme un repli', async () => {
      scenario({ cuda: false, tracks: { '1': [{ startMs: 100, endMs: 600, text: 'cpu' }] } });
      await setup();
      const rec = await importFile(fx.obsMkv);
      await transcribe(rec.id);
      await services.runner.idle();
      expect((await list(rec.id)).transcriptions[0]).toMatchObject({
        devicesUsed: ['cpu'],
        fallbackError: null,
      });
    });
  });

  it('langue imposée : transmise au worker et marquée comme imposée', async () => {
    scenario({ tracks: { '1': [{ startMs: 100, endMs: 600, text: 'hello' }] } });
    await setup({ WHISPER_LANGUAGE: 'en' });
    const rec = await importFile(fx.obsMkv);
    await transcribe(rec.id);
    await services.runner.idle();
    expect(
      commands()
        .filter((c) => c.cmd === 'transcribe')
        .every((c) => c.language === 'en'),
    ).toBe(true);
    expect((await list(rec.id)).transcriptions[0]).toMatchObject({
      language: 'en',
      languageSource: 'forced',
    });
  });

  it('langue détectée au premier bloc parlant puis imposée aux blocs suivants', async () => {
    scenario({
      tracks: {
        '0': [{ startMs: 15 * MIN, endMs: 15 * MIN + 2_000, text: 'enfin quelqu un parle' }],
      },
    });
    await setup({ WHISPER_CHUNK_SEC: '600' });
    const rec = await importFile(fx.longMkv);
    await transcribe(rec.id);
    await services.runner.idle();
    const langs = commands()
      .filter((c) => c.cmd === 'transcribe')
      .map((c) => c.language);
    expect(langs).toEqual([null, null, 'fr', 'fr', 'fr', 'fr']); // bloc 1 silencieux, bloc 2 détecte
  });

  it('segments suspects signalés (hallucination connue, absence de parole), jamais supprimés', async () => {
    scenario({
      tracks: {
        '1': [
          {
            startMs: 100,
            endMs: 1_500,
            text: "Sous-titres réalisés par la communauté d'Amara.org",
          },
          { startMs: 2_000, endMs: 2_500, text: 'euh', noSpeechProb: 0.9, avgLogprob: -1.6 },
          { startMs: 3_000, endMs: 3_800, text: 'vraie phrase' },
        ],
      },
    });
    await setup();
    const rec = await importFile(fx.obsMkv);
    await transcribe(rec.id);
    await services.runner.idle();
    const { segments } = await transcript(rec.id, '?audioIndex=1');
    expect(segments.map((s) => s.suspicionReasons)).toEqual([
      ['known_hallucination'],
      ['no_speech'],
      [],
    ]);
    expect(segments[0]!.suspicionScore).toBeGreaterThan(0);
    expect(segments[2]!.suspicionScore).toBe(0);
  });

  it('comparaison des modèles : même audio et mêmes paramètres, métriques et deux transcriptions', async () => {
    scenario({ tracks: { '1': [{ startMs: 500, endMs: 1_000, text: 'comparaison' }] } });
    await setup();
    const rec = await importFile(fx.obsMkv);
    await transcribe(rec.id, { model: 'large-v3-turbo' });
    await services.runner.idle();
    await transcribe(rec.id, { model: 'large-v3' });
    await services.runner.idle();
    const { comparisons } = await list(rec.id);
    expect(comparisons.map((c) => c.audioIndex).sort()).toEqual([1, 2]);
    for (const g of comparisons) {
      expect(g.transcriptions.map((t) => t.model).sort()).toEqual(['large-v3', 'large-v3-turbo']);
      expect(g.sameDevices).toBe(true);
      for (const t of g.transcriptions) {
        expect(t.devicesUsed.length).toBeGreaterThan(0);
        expect(t.processingMs).toBeGreaterThan(0);
        expect(t.realtimeFactor).toBeGreaterThan(0);
        expect(typeof t.segmentCount).toBe('number');
      }
    }
    const v3 = comparisons[0]!.transcriptions.find((t) => t.model === 'large-v3')!;
    const byIds = await transcript(rec.id, `?transcriptionIds=${v3.id}`);
    expect(byIds.transcriptions.map((t) => t.model)).toEqual(['large-v3']);
    const byModel = await transcript(rec.id, '?model=large-v3');
    expect(byModel.transcriptions.every((t) => t.model === 'large-v3')).toBe(true);
    expect((await transcribe(rec.id, { model: 'tiny' })).body).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('comparaison : un modèle sur GPU, l’autre sur CPU → signalé comme non comparable', async () => {
    scenario({ cuda: true, tracks: { '1': [{ startMs: 500, endMs: 1_000, text: 'gpu' }] } });
    await setup();
    const rec = await importFile(fx.obsMkv);
    await transcribe(rec.id, { model: 'large-v3-turbo' }); // GPU disponible : CUDA
    await services.runner.idle();
    scenario({ cuda: false, tracks: { '1': [{ startMs: 500, endMs: 1_000, text: 'cpu' }] } });
    await transcribe(rec.id, { model: 'large-v3' }); // plus de GPU : CPU
    await services.runner.idle();

    const { comparisons } = await list(rec.id);
    expect(comparisons).toHaveLength(2);
    for (const g of comparisons) {
      const devices = Object.fromEntries(g.transcriptions.map((t) => [t.model, t.devicesUsed]));
      expect(devices).toEqual({ 'large-v3-turbo': ['cuda'], 'large-v3': ['cpu'] });
      expect(g.sameDevices).toBe(false);
    }
  });

  it('réutilise le WAV dérivé existant et ne le supprime pas après transcription', async () => {
    scenario({ tracks: {} });
    await setup();
    const rec = await importFile(fx.obsMkv);
    await app.inject({ method: 'POST', url: `/api/recordings/${rec.id}/transcription-audio` });
    await services.runner.idle();
    const before = services.derivatives.repo
      .listForRecording(rec.id)
      .filter((d) => d.kind === 'audio_transcription');
    await transcribe(rec.id);
    await services.runner.idle();
    const after = services.derivatives.repo
      .listForRecording(rec.id)
      .filter((d) => d.kind === 'audio_transcription');
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id)); // pas de réextraction
    for (const d of after)
      expect(existsSync(path.join(config.paths.storage, d.relPath))).toBe(true);
  });

  it('vocabulaire du jeu : désactivé par défaut, transmis seulement si le profil l’active', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'acs-root-'));
    cpSync(path.join(ROOT_DIR, 'profiles'), path.join(root, 'profiles'), { recursive: true });
    const valorant = path.join(root, 'profiles', 'games', 'valorant.json');
    const profile = JSON.parse(readFileSync(valorant, 'utf8'));
    profile.transcription = { useVocabulary: true, extraTerms: ['Kakashi'] };
    writeFileSync(valorant, JSON.stringify(profile));

    scenario({ tracks: {} });
    await setup({}, root);
    const recValo = (
      await app.inject({
        method: 'POST',
        url: '/api/recordings',
        payload: { path: fx.obsMkv, gameId: 'valorant' },
      })
    ).json<{ recording: RecordingDto }>().recording;
    await transcribe(recValo.id);
    await services.runner.idle();
    const init = commands().find((c) => c.cmd === 'init')!;
    expect(init.hotwords).toContain('spike');
    expect(init.hotwords).toContain('Kakashi');
    rmSync(root, { recursive: true, force: true });
  });

  it('refuse un corps invalide et un enregistrement inconnu', async () => {
    scenario({ tracks: {} });
    await setup();
    const rec = await importFile(fx.obsMkv);
    expect((await transcribe(rec.id, { language: 'français' })).body).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect((await transcribe(rec.id, { gpu: true })).body).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect((await transcribe('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});
