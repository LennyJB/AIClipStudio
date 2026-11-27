/**
 * Étape 9, de bout en bout : détection locale des types de contenu (FFmpeg réel, transcription
 * simulée), corrections du créateur, et prise en compte par l'analyse éditoriale (FAUX modèle :
 * aucun appel à Claude API).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeModel, type ModelRequest } from '@acs/editorial';
import { fingerprintFile } from '@acs/media';
import {
  createTalkVideo,
  FFMPEG,
  FFPROBE,
  ffmpegAvailable,
} from '../../../tests/helpers/media-fixtures';
import type { AnalysisRunDto } from './analysis/repository';
import { buildApp } from './app';
import { loadConfig, ROOT_DIR, type AppConfig } from './config';
import type { ContentTypesView } from './content/service';
import { openDatabase, type Db } from './db';
import type { JobDto, RecordingDto } from './recordings/repository';
import type { Services } from './services';

const FAKE_WORKER = fileURLToPath(
  new URL('../../../tests/helpers/fake-whisper-worker.mjs', import.meta.url),
);
const enabled = ffmpegAvailable();
const S = 1000;

/** 3 minutes : une minute de partie, puis deux minutes de discussion avec le chat. */
const MIC = [
  { startMs: 5 * S, endMs: 8 * S, text: 'ils plantent le spike en B' },
  { startMs: 12 * S, endMs: 15 * S, text: 'attends quoi ? mdr' },
  { startMs: 20 * S, endMs: 23 * S, text: 'sérieux ?! mais non je defuse' },
  { startMs: 30 * S, endMs: 33 * S, text: 'on gagne le round' },
  { startMs: 70 * S, endMs: 74 * S, text: 'merci pour le sub les amis' },
  { startMs: 80 * S, endMs: 84 * S, text: 'alors dans le chat quelqu’un demande ma routine' },
  { startMs: 95 * S, endMs: 99 * S, text: 'dites-moi vous en pensez quoi' },
  { startMs: 110 * S, endMs: 114 * S, text: 'mdr non mais la vache cette question !' },
  { startMs: 116 * S, endMs: 119 * S, text: 'ptdr je rigole encore' },
  { startMs: 140 * S, endMs: 144 * S, text: 'merci pour le follow' },
];
const DISCORD = [
  { startMs: 9 * S, endMs: 11 * S, text: 'SECRETDISCORD je suis à B ?' },
  { startMs: 16 * S, endMs: 19 * S, text: 'SECRETBIS rotate rotate' },
];

let video: string;
let app: FastifyInstance;
let services: Services;
let db: Db;
let config: AppConfig;
let model: FakeModel;

const noMoments = (req: ModelRequest) =>
  req.stage === 'triage'
    ? { kind: 'json' as const, value: { moments: [], streamSummary: 'Stream mixte.' } }
    : { kind: 'json' as const, value: { moments: [], noClipReason: 'Rien de notable.' } };

async function setup() {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-ct-'));
  mkdirSync(path.join(storage, 'config'), { recursive: true });
  writeFileSync(
    path.join(storage, 'config', 'privacy.json'),
    JSON.stringify({ schemaVersion: 1, pseudonyms: [] }),
  );
  config = loadConfig(
    {
      NODE_ENV: 'test',
      STORAGE_DIR: storage,
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
      WHISPER_WORKER_COMMAND: JSON.stringify([process.execPath, FAKE_WORKER]),
      ANALYSIS_PRIVACY_FILE: path.join(storage, 'config', 'privacy.json'),
    },
    ROOT_DIR,
  );
  db = openDatabase(':memory:');
  model = new FakeModel(noMoments);
  ({ app, services } = buildApp({ config, db, model }));
}

const call = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const res = await app.inject(
    payload === undefined
      ? { method, url }
      : { method, url, payload: payload as Record<string, unknown> },
  );
  return { status: res.statusCode, body: res.json<T>() };
};

async function importAndTranscribe(gameId = 'valorant'): Promise<RecordingDto> {
  const rec = (
    await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video, gameId })
  ).body.recording;
  await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await services.runner.idle();
  return rec;
}

const view = async (id: string) =>
  (await call<ContentTypesView>('GET', `/api/recordings/${id}/content-types`)).body;

const dryRun = async (id: string) => {
  const r = await call<{ status: string; run: AnalysisRunDto; reused: boolean }>(
    'POST',
    `/api/recordings/${id}/analyses`,
    {},
  );
  await services.runner.idle();
  const run = (await call<{ run: AnalysisRunDto }>('GET', `/api/analyses/${r.body.run.id}`)).body
    .run;
  return { ...r.body, run };
};

let reqN = 0;
const correct = (id: string, segments: unknown, requestId = `correction-${++reqN}`) =>
  call<ContentTypesView & { error?: { code: string } }>(
    'PUT',
    `/api/recordings/${id}/content-types`,
    {
      requestId,
      segments,
    },
  );

describe.skipIf(!enabled)('Étape 9 : types de contenu (FFmpeg réel, aucun appel Claude)', () => {
  beforeAll(() => {
    video = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-ct-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': MIC, '1': DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    db?.close();
  });

  it('détection locale : job « analysis », segments horodatés couvrant tout, limites annoncées, original intact, aucun appel réseau', async () => {
    await setup();
    const rec = await importAndTranscribe();
    expect((await view(rec.id)).effective).toBeNull();
    const fpBefore = (await fingerprintFile(video)).hash;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const r = await call<{ status: string; job: JobDto }>(
      'POST',
      `/api/recordings/${rec.id}/content-types/detect`,
      {},
    );
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({ type: 'detect_content_types', lane: 'analysis' });
    await services.runner.idle();

    const v = await view(rec.id);
    expect(v.detection).toMatchObject({ detectorVersion: 'content-v1', stale: false });
    const segs = v.detection!.detection.segments;
    expect(segs[0]!.startMs).toBe(0);
    expect(segs.at(-1)!.endMs).toBe(v.detection!.detection.durationMs);
    for (const s of segs) {
      expect(['gaming', 'just_chatting', 'reaction', 'podcast', 'irl', 'unknown']).toContain(
        s.type,
      );
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(0.9);
    }
    // Vidéo de test : image fixe à 2 i/s, très peu d'images clés ⇒ limite explicite.
    expect(v.detection!.detection.limits.join(' ')).toMatch(/image/u);
    expect(v.effective?.source).toBe('auto');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
    expect((await fingerprintFile(video)).hash).toBe(fpBefore);

    // Même entrée : réutilisée (200), sauf `force`.
    const again = await call<{ status: string }>(
      'POST',
      `/api/recordings/${rec.id}/content-types/detect`,
      {},
    );
    expect(again).toMatchObject({ status: 200, body: { status: 'ready' } });
    const forced = await call('POST', `/api/recordings/${rec.id}/content-types/detect`, {
      force: true,
    });
    expect(forced.status).toBe(202);
    await services.runner.idle();
    expect((await view(rec.id)).detection!.id).toBe(v.detection!.id + 1);
  });

  it('sans transcription : refus explicite (aucune conclusion inventée)', async () => {
    await setup();
    const rec = (
      await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video })
    ).body.recording;
    const r = await call<{ error: { code: string } }>(
      'POST',
      `/api/recordings/${rec.id}/content-types/detect`,
      {},
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ANALYSIS_NOT_READY');
  });

  it('corrections : validées, la correction l’emporte, idempotentes, retour à l’automatique, historique conservé', async () => {
    await setup();
    const rec = await importAndTranscribe();
    await call('POST', `/api/recordings/${rec.id}/content-types/detect`, {});
    await services.runner.idle();
    const duration = (await view(rec.id)).durationMs!;

    // Trou : refus.
    const gap = await correct(rec.id, [
      { startMs: 0, endMs: 50 * S, type: 'gaming' },
      { startMs: 60 * S, endMs: duration, type: 'just_chatting' },
    ]);
    expect(gap.status).toBe(400);
    // Type inconnu : refus par le schéma.
    expect((await correct(rec.id, [{ startMs: 0, endMs: duration, type: 'mixte' }])).status).toBe(
      400,
    );

    const body = [
      { startMs: 0, endMs: 60 * S, type: 'gaming' },
      { startMs: 60 * S, endMs: duration, type: 'just_chatting' },
    ];
    const ok = await correct(rec.id, body, 'correction-fixe-1');
    expect(ok.status).toBe(200);
    expect(ok.body.effective).toMatchObject({
      source: 'manual',
      summary: { kind: 'mixed' },
      segments: [
        { startMs: 0, endMs: 60 * S, type: 'gaming', confidence: 1, source: 'manual' },
        {
          startMs: 60 * S,
          endMs: duration,
          type: 'just_chatting',
          confidence: 1,
          source: 'manual',
        },
      ],
    });
    // Même requête : sans effet ; même identifiant pour un autre contenu : refus.
    expect((await correct(rec.id, body, 'correction-fixe-1')).status).toBe(200);
    const mismatch = await correct(
      rec.id,
      [{ startMs: 0, endMs: duration, type: 'irl' }],
      'correction-fixe-1',
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error?.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(services.contentTypes.repo.listCorrections(rec.id)).toHaveLength(1);

    // Une nouvelle détection ne remplace PAS la correction.
    await call('POST', `/api/recordings/${rec.id}/content-types/detect`, { force: true });
    await services.runner.idle();
    expect((await view(rec.id)).effective?.source).toBe('manual');

    // Retour explicite à la détection automatique ; l'historique reste.
    const reset = await correct(rec.id, null);
    expect(reset.body.effective?.source).toBe('auto');
    expect(services.contentTypes.repo.listCorrections(rec.id)).toHaveLength(2);
  });

  it('gaming : sans segmentation ou entièrement gaming, analyse STRICTEMENT identique (même clé, réutilisée)', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const before = await dryRun(rec.id);
    expect(before.run.status).toBe('completed');
    await call('POST', `/api/recordings/${rec.id}/content-types/detect`, {});
    await services.runner.idle();
    await correct(rec.id, [
      { startMs: 0, endMs: (await view(rec.id)).durationMs!, type: 'gaming' },
    ]);
    const after = await dryRun(rec.id);
    expect(after).toMatchObject({ status: 'ready', reused: true });
    expect(after.run.id).toBe(before.run.id);
    expect(after.run.inputKey).toBe(before.run.inputKey);
  });

  it('stream mixte corrigé : nouvelle clé, critères par passage et contexte de format dans les requêtes (faux modèle)', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const before = await dryRun(rec.id);
    await call('POST', `/api/recordings/${rec.id}/content-types/detect`, {});
    await services.runner.idle();
    const duration = (await view(rec.id)).durationMs!;
    await correct(rec.id, [
      { startMs: 0, endMs: 60 * S, type: 'gaming' },
      { startMs: 60 * S, endMs: duration, type: 'just_chatting' },
    ]);
    const after = await dryRun(rec.id);
    expect(after.reused).toBe(false);
    expect(after.run.inputKey).not.toBe(before.run.inputKey);

    // Analyse « claude » avec le faux modèle : les requêtes enregistrées à la préparation et
    // celles réellement envoyées sont identiques (sinon la reprise refuserait : CONFLICT).
    const r = await call<{ run: AnalysisRunDto }>('POST', `/api/recordings/${rec.id}/analyses`, {
      mode: 'claude',
      acceptBudgetUsd: config.analysis.maxCostUsd,
      review: false,
    });
    expect(r.status).toBeLessThan(300);
    await services.runner.idle();
    const run = (await call<{ run: AnalysisRunDto }>('GET', `/api/analyses/${r.body.run.id}`)).body
      .run;
    expect(run.status).toBe('completed');

    const triage = model.calls.filter((c) => c.stage === 'triage');
    const deep = model.calls.filter((c) => c.stage === 'deep');
    expect(triage.length).toBeGreaterThan(0);
    expect(deep.length).toBeGreaterThan(0);
    const all = model.calls.map((c) => c.userText).join('\n');
    expect(all).toContain('Type de contenu de ce passage');
    expect(all).toContain('jamais une preuve');
    expect(triage[0]!.userText).toContain('Just Chatting (confirmé par le créateur)');
    expect(triage[0]!.userText).toContain('Gaming (confirmé par le créateur)');
    // Le passage Just Chatting reçoit les critères de son format ; le passage de jeu, non.
    const chat = deep.find((c) => c.userText.includes('merci pour le sub'));
    const game = deep.find((c) => c.userText.includes('je defuse'));
    expect(chat?.userText).toContain('Just Chatting (confirmé par le créateur)');
    expect(chat?.userText).toContain('Format Just Chatting');
    expect(game?.userText).toContain('Gaming (confirmé par le créateur)');
    expect(game?.userText).not.toContain('Format Just Chatting');
    // Prompts système inchangés (mis en cache), confidentialité Discord préservée.
    expect(all).not.toMatch(/SECRETDISCORD|SECRETBIS/u);
    for (const c of model.calls) expect(c.system).not.toContain('Just Chatting');
  });
});
