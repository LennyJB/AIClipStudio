/**
 * Rendus des clips (étape 6b) de bout en bout par l'API : FFmpeg réel, transcription simulée,
 * faux modèle (aucun appel à Claude). Base SQLite sur fichier : le verrou d'écriture est vérifié
 * depuis une seconde connexion, comme le ferait le CLI dans un autre processus.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
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
import type { RecordingDto } from './recordings/repository';
import type { Services } from './services';

const FAKE_WORKER = fileURLToPath(
  new URL('../../../tests/helpers/fake-whisper-worker.mjs', import.meta.url),
);
const enabled = ffmpegAvailable();

let master: string;
let app: FastifyInstance;
let services: Services;
let db: Db;
let config: AppConfig;
let dbFile: string;

async function setup() {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-rendus '));
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
      RENDER_X264_PRESET: 'ultrafast',
      RENDER_PREVIEW_HEIGHT: '320',
    },
    ROOT_DIR,
  );
  dbFile = path.join(storage, 'base.sqlite');
  db = openDatabase(dbFile);
  ({ app, services } = buildApp({ config, db, model: new FakeModel(scenarioScript) }));
  const video = path.join(storage, 'original été.mkv');
  copyFileSync(master, video);
  return video;
}

const call = async <T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH' | 'HEAD',
  url: string,
  payload?: Record<string, unknown>,
  headers?: Record<string, string>,
) => {
  const res = await app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    ...(headers ? { headers } : {}),
  });
  let body: T;
  try {
    body = res.json<T>();
  } catch {
    body = res.body as T;
  }
  return { status: res.statusCode, body, headers: res.headers, raw: res.rawPayload };
};

interface RenderView {
  render: {
    id: string;
    kind: string;
    status: string;
    outputRelPath: string | null;
    errorCode: string | null;
    width: number | null;
    height: number | null;
  };
  created?: boolean;
  error?: { code: string };
}

/** Import, transcription, analyse, acceptation, micro déclaré, projet créé. */
async function prepare(video: string) {
  const rec = (await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video }))
    .body.recording;
  await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await services.runner.idle();
  await call('POST', `/api/recordings/${rec.id}/analyses`, {
    mode: 'claude',
    acceptBudgetUsd: config.analysis.maxCostUsd,
    review: false,
  });
  await services.runner.idle();
  const l = await call<{ items: { proposal: { id: string; tier: string } }[] }>(
    'GET',
    `/api/recordings/${rec.id}/proposals`,
  );
  const clip = l.body.items.find((i) => i.proposal.tier === 'clip')!.proposal.id;
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
  ).body.project.id;
  return { rec, clip, project };
}

const requestRender = (project: string, kind: 'preview' | 'final') =>
  call<RenderView>('POST', `/api/clip-projects/${project}/renders`, {
    requestId: randomUUID(),
    kind,
  });
const reject = (clip: string) =>
  services.review.decide(
    clip,
    { requestId: randomUUID(), decision: 'rejected', reasons: ['trop_long'] },
    'cli',
  );
const exportDirs = () =>
  existsSync(config.paths.exports)
    ? readdirSync(config.paths.exports).filter((d) => !d.startsWith('.'))
    : [];
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

describe.skipIf(!enabled)('Rendus des clips (API, étape 6b)', () => {
  beforeAll(() => {
    master = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-rendus-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    await app?.close();
  });

  it('aperçu puis export final : lecture Range/HEAD, téléchargement, .srt pseudonymisé, render.json sans chemin ; original intact', async () => {
    const video = await setup();
    const before = sha(video);
    const { project } = await prepare(video);

    const p = await requestRender(project, 'preview');
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    await services.runner.idle();
    let v = (await call<RenderView>('GET', `/api/renders/${p.body.render.id}`)).body;
    expect(v.render).toMatchObject({ status: 'succeeded', width: 180, height: 320 });
    // Même plan : aucun nouveau rendu.
    const again = await requestRender(project, 'preview');
    expect(again.status).toBe(200);
    expect(again.body.render.id).toBe(p.body.render.id);

    const head = await call('HEAD', `/api/renders/${p.body.render.id}/video`);
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('video/mp4');
    const part = await call('GET', `/api/renders/${p.body.render.id}/video`, undefined, {
      range: 'bytes=0-99',
    });
    expect(part.status).toBe(206);
    expect(part.raw.length).toBe(100);
    expect((await call('GET', `/api/renders/${p.body.render.id}/download`)).status).toBe(409);

    const f = await requestRender(project, 'final');
    await services.runner.idle();
    v = (await call<RenderView>('GET', `/api/renders/${f.body.render.id}`)).body;
    expect(v.render).toMatchObject({
      status: 'succeeded',
      kind: 'final',
      width: 1080,
      height: 1920,
    });
    const dirs = exportDirs();
    expect(dirs).toHaveLength(1);
    const dir = path.join(config.paths.exports, dirs[0]!);
    expect(readdirSync(dir).sort()).toEqual(['clip.mp4', 'clip.srt', 'render.json']);
    const srt = readFileSync(path.join(dir, 'clip.srt'), 'utf8');
    expect(srt).toContain('[Coéquipier 1]');
    expect(srt).not.toContain('Théo');
    expect(srt).not.toContain('SECRET');
    const meta = readFileSync(path.join(dir, 'render.json'), 'utf8');
    expect(meta).not.toContain(config.paths.storage);
    expect(meta).not.toContain('original');
    expect(meta).not.toMatch(/confiance|tenter/u);
    expect(JSON.parse(meta)).toMatchObject({ kind: 'final', audio: { loudnormLufs: -14 } });
    const dl = await call('GET', `/api/renders/${f.body.render.id}/download`);
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-disposition'])).toMatch(
      /^attachment; filename="\d{4}-\d{2}-\d{2}_[a-z0-9-]+_[0-9a-f]{8}\.mp4"/u,
    );
    const srtRoute = await call('GET', `/api/renders/${f.body.render.id}/subtitles.srt`);
    expect(srtRoute.status).toBe(200);
    expect(existsSync(path.join(config.paths.exports, '.staging', f.body.render.id))).toBe(false);
    expect(sha(video)).toBe(before);
  }, 240_000);

  it('consentement : micro devenu non autorisé ⇒ rendu refusé (422), aucun fichier', async () => {
    const video = await setup();
    const { rec, project } = await prepare(video);
    await call('POST', `/api/recordings/${rec.id}/export-audio`, {
      requestId: randomUUID(),
      kind: 'declaration',
      subject: 'mic_composition',
      payload: { creatorVoice: 'present', otherVoices: 'present' },
    });
    const r = await requestRender(project, 'final');
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe('EXPORT_CONSENT_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip_renders').get()).toEqual({ n: 0 });
  }, 240_000);

  it('décision refusée : demande refusée ; rendu en file annulé par la revue ; aucun export', async () => {
    const video = await setup();
    const { clip, project } = await prepare(video);
    // Rendu demandé puis refus avant son exécution (le runner est occupé par un autre rendu).
    const a = await requestRender(project, 'preview');
    const b = await requestRender(project, 'final');
    reject(clip);
    await services.runner.idle();
    const status = (id: string) =>
      db.prepare('SELECT status, error_code FROM clip_renders WHERE id = ?').get(id) as {
        status: string;
        error_code: string;
      };
    expect(['cancelled', 'failed']).toContain(status(b.body.render.id).status);
    expect(['cancelled', 'failed', 'succeeded']).toContain(status(a.body.render.id).status);
    expect(exportDirs()).toEqual([]);
    const again = await requestRender(project, 'final');
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('PROPOSAL_NOT_ACCEPTED');
  }, 240_000);

  it('publication sous verrou : refus juste avant la publication ⇒ aucun export ; verrou tenu pendant la publication', async () => {
    const video = await setup();
    const { clip, project } = await prepare(video);
    // 1. Refus enregistré entre la fin du rendu et la publication.
    services.renders.hooks.beforePublishLock = () => {
      reject(clip);
    };
    const r1 = await requestRender(project, 'final');
    await services.runner.idle();
    const row1 = db
      .prepare('SELECT status, error_code FROM clip_renders WHERE id = ?')
      .get(r1.body.render.id);
    expect(row1).toEqual({ status: 'failed', error_code: 'PROPOSAL_NOT_ACCEPTED' });
    expect(exportDirs()).toEqual([]);
    expect(readdirSync(path.join(config.paths.exports, '.staging'))).toEqual([]);

    // 2. Réacceptée : pendant la transaction de publication, une AUTRE connexion (comme le CLI)
    //    ne peut pas prendre le verrou d'écriture : décision et publication sont ordonnées.
    services.review.decide(clip, { requestId: randomUUID(), decision: 'accepted' }, 'cli');
    delete services.renders.hooks.beforePublishLock;
    let lockedOut = false;
    services.renders.hooks.beforeCommit = () => {
      const other = new Database(dbFile);
      other.pragma('busy_timeout = 50');
      try {
        other.prepare('BEGIN IMMEDIATE').run();
        other.prepare('ROLLBACK').run();
      } catch (err) {
        lockedOut = /locked|busy/iu.test(String(err));
      } finally {
        other.close();
      }
    };
    const r2 = await requestRender(project, 'final');
    await services.runner.idle();
    expect(lockedOut).toBe(true);
    expect(
      db.prepare('SELECT status FROM clip_renders WHERE id = ?').get(r2.body.render.id),
    ).toEqual({ status: 'succeeded' });
    expect(exportDirs()).toHaveLength(1);
    services.renders.hooks = {};
  }, 300_000);

  it('échec de la validation après le renommage : renommage inverse, aucun export ; récupération au démarrage', async () => {
    const video = await setup();
    const { clip, project } = await prepare(video);
    services.renders.hooks.beforeCommit = () => {
      throw new Error('panne simulée avant COMMIT');
    };
    const r = await requestRender(project, 'final');
    await services.runner.idle();
    services.renders.hooks = {};
    expect(exportDirs()).toEqual([]);
    expect(
      (
        db.prepare('SELECT status FROM clip_renders WHERE id = ?').get(r.body.render.id) as {
          status: string;
        }
      ).status,
    ).toBe('failed');

    // Rendu réussi, puis on reconstitue les états d'un arrêt brutal pour la récupération.
    const ok = await requestRender(project, 'final');
    await services.runner.idle();
    const row = db.prepare('SELECT * FROM clip_renders WHERE id = ?').get(ok.body.render.id) as {
      staging_rel_path: string;
      output_rel_path: string;
    };
    const dest = path.dirname(path.join(config.paths.storage, row.output_rel_path));
    const staging = path.join(config.paths.storage, row.staging_rel_path);
    const setFinalizing = () =>
      db
        .prepare(`UPDATE clip_renders SET status = 'finalizing' WHERE id = ?`)
        .run(ok.body.render.id);
    const status = () =>
      (
        db.prepare('SELECT status FROM clip_renders WHERE id = ?').get(ok.body.render.id) as {
          status: string;
        }
      ).status;

    // a) Arrêt entre le renommage et le COMMIT, décision toujours acceptée : validé.
    setFinalizing();
    expect(await services.renders.recoverFinalizing()).toMatchObject({ published: 1 });
    expect(status()).toBe('succeeded');
    // b) Arrêt avant le renommage (fichiers en attente seulement) : publication reprise.
    renameSync(dest, staging);
    setFinalizing();
    expect(await services.renders.recoverFinalizing()).toMatchObject({ published: 1 });
    expect(existsSync(dest)).toBe(true);
    // c) Arrêt entre le renommage et le COMMIT, décision refusée entre-temps (CLI) : retiré.
    setFinalizing();
    reject(clip);
    expect(await services.renders.recoverFinalizing()).toMatchObject({ withdrawn: 1 });
    expect(existsSync(dest)).toBe(false);
    expect(status()).toBe('failed');
  }, 300_000);

  it('récupération : un accord retiré (ou la confidentialité modifiée) après le passage en « finalizing » empêche TOUTE publication', async () => {
    const video = await setup();
    const { rec, project } = await prepare(video);
    const audio = (body: Record<string, unknown>) =>
      call('POST', `/api/recordings/${rec.id}/export-audio`, { requestId: randomUUID(), ...body });
    const discord = (action: 'granted' | 'revoked') =>
      audio({ kind: 'consent', subject: 'discord_voices', action });
    const mic = (otherVoices: 'present' | 'absent') =>
      audio({
        kind: 'declaration',
        subject: 'mic_composition',
        payload: { creatorVoice: 'present', otherVoices },
      });
    const rev = () =>
      (
        db.prepare('SELECT current_revision AS r FROM clip_projects WHERE id = ?').get(project) as {
          r: number;
        }
      ).r;
    const patch = (changes: Record<string, unknown>) =>
      call('PATCH', `/api/clip-projects/${project}`, {
        requestId: randomUUID(),
        baseRevision: rev(),
        changes,
      });

    // Clip avec micro + Discord, sous-titres micro + Discord (accord Discord donné).
    await discord('granted');
    expect(
      (
        await patch({
          audio: { tracks: [{ audioIndex: 1 }] },
          captions: { enabled: true, sources: ['mic', 'discord'] },
        })
      ).status,
    ).toBe(200);

    /** Rendu final réussi, puis état reconstitué d'un arrêt pendant la publication. */
    const crashed = async (where: 'apres-renommage' | 'avant-renommage') => {
      const r = await requestRender(project, 'final');
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      await services.runner.idle();
      const row = db.prepare('SELECT * FROM clip_renders WHERE id = ?').get(r.body.render.id) as {
        id: string;
        status: string;
        staging_rel_path: string;
        output_rel_path: string;
      };
      expect(row.status).toBe('succeeded');
      const dest = path.dirname(path.join(config.paths.storage, row.output_rel_path));
      const staging = path.join(config.paths.storage, row.staging_rel_path);
      if (where === 'avant-renommage') renameSync(dest, staging);
      db.prepare(`UPDATE clip_renders SET status = 'finalizing' WHERE id = ?`).run(row.id);
      return { id: row.id, dest, staging };
    };
    const after = (c: { id: string; dest: string; staging: string }) => ({
      ...(db
        .prepare('SELECT status, error_code FROM clip_renders WHERE id = ?')
        .get(c.id) as object),
      dest: existsSync(c.dest),
      staging: existsSync(c.staging),
    });

    // 1. Micro : des tiers sont désormais déclarés dans le micro, sans accord « autres voix ».
    let c = await crashed('apres-renommage');
    await mic('present');
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      withdrawn: 1,
    });
    expect(after(c)).toEqual({
      status: 'failed',
      error_code: 'EXPORT_CONSENT_REQUIRED',
      dest: false,
      staging: false,
    });
    await mic('absent');

    // 2. Discord (audio et sous-titres) : accord retiré, arrêt AVANT le renommage.
    c = await crashed('avant-renommage');
    await discord('revoked');
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      withdrawn: 1,
    });
    expect(after(c)).toEqual({
      status: 'failed',
      error_code: 'EXPORT_CONSENT_REQUIRED',
      dest: false,
      staging: false,
    });
    await discord('granted');

    // 3. Sous-titres Discord seuls (piste Discord désactivée) : accord retiré ⇒ jamais publié.
    expect((await patch({ audio: { tracks: [{ audioIndex: 1, enabled: false }] } })).status).toBe(
      200,
    );
    c = await crashed('apres-renommage');
    await discord('revoked');
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      withdrawn: 1,
    });
    expect(after(c)).toEqual({
      status: 'failed',
      error_code: 'EXPORT_CONSENT_REQUIRED',
      dest: false,
      staging: false,
    });
    expect(
      String(
        (
          db.prepare('SELECT error_message FROM clip_renders WHERE id = ?').get(c.id) as {
            error_message: string;
          }
        ).error_message,
      ),
    ).toMatch(/Sous-titres non autorisés|Accords/u);
    await discord('granted');

    // 4. Fichier de confidentialité modifié depuis le rendu ⇒ jamais publié.
    c = await crashed('apres-renommage');
    writeFileSync(
      config.analysis.privacyFile,
      JSON.stringify({
        schemaVersion: 1,
        pseudonyms: [{ names: ['Théo', 'Teo'], label: 'Coéquipier 1' }],
      }),
    );
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      withdrawn: 1,
    });
    expect(after(c)).toEqual({
      status: 'failed',
      error_code: 'VERSION_CONFLICT',
      dest: false,
      staging: false,
    });

    // 5. Contenu en attente altéré alors que tout est valide ⇒ quarantaine (jamais publié, jamais supprimé).
    c = await crashed('avant-renommage');
    writeFileSync(path.join(c.staging, 'clip.mp4'), 'altéré');
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      quarantined: 1,
    });
    expect(after(c)).toMatchObject({
      status: 'failed',
      error_code: 'RENDER_FAILED',
      dest: false,
      staging: false,
    });
    expect(
      existsSync(path.join(config.paths.exports, '.staging', 'quarantine', c.id, 'clip.mp4')),
    ).toBe(true);

    // 6. Témoin : rien n'a changé ⇒ publié.
    c = await crashed('apres-renommage');
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 1,
      withdrawn: 0,
    });
    expect(after(c)).toEqual({ status: 'succeeded', error_code: null, dest: true, staging: false });
    // Seul le témoin est un export ; aucun résidu hors quarantaine dans la zone d'attente.
    expect(exportDirs()).toEqual([path.basename(c.dest)]);
    expect(readdirSync(path.join(config.paths.exports, '.staging')).sort()).toEqual(['quarantine']);
  }, 600_000);

  it('confidentialité modifiée ENTRE le recalcul du plan et la publication : jamais publié (récupération et rendu normal)', async () => {
    const video = await setup();
    const { rec, project } = await prepare(video);
    const original = readFileSync(config.analysis.privacyFile);
    const touchPrivacy = () =>
      writeFileSync(
        config.analysis.privacyFile,
        JSON.stringify({
          schemaVersion: 1,
          pseudonyms: [{ names: ['Théo', 'Théodore'], label: 'Coéquipier 1' }],
        }),
      );
    const crashed = async (where: 'apres-renommage' | 'avant-renommage') => {
      const r = await requestRender(project, 'final');
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      await services.runner.idle();
      const row = db.prepare('SELECT * FROM clip_renders WHERE id = ?').get(r.body.render.id) as {
        id: string;
        staging_rel_path: string;
        output_rel_path: string;
      };
      const dest = path.dirname(path.join(config.paths.storage, row.output_rel_path));
      const staging = path.join(config.paths.storage, row.staging_rel_path);
      if (where === 'avant-renommage') renameSync(dest, staging);
      db.prepare(`UPDATE clip_renders SET status = 'finalizing' WHERE id = ?`).run(row.id);
      return { id: row.id, dest, staging };
    };
    const state = (c: { id: string; dest: string; staging: string }) => ({
      ...(db
        .prepare('SELECT status, error_code, error_message FROM clip_renders WHERE id = ?')
        .get(c.id) as object),
      dest: existsSync(c.dest),
      staging: existsSync(c.staging),
    });

    // 1. Récupération, arrêt après le renommage : le plan recalculé est identique, puis le fichier
    //    change juste avant la transaction ⇒ refus SOUS LE VERROU, fichier retiré.
    let c = await crashed('apres-renommage');
    let plansChecked = 0;
    services.renders.hooks.beforeRecoveryLock = () => {
      plansChecked++;
      touchPrivacy();
    };
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      withdrawn: 1,
    });
    expect(plansChecked).toBe(1);
    expect(state(c)).toMatchObject({
      status: 'failed',
      error_code: 'VERSION_CONFLICT',
      error_message: expect.stringMatching(/confidentialité modifié pendant la récupération/u),
      dest: false,
      staging: false,
    });
    writeFileSync(config.analysis.privacyFile, original);

    // 2. Même course, arrêt AVANT le renommage : zone d'attente supprimée, jamais publiée.
    c = await crashed('avant-renommage');
    services.renders.hooks.beforeRecoveryLock = touchPrivacy;
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      withdrawn: 1,
    });
    expect(state(c)).toMatchObject({
      status: 'failed',
      error_code: 'VERSION_CONFLICT',
      dest: false,
      staging: false,
    });
    writeFileSync(config.analysis.privacyFile, original);

    // 3. Même course pour les accords audio (déjà revérifiés sous verrou) : micro devenu non autorisé.
    c = await crashed('apres-renommage');
    services.renders.hooks.beforeRecoveryLock = () =>
      void services.exportAudio.record(
        rec.id,
        {
          requestId: randomUUID(),
          kind: 'declaration',
          subject: 'mic_composition',
          payload: { creatorVoice: 'present', otherVoices: 'present' },
        },
        'cli',
      );
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 0,
      withdrawn: 1,
    });
    expect(state(c)).toMatchObject({
      status: 'failed',
      error_code: 'EXPORT_CONSENT_REQUIRED',
      dest: false,
    });
    services.exportAudio.record(
      rec.id,
      {
        requestId: randomUUID(),
        kind: 'declaration',
        subject: 'mic_composition',
        payload: { creatorVoice: 'present', otherVoices: 'absent' },
      },
      'cli',
    );

    // 4. Rendu normal : fichier modifié après la dernière vérification asynchrone, avant le verrou.
    services.renders.hooks = { beforePublishLock: touchPrivacy };
    const r = await requestRender(project, 'final');
    await services.runner.idle();
    expect(
      db.prepare('SELECT status, error_code FROM clip_renders WHERE id = ?').get(r.body.render.id),
    ).toEqual({
      status: 'failed',
      error_code: 'VERSION_CONFLICT',
    });
    writeFileSync(config.analysis.privacyFile, original);

    // 5. Témoin : point d'arrêt sans modification ⇒ publié.
    services.renders.hooks = {};
    c = await crashed('apres-renommage');
    services.renders.hooks.beforeRecoveryLock = () => undefined;
    expect(await services.renders.recoverFinalizing()).toMatchObject({
      published: 1,
      withdrawn: 0,
    });
    expect(state(c)).toMatchObject({ status: 'succeeded', dest: true, staging: false });
    services.renders.hooks = {};
    expect(exportDirs()).toEqual([path.basename(c.dest)]);
  }, 600_000);

  it('nettoyage : un aperçu est évincé ; ni un rendu actif, ni un export final ne sont touchés', async () => {
    const video = await setup();
    const { project } = await prepare(video);
    const p = await requestRender(project, 'preview');
    const f = await requestRender(project, 'final');
    await services.runner.idle();
    // Rendu « en cours » simulé, avec ses fichiers de travail.
    const active = randomUUID();
    db.prepare(
      `INSERT INTO clip_renders (id, project_id, revision, kind, status, plan_hash) VALUES (?, ?, 1, 'preview', 'running', 'actif')`,
    ).run(active, project);
    const work = path.join(config.paths.processing, 'renders', 'tmp', active);
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, 'clip.mp4.part'), 'x');
    const report = await services.storage.clean({
      dryRun: false,
      evictAllCache: true,
      orphanGraceMs: 0,
    });
    expect(report.items.some((i) => i.relPath.includes(active))).toBe(false);
    expect(existsSync(path.join(work, 'clip.mp4.part'))).toBe(true);
    const statusOf = (id: string) =>
      (db.prepare('SELECT status FROM clip_renders WHERE id = ?').get(id) as { status: string })
        .status;
    expect(statusOf(p.body.render.id)).toBe('evicted');
    expect(statusOf(f.body.render.id)).toBe('succeeded');
    expect(readdirSync(path.join(config.paths.exports, exportDirs()[0]!))).toContain('clip.mp4');
    expect((await call('GET', `/api/renders/${p.body.render.id}/video`)).status).toBe(409);
    expect(() =>
      db.prepare(`UPDATE clip_renders SET status = 'evicted' WHERE id = ?`).run(f.body.render.id),
    ).toThrow(/CHECK/);
  }, 300_000);

  it('image fixe et effets proposés (révision système, mode enrichi)', async () => {
    const video = await setup();
    const { project } = await prepare(video);
    const img = await call('GET', `/api/clip-projects/${project}/frame?atEditMs=1000`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.raw.subarray(0, 2).toString('hex')).toBe('ffd8');
    await call('PATCH', `/api/clip-projects/${project}`, {
      requestId: randomUUID(),
      baseRevision: 1,
      changes: { mode: 'enrichi' },
    });
    const s = await call<{ revision: number; suggested: { type: string; reason: string }[] }>(
      'POST',
      `/api/clip-projects/${project}/effects/suggest`,
      { requestId: randomUUID(), baseRevision: 2 },
    );
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.revision).toBe(3);
    expect(s.body.suggested[0]?.type).toBe('caption_emphasis');
    const revs = await call<{ revisions: { source: string }[] }>(
      'GET',
      `/api/clip-projects/${project}/revisions`,
    );
    expect(revs.body.revisions.at(-1)!.source).toBe('system');
  }, 240_000);

  /* ------------------------------ Étape 6c ------------------------------ */

  interface ProjectBody {
    revision: number;
    documentHash: string;
    editable: boolean;
    document: {
      audio: { tracks: { audioIndex: number; role: string; enabled: boolean }[] };
      effects: { id: string; type: string; enabled: boolean; origin: string }[];
    };
    audio: { selected: { audioIndex: number; role: string }[] };
    error?: { code: string };
  }
  const patch = (project: string, baseRevision: number, changes: Record<string, unknown>) =>
    call<ProjectBody>('PATCH', `/api/clip-projects/${project}`, {
      requestId: randomUUID(),
      baseRevision,
      changes,
    });
  const consent = (rec: string, action: 'granted' | 'revoked') =>
    call('POST', `/api/recordings/${rec}/export-audio`, {
      requestId: randomUUID(),
      kind: 'consent',
      subject: 'discord_voices',
      action,
    });

  it('6c : liste avec lecture seule et dernier rendu ; ajout de piste selon l’autorisation du serveur', async () => {
    const video = await setup();
    const { rec, clip, project } = await prepare(video);
    type ListBody = {
      items: {
        proposal: { id: string };
        readOnly: boolean;
        decision: string;
        project: { id: string; lastRender: { id: string; kind: string; status: string } | null };
      }[];
    };
    let l = (await call<ListBody>('GET', `/api/recordings/${rec.id}/clips`)).body;
    let item = l.items.find((i) => i.project?.id === project)!;
    expect(item).toMatchObject({ readOnly: false, decision: 'accepted' });
    expect(item.project.lastRender).toBeNull();

    // Discord (piste 1) : non autorisé ⇒ ajout refusé par le serveur.
    let v = (await call<ProjectBody>('GET', `/api/clip-projects/${project}`)).body;
    expect(v.document.audio.tracks.map((t) => t.audioIndex)).toEqual([0]);
    expect(v.audio.selected.map((t) => t.audioIndex)).toEqual([0]);
    let r = await patch(project, v.revision, {
      audio: { tracks: [{ audioIndex: 1, enabled: true }] },
    });
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe('EXPORT_CONSENT_REQUIRED');
    // Accord donné : la piste devient autorisée, l'ajout explicite est accepté.
    await consent(rec.id, 'granted');
    v = (await call<ProjectBody>('GET', `/api/clip-projects/${project}`)).body;
    expect(v.audio.selected.map((t) => t.audioIndex)).toEqual([0, 1]);
    r = await patch(project, v.revision, { audio: { tracks: [{ audioIndex: 1, enabled: true }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.document.audio.tracks.map((t) => [t.audioIndex, t.enabled])).toEqual([
      [0, true],
      [1, true],
    ]);
    // Retrait, puis accord révoqué : réactivation refusée (décision relue sous verrou).
    r = await patch(project, r.body.revision, {
      audio: { tracks: [{ audioIndex: 1, enabled: false }] },
    });
    expect(r.status).toBe(200);
    await consent(rec.id, 'revoked');
    const refused = await patch(project, r.body.revision, {
      audio: { tracks: [{ audioIndex: 1, enabled: true }] },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe('EXPORT_CONSENT_REQUIRED');

    // Dernier rendu dans la liste ; décision changée ⇒ projet toujours listé, en lecture seule.
    const p = await requestRender(project, 'preview');
    await services.runner.idle();
    l = (await call<ListBody>('GET', `/api/recordings/${rec.id}/clips`)).body;
    item = l.items.find((i) => i.project?.id === project)!;
    expect(item.project.lastRender).toEqual({
      id: p.body.render.id,
      kind: 'preview',
      status: 'succeeded',
    });
    reject(clip);
    l = (await call<ListBody>('GET', `/api/recordings/${rec.id}/clips`)).body;
    item = l.items.find((i) => i.project?.id === project)!;
    expect(item).toMatchObject({ readOnly: true, decision: 'rejected' });
    expect(item.proposal.id).toBe(clip);
    expect(l.items.filter((i) => i.project?.id === project)).toHaveLength(1);
    expect((await call<ProjectBody>('GET', `/api/clip-projects/${project}`)).body.editable).toBe(
      false,
    );
  }, 300_000);

  it('6c : effets proposés désactivés, choix existants conservés, révisions antérieures intactes', async () => {
    const video = await setup();
    const { project } = await prepare(video);
    let v = (await patch(project, 1, { mode: 'enrichi' })).body;
    const suggest = (base: number) =>
      call<{ revision: number; suggested: { id: string; enabled: boolean }[] }>(
        'POST',
        `/api/clip-projects/${project}/effects/suggest`,
        { requestId: randomUUID(), baseRevision: base },
      );
    const s1 = await suggest(v.revision);
    expect(s1.status).toBe(200);
    expect(s1.body.suggested.length).toBeGreaterThan(0);
    expect(s1.body.suggested.every((e) => !e.enabled)).toBe(true);
    v = (await call<ProjectBody>('GET', `/api/clip-projects/${project}`)).body;
    expect(v.document.effects.every((e) => !e.enabled)).toBe(true);
    // Le créateur active le premier effet ; une nouvelle proposition ne change rien.
    const chosen = v.document.effects[0]!.id;
    v = (await patch(project, v.revision, { effects: [{ id: chosen, enabled: true }] })).body;
    const hashBefore = v.documentHash;
    const revBefore = v.revision;
    const s2 = await suggest(v.revision);
    expect(s2.status).toBe(200);
    v = (await call<ProjectBody>('GET', `/api/clip-projects/${project}`)).body;
    expect(v.document.effects.map((e) => [e.id, e.enabled])).toEqual(
      v.document.effects.map((e) => [e.id, e.id === chosen]),
    );
    // Révision précédente jamais réécrite.
    const old = db
      .prepare(
        'SELECT document_hash FROM clip_project_revisions WHERE project_id = ? AND revision = ?',
      )
      .get(project, revBefore) as { document_hash: string };
    expect(old.document_hash).toBe(hashBefore);
  }, 300_000);

  it('6c : image fixe — demande remplacée, plafond global, client déconnecté (FFmpeg non mené à terme)', async () => {
    const video = await setup();
    const { rec, project } = await prepare(video);
    // Second projet (moment secondaire) pour le plafond global.
    const l = await call<{ items: { proposal: { id: string; tier: string } }[] }>(
      'GET',
      `/api/recordings/${rec.id}/proposals`,
    );
    const second = l.body.items.find((i) => i.proposal.tier !== 'clip')!.proposal.id;
    await call('POST', `/api/proposals/${second}/decision`, {
      requestId: randomUUID(),
      decision: 'accepted',
    });
    const projectB = (
      await call<{ project: { id: string } }>('POST', `/api/proposals/${second}/clip-project`, {
        requestId: randomUUID(),
      })
    ).body.project.id;
    expect(projectB).not.toBe(project);
    const tmpDir = path.join(config.paths.processing, 'renders', 'tmp');
    const images = () =>
      existsSync(tmpDir) ? readdirSync(tmpDir).filter((d) => d.startsWith('image-')) : [];
    const jpeg = (b: Buffer) => b.subarray(0, 2).toString('hex') === 'ffd8';

    // 1. Deux demandes sur le même projet : la première est arrêtée, la seconde aboutit.
    const first = services.renders.frame(project, 0);
    const again = services.renders.frame(project, 1000);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(jpeg(await again)).toBe(true);
    expect(services.renders.activeFrameGenerations()).toBe(0);

    // Générations bloquées juste avant FFmpeg (signal observé).
    const gates: { id: string; signal: AbortSignal; open: () => void }[] = [];
    services.renders.hooks.beforeFrameProcess = (id, signal) =>
      new Promise<void>((open) => gates.push({ id, signal, open }));
    try {
      // 2. Le signal d'arrêt atteint FFmpeg : une génération remplacée n'est pas menée à terme.
      const a = services.renders.frame(project, 0);
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      const b = services.renders.frame(project, 0);
      expect(gates[0]!.signal.aborted).toBe(true);
      gates[0]!.open();
      await expect(a).rejects.toMatchObject({ code: 'CANCELLED' });
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1]!.open();
      expect(jpeg(await b)).toBe(true);

      // 3. Plafond global (2) : deux projets en cours ⇒ la limite est atteinte ; plafond 1 ⇒ refus.
      const pa = services.renders.frame(project, 0);
      const pb = services.renders.frame(projectB, 0);
      await vi.waitFor(() => expect(gates).toHaveLength(4));
      expect(services.renders.activeFrameGenerations()).toBe(2);
      gates[2]!.open();
      gates[3]!.open();
      expect(jpeg(await pa)).toBe(true);
      expect(jpeg(await pb)).toBe(true);
      services.renders.maxFrameGenerations = 1;
      const held = services.renders.frame(project, 0);
      await vi.waitFor(() => expect(gates).toHaveLength(5));
      const busy = await call<{ error: { code: string } }>(
        'GET',
        `/api/clip-projects/${projectB}/frame`,
      );
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('CONFLICT');
      expect(gates).toHaveLength(5); // aucune génération lancée pour le refus
      gates[4]!.open();
      expect(jpeg(await held)).toBe(true);
      services.renders.maxFrameGenerations = 2;

      // 4. Client HTTP déconnecté avant la réponse : le serveur arrête la génération.
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const req = http.get(`${address}/api/clip-projects/${project}/frame`);
      req.on('error', () => undefined);
      await vi.waitFor(() => expect(gates).toHaveLength(6), { timeout: 10_000 });
      expect(gates[5]!.signal.aborted).toBe(false);
      req.destroy();
      await vi.waitFor(() => expect(gates[5]!.signal.aborted).toBe(true), { timeout: 10_000 });
      gates[5]!.open();
      await vi.waitFor(() => expect(services.renders.activeFrameGenerations()).toBe(0));
      await vi.waitFor(() => expect(images()).toEqual([]));
    } finally {
      delete services.renders.hooks.beforeFrameProcess;
      services.renders.maxFrameGenerations = 2;
    }
  }, 300_000);
});
