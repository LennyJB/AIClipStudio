/**
 * Médias de travail de l'éditeur par l'API (étape 7d, docs/plan-etape-7.md §5.2) : FFmpeg réel,
 * transcription simulée, faux modèle (aucun appel à Claude), base SQLite sur fichier.
 *
 *  - préparation : proxy, vignettes MASQUÉES, pistes autorisées ET activées seulement, baux ;
 *  - nettoyage jamais pendant un bail, possible après sa fin ;
 *  - sécurité du proxy : UN test par contrôle (adresse du socket, `Host`, `Origin`,
 *    `Sec-Fetch-Site`, corps JSON, jeton, CORS, en-têtes, journaux), avec `app.inject`
 *    (option `remoteAddress`) puis un serveur réel derrière le VRAI proxy de Vite
 *    (`apps/web/vite.config.ts`, `changeOrigin: false`), sans navigateur (décision du créateur :
 *    le même scénario avec Chromium arrive en 7e, avec Playwright).
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeModel } from '@acs/editorial';
import {
  SCENARIO_DISCORD,
  SCENARIO_MIC,
  scenarioScript,
} from '../../../tests/helpers/claude-scenario';
import {
  createTalkVideo,
  FFMPEG,
  FFPROBE,
  ffmpegAvailable,
} from '../../../tests/helpers/media-fixtures';
import { buildApp } from './app';
import { loadConfig, ROOT_DIR, type AppConfig } from './config';
import { openDatabase, type Db } from './db';
import { loggerOptions } from './logger';
import type { RecordingDto } from './recordings/repository';
import type { Services } from './services';

const FAKE_WORKER = fileURLToPath(
  new URL('../../../tests/helpers/fake-whisper-worker.mjs', import.meta.url),
);
const VITE_CONFIG = fileURLToPath(new URL('../../../apps/web/vite.config.ts', import.meta.url));
const enabled = ffmpegAvailable();

let master: string;
let config: AppConfig;
const apps: FastifyInstance[] = [];
const ORIGIN = 'http://127.0.0.1:5173';
const HOST = '127.0.0.1:5173';

interface Instance {
  app: FastifyInstance;
  services: Services;
  db: Db;
}

async function setup(
  env: Record<string, string> = {},
  onBuild?: (app: FastifyInstance) => void,
): Promise<{ video: string; inst: Instance }> {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-medias-editeur-'));
  mkdirSync(path.join(storage, 'config'), { recursive: true });
  writeFileSync(
    path.join(storage, 'config', 'privacy.json'),
    JSON.stringify({ schemaVersion: 1, pseudonyms: [{ names: ['Théo'], label: 'Coéquipier 1' }] }),
  );
  config = loadConfig(
    {
      NODE_ENV: 'test',
      STORAGE_DIR: storage,
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
      WHISPER_WORKER_COMMAND: JSON.stringify([process.execPath, FAKE_WORKER]),
      ANALYSIS_PRIVACY_FILE: path.join(storage, 'config', 'privacy.json'),
      EDITOR_WINDOW_MARGIN_SEC: '10',
      ...env,
    },
    ROOT_DIR,
  );
  const db = openDatabase(path.join(storage, 'base.sqlite'));
  const { app, services } = buildApp({ config, db, model: new FakeModel(scenarioScript) });
  apps.push(app);
  onBuild?.(app);
  const video = path.join(storage, 'original.mkv');
  copyFileSync(master, video);
  return { video, inst: { app, services, db } };
}

/** Import, transcription, analyse, acceptation, micro déclaré, projet créé. */
async function prepareProject(inst: Instance, video: string) {
  const call = async <T>(method: 'GET' | 'POST', url: string, payload?: object) =>
    (await inst.app.inject({ method, url, ...(payload ? { payload } : {}) })).json<T>();
  const rec = (await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video }))
    .recording;
  await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await inst.services.runner.idle();
  await call('POST', `/api/recordings/${rec.id}/analyses`, {
    mode: 'claude',
    acceptBudgetUsd: config.analysis.maxCostUsd,
    review: false,
  });
  await inst.services.runner.idle();
  const l = await call<{ items: { proposal: { id: string; tier: string } }[] }>(
    'GET',
    `/api/recordings/${rec.id}/proposals`,
  );
  const clip = l.items.find((i) => i.proposal.tier === 'clip')!.proposal.id;
  await call('POST', `/api/proposals/${clip}/decision`, {
    requestId: randomUUID(),
    decision: 'accepted',
  });
  await call('POST', `/api/recordings/${rec.id}/export-audio`, {
    requestId: randomUUID(),
    kind: 'declaration',
    subject: 'mic_composition',
    payload: { creatorVoice: 'present', otherVoices: 'absent' },
  });
  const project = (
    await call<{ project: { id: string } }>('POST', `/api/proposals/${clip}/clip-project`, {
      requestId: randomUUID(),
    })
  ).project.id;
  return { rec, project };
}

interface Prepared {
  status: 'ready' | 'pending';
  lease: { expiresAt: string };
  proxy: { id: string } | null;
  thumbnails: { id: string; layout: { count: number } | null } | null;
  audio: { id: string; audioIndex: number; role: string }[];
  waveforms: { id: string; audioIndex: number }[];
  jobs: { type: string }[];
}

/** Session de l'éditeur : médias prêts, bail pris. */
async function openSession(inst: Instance, project: string, sessionId = randomUUID()) {
  const prep = () =>
    inst.app.inject({
      method: 'POST',
      url: `/api/clip-projects/${project}/editor-media`,
      payload: { sessionId },
    });
  const first = (await prep()).json<Prepared>();
  await inst.services.runner.idle();
  const ready = (await prep()).json<Prepared>();
  return { sessionId, first, ready };
}

const tokenRequest = (
  inst: Instance,
  project: string,
  body: object,
  o: { headers?: Record<string, string | undefined>; remoteAddress?: string } = {},
) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    host: HOST,
    origin: ORIGIN,
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    ...o.headers,
  })) {
    if (v !== undefined) headers[k] = v;
  }
  return inst.app.inject({
    method: 'POST',
    url: `/api/clip-projects/${project}/media-token`,
    headers,
    payload: JSON.stringify(body),
    remoteAddress: o.remoteAddress ?? '127.0.0.1',
  });
};

const mediaRequest = (
  inst: Instance,
  derivativeId: string,
  token: string | null,
  o: {
    headers?: Record<string, string | undefined>;
    remoteAddress?: string;
    method?: 'GET' | 'HEAD' | 'OPTIONS';
  } = {},
) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    host: HOST,
    'sec-fetch-site': 'same-origin',
    range: 'bytes=0-99',
    ...o.headers,
  })) {
    if (v !== undefined) headers[k] = v;
  }
  return inst.app.inject({
    method: o.method ?? 'GET',
    url: `/api/editor-media/${derivativeId}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`,
    headers,
    remoteAddress: o.remoteAddress ?? '127.0.0.1',
  });
};

describe.skipIf(!enabled)('médias de travail de l’éditeur par l’API (étape 7d)', () => {
  beforeAll(() => {
    master = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-medias-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const a of apps.splice(0)) await a.close();
  });

  it('préparation : proxy et vignettes dans processing/editor, pistes autorisées ET activées seulement, baux de session ; vignettes recalculées quand les masques changent', async () => {
    const { video, inst } = await setup();
    const { rec, project } = await prepareProject(inst, video);
    const { sessionId, first, ready } = await openSession(inst, project);
    expect(first.status).toBe('pending');
    expect(first.jobs.map((j) => j.type).sort()).toEqual(
      ['extract_audio_stems', 'thumbnail_sprite', 'video_proxy'].sort(),
    );
    expect(ready.status, JSON.stringify(ready)).toBe('ready');
    // Micro déclaré, Discord sans accord : seule la piste micro est préparée.
    expect(ready.audio.map((a) => [a.audioIndex, a.role])).toEqual([[0, 'mic']]);
    expect(ready.waveforms.map((w) => w.audioIndex)).toEqual([0]);
    expect(ready.thumbnails?.layout?.count).toBeGreaterThan(0);
    const derivs = inst.services.derivatives.repo;
    const proxy = derivs.get(ready.proxy!.id)!;
    const thumbs = derivs.get(ready.thumbnails!.id)!;
    expect(proxy.relPath.startsWith(`processing/editor/${rec.id}/`)).toBe(true);
    expect(thumbs.relPath.startsWith(`processing/editor/${rec.id}/`)).toBe(true);
    const holder = `editor:${project}:${sessionId}`;
    // Baux de la session sur les clés de cache des 4 médias (posés dès la première demande).
    const leased = (
      inst.db.prepare('SELECT cache_key FROM derivative_leases WHERE holder = ?').all(holder) as {
        cache_key: string;
      }[]
    ).map((r) => r.cache_key);
    const keyOf = (id: string) => derivs.get(id)!.cacheKey;
    expect(leased.sort()).toEqual(
      [proxy.id, thumbs.id, ready.audio[0]!.id, ready.waveforms[0]!.id].map(keyOf).sort(),
    );
    // Masque ajouté : nouvelle planche (les masques entrent dans sa clé), même proxy.
    const doc = (
      await inst.app.inject({ method: 'GET', url: `/api/clip-projects/${project}/document` })
    ).json<{ version: number }>();
    await inst.app.inject({
      method: 'POST',
      url: `/api/clip-projects/${project}/edits`,
      payload: {
        requestId: randomUUID(),
        base: { version: doc.version },
        kind: 'do',
        ops: [
          {
            type: 'setEntity',
            collection: 'mask',
            entity: {
              id: 'mask-900',
              rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
              label: 'pseudo',
              mode: 'opaque',
              srcRange: null,
            },
          },
        ],
      },
    });
    const again = await openSession(inst, project, sessionId);
    expect(again.ready.proxy!.id).toBe(proxy.id);
    expect(again.ready.thumbnails!.id).not.toBe(thumbs.id);
    expect(derivs.get(again.ready.thumbnails!.id)!.params).toMatchObject({
      masks: [{ x: 0, y: 0, w: 0.5, h: 0.5 }],
    });
  }, 300_000);

  it('révocation pendant une session ouverte et une lecture en cours : décision relue sans nouvelle version, piste plus servie ni préparée', async () => {
    const { video, inst } = await setup();
    const { rec, project } = await prepareProject(inst, video);
    const { sessionId, ready } = await openSession(inst, project);
    const stem = ready.audio.find((a) => a.audioIndex === 0)!;
    const wave = ready.waveforms.find((w) => w.audioIndex === 0)!;
    const decision = async () =>
      (
        await inst.app.inject({
          method: 'GET',
          url: `/api/clip-projects/${project}/audio-decision`,
        })
      ).json<{ audio: { selected: { audioIndex: number }[] } }>().audio.selected;
    const version = async () =>
      (
        await inst.app.inject({ method: 'GET', url: `/api/clip-projects/${project}/document` })
      ).json<{ version: number }>().version;
    expect(await decision()).toEqual([{ audioIndex: 0, role: 'mic' }]);
    const v0 = await version();
    // Lecture en cours : jeton délivré, requêtes Range servies.
    const tok = (await tokenRequest(inst, project, { sessionId, derivativeId: stem.id })).json<{
      token: string;
    }>().token;
    expect((await mediaRequest(inst, stem.id, tok)).statusCode).toBe(206);

    // Révocation (déclaration modifiée : d'autres voix sont présentes sur le micro).
    const r = await inst.app.inject({
      method: 'POST',
      url: `/api/recordings/${rec.id}/export-audio`,
      payload: {
        requestId: randomUUID(),
        kind: 'declaration',
        subject: 'mic_composition',
        payload: { creatorVoice: 'present', otherVoices: 'present' },
      },
    });
    expect(r.statusCode, r.body).toBe(200);

    // Décision relue immédiatement, sans aucune nouvelle version du document.
    expect(await decision()).toEqual([]);
    expect(await version()).toBe(v0);
    // La lecture en cours s'arrête : la requête Range suivante est refusée, même avec le jeton.
    expect(
      (await mediaRequest(inst, stem.id, tok, { headers: { range: 'bytes=100-199' } })).statusCode,
    ).toBe(403);
    expect(
      (await tokenRequest(inst, project, { sessionId, derivativeId: stem.id })).statusCode,
    ).toBe(403);
    expect(
      (await tokenRequest(inst, project, { sessionId, derivativeId: wave.id })).statusCode,
    ).toBe(403);
    // Nouvelle préparation : plus aucune piste.
    const again = (
      await inst.app.inject({
        method: 'POST',
        url: `/api/clip-projects/${project}/editor-media`,
        payload: { sessionId },
      })
    ).json<Prepared>();
    expect(again.audio).toEqual([]);
    expect(again.waveforms).toEqual([]);
    // L'image reste disponible (aucune donnée audio).
    expect(
      (await tokenRequest(inst, project, { sessionId, derivativeId: ready.proxy!.id })).statusCode,
    ).toBe(200);
  }, 300_000);

  it('course : médias encore en préparation lors de la demande ⇒ protégés DÈS leur création (éviction automatique et nettoyage), sans nouvel appel ; puis libération et expiration', async () => {
    // Budget de cache minuscule : l'éviction automatique (après chaque traitement réussi)
    // supprimerait tout dérivé non protégé dès sa création.
    const { video, inst } = await setup({ CACHE_MAX_GB: '0.000001' });
    const { project } = await prepareProject(inst, video);
    const sessionId = randomUUID();
    const prepare = () =>
      inst.app.inject({
        method: 'POST',
        url: `/api/clip-projects/${project}/editor-media`,
        payload: { sessionId },
      });
    // 1. Demande alors que rien n'est prêt : traitements en attente.
    const first = (await prepare()).json<Prepared>();
    expect(first.status).toBe('pending');
    expect(first.proxy).toBeNull();
    // 2. Les traitements se terminent et créent les dérivés (éviction automatique après chacun).
    await inst.services.runner.idle();
    const editorKinds = inst.db
      .prepare(
        `SELECT id, kind, rel_path FROM media_derivatives
         WHERE kind IN ('video_proxy','thumbnail','audio_stem','waveform') ORDER BY kind`,
      )
      .all() as { id: string; kind: string; rel_path: string }[];
    expect(editorKinds.map((d) => d.kind)).toEqual([
      'audio_stem',
      'thumbnail',
      'video_proxy',
      'waveform',
    ]);
    // 3. Nettoyage complet AVANT tout nouvel appel de l'interface.
    await inst.services.storage.clean({ dryRun: false, evictAllCache: true });
    // 4. Rien de ce qui est destiné à la session active n'a été supprimé.
    for (const d of editorKinds) {
      expect(existsSync(path.join(config.paths.storage, d.rel_path)), d.kind).toBe(true);
      expect(inst.services.derivatives.repo.get(d.id), d.kind).not.toBeNull();
    }
    // La session lit ses médias sans avoir rappelé la préparation.
    const proxy = editorKinds.find((d) => d.kind === 'video_proxy')!;
    const tok = await tokenRequest(inst, project, { sessionId, derivativeId: proxy.id });
    expect(tok.statusCode, tok.body).toBe(200);
    expect(
      (await mediaRequest(inst, proxy.id, tok.json<{ token: string }>().token)).statusCode,
    ).toBe(206);

    // Expiration du bail (éditeur abandonné sans libération) : redevient évinçable.
    inst.db.prepare(`UPDATE derivative_leases SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    await inst.services.storage.clean({ dryRun: false, evictAllCache: true });
    for (const d of editorKinds) {
      expect(existsSync(path.join(config.paths.storage, d.rel_path)), d.kind).toBe(false);
    }

    // Nouvelle session : demande pendant la préparation, puis libération explicite.
    const s2 = randomUUID();
    const again = (
      await inst.app.inject({
        method: 'POST',
        url: `/api/clip-projects/${project}/editor-media`,
        payload: { sessionId: s2 },
      })
    ).json<Prepared>();
    expect(again.status).toBe('pending');
    await inst.services.runner.idle();
    const created = inst.db
      .prepare(`SELECT rel_path FROM media_derivatives WHERE kind IN ('video_proxy','thumbnail')`)
      .all() as { rel_path: string }[];
    expect(created).toHaveLength(2);
    await inst.services.storage.clean({ dryRun: false, evictAllCache: true });
    for (const d of created)
      expect(existsSync(path.join(config.paths.storage, d.rel_path))).toBe(true);
    await inst.app.inject({
      method: 'POST',
      url: `/api/clip-projects/${project}/editor-media/release`,
      payload: { sessionId: s2 },
    });
    await inst.services.storage.clean({ dryRun: false, evictAllCache: true });
    for (const d of created)
      expect(existsSync(path.join(config.paths.storage, d.rel_path))).toBe(false);
  }, 300_000);

  it('baux : le nettoyage ne supprime jamais un média sous bail ; après la fin de session, il redevient évinçable ; original intact', async () => {
    const { video, inst } = await setup();
    const { project } = await prepareProject(inst, video);
    const { sessionId, ready } = await openSession(inst, project);
    const proxy = inst.services.derivatives.repo.get(ready.proxy!.id)!;
    const abs = path.join(config.paths.storage, proxy.relPath);
    const r1 = await inst.services.storage.clean({ dryRun: false, evictAllCache: true });
    expect(r1.items.some((i) => i.derivativeId === proxy.id)).toBe(false);
    expect(r1.skippedInUse).toBeGreaterThanOrEqual(4);
    expect(existsSync(abs)).toBe(true);
    const rel = await inst.app.inject({
      method: 'POST',
      url: `/api/clip-projects/${project}/editor-media/release`,
      payload: { sessionId },
    });
    expect(rel.json()).toMatchObject({ released: 4, checkpoint: expect.any(Number) });
    const r2 = await inst.services.storage.clean({ dryRun: false, evictAllCache: true });
    expect(r2.items.some((i) => i.derivativeId === proxy.id)).toBe(true);
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(video)).toBe(true);
  }, 300_000);

  describe('sécurité du proxy (§5.2) : un test par contrôle', () => {
    let inst: Instance;
    let project: string;
    let sessionId: string;
    let ready: Prepared;
    let token: string;

    const fresh = async () => {
      const s = await setup();
      inst = s.inst;
      ({ project } = await prepareProject(inst, s.video));
      ({ sessionId, ready } = await openSession(inst, project));
      const t = await tokenRequest(inst, project, { sessionId, derivativeId: ready.proxy!.id });
      expect(t.statusCode, t.body).toBe(200);
      token = t.json<{ token: string }>().token;
    };

    it('adresse du socket : non locale ⇒ 403, MÊME avec X-Forwarded-For, X-Real-IP ou Forwarded', async () => {
      await fresh();
      const spoof = {
        'x-forwarded-for': '127.0.0.1',
        'x-real-ip': '127.0.0.1',
        forwarded: 'for=127.0.0.1',
      };
      for (const remoteAddress of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20']) {
        const m = await mediaRequest(inst, ready.proxy!.id, token, {
          remoteAddress,
          headers: spoof,
        });
        expect(m.statusCode, remoteAddress).toBe(403);
        const t = await tokenRequest(
          inst,
          project,
          { sessionId, derivativeId: ready.proxy!.id },
          { remoteAddress, headers: spoof },
        );
        expect(t.statusCode).toBe(403);
      }
      for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect(
          (await mediaRequest(inst, ready.proxy!.id, token, { remoteAddress })).statusCode,
        ).toBe(206);
      }
    }, 300_000);

    it('Host : 127.0.0.1:5173 et localhost:5173 acceptés ; evil.example:5173, port de l’API et autre port refusés', async () => {
      await fresh();
      for (const host of ['127.0.0.1:5173', 'localhost:5173']) {
        expect(
          (await mediaRequest(inst, ready.proxy!.id, token, { headers: { host } })).statusCode,
        ).toBe(206);
      }
      for (const host of ['evil.example:5173', '127.0.0.1:4000', '127.0.0.1:3000', '127.0.0.1']) {
        const m = await mediaRequest(inst, ready.proxy!.id, token, { headers: { host } });
        expect(m.statusCode, host).toBe(403);
        const t = await tokenRequest(
          inst,
          project,
          { sessionId, derivativeId: ready.proxy!.id },
          { headers: { host } },
        );
        expect(t.statusCode, host).toBe(403);
      }
    }, 300_000);

    it('demande de jeton : Origin absent, hors liste ou « null », corps non JSON, Sec-Fetch-Site intersite ⇒ 403 ; sinon jeton', async () => {
      await fresh();
      const body = { sessionId, derivativeId: ready.proxy!.id };
      const refused: Record<string, string | undefined>[] = [
        { origin: undefined },
        { origin: 'http://localhost:4999' },
        { origin: 'http://127.0.0.1:3000' },
        { origin: 'null' },
        { 'content-type': 'text/plain' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site' },
      ];
      for (const headers of refused) {
        const r = await tokenRequest(inst, project, body, { headers });
        expect(r.statusCode, JSON.stringify(headers)).toBe(403);
      }
      const ok = await tokenRequest(inst, project, body);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ token: expect.any(String), expiresAt: expect.any(String) });
      expect(ok.json<{ token: string }>().token.split('.')[1]).toHaveLength(43); // 256 bits
      // Session sans bail, ou dérivé d'une autre piste (non autorisée) : refusés.
      const other = await tokenRequest(inst, project, { ...body, sessionId: randomUUID() });
      expect(other.statusCode).toBe(403);
    }, 300_000);

    it('lecture du média : Origin absent + jeton + same-origin ⇒ 206 ; sans jeton ⇒ 403 ; Sec-Fetch-Site absent ⇒ 206 ; Origin non autorisé ou intersite ⇒ 403 même avec un jeton', async () => {
      await fresh();
      const id = ready.proxy!.id;
      const ok = await mediaRequest(inst, id, token);
      expect(ok.statusCode).toBe(206);
      expect(ok.headers['content-range']).toMatch(/^bytes 0-99\//u);
      expect(ok.headers['content-type']).toBe('video/mp4');
      expect((await mediaRequest(inst, id, null)).statusCode).toBe(403);
      expect(
        (await mediaRequest(inst, id, token, { headers: { 'sec-fetch-site': undefined } }))
          .statusCode,
      ).toBe(206);
      expect(
        (await mediaRequest(inst, id, token, { headers: { origin: ORIGIN } })).statusCode,
      ).toBe(206);
      for (const headers of [
        { origin: 'http://localhost:4999' },
        { origin: 'null' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site' },
      ]) {
        expect(
          (await mediaRequest(inst, id, token, { headers })).statusCode,
          JSON.stringify(headers),
        ).toBe(403);
      }
      const head = await mediaRequest(inst, id, token, { method: 'HEAD' });
      expect(head.statusCode).toBe(206);
      expect(head.rawPayload.length).toBe(0);
    }, 300_000);

    it('jeton absent, expiré, falsifié, ou lié à un autre dérivé ⇒ 403 ; bail rendu ou piste révoquée ⇒ 403', async () => {
      await fresh();
      const id = ready.proxy!.id;
      const [body, sig] = token.split('.') as [string, string];
      const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
      expect((await mediaRequest(inst, id, `${body}.${flip(sig)}`)).statusCode).toBe(403);
      const forged = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(body, 'base64url').toString()),
          expiresAt: 9e15,
        }),
      ).toString('base64url');
      expect((await mediaRequest(inst, id, `${forged}.${sig}`)).statusCode).toBe(403);
      expect((await mediaRequest(inst, id, 'abc')).statusCode).toBe(403);
      // Jeton du proxy présenté pour la planche de vignettes.
      expect((await mediaRequest(inst, ready.thumbnails!.id, token)).statusCode).toBe(403);
      // Piste audio : servie avec son propre jeton ; révoquée (déclaration retirée) ⇒ 403.
      const audioTok = (
        await tokenRequest(inst, project, { sessionId, derivativeId: ready.audio[0]!.id })
      ).json<{ token: string }>().token;
      expect((await mediaRequest(inst, ready.audio[0]!.id, audioTok)).statusCode).toBe(206);
      const rec = inst.services.clips.recordingOf(inst.services.clips.projectRow(project));
      await inst.app.inject({
        method: 'POST',
        url: `/api/recordings/${rec.id}/export-audio`,
        payload: {
          requestId: randomUUID(),
          kind: 'declaration',
          subject: 'mic_composition',
          payload: { creatorVoice: 'present', otherVoices: 'present' },
        },
      });
      expect((await mediaRequest(inst, ready.audio[0]!.id, audioTok)).statusCode).toBe(403);
      // Expiré (11 minutes plus tard) : 403.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
      expect((await mediaRequest(inst, id, token)).statusCode).toBe(403);
      vi.restoreAllMocks();
      expect((await mediaRequest(inst, id, token)).statusCode).toBe(206);
      // Bail rendu (éditeur fermé) : le jeton ne suffit plus.
      await inst.app.inject({
        method: 'POST',
        url: `/api/clip-projects/${project}/editor-media/release`,
        payload: { sessionId },
      });
      expect((await mediaRequest(inst, id, token)).statusCode).toBe(403);
    }, 300_000);

    it('CORS fermé : OPTIONS ⇒ 403 ; aucun Access-Control-Allow-Origin ; en-têtes de protection présents', async () => {
      await fresh();
      const responses = [
        await mediaRequest(inst, ready.proxy!.id, token),
        await mediaRequest(inst, ready.proxy!.id, null),
        await tokenRequest(inst, project, { sessionId, derivativeId: ready.proxy!.id }),
        await mediaRequest(inst, ready.proxy!.id, token, {
          method: 'OPTIONS',
          headers: { origin: 'http://localhost:4999', 'access-control-request-method': 'GET' },
        }),
        await inst.app.inject({
          method: 'OPTIONS',
          url: `/api/clip-projects/${project}/media-token`,
          headers: {
            host: HOST,
            origin: 'http://localhost:4999',
            'access-control-request-method': 'POST',
          },
          remoteAddress: '127.0.0.1',
        }),
      ];
      expect(responses[3]!.statusCode).toBe(403);
      expect(responses[4]!.statusCode).toBe(403);
      for (const r of responses) {
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
      }
      for (const r of [responses[0]!, responses[2]!]) {
        expect(r.headers).toMatchObject({
          'cross-origin-resource-policy': 'same-origin',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
      }
    }, 300_000);
  });

  it('polices de l’aperçu : liste fermée, connexion locale et Host autorisé seulement', async () => {
    const { inst } = await setup();
    const font = (file: string, o: { host?: string; remoteAddress?: string } = {}) =>
      inst.app.inject({
        method: 'GET',
        url: `/api/editor/fonts/${file}`,
        headers: { host: o.host ?? HOST },
        remoteAddress: o.remoteAddress ?? '127.0.0.1',
      });
    const ok = await font('Inter-Bold.ttf');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('font/ttf');
    expect(ok.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(ok.rawPayload.subarray(0, 4).toString('hex')).toBe('00010000');
    expect((await font('OFL-Inter.txt')).statusCode).toBe(404);
    expect((await font('..%2F..%2Fpackage.json')).statusCode).toBe(404);
    expect((await font('Inter-Bold.ttf', { host: 'evil.example:5173' })).statusCode).toBe(403);
    expect((await font('Inter-Bold.ttf', { remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
  });

  it('jeton absent des journaux du serveur', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const { config: c } = {
      config: loadConfig({ NODE_ENV: 'production', LOG_LEVEL: 'info' }, ROOT_DIR),
    };
    const opts = loggerOptions(c) as object;
    const app = Fastify({ logger: { ...opts, stream } as never });
    apps.push(app);
    app.get('/api/editor-media/:id', async () => 'ok');
    await app.inject({ method: 'GET', url: '/api/editor-media/d1?token=SECRET-JETON-123' });
    const all = lines.join('');
    expect(all).toContain('/api/editor-media/d1?token=[masqué]');
    expect(all).not.toContain('SECRET-JETON-123');
  });

  it('architecture : trustProxy désactivé ; aucun en-tête de transfert lu par le contrôle d’accès', async () => {
    const { inst } = await setup();
    expect((inst.app.initialConfig as { trustProxy?: unknown }).trustProxy ?? false).toBe(false);
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(
      fileURLToPath(new URL('./clips/media-access.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\/\/.*$/gmu, '');
    expect(code).not.toMatch(/x-forwarded|x-real-ip|['"]forwarded['"]|\.ips?\b/iu);
    expect(code).toContain('req.raw.socket.remoteAddress');
  });

  it('serveur réel derrière le VRAI proxy de Vite (changeOrigin: false) : jeton par POST, média par GET Range ; en-têtes reçus par l’API ; autre origine et Host étranger refusés', async () => {
    const vitePort = await freePort();
    const origins = `http://127.0.0.1:${vitePort},http://localhost:${vitePort}`;
    const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
    const { video, inst } = await setup({ EDITOR_ALLOWED_ORIGINS: origins }, (app) =>
      app.addHook('onRequest', async (req) => {
        if (req.url.startsWith('/api/editor-media') || req.url.includes('/media-token')) {
          seen.push({ url: req.url, headers: { ...req.headers } });
        }
      }),
    );
    const { project } = await prepareProject(inst, video);
    const { sessionId, ready } = await openSession(inst, project);
    await inst.app.listen({ host: '127.0.0.1', port: 0 });
    const apiPort = (inst.app.server.address() as { port: number }).port;

    const previous = process.env.ACS_API_URL;
    process.env.ACS_API_URL = `http://127.0.0.1:${apiPort}`;
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: VITE_CONFIG,
      root: path.dirname(VITE_CONFIG),
      logLevel: 'silent',
      clearScreen: false,
      server: { port: vitePort, strictPort: true, host: '127.0.0.1', hmr: false },
    });
    try {
      await vite.listen();
      const viaVite = (
        method: string,
        url: string,
        headers: Record<string, string>,
        body?: string,
      ) => request(vitePort, method, url, headers, body);
      const viteHost = `127.0.0.1:${vitePort}`;

      // fetch POST de l'interface (même origine) : jeton.
      const tok = await viaVite(
        'POST',
        `/api/clip-projects/${project}/media-token`,
        {
          host: viteHost,
          origin: `http://${viteHost}`,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        JSON.stringify({ sessionId, derivativeId: ready.proxy!.id }),
      );
      expect(tok.status, tok.body.toString()).toBe(200);
      const token = (JSON.parse(tok.body.toString()) as { token: string }).token;

      // Balise <video> de l'interface : pas d'Origin, Range, same-origin ⇒ 206.
      const mediaUrl = `/api/editor-media/${ready.proxy!.id}?token=${encodeURIComponent(token)}`;
      const vid = await viaVite('GET', mediaUrl, {
        host: viteHost,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'video',
        range: 'bytes=0-',
      });
      expect(vid.status).toBe(206);
      expect(vid.headers['content-type']).toBe('video/mp4');
      const atApi = seen.filter((s) => s.url.startsWith('/api/editor-media')).at(-1)!;
      expect(atApi.headers.host).toBe(viteHost); // Vite conserve le Host (changeOrigin: false)
      expect(atApi.headers.origin).toBeUndefined();
      expect(Object.keys(atApi.headers).filter((h) => /forwarded|x-real-ip/iu.test(h))).toEqual([]);

      // Page d'une autre origine : balise <video> (intersite) et demande de jeton refusées.
      const cross = await viaVite('GET', mediaUrl, {
        host: viteHost,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        range: 'bytes=0-',
      });
      expect(cross.status).toBe(403);
      const crossTok = await viaVite(
        'POST',
        `/api/clip-projects/${project}/media-token`,
        {
          host: viteHost,
          origin: 'http://localhost:4999',
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        JSON.stringify({ sessionId, derivativeId: ready.proxy!.id }),
      );
      expect(crossTok.status).toBe(403);

      // Host étranger : refusé par Vite (jamais transmis) ; le même envoyé à l'API : refusé.
      const before = seen.length;
      const evilVite = await viaVite('GET', mediaUrl, {
        host: `evil.example:${vitePort}`,
        'sec-fetch-site': 'same-origin',
      });
      expect(evilVite.status).toBe(403);
      expect(seen.length).toBe(before);
      const evilApi = await request(apiPort, 'GET', mediaUrl, {
        host: `evil.example:${vitePort}`,
        'sec-fetch-site': 'same-origin',
      });
      expect(evilApi.status).toBe(403);
      // Directement sur le port de l'API avec son propre Host : refusé (liste non élargie).
      const apiHost = await request(apiPort, 'GET', mediaUrl, {
        host: `127.0.0.1:${apiPort}`,
        'sec-fetch-site': 'same-origin',
      });
      expect(apiHost.status).toBe(403);
    } finally {
      await vite.close();
      if (previous === undefined) delete process.env.ACS_API_URL;
      else process.env.ACS_API_URL = previous;
    }
  }, 300_000);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function request(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: url, headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}
