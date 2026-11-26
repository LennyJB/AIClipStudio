/**
 * Moteur multi-segments branché sur le journal (étape 7, PR 7c) de bout en bout par l'API : FFmpeg
 * réel, transcription simulée, faux modèle (aucun appel à Claude), base SQLite sur fichier.
 *
 *  - nouveaux projets : fenêtre éditable ±EDITOR_WINDOW_MARGIN_SEC couverte par le manifeste ;
 *  - rendu du DOCUMENT V2 (coupes, arrêt sur image, vide) avec point de contrôle à la version ;
 *  - image exacte pendant un arrêt sur image et un vide ;
 *  - élargissement de la fenêtre : nouveau manifeste construit par le serveur, sous-titres de la
 *    zone ajoutée, lots de l'interface refusés, manifeste revérifié au rendu.
 * La piste unique « Tout » est couverte par le moteur (multi-segment.integration.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeModel } from '@acs/editorial';
import type { ClipProjectV2 } from '@acs/timeline';
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
let config: AppConfig;
const apps: FastifyInstance[] = [];

interface Instance {
  app: FastifyInstance;
  services: Services;
  db: Db;
}

async function setup(env: Record<string, string> = {}): Promise<{ video: string; inst: Instance }> {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-montage-'));
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
      ...env,
    },
    ROOT_DIR,
  );
  const db = openDatabase(path.join(storage, 'base.sqlite'));
  const { app, services } = buildApp({ config, db, model: new FakeModel(scenarioScript) });
  apps.push(app);
  const video = path.join(storage, 'original.mkv');
  copyFileSync(master, video);
  return { video, inst: { app, services, db } };
}

const caller =
  (app: FastifyInstance) =>
  async <T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: Record<string, unknown>,
  ) => {
    const res = await app.inject(
      payload === undefined ? { method, url } : { method, url, payload },
    );
    let body: T;
    try {
      body = res.json<T>();
    } catch {
      body = res.body as T;
    }
    return { status: res.statusCode, body, headers: res.headers, raw: res.rawPayload };
  };

interface ErrorBody {
  error?: { code: string; message: string };
}
interface DocBody extends ErrorBody {
  version: number;
  document: ClipProjectV2;
}

/** Import, transcription, analyse, acceptation, micro déclaré, projet créé. */
async function prepare(inst: Instance, video: string) {
  const call = caller(inst.app);
  const rec = (await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video }))
    .body.recording;
  await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await inst.services.runner.idle();
  await call('POST', `/api/recordings/${rec.id}/analyses`, {
    mode: 'claude',
    acceptBudgetUsd: config.analysis.maxCostUsd,
    review: false,
  });
  await inst.services.runner.idle();
  const l = await call<{
    items: { proposal: { id: string; tier: string; srcStartMs: number; srcEndMs: number } }[];
  }>('GET', `/api/recordings/${rec.id}/proposals`);
  const proposal = l.body.items.find((i) => i.proposal.tier === 'clip')!.proposal;
  await call('POST', `/api/proposals/${proposal.id}/decision`, {
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
    await call<{ project: { id: string } }>('POST', `/api/proposals/${proposal.id}/clip-project`, {
      requestId: randomUUID(),
    })
  ).body.project.id;
  const t = tools(inst, project);
  return { rec, proposal, project, ...t };
}

const tools = (inst: Instance, project: string) => {
  const call = caller(inst.app);
  return {
    call,
    doc: async () => (await call<DocBody>('GET', `/api/clip-projects/${project}/document`)).body,
    edit: (body: Record<string, unknown>) =>
      call<ErrorBody & { version: number }>('POST', `/api/clip-projects/${project}/edits`, {
        requestId: randomUUID(),
        ...body,
      }),
    render: async (kind: 'preview' | 'final' = 'preview') => {
      const r = await call<ErrorBody & { render: { id: string } }>(
        'POST',
        `/api/clip-projects/${project}/renders`,
        { requestId: randomUUID(), kind },
      );
      await inst.services.runner.idle();
      return r;
    },
    manifest: (id: string) =>
      inst.db
        .prepare(
          'SELECT recording_id, window_start_ms, window_end_ms, sha256 FROM source_integrity_manifests WHERE id = ?',
        )
        .get(id) as
        | { recording_id: string; window_start_ms: number; window_end_ms: number; sha256: string }
        | undefined,
    renderRow: (id: string) =>
      inst.db
        .prepare(
          'SELECT status, revision, duration_ms, error_code, error_message FROM clip_renders WHERE id = ?',
        )
        .get(id) as {
        status: string;
        revision: number;
        duration_ms: number | null;
        error_code: string | null;
        error_message: string | null;
      },
  };
};

describe.skipIf(!enabled)('Moteur multi-segments par l’API (étape 7c)', () => {
  beforeAll(() => {
    master = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-montage-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  it('nouveau projet : fenêtre éditable = proposition ± EDITOR_WINDOW_MARGIN_SEC, couverte par le manifeste ; sous-titres préparés sur la fenêtre', async () => {
    const { video, inst } = await setup({ EDITOR_WINDOW_MARGIN_SEC: '45' });
    const t = await prepare(inst, video);
    const d = await t.doc();
    const w = d.document.source.editWindow;
    expect(w).toMatchObject({
      srcStartMs: Math.max(0, t.proposal.srcStartMs - 45_000),
      srcEndMs: Math.min(180_000, t.proposal.srcEndMs + 45_000),
    });
    expect(t.manifest(w.integrityManifestId)).toMatchObject({
      recording_id: t.rec.id,
      window_start_ms: w.srcStartMs,
      window_end_ms: w.srcEndMs,
    });
    for (const i of d.document.captions.items) {
      expect(i.srcStartMs).toBeGreaterThanOrEqual(w.srcStartMs);
      expect(i.srcEndMs).toBeLessThanOrEqual(w.srcEndMs);
    }
    // L'interface de l'étape 6 lit toujours le projet (projection v1 exacte).
    expect((await t.call('GET', `/api/clip-projects/${t.project}`)).status).toBe(200);
  }, 300_000);

  it('montage du journal rendu : coupe, arrêt sur image, vide ; version du plan = tête ; image exacte pendant l’arrêt et le vide', async () => {
    const { video, inst } = await setup();
    const t = await prepare(inst, video);
    const d0 = await t.doc();
    const seg = d0.document.segments[0]!;
    if (seg.kind !== 'source') throw new Error('segment source attendu');
    const mid = Math.round((seg.srcStartMs + seg.srcEndMs) / 2);
    // Coupe en trois, arrêt sur image dans la première partie, la partie du milieu devient un vide.
    const r1 = await t.edit({
      base: { version: d0.version },
      kind: 'do',
      ops: [
        { type: 'splitSegment', segmentId: seg.id, atSrcMs: mid, newId: 'fin' },
        { type: 'splitSegment', segmentId: seg.id, atSrcMs: mid - 4000, newId: 'milieu' },
        { type: 'liftDelete', segmentId: 'milieu', gapId: 'vide' },
        {
          type: 'insertFreeze',
          segmentId: seg.id,
          atSrcMs: seg.srcStartMs + 2000,
          freezeId: 'arret',
          newId: 'suite',
          editDurMs: 1500,
        },
      ],
    });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const d1 = await t.doc();
    expect(d1.document.segments.map((s) => s.kind)).toEqual([
      'source',
      'freeze',
      'source',
      'gap',
      'source',
    ]);
    // L'interface 6c ne peut pas représenter un vide : refus explicite ; le moteur, lui, le rend.
    const v6 = await t.call<ErrorBody>('GET', `/api/clip-projects/${t.project}`);
    expect(v6.body.error?.code).toBe('EDITOR_REQUIRED');

    const r = await t.render('preview');
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const row = t.renderRow(r.body.render.id);
    expect(row, row.error_message ?? '').toMatchObject({
      status: 'succeeded',
      revision: d1.version,
    });
    const total = d1.document.segments.reduce(
      (n, s) => n + (s.kind === 'source' ? s.srcEndMs - s.srcStartMs : s.editDurMs),
      0,
    );
    expect(Math.abs(row.duration_ms! - total)).toBeLessThanOrEqual(600); // source à 2 i/s
    // Point de contrôle à la version rendue (révision immuable v2).
    expect(
      inst.db
        .prepare(
          'SELECT schema_version FROM clip_project_revisions WHERE project_id = ? AND revision = ?',
        )
        .get(t.project, d1.version),
    ).toEqual({ schema_version: 2 });

    // Image exacte pendant l'arrêt sur image (2,0–3,5 s) et pendant le vide.
    const firstLen = 2000;
    const gapAt = firstLen + 1500 + (mid - 4000 - (seg.srcStartMs + 2000)) + 1000;
    for (const at of [2600, gapAt]) {
      const img = await t.call('GET', `/api/clip-projects/${t.project}/frame?atEditMs=${at}`);
      expect(img.status, `${at} ms`).toBe(200);
      expect(img.headers['content-type']).toBe('image/jpeg');
      expect(img.raw.subarray(0, 2).toString('hex')).toBe('ffd8');
    }
  }, 300_000);

  it('élargissement de la fenêtre : nouveau manifeste, sous-titres de la zone ajoutée, segment allongé au-delà, rendu ; l’interface ne peut ni élargir ni restaurer la fenêtre', async () => {
    const { video, inst } = await setup({ EDITOR_WINDOW_MARGIN_SEC: '10' });
    const t = await prepare(inst, video);
    const d0 = await t.doc();
    const w0 = d0.document.source.editWindow;
    const m0 = t.manifest(w0.integrityManifestId)!;

    // Lots de l'interface : jamais d'élargissement ni de restauration de la fenêtre.
    const forged = await t.edit({
      base: { version: d0.version },
      kind: 'do',
      ops: [
        {
          type: 'extendWindow',
          srcStartMs: 0,
          srcEndMs: 180_000,
          integrityManifestId: w0.integrityManifestId + 'x',
        },
      ],
    });
    expect(forged.body.error?.code).toBe('VALIDATION_FAILED');
    const restore = await t.edit({
      base: { version: d0.version },
      kind: 'do',
      ops: [
        {
          type: 'restore',
          entries: [{ key: 'window', value: { ...w0, srcStartMs: 0 }, expect: null }],
        },
      ],
    });
    expect(restore.body.error?.code).toBe('VALIDATION_FAILED');

    // Élargissement par la route dédiée.
    const wanted = {
      srcStartMs: Math.max(0, w0.srcStartMs - 20_000),
      srcEndMs: w0.srcEndMs + 20_000,
    };
    const requestId = randomUUID();
    const ext = await t.call<ErrorBody & { version: number; replayed: boolean }>(
      'POST',
      `/api/clip-projects/${t.project}/window`,
      { requestId, baseRevision: d0.version, ...wanted },
    );
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    expect(ext.body).toMatchObject({ version: d0.version + 1, replayed: false });
    const again = await t.call<{ version: number; replayed: boolean }>(
      'POST',
      `/api/clip-projects/${t.project}/window`,
      { requestId, baseRevision: d0.version, ...wanted },
    );
    expect(again.body).toMatchObject({ version: d0.version + 1, replayed: true });
    const mismatch = await t.call<ErrorBody>('POST', `/api/clip-projects/${t.project}/window`, {
      requestId,
      baseRevision: d0.version,
      ...wanted,
      srcEndMs: wanted.srcEndMs + 1000,
    });
    expect(mismatch.body.error?.code).toBe('IDEMPOTENCY_MISMATCH');

    const d1 = await t.doc();
    const w1 = d1.document.source.editWindow;
    expect(w1).toMatchObject(wanted);
    expect(w1.integrityManifestId).not.toBe(w0.integrityManifestId);
    expect(t.manifest(w1.integrityManifestId)).toMatchObject({
      recording_id: t.rec.id,
      window_start_ms: wanted.srcStartMs,
      window_end_ms: wanted.srcEndMs,
    });
    // Manifestes figés : l'ancien est inchangé.
    expect(t.manifest(w0.integrityManifestId)).toEqual(m0);
    // Sous-titres de la zone ajoutée (mêmes règles de découpage, identifiants propres).
    const added = d1.document.captions.items.filter((i) => i.id.includes(`-v${d1.version}-`));
    expect(added.length).toBeGreaterThan(0);
    for (const i of added) {
      expect(i.srcStartMs < w0.srcStartMs || i.srcEndMs > w0.srcEndMs).toBe(true);
    }
    expect(d1.document.captions.items.length).toBe(
      d0.document.captions.items.length + added.length,
    );

    // Segment allongé au-delà de l'ancienne fenêtre, puis rendu (manifeste revérifié).
    const seg = d1.document.segments[0]!;
    const trim = await t.edit({
      base: { version: d1.version },
      kind: 'do',
      ops: [{ type: 'trimSegment', segmentId: seg.id, srcStartMs: w0.srcStartMs - 5000 }],
    });
    expect(trim.status, JSON.stringify(trim.body)).toBe(200);
    const r = await t.render('preview');
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(t.renderRow(r.body.render.id).status).toBe('succeeded');
    // Annuler l'élargissement alors qu'un segment en dépend : refusé, rien n'est écrit.
    const undo = await t.edit({
      base: { version: trim.body.version },
      kind: 'undo',
      targetSeq: d1.version,
    });
    expect(undo.status).toBe(409);
    expect((await t.doc()).version).toBe(trim.body.version);

    // Un document dont la fenêtre n'est pas couverte par son manifeste n'est jamais rendu.
    const row = inst.services.clips.projectRow(t.project);
    const doc = (await t.doc()).document;
    expect(() =>
      inst.services.clips.windowManifest(row, {
        ...doc,
        source: {
          ...doc.source,
          editWindow: { ...doc.source.editWindow, integrityManifestId: w0.integrityManifestId },
        },
      }),
    ).toThrow(/pas couverte/);
  }, 300_000);

  it('élargissement rejoué après un second élargissement : même réponse que la première opération (version et fenêtre), replayed: true', async () => {
    const { video, inst } = await setup({ EDITOR_WINDOW_MARGIN_SEC: '10' });
    const t = await prepare(inst, video);
    const d0 = await t.doc();
    const w0 = d0.document.source.editWindow;
    interface WindowBody extends ErrorBody {
      version: number;
      replayed: boolean;
      window: { srcStartMs: number; srcEndMs: number; integrityManifestId: string };
    }
    const extend = (body: Record<string, unknown>) =>
      t.call<WindowBody>('POST', `/api/clip-projects/${t.project}/window`, body);

    // 1. Premier élargissement.
    const first = {
      requestId: randomUUID(),
      baseRevision: d0.version,
      srcStartMs: Math.max(0, w0.srcStartMs - 5000),
      srcEndMs: w0.srcEndMs + 5000,
    };
    const r1 = await extend(first);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({
      version: d0.version + 1,
      replayed: false,
      window: { srcStartMs: first.srcStartMs, srcEndMs: first.srcEndMs },
    });

    // 2. Second élargissement (nouvelle version, nouveau manifeste).
    const r2 = await extend({
      requestId: randomUUID(),
      baseRevision: r1.body.version,
      srcStartMs: Math.max(0, first.srcStartMs - 5000),
      srcEndMs: first.srcEndMs + 5000,
    });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.version).toBe(r1.body.version + 1);
    expect(r2.body.window.integrityManifestId).not.toBe(r1.body.window.integrityManifestId);
    expect((await t.doc()).document.source.editWindow).toEqual(r2.body.window);

    // 3. Rejeu de la première requête : résultat de la PREMIÈRE opération, rien n'est écrit.
    const replay = await extend(first);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toEqual({ ...r1.body, replayed: true });
    expect(replay.body.window).not.toEqual(r2.body.window);
    expect((await t.doc()).version).toBe(r2.body.version);
  }, 300_000);
});
