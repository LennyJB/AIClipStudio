/**
 * Projets de clip (étape 6a), de bout en bout par l'API : FFmpeg réel, transcription simulée,
 * faux modèle (aucun appel réel à Claude). Aucun rendu à cette étape.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

async function setup() {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-clips-'));
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
  db = openDatabase(':memory:');
  ({ app, services } = buildApp({ config, db, model: new FakeModel(scenarioScript) }));
  // Chaque test travaille sur SA copie de l'original (certains la modifient volontairement).
  const video = path.join(storage, 'original.mkv');
  copyFileSync(master, video);
  return video;
}

const call = async <T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) => {
  const res = await app.inject(payload === undefined ? { method, url } : { method, url, payload });
  return { status: res.statusCode, body: res.json<T>() };
};

interface View {
  project: { id: string; proposalId: string; currentRevision: number };
  revision: number;
  document: {
    segments: { srcStartMs: number; srcEndMs: number }[];
    captions: {
      sources: string[];
      items: { id: string; speakerRole: string; srcStartMs: number }[];
    };
    audio: { tracks: { audioIndex: number; role: string }[] };
    layout: { preset: string };
    source: { integrityManifestId: string };
  };
  editable: boolean;
  decision: { status: string };
  audio: { selected: { role: string }[]; captionRoles: string[] };
  captions:
    | {
        itemId: string;
        text: string;
        originalText: string;
        corrected: boolean;
        speakerRole: string;
      }[]
    | null;
  integrity: { method: string; protectedBytes: number } | null;
  warnings: { code: string }[];
  created?: boolean;
  replayed?: boolean;
  error?: { code: string; message: string };
}

/** Import, transcription, analyse : renvoie l'enregistrement et la proposition « clip ». */
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
  return { rec, clip };
}

const decide = (pid: string, decision: 'accepted' | 'rejected' | 'pending') =>
  call('POST', `/api/proposals/${pid}/decision`, {
    requestId: randomUUID(),
    decision,
    ...(decision === 'rejected' ? { reasons: ['pas_drole'] } : {}),
  });
const create = (pid: string, requestId = randomUUID()) =>
  call<View>('POST', `/api/proposals/${pid}/clip-project`, { requestId });
const patch = (
  id: string,
  baseRevision: number,
  changes: Record<string, unknown>,
  requestId = randomUUID(),
) => call<View>('PATCH', `/api/clip-projects/${id}`, { requestId, baseRevision, changes });
const audioEvent = (recId: string, body: Record<string, unknown>) =>
  call<{ decision: { selected: { role: string }[]; captionRoles: string[] }; replayed: boolean }>(
    'POST',
    `/api/recordings/${recId}/export-audio`,
    { requestId: randomUUID(), ...body },
  );
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

describe.skipIf(!enabled)('Projets de clip (API, étape 6a)', () => {
  beforeAll(() => {
    master = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-clips-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    await app?.close();
  });

  it('création réservée aux propositions acceptées ; document, sous-titres micro, manifeste ; original intact', async () => {
    const video = await setup();
    const before = sha(video);
    const { rec, clip } = await prepare(video);

    let r = await create(clip);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('PROPOSAL_NOT_ACCEPTED');
    await decide(clip, 'rejected');
    expect((await create(clip)).body.error?.code).toBe('PROPOSAL_NOT_ACCEPTED');

    await decide(clip, 'accepted');
    r = await create(clip);
    expect(r.status).toBe(201);
    const v = r.body;
    expect(v.created).toBe(true);
    expect(v.revision).toBe(1);
    expect(v.editable).toBe(true);
    expect(v.document.segments).toHaveLength(1);
    // Micro seul : Discord non autorisé à l'export (aucun accord), ni en audio ni en sous-titres.
    expect(v.document.audio.tracks.map((t) => t.role)).toEqual(['mic']);
    expect(v.document.captions.sources).toEqual(['mic']);
    expect(v.captions!.every((c) => c.speakerRole === 'mic')).toBe(true);
    expect(JSON.stringify(v.captions)).not.toContain('SECRET');
    // Pseudonymisation du texte AFFICHÉ, texte d'origine intact.
    const theo = v.captions!.find((c) => c.originalText.includes('Théo'))!;
    expect(theo.text).toContain('[Coéquipier 1]');
    expect(theo.text).not.toContain('Théo');
    expect(v.integrity).toMatchObject({ method: 'byte_ranges' });
    expect(v.document.layout.preset).toBe('blurred_fit');
    expect(v.warnings.map((w) => w.code)).toContain('FRAMING_NOT_VALIDATED');

    // Idempotent : la même proposition renvoie le même projet (200), sans nouvelle révision.
    const again = await create(clip);
    expect(again.status).toBe(200);
    expect(again.body.project.id).toBe(v.project.id);
    expect(again.body.created).toBe(false);

    // Liste des clips : une entrée par moment accepté, avec son projet.
    const l = await call<{ items: { proposal: { id: string }; project: { id: string } | null }[] }>(
      'GET',
      `/api/recordings/${rec.id}/clips`,
    );
    expect(l.body.items.map((i) => i.project?.id)).toEqual([v.project.id]);
    expect(sha(video)).toBe(before);
  }, 120_000);

  it('audio exporté : accord Discord tracé, idempotent, révocable ; la piste « tout » jamais autorisée par lui', async () => {
    const video = await setup();
    const { rec, clip } = await prepare(video);
    await decide(clip, 'accepted');
    const v = (await create(clip)).body;

    let a = await call<{
      decision: {
        selected: { role: string }[];
        tracks: { role: string; exportable: boolean; reason: string }[];
      };
    }>('GET', `/api/recordings/${rec.id}/export-audio`);
    expect(a.body.decision.selected.map((t) => t.role)).toEqual(['mic']);
    expect(a.body.decision.tracks.find((t) => t.role === 'discord')!.reason).toMatch(
      /accord requis/,
    );

    // Sous-titres Discord refusés sans accord.
    const refused = await patch(v.project.id, 1, { captions: { sources: ['mic', 'discord'] } });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe('EXPORT_CONSENT_REQUIRED');

    const requestId = randomUUID();
    const granted = await call<{ decision: { selected: { role: string }[] }; replayed: boolean }>(
      'POST',
      `/api/recordings/${rec.id}/export-audio`,
      {
        requestId,
        kind: 'consent',
        subject: 'discord_voices',
        action: 'granted',
        note: 'accord oral',
      },
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.decision.selected.map((t) => t.role)).toEqual(['mic', 'discord']);
    const replay = await call<{ replayed: boolean }>(
      'POST',
      `/api/recordings/${rec.id}/export-audio`,
      {
        requestId,
        kind: 'consent',
        subject: 'discord_voices',
        action: 'granted',
        note: 'accord oral',
      },
    );
    expect(replay.body.replayed).toBe(true);
    const mismatch = await call<{ error: { code: string } }>(
      'POST',
      `/api/recordings/${rec.id}/export-audio`,
      {
        requestId,
        kind: 'consent',
        subject: 'discord_voices',
        action: 'revoked',
      },
    );
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    // Déclaration incohérente refusée par le schéma.
    expect(
      (
        await audioEvent(rec.id, {
          kind: 'declaration',
          subject: 'mix_composition',
          payload: { discord: 'peut-être' },
        })
      ).status,
    ).toBe(400);

    const ok = await patch(v.project.id, 1, { captions: { sources: ['mic', 'discord'] } });
    expect(ok.status).toBe(200);
    expect(ok.body.captions!.some((c) => c.speakerRole === 'discord')).toBe(true);

    await audioEvent(rec.id, { kind: 'consent', subject: 'discord_voices', action: 'revoked' });
    a = await call('GET', `/api/recordings/${rec.id}/export-audio`);
    expect(a.body.decision.selected.map((t) => t.role)).toEqual(['mic']);
    // Révoqué : même un document qui les contient n'affiche plus les sous-titres Discord.
    const after = await call<View>('GET', `/api/clip-projects/${v.project.id}`);
    expect(after.body.captions!.every((c) => c.speakerRole === 'mic')).toBe(true);
    const hist = await call<{ history: { action: string; source: string }[] }>(
      'GET',
      `/api/recordings/${rec.id}/export-audio`,
    );
    expect(hist.body.history.map((h) => h.action)).toEqual(['granted', 'revoked']);
    expect(() => db.prepare('DELETE FROM export_audio_events').run()).toThrow(/ajout seul/);
  }, 120_000);

  it('réglages : révisions immuables, conflit de version, rejeu, bornes ±10 s, corrections tracées', async () => {
    const video = await setup();
    const { clip } = await prepare(video);
    await decide(clip, 'accepted');
    const v = (await create(clip)).body;
    const id = v.project.id;
    const start = v.document.segments[0]!.srcStartMs;

    const requestId = randomUUID();
    const r2 = await patch(id, 1, { layout: { preset: 'gameplay_crop', focusX: 0.3 } }, requestId);
    expect(r2.body.revision).toBe(2);
    // Rejeu : aucune nouvelle révision.
    const replay = await patch(
      id,
      1,
      { layout: { preset: 'gameplay_crop', focusX: 0.3 } },
      requestId,
    );
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.revision).toBe(2);
    // Version périmée.
    const stale = await patch(id, 1, { mode: 'enrichi' });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('VERSION_CONFLICT');
    // Bornes : au-delà de ±10 s refusé ; en deçà calé.
    expect((await patch(id, 2, { bounds: { startMs: start - 10_001 } })).status).toBe(400);
    // Début placé après la mise en place : alerte « contexte coupé ».
    const setupStart = (r2.body.document as unknown as { anchors: { setupStartMs: number } })
      .anchors.setupStartMs;
    const moved = await patch(id, 2, {
      bounds: { startMs: Math.min(start + 10_000, setupStart + 1_500) },
    });
    expect(moved.status, JSON.stringify(moved.body.error)).toBe(200);
    expect(moved.body.document.segments[0]!.srcStartMs).toBeGreaterThan(start);
    expect(moved.body.warnings.map((w) => w.code)).toContain('CONTEXT_MAY_BE_CUT');

    // Correction : affichée (puis pseudonymisée), origine conservée et tracée.
    const line = moved.body.captions!.find((c) => c.originalText.includes('Théo'))!;
    const fixed = await patch(id, 3, {
      corrections: [{ itemId: line.itemId, text: 'Je fais confiance à Théo, vraiment' }],
    });
    const shown = fixed.body.captions!.find((c) => c.itemId === line.itemId)!;
    expect(shown).toMatchObject({
      corrected: true,
      text: 'Je fais confiance à [Coéquipier 1], vraiment',
    });
    expect(shown.originalText).toBe(line.originalText);
    const revs = await call<{
      revisions: { revision: number; changeSummary: string; corrections: unknown[] }[];
    }>('GET', `/api/clip-projects/${id}/revisions`);
    expect(revs.body.revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    expect(revs.body.revisions[3]!.changeSummary).toMatch(/corrigé/);
    expect(revs.body.revisions[3]!.corrections).toHaveLength(1);
    // La transcription en base n'est jamais modifiée.
    const raw = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transcript_segments WHERE text LIKE '%vraiment%confiance%'`,
      )
      .get() as { n: number };
    expect(raw.n).toBe(0);
    expect(() =>
      db.prepare('UPDATE clip_project_revisions SET change_summary = NULL').run(),
    ).toThrow(/immuable/);
  }, 120_000);

  it('décision changée hors interface : le projet devient en lecture seule, aucune modification possible', async () => {
    const video = await setup();
    const { clip } = await prepare(video);
    await decide(clip, 'accepted');
    const v = (await create(clip)).body;
    // Refus directement par le service (comme le CLI), sans passer par l'interface.
    services.review.decide(
      clip,
      { requestId: randomUUID(), decision: 'rejected', reasons: ['trop_long'] },
      'cli',
    );
    const p = await patch(v.project.id, 1, { mode: 'enrichi' });
    expect(p.status).toBe(409);
    expect(p.body.error?.code).toBe('PROPOSAL_NOT_ACCEPTED');
    const view = (await call<View>('GET', `/api/clip-projects/${v.project.id}`)).body;
    expect(view.editable).toBe(false);
    expect(view.decision.status).toBe('rejected');
    expect(view.revision).toBe(1);
    // Réacceptée : modifiable à nouveau, sans nouveau projet.
    await decide(clip, 'accepted');
    expect((await patch(v.project.id, 1, { mode: 'enrichi' })).status).toBe(200);
    expect((await create(clip)).body.project.id).toBe(v.project.id);
  }, 120_000);

  it('concurrence : un refus enregistré pendant la préparation empêche la création (revérifié sous verrou)', async () => {
    const video = await setup();
    const { clip } = await prepare(video);
    await decide(clip, 'accepted');
    // Le refus arrive (comme depuis le CLI) APRÈS le premier contrôle et le calcul du manifeste.
    const original = services.analysis.validatedFraming.bind(services.analysis);
    services.analysis.validatedFraming = async (id: string) => {
      services.review.decide(
        clip,
        { requestId: randomUUID(), decision: 'rejected', reasons: ['pas_drole'] },
        'cli',
      );
      return original(id);
    };
    const r = await create(clip);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('PROPOSAL_NOT_ACCEPTED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip_projects').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_integrity_manifests').get()).toEqual({
      n: 0,
    });
  }, 120_000);

  it('intégrité : modification dans la fenêtre détectée malgré taille et date restaurées', async () => {
    const video = await setup();
    const { clip } = await prepare(video);
    await decide(clip, 'accepted');
    const v = (await create(clip)).body;
    expect(await services.clips.verifySource(v.project.id)).toMatchObject({ ok: true });
    const m = services.clips.repo.manifest(v.document.source.integrityManifestId)!;
    const window = m.ranges.find(([, , role]) => role === 'window')!;
    const st = statSync(video);
    const data = readFileSync(video);
    const pos = Math.floor((window[0] + window[1]) / 2);
    data[pos] = data[pos]! ^ 0xff;
    writeFileSync(video, data);
    utimesSync(video, st.atime, st.mtime);
    expect(statSync(video).size).toBe(st.size);
    await expect(services.clips.verifySource(v.project.id)).rejects.toMatchObject({
      code: 'MEDIA_SOURCE_CHANGED',
    });
  }, 120_000);

  it('validation : identifiants et corps stricts', async () => {
    await setup();
    expect((await call('GET', '/api/clip-projects/pas-un-uuid')).status).toBe(400);
    expect((await call('GET', `/api/clip-projects/${randomUUID()}`)).status).toBe(404);
    expect((await call('POST', `/api/proposals/${randomUUID()}/clip-project`, {})).status).toBe(
      400,
    );
    expect(
      (
        await call('POST', `/api/proposals/${randomUUID()}/clip-project`, {
          requestId: randomUUID(),
          x: 1,
        })
      ).status,
    ).toBe(400);
  }, 60_000);
});
