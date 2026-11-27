/**
 * Journal d'édition (étape 7b) de bout en bout par l'API : FFmpeg réel pour l'import, faux modèle
 * (aucun appel à Claude). Base SQLite sur FICHIER : rechargement et deuxième connexion réels.
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
import { CHECKPOINT_EVERY } from './clips/edits';
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
let dbFile: string;
const apps: FastifyInstance[] = [];

interface Instance {
  app: FastifyInstance;
  services: Services;
  db: Db;
}

function open(): Instance {
  const db = openDatabase(dbFile);
  const { app, services } = buildApp({ config, db, model: new FakeModel(scenarioScript) });
  apps.push(app);
  return { app, services, db };
}

async function setup() {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-journal-'));
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
    },
    ROOT_DIR,
  );
  dbFile = path.join(storage, 'base.sqlite');
  const video = path.join(storage, 'original.mkv');
  copyFileSync(master, video);
  return { video, inst: open() };
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
    return { status: res.statusCode, body: res.json<T>() };
  };

interface Doc {
  version: number;
  hash: string;
  editable: boolean;
  history: { undo: number | null; redo: number | null };
  document: {
    segments: { id: string }[];
    mode: string;
    masks: { id: string; mode: string }[];
    captions: { items: { id: string }[] };
    overlays: { id: string }[];
  };
}
interface EditBody {
  version: number;
  hash: string;
  replayed: boolean;
  rebased: boolean;
  history: { undo: number | null; redo: number | null };
  error?: { code: string; message: string; details?: Record<string, unknown> };
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

const tools = (inst: Instance, project: string) => {
  const call = caller(inst.app);
  return {
    call,
    doc: async () => (await call<Doc>('GET', `/api/clip-projects/${project}/document`)).body,
    edit: (body: Record<string, unknown>) =>
      call<EditBody>('POST', `/api/clip-projects/${project}/edits`, {
        requestId: randomUUID(),
        ...body,
      }),
    journalCount: () =>
      (
        inst.db
          .prepare('SELECT COUNT(*) AS n FROM clip_project_edits WHERE project_id = ?')
          .get(project) as { n: number }
      ).n,
  };
};

describe.skipIf(!enabled)('Journal d’édition (API, étape 7b)', () => {
  beforeAll(() => {
    master = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-journal-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  it('lots : application, idempotence, empreinte attendue, refus sans écriture', async () => {
    const { video, inst } = await setup();
    const { project, clip } = await prepare(inst, video);
    const t = tools(inst, project);
    const d0 = await t.doc();
    expect(d0).toMatchObject({ version: 1, editable: true, history: { undo: null, redo: null } });

    const requestId = randomUUID();
    const body = {
      requestId,
      base: { version: 1 },
      kind: 'do',
      ops: [{ type: 'setMode', mode: 'enrichi' }],
    };
    const first = await t.call<EditBody>('POST', `/api/clip-projects/${project}/edits`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      version: 2,
      replayed: false,
      rebased: false,
      history: { undo: 2 },
    });
    // Même requête : rejouée, rien de plus. Même requestId, autre contenu : refus.
    const again = await t.call<EditBody>('POST', `/api/clip-projects/${project}/edits`, body);
    expect(again.body).toMatchObject({ version: 2, replayed: true });
    const other = await t.call<EditBody>('POST', `/api/clip-projects/${project}/edits`, {
      ...body,
      ops: [{ type: 'setMode', mode: 'fidele' }],
    });
    expect(other.status).toBe(409);
    expect(other.body.error?.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(t.journalCount()).toBe(1);

    // Empreinte attendue fausse : rien n'est écrit.
    const diverged = await t.edit({
      base: { version: 2 },
      kind: 'do',
      ops: [{ type: 'setMode', mode: 'fidele' }],
      expectedHash: '0'.repeat(64),
    });
    expect(diverged.body.error?.code).toBe('DOCUMENT_DIVERGED');
    // Opération inconnue ou invalide : refus, rien n'est écrit.
    const bad = await t.edit({
      base: { version: 2 },
      kind: 'do',
      ops: [{ type: 'exec', cmd: 'rm -rf' }],
    });
    expect(bad.status).toBe(400);
    // Piste non autorisée (Discord sans accord) : refus.
    const discord = await t.edit({
      base: { version: 2 },
      kind: 'do',
      ops: [{ type: 'setTrack', audioIndex: 1, role: 'discord', enabled: true }],
    });
    expect(discord.status).toBe(422);
    expect(discord.body.error?.code).toBe('EXPORT_CONSENT_REQUIRED');
    expect(t.journalCount()).toBe(1);

    // Proposition refusée : aucune écriture possible.
    await t.call('POST', `/api/proposals/${clip}/decision`, {
      requestId: randomUUID(),
      decision: 'rejected',
      reasons: ['trop_long'],
    });
    const refused = await t.edit({
      base: { version: 2 },
      kind: 'do',
      ops: [{ type: 'setMode', mode: 'fidele' }],
    });
    expect(refused.body.error?.code).toBe('PROPOSAL_NOT_ACCEPTED');
    expect(t.journalCount()).toBe(1);
    expect((await t.doc()).editable).toBe(false);
  }, 300_000);

  it('annuler / rétablir : haut de pile, confirmation de masque, après rechargement', async () => {
    const { video, inst } = await setup();
    const { project } = await prepare(inst, video);
    const t = tools(inst, project);
    await t.edit({ base: { version: 1 }, kind: 'do', ops: [{ type: 'setMode', mode: 'enrichi' }] });
    const mask = {
      id: 'tm',
      rect: { x: 0, y: 0, w: 0.2, h: 0.2 },
      label: 'Pseudo',
      mode: 'opaque',
      srcRange: null,
    };
    const added = await t.edit({
      base: { version: 2 },
      kind: 'do',
      ops: [{ type: 'setEntity', collection: 'mask', entity: mask }],
    });
    expect(added.body).toMatchObject({ version: 3, history: { undo: 3 } });

    // Annuler le geste 2 alors que le 3 est en haut de pile : HISTORY_CHANGED, rien n'est écrit.
    const wrong = await t.edit({ base: { version: 3 }, kind: 'undo', targetSeq: 2 });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error?.code).toBe('HISTORY_CHANGED');
    // Annuler l'ajout d'un masque (qui le retire) : confirmation exigée.
    const noAck = await t.edit({ base: { version: 3 }, kind: 'undo', targetSeq: 3 });
    expect(noAck.body.error?.code).toBe('MASK_RISK_NOT_ACKNOWLEDGED');
    expect(t.journalCount()).toBe(2);
    const undone = await t.edit({
      base: { version: 3 },
      kind: 'undo',
      targetSeq: 3,
      acknowledgeMaskRisk: true,
    });
    expect(undone.body).toMatchObject({ version: 4, history: { undo: 2, redo: 3 } });
    expect((await t.doc()).document.masks.map((m) => m.id)).not.toContain('tm');

    // Rechargement : nouvelle instance sur la même base ; l'historique est reconstruit du journal.
    await inst.app.close();
    const reloaded = open();
    const t2 = tools(reloaded, project);
    const d = await t2.doc();
    expect(d).toMatchObject({ version: 4, history: { undo: 2, redo: 3 } });
    const redone = await t2.edit({ base: { version: 4 }, kind: 'redo', targetSeq: 3 });
    expect(redone.body).toMatchObject({ version: 5, history: { undo: 5, redo: null } });
    expect((await t2.doc()).document.masks.map((m) => m.id)).toContain('tm');
    // Un nouveau geste vide « rétablir ».
    await t2.edit({ base: { version: 5 }, kind: 'undo', targetSeq: 5, acknowledgeMaskRisk: true });
    const fresh = await t2.edit({
      base: { version: 6 },
      kind: 'do',
      ops: [{ type: 'setMode', mode: 'fidele' }],
    });
    expect(fresh.body.history).toEqual({ undo: 7, redo: null });
  }, 300_000);

  it('base ancienne : réapplication si indépendant, conflit explicite sinon ; deux connexions', async () => {
    const { video, inst } = await setup();
    const { project } = await prepare(inst, video);
    const t = tools(inst, project);
    const item = (await t.doc()).document.captions.items[0]!.id;
    // Deuxième connexion (comme un autre onglet servi par un autre processus).
    const second = open();
    const t2 = tools(second, project);
    expect(
      (
        await t2.edit({
          base: { version: 1 },
          kind: 'do',
          ops: [{ type: 'setMode', mode: 'enrichi' }],
        })
      ).body.version,
    ).toBe(2);

    // Lot construit sur la version 1, indépendant : réappliqué.
    const indep = await t.edit({
      base: { version: 1 },
      kind: 'do',
      ops: [{ type: 'editCaptionText', itemId: item, text: 'Salut', at: 't' }],
    });
    expect(indep.body).toMatchObject({ version: 3, rebased: true });

    // Lot sur la version 1 qui écrit ce que la connexion 2 a écrit : conflit, rien n'est écrit.
    const before = t.journalCount();
    const conflict = await t.edit({
      base: { version: 1 },
      kind: 'do',
      ops: [{ type: 'setMode', mode: 'fidele' }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentRevision: 3, reason: 'C1_REMOTE_WRITE_VS_LOCAL', keys: ['mode'] },
    });
    expect(t.journalCount()).toBe(before);

    // Masques : jamais réappliqués automatiquement, même indépendants.
    const mask = {
      id: 'tm',
      rect: { x: 0, y: 0, w: 0.2, h: 0.2 },
      label: 'Pseudo',
      mode: 'opaque',
      srcRange: null,
    };
    const sensitive = await t.edit({
      base: { version: 2 },
      kind: 'do',
      ops: [{ type: 'setEntity', collection: 'mask', entity: mask }],
    });
    expect(sensitive.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { reason: 'C7_SENSITIVE' },
    });

    // Les deux connexions voient la même tête.
    expect((await t2.doc()).version).toBe(3);
    expect((await t.doc()).hash).toBe((await t2.doc()).hash);
  }, 300_000);

  it('PATCH v1 et effets : entrées « system » annulables ; fonction de l’éditeur ⇒ EDITOR_REQUIRED', async () => {
    const { video, inst } = await setup();
    const { project } = await prepare(inst, video);
    const t = tools(inst, project);
    const initial = (
      await t.call<{ document: { layout: { preset: string } } }>(
        'GET',
        `/api/clip-projects/${project}`,
      )
    ).body.document.layout.preset;
    const patched = await t.call<{ revision: number; document: { layout: { preset: string } } }>(
      'PATCH',
      `/api/clip-projects/${project}`,
      {
        requestId: randomUUID(),
        baseRevision: 1,
        changes: { layout: { preset: 'gameplay_crop' } },
      },
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({
      revision: 2,
      document: { layout: { preset: 'gameplay_crop' } },
    });
    const e = inst.db
      .prepare('SELECT kind, source FROM clip_project_edits WHERE project_id = ? AND seq = 2')
      .get(project);
    expect(e).toEqual({ kind: 'system', source: 'ui' });
    // Annuler le PATCH depuis l'éditeur.
    const undone = await t.edit({ base: { version: 2 }, kind: 'undo', targetSeq: 2 });
    expect(undone.status).toBe(200);
    const v = await t.call<{ revision: number; document: { layout: { preset: string } } }>(
      'GET',
      `/api/clip-projects/${project}`,
    );
    expect(v.body).toMatchObject({ revision: 3, document: { layout: { preset: initial } } });

    // Calque (fonction de l'éditeur) : l'interface 6c et le PATCH v1 refusent clairement ; le moteur
    // (qui rend le document v2 depuis la PR 7c) refuse explicitement les calques image (ils
    // dépendent de la bibliothèque de médias, PR 7f ; les calques texte sont rendus depuis la 7e).
    const overlay = {
      id: 'titre',
      kind: 'image',
      assetId: 'a'.repeat(64),
      text: null,
      timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 2_000 },
      frame: { x: 0, y: 0, w: 1, h: 0.1 },
      opacity: 1,
      z: 1,
    };
    await t.edit({
      base: { version: 3 },
      kind: 'do',
      ops: [{ type: 'setEntity', collection: 'overlay', entity: overlay }],
    });
    const view = await t.call<EditBody>('GET', `/api/clip-projects/${project}`);
    expect(view.status).toBe(409);
    expect(view.body.error?.code).toBe('EDITOR_REQUIRED');
    const p2 = await t.call<EditBody>('PATCH', `/api/clip-projects/${project}`, {
      requestId: randomUUID(),
      baseRevision: 4,
      changes: { mode: 'enrichi' },
    });
    expect(p2.body.error?.code).toBe('EDITOR_REQUIRED');
    const render = await t.call<EditBody>('POST', `/api/clip-projects/${project}/renders`, {
      requestId: randomUUID(),
      kind: 'preview',
    });
    expect(render.status).toBe(409);
    expect(render.body.error?.code).toBe('RENDER_FEATURE_UNSUPPORTED');
    // Le document v2 reste lisible par l'éditeur ; annuler le calque rend le projet de nouveau
    // lisible par l'interface 6c.
    expect((await t.doc()).document.overlays.map((o) => o.id)).toEqual(['titre']);
    await t.edit({ base: { version: 4 }, kind: 'undo', targetSeq: 4 });
    expect((await t.call('GET', `/api/clip-projects/${project}`)).status).toBe(200);
  }, 300_000);

  it('points de contrôle : avant rendu et tous les 200 lots ; rejeu vérifié (journal altéré détecté)', async () => {
    const { video, inst } = await setup();
    const { project } = await prepare(inst, video);
    const t = tools(inst, project);
    // Un point de contrôle explicite à la version courante : révision immuable v2.
    await t.edit({ base: { version: 1 }, kind: 'do', ops: [{ type: 'setMode', mode: 'enrichi' }] });
    expect(inst.services.clips.edits.checkpoint(project)).toBe(2);
    expect(inst.services.clips.edits.checkpoint(project)).toBe(2); // idempotent
    const rev = inst.db
      .prepare(
        'SELECT schema_version, request_id FROM clip_project_revisions WHERE project_id = ? AND revision = 2',
      )
      .get(project);
    expect(rev).toEqual({ schema_version: 2, request_id: 'checkpoint-2' });
    // Les versions listées ne dupliquent pas le point de contrôle.
    const revs = await t.call<{ revisions: { revision: number }[] }>(
      'GET',
      `/api/clip-projects/${project}/revisions`,
    );
    expect(revs.body.revisions.map((r) => r.revision)).toEqual([1, 2]);

    // 200 lots : point de contrôle automatique.
    let version = 2;
    for (let i = 0; i < CHECKPOINT_EVERY; i++) {
      const r = await t.edit({
        base: { version },
        kind: 'do',
        ops: [{ type: 'setMode', mode: i % 2 ? 'enrichi' : 'fidele' }],
      });
      version = r.body.version;
    }
    const head = inst.db
      .prepare('SELECT head_seq, checkpoint_revision FROM clip_project_heads WHERE project_id = ?')
      .get(project);
    expect(head).toEqual({ head_seq: 202, checkpoint_revision: 202 });

    // Journal altéré (déclencheur retiré pour le test) : rejeu refusé, jamais corrigé.
    inst.db.exec('DROP TRIGGER clip_project_edits_no_update');
    inst.db
      .prepare(`UPDATE clip_project_edits SET hash_after = ? WHERE project_id = ? AND seq = 3`)
      .run('f'.repeat(64), project);
    await inst.app.close();
    const reloaded = open();
    // Le dernier point de contrôle (202) suffit pour la tête ; la version 3 exige le rejeu de
    // l'entrée 3 depuis le point de contrôle 2 : l'altération est détectée.
    expect(() => reloaded.services.clips.edits.docAt(project, 3)).toThrow(
      /Empreinte inattendue à l’entrée 3/,
    );
  }, 300_000);
});
