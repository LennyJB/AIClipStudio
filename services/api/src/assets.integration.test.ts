/**
 * Bibliothèque de médias par l'API (étape 7, PR 7f) : FFmpeg réel, transcription simulée, faux
 * modèle (aucun appel à Claude), base SQLite sur fichier.
 *
 *  - import (flux, taille bornée pendant la réception), normalisation, déduplication ;
 *  - aucun chemin exposé ; fichiers servis avec des en-têtes stricts ;
 *  - contrôles d'accès (adresse du socket, Host, Origin, Sec-Fetch-Site, CORS fermé, type du corps),
 *    noms et identifiants piégés refusés ; fichiers piégés refusés sans rien laisser sur le disque ;
 *  - suppression refusée tant qu'un projet (version, journal) référence le média ;
 *  - lot d'édition qui référence un média absent : refusé ;
 *  - rendu : média manquant ou altéré ⇒ refus explicite ; média supprimé ou altéré PENDANT le rendu
 *    ⇒ sans effet (copie vérifiée) ; réimportation ⇒ réparé ; originaux intacts.
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeModel } from '@acs/editorial';
import type { ClipProjectV2 } from '@acs/timeline';
import {
  animatedGif,
  halfTransparentPng,
  polyglot,
  solidImage,
  textFile,
  tone,
} from '../../../tests/helpers/asset-fixtures';
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
import type { RecordingDto } from './recordings/repository';
import type { Services } from './services';

const FAKE_WORKER = fileURLToPath(
  new URL('../../../tests/helpers/fake-whisper-worker.mjs', import.meta.url),
);
const enabled = ffmpegAvailable();
const ORIGIN = 'http://127.0.0.1:5173';
const HOST = '127.0.0.1:5173';

let master: string;
let fixtures: string;
const apps: FastifyInstance[] = [];

interface Instance {
  app: FastifyInstance;
  services: Services;
  db: Db;
  config: AppConfig;
  storage: string;
}

async function setup(env: Record<string, string> = {}): Promise<Instance> {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-biblio-'));
  mkdirSync(path.join(storage, 'config'), { recursive: true });
  writeFileSync(
    path.join(storage, 'config', 'privacy.json'),
    JSON.stringify({ schemaVersion: 1, pseudonyms: [{ names: ['Théo'], label: 'Coéquipier 1' }] }),
  );
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      STORAGE_DIR: storage,
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
      WHISPER_WORKER_COMMAND: JSON.stringify([process.execPath, FAKE_WORKER]),
      ANALYSIS_PRIVACY_FILE: path.join(storage, 'config', 'privacy.json'),
      RENDER_X264_PRESET: 'ultrafast',
      RENDER_PREVIEW_HEIGHT: '320',
      ...env,
    },
    ROOT_DIR,
  );
  const db = openDatabase(path.join(storage, 'base.sqlite'));
  const { app, services } = buildApp({ config, db, model: new FakeModel(scenarioScript) });
  apps.push(app);
  return { app, services, db, config, storage };
}

type Headers = Record<string, string | undefined>;
const req = (
  inst: Instance,
  method: 'GET' | 'POST' | 'DELETE' | 'OPTIONS',
  url: string,
  o: { headers?: Headers; payload?: Buffer | string; remoteAddress?: string } = {},
) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    host: HOST,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...o.headers,
  })) {
    if (v !== undefined) headers[k] = v;
  }
  return inst.app.inject({
    method,
    url,
    headers,
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
    remoteAddress: o.remoteAddress ?? '127.0.0.1',
  });
};

interface AssetBody {
  asset: {
    id: string;
    kind: string;
    status: string;
    width: number | null;
    durationMs: number | null;
  };
  duplicate: boolean;
  error?: { code: string; details?: { reason?: string } };
}

const upload = (
  inst: Instance,
  file: string,
  o: { name?: string; rights?: string; headers?: Headers; remoteAddress?: string } = {},
) =>
  req(
    inst,
    'POST',
    `/api/media-assets?name=${encodeURIComponent(o.name ?? path.basename(file))}&rights=${o.rights ?? 'own'}`,
    {
      headers: { 'content-type': 'application/octet-stream', ...o.headers },
      payload: readFileSync(file),
      ...(o.remoteAddress ? { remoteAddress: o.remoteAddress } : {}),
    },
  );

const call = async <T = Record<string, unknown>>(
  inst: Instance,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) => {
  const res = await inst.app.inject(
    payload === undefined ? { method, url } : { method, url, payload },
  );
  return { status: res.statusCode, body: res.json<T>() };
};

/** Import, transcription, analyse, acceptation, micro déclaré, projet créé. */
async function prepare(inst: Instance) {
  const video = path.join(inst.storage, 'original.mkv');
  copyFileSync(master, video);
  const rec = (
    await call<{ recording: RecordingDto }>(inst, 'POST', '/api/recordings', { path: video })
  ).body.recording;
  await call(inst, 'POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await inst.services.runner.idle();
  await call(inst, 'POST', `/api/recordings/${rec.id}/analyses`, {
    mode: 'claude',
    acceptBudgetUsd: inst.config.analysis.maxCostUsd,
    review: false,
  });
  await inst.services.runner.idle();
  const l = await call<{ items: { proposal: { id: string; tier: string } }[] }>(
    inst,
    'GET',
    `/api/recordings/${rec.id}/proposals`,
  );
  const found = l.body.items?.find((i) => i.proposal.tier === 'clip');
  if (!found)
    throw new Error(
      `aucune proposition : ${JSON.stringify(l.body).slice(0, 800)} ${JSON.stringify(inst.db.prepare('SELECT status, error_message FROM jobs').all())}`,
    );
  const proposal = found.proposal;
  await call(inst, 'POST', `/api/proposals/${proposal.id}/decision`, {
    requestId: randomUUID(),
    decision: 'accepted',
  });
  await call(inst, 'POST', `/api/recordings/${rec.id}/export-audio`, {
    requestId: randomUUID(),
    kind: 'declaration',
    subject: 'mic_composition',
    payload: { creatorVoice: 'present', otherVoices: 'absent' },
  });
  const project = (
    await call<{ project: { id: string } }>(
      inst,
      'POST',
      `/api/proposals/${proposal.id}/clip-project`,
      {
        requestId: randomUUID(),
      },
    )
  ).body.project.id;
  const doc = async () =>
    (
      await call<{ version: number; document: ClipProjectV2 }>(
        inst,
        'GET',
        `/api/clip-projects/${project}/document`,
      )
    ).body;
  const edit = async (ops: unknown[]) => {
    const d = await doc();
    return call<{ version?: number; error?: { code: string } }>(
      inst,
      'POST',
      `/api/clip-projects/${project}/edits`,
      { requestId: randomUUID(), base: { version: d.version }, kind: 'do', ops },
    );
  };
  const render = async () => {
    const r = await call<{ render?: { id: string }; error?: { code: string } }>(
      inst,
      'POST',
      `/api/clip-projects/${project}/renders`,
      { requestId: randomUUID(), kind: 'preview' },
    );
    await inst.services.runner.idle();
    return r;
  };
  const renderRow = (id: string) =>
    inst.db.prepare('SELECT status, error_code FROM clip_renders WHERE id = ?').get(id) as {
      status: string;
      error_code: string | null;
    };
  return { video, project, doc, edit, render, renderRow };
}

const overlayOp = (assetId: string, id = 'meme') => ({
  type: 'setEntity',
  collection: 'overlay',
  entity: {
    id,
    kind: 'meme',
    assetId,
    text: null,
    timing: { anchor: 'edit', from: 'start', offsetMs: 500, durMs: 1500 },
    frame: { x: 0.1, y: 0.1, w: 0.4, h: 0.2 },
    opacity: 1,
    z: 0,
  },
});
const sfxOp = (assetId: string) => ({
  type: 'setEntity',
  collection: 'sfx',
  entity: {
    id: 'boing',
    assetId,
    timing: { anchor: 'edit', from: 'start', offsetMs: 1000, durMs: 1000 },
    gainDb: -3,
  },
});

const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name))
    : [];

describe.skipIf(!enabled)('bibliothèque de médias par l’API (étape 7f)', () => {
  beforeAll(() => {
    fixtures = mkdtempSync(path.join(tmpdir(), 'acs-biblio-fixtures-'));
    master = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-biblio-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  it('import : normalisé, dédupliqué, aucun chemin exposé, fichiers servis avec des en-têtes stricts ; original importé jamais conservé', async () => {
    const inst = await setup();
    const png = solidImage(fixtures, 'logo.png', '0xFF00FF', 300, 150);
    const before = readFileSync(png);
    const r = await upload(inst, png, { name: 'Mon logo.png' });
    expect(r.statusCode, r.body).toBe(201);
    const a = r.json<AssetBody>().asset;
    expect(a).toMatchObject({ kind: 'image', status: 'ok', width: 300 });
    expect(a.id).toMatch(/^[0-9a-f]{64}$/u);
    // Même fichier : aucun second exemplaire.
    const again = await upload(inst, png, { name: 'copie.png' });
    expect(again.statusCode).toBe(200);
    expect(again.json<AssetBody>()).toMatchObject({ duplicate: true, asset: { id: a.id } });
    expect(files(inst.config.paths.assets).filter((f) => f.endsWith('.png'))).toHaveLength(2); // fichier + aperçu

    const list = await req(inst, 'GET', '/api/media-assets?kind=image');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(inst.storage);
    expect(list.body).not.toContain('assets/');
    expect(list.json<{ assets: unknown[] }>().assets).toHaveLength(1);

    for (const v of ['file', 'preview']) {
      const f = await req(inst, 'GET', `/api/media-assets/${a.id}/${v}`, {
        headers: { origin: undefined },
      });
      expect(f.statusCode).toBe(200);
      expect(f.headers['content-type']).toBe('image/png');
      expect(f.headers['x-content-type-options']).toBe('nosniff');
      expect(f.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(f.headers['content-security-policy']).toContain("default-src 'none'");
      expect(f.headers['access-control-allow-origin']).toBeUndefined();
      expect(f.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    }
    const wav = await upload(inst, tone(fixtures, 'boing.mp3', 1500, 0.4));
    expect(wav.statusCode, wav.body).toBe(201);
    const s = await req(inst, 'GET', `/api/media-assets/${wav.json<AssetBody>().asset.id}/file`);
    expect(s.headers['content-type']).toBe('audio/wav');
    // Aucun reste d'import ; l'original choisi par le créateur n'a pas été touché.
    expect(files(path.join(inst.config.paths.assets, '.incoming'))).toEqual([]);
    expect(readFileSync(png).equals(before)).toBe(true);
  }, 120_000);

  it('accès : autre machine, Host, Origin, Sec-Fetch-Site, CORS, type du corps, nom ou identifiant piégés : refusés', async () => {
    const inst = await setup();
    const png = solidImage(fixtures, 'acces.png', 'red');
    expect((await upload(inst, png, { remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
    expect((await upload(inst, png, { headers: { host: 'evil.example:5173' } })).statusCode).toBe(
      403,
    );
    expect(
      (await upload(inst, png, { headers: { origin: 'http://evil.example' } })).statusCode,
    ).toBe(403);
    expect((await upload(inst, png, { headers: { origin: 'null' } })).statusCode).toBe(403);
    expect(
      (await upload(inst, png, { headers: { 'sec-fetch-site': 'cross-site' } })).statusCode,
    ).toBe(403);
    expect(
      (await upload(inst, png, { headers: { 'sec-fetch-site': 'same-site' } })).statusCode,
    ).toBe(403);
    for (const type of [
      'multipart/form-data; boundary=x',
      'text/plain',
      'application/x-www-form-urlencoded',
    ]) {
      const r = await upload(inst, png, { headers: { 'content-type': type } });
      expect([400, 415], type).toContain(r.statusCode);
    }
    expect((await req(inst, 'OPTIONS', '/api/media-assets')).statusCode).toBe(403);
    for (const name of ['../../etc/passwd.png', 'dossier/logo.png', 'c:\\x\\logo.png', '']) {
      expect((await upload(inst, png, { name })).statusCode, name).toBe(400);
    }
    expect((await upload(inst, png, { rights: 'inconnu' })).statusCode).toBe(400);
    for (const id of ['..%2F..%2Fetc%2Fpasswd', 'A'.repeat(64), '1'.repeat(63)]) {
      expect((await req(inst, 'GET', `/api/media-assets/${id}/file`)).statusCode, id).toBe(400);
    }
    expect((await req(inst, 'GET', `/api/media-assets/${'1'.repeat(64)}/file`)).statusCode).toBe(
      404,
    );
    expect(inst.db.prepare('SELECT count(*) AS n FROM media_assets').get()).toEqual({ n: 0 });
  }, 60_000);

  it('fichiers piégés refusés (raison explicite), rien n’est conservé ; taille bornée pendant la réception', async () => {
    const inst = await setup({ MEDIA_ASSET_MAX_MB: '1' });
    const cases: [string, string, string][] = [
      [
        textFile(fixtures, 'x.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>      '),
        'x.svg',
        'format',
      ],
      [solidImage(fixtures, 'vrai.png', 'blue'), 'photo.jpg', 'extension_mismatch'],
      [
        polyglot(fixtures, solidImage(fixtures, 'base.png', 'red'), 'poly.png'),
        'poly.png',
        'trailing_data',
      ],
      [animatedGif(fixtures), 'anim.gif', 'animated'],
    ];
    for (const [file, name, reason] of cases) {
      const r = await upload(inst, file, { name });
      expect(r.statusCode, name).toBe(422);
      expect(r.json<AssetBody>().error).toMatchObject({
        code: 'ASSET_REJECTED',
        details: { reason },
      });
    }
    const big = path.join(fixtures, 'big.wav');
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 1));
    const r = await upload(inst, big);
    expect(r.statusCode).toBe(422);
    expect(r.json<AssetBody>().error?.details?.reason).toBe('too_large');
    expect(files(inst.config.paths.assets)).toEqual([]);
    expect(inst.db.prepare('SELECT count(*) AS n FROM media_assets').get()).toEqual({ n: 0 });
  }, 60_000);

  it('utilisation : lot qui référence un média absent refusé ; suppression refusée tant qu’un projet le référence (même retiré : journal) ; rendu avec calque et effet sonore ; média libre supprimable', async () => {
    const inst = await setup();
    const t = await prepare(inst);
    const img = (
      await upload(inst, halfTransparentPng(fixtures, 'meme.png', '0x00FF00', 200, 100))
    ).json<AssetBody>().asset;
    const snd = (await upload(inst, tone(fixtures, 'sfx.wav', 1200, 0.5))).json<AssetBody>().asset;
    const free = (await upload(inst, solidImage(fixtures, 'libre.png', 'white'))).json<AssetBody>()
      .asset;

    // Média inconnu, ou de mauvais type : refusé, rien n'est écrit.
    const v0 = (await t.doc()).version;
    expect((await t.edit([overlayOp('9'.repeat(64))])).body.error?.code).toBe('ASSET_MISSING');
    expect((await t.edit([overlayOp(snd.id)])).body.error?.code).toBe('ASSET_MISSING');
    expect((await t.edit([sfxOp(img.id)])).body.error?.code).toBe('ASSET_MISSING');
    expect((await t.doc()).version).toBe(v0);

    const ok = await t.edit([overlayOp(img.id), sfxOp(snd.id)]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const del = await req(inst, 'DELETE', `/api/media-assets/${img.id}`);
    expect(del.statusCode).toBe(409);
    expect(del.json<AssetBody>().error?.code).toBe('ASSET_IN_USE');
    const detail = await req(inst, 'GET', `/api/media-assets/${snd.id}`);
    expect(detail.json<{ usage: { projectIds: string[] } }>().usage.projectIds).toEqual([
      t.project,
    ]);

    // Rendu : calque et effet sonore pris en charge (plus aucun refus « non pris en charge »).
    const r = await t.render();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(t.renderRow(r.body.render!.id)).toMatchObject({ status: 'succeeded', error_code: null });

    // Retiré du document : toujours référencé par le journal (une annulation le ramènerait).
    expect(
      (await t.edit([{ type: 'removeEntity', collection: 'overlay', id: 'meme' }])).status,
    ).toBe(200);
    expect((await req(inst, 'DELETE', `/api/media-assets/${img.id}`)).statusCode).toBe(409);

    // Média jamais utilisé : supprimé, fichiers effacés.
    const ok2 = await req(inst, 'DELETE', `/api/media-assets/${free.id}`);
    expect(ok2.statusCode).toBe(200);
    expect(files(inst.config.paths.assets).some((f) => f.includes(free.id))).toBe(false);
    expect((await req(inst, 'GET', `/api/media-assets/${free.id}`)).statusCode).toBe(404);
  }, 400_000);

  it('fichier manquant ou altéré : signalé, rendu refusé explicitement (aucun repli) ; supprimé ou altéré PENDANT le rendu : sans effet ; réimportation ⇒ réparé ; fichiers orphelins retirés au démarrage', async () => {
    const inst = await setup();
    const t = await prepare(inst);
    const pngFile = solidImage(fixtures, 'manquant.png', '0x00FFFF', 120, 60);
    const img = (await upload(inst, pngFile)).json<AssetBody>().asset;
    expect((await t.edit([overlayOp(img.id)])).status).toBe(200);
    const stored = files(inst.config.paths.assets).find((f) => f.endsWith(`${img.id}.png`))!;
    const original = readFileSync(stored);

    // Fichier effacé à la main : signalé, rendu refusé AVANT toute exécution.
    rmSync(stored);
    expect(
      (await req(inst, 'GET', '/api/media-assets'))
        .json<{ assets: { id: string; status: string }[] }>()
        .assets.find((a) => a.id === img.id)?.status,
    ).toBe('missing');
    const refused = await t.render();
    expect(refused.body.error?.code).toBe('ASSET_MISSING');
    expect((await req(inst, 'GET', `/api/media-assets/${img.id}/file`)).statusCode).toBe(409);

    // Réimporter le même fichier répare le média.
    const repaired = await upload(inst, pngFile);
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json<AssetBody>().asset.status).toBe('ok');

    // Fichier ALTÉRÉ (même taille) : le rendu échoue explicitement à la vérification de la copie.
    const tampered = Buffer.from(original);
    tampered[tampered.length - 20] = tampered[tampered.length - 20]! ^ 0xff;
    writeFileSync(stored, tampered);
    const bad = await t.render();
    expect(t.renderRow(bad.body.render!.id)).toMatchObject({
      status: 'failed',
      error_code: 'ASSET_MISSING',
    });
    writeFileSync(stored, original);

    // Supprimé PENDANT le rendu (après la copie vérifiée) : le rendu va au bout.
    inst.services.renders.hooks.beforePublishLock = () => {
      rmSync(stored, { force: true });
    };
    const during = await t.render();
    expect(t.renderRow(during.body.render!.id)).toMatchObject({ status: 'succeeded' });
    inst.services.renders.hooks.beforePublishLock = undefined;
    writeFileSync(stored, original);

    // Démarrage : imports interrompus et fichiers sans ligne en base retirés.
    const shard = path.join(inst.config.paths.assets, 'ab');
    mkdirSync(shard, { recursive: true });
    writeFileSync(path.join(shard, `${'ab'.repeat(32)}.png`), 'orphelin');
    mkdirSync(path.join(inst.config.paths.assets, '.incoming', 'x'), { recursive: true });
    await inst.services.assets.recover();
    expect(existsSync(path.join(shard, `${'ab'.repeat(32)}.png`))).toBe(false);
    expect(existsSync(path.join(inst.config.paths.assets, '.incoming'))).toBe(false);
    expect(existsSync(stored)).toBe(true);
    // L'enregistrement original n'a jamais été modifié.
    expect(readFileSync(t.video).equals(readFileSync(master))).toBe(true);
  }, 400_000);
});
