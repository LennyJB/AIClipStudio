/**
 * Revue des propositions (étape 5), de bout en bout par l'API : FFmpeg réel, transcription
 * simulée, faux modèle (aucun appel réel à Claude).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import type { AnalysisRunDto } from './analysis/repository';
import { buildApp } from './app';
import { loadConfig, ROOT_DIR, type AppConfig } from './config';
import { openDatabase, type Db } from './db';
import type { RecordingDto } from './recordings/repository';
import type { Services } from './services';

const FAKE_WORKER = fileURLToPath(
  new URL('../../../tests/helpers/fake-whisper-worker.mjs', import.meta.url),
);
const enabled = ffmpegAvailable();

let video: string;
let app: FastifyInstance;
let services: Services;
let db: Db;
let config: AppConfig;
let model: FakeModel;

async function setup(dbFile?: string, storageDir?: string) {
  const storage = storageDir ?? (await mkdtemp(path.join(tmpdir(), 'acs-review-')));
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
  db = openDatabase(dbFile ?? ':memory:');
  model = new FakeModel(scenarioScript);
  ({ app, services } = buildApp({ config, db, model }));
  return storage;
}

const call = async <T = Record<string, unknown>>(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) => {
  const res = await app.inject(payload === undefined ? { method, url } : { method, url, payload });
  return { status: res.statusCode, body: res.json<T>() };
};

async function importAndTranscribe(): Promise<RecordingDto> {
  const rec = (await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video }))
    .body.recording;
  await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await services.runner.idle();
  return rec;
}

/** Analyse complète, sans pause de relecture. */
async function analyze(
  recId: string,
  extra: Record<string, unknown> = {},
): Promise<AnalysisRunDto> {
  const r = await call<{ run: AnalysisRunDto }>('POST', `/api/recordings/${recId}/analyses`, {
    mode: 'claude',
    acceptBudgetUsd: config.analysis.maxCostUsd,
    review: false,
    ...extra,
  });
  expect(r.status).toBeLessThan(300);
  await services.runner.idle();
  return services.analysis.repo.getRun(r.body.run.id)!;
}

interface Item {
  proposal: { id: string; tier: string; title: string; runId: string };
  state: string;
  version: number;
  review: { status: string; reasons: string[]; comment: string | null } | null;
  effective: { status: string; inherited: boolean; sourceProposalId: string | null };
}
const list = async (recId: string, q = '') =>
  (
    await call<{ items: Item[]; counts: Record<string, number>; run: { id: string } }>(
      'GET',
      `/api/recordings/${recId}/proposals${q}`,
    )
  ).body;
const decide = (pid: string, body: Record<string, unknown>) =>
  call<Record<string, unknown>>('POST', `/api/proposals/${pid}/decision`, {
    requestId: randomUUID(),
    ...body,
  });

describe.skipIf(!enabled)('Revue des propositions (API, faux modèle)', () => {
  beforeAll(() => {
    video = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-review-video-')), 180);
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
      language: 'fr',
      tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
    });
  }, 120_000);

  afterEach(async () => {
    await app?.close();
  });

  it('liste : dernière analyse terminée, clips et moments secondaires séparés, contexte avec marqueurs', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const run = await analyze(rec.id);
    const l = await list(rec.id);
    expect(l.run.id).toBe(run.id);
    expect(l.items.map((i) => i.proposal.tier).sort()).toEqual(['clip', 'secondary']);
    expect(l.counts).toMatchObject({ all: 2, to_review: 2 });
    expect((await list(rec.id, '?tier=secondary')).items).toHaveLength(1);
    const clip = l.items.find((i) => i.proposal.tier === 'clip')!;

    const ctx = (
      await call<{
        segments: { text: string; marker: string | null; sentToClaude: boolean; role: string }[];
      }>('GET', `/api/proposals/${clip.proposal.id}/context`)
    ).body;
    expect(ctx.segments.find((s) => s.marker === 'punchline')?.text).toContain('j’adore perdre');
    expect(ctx.segments.find((s) => s.marker === 'setup')?.text).toContain('tenter le plan');
    // Affichage local : Discord visible, mais signalé comme NON transmis à Claude.
    const dsc = ctx.segments.find((s) => s.text.includes('SECRETTER'))!;
    expect(dsc).toMatchObject({ role: 'discord', sentToClaude: false });
    expect(ctx.segments.find((s) => s.marker === 'punchline')!.sentToClaude).toBe(true);
  });

  it('décisions : refus multi-motifs, rejeu idempotent, historique, journal ; aucune préférence activée', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const run1 = await analyze(rec.id);
    const hashes1 = (
      db
        .prepare('SELECT request_hash FROM llm_calls WHERE run_id = ? ORDER BY request_hash')
        .all(run1.id) as { request_hash: string }[]
    ).map((r) => r.request_hash);
    const [clip, second] = (await list(rec.id)).items.sort((a, b) =>
      a.proposal.tier.localeCompare(b.proposal.tier),
    );

    const requestId = randomUUID();
    const a = await call('POST', `/api/proposals/${clip!.proposal.id}/decision`, {
      requestId,
      decision: 'accepted',
      comment: 'top',
      expectedVersion: 0,
    });
    expect(a.status).toBe(200);
    const again = await call('POST', `/api/proposals/${clip!.proposal.id}/decision`, {
      requestId,
      decision: 'accepted',
      comment: 'top',
      expectedVersion: 0,
    });
    expect(again.body).toEqual({ ...a.body, replayed: true });

    expect(
      (await decide(second!.proposal.id, { decision: 'rejected', reasons: ['autre'] })).status,
    ).toBe(400);
    const rej = await decide(second!.proposal.id, {
      decision: 'rejected',
      reasons: ['trop_long', 'pas_drole'],
      comment: 'trop lent',
    });
    expect(rej.body).toMatchObject({
      outcome: 'applied',
      state: 'rejected',
      review: { reasons: ['pas_drole', 'trop_long'] },
    });

    const j = (
      await call<{
        events: { type: string; gameId: string; recordingId: string; runId: string }[];
      }>('GET', `/api/feedback-events?recordingId=${rec.id}`)
    ).body;
    expect(j.events.map((e) => e.type)).toEqual(['proposal_accepted', 'proposal_rejected']);
    expect(j.events[0]).toMatchObject({ recordingId: rec.id, gameId: rec.gameId, runId: run1.id });

    // Une analyse lancée APRÈS des décisions envoie exactement les mêmes requêtes à Claude.
    const run2 = await analyze(rec.id, { forceRecall: true });
    const hashes2 = (
      db
        .prepare(
          `SELECT request_hash FROM llm_calls WHERE run_id = ? AND status <> 'reused' ORDER BY request_hash`,
        )
        .all(run2.id) as { request_hash: string }[]
    ).map((r) => r.request_hash);
    expect(hashes2).toEqual(hashes1);
    expect(run2.memoryVersion).toBeNull();

    // Les propositions de la nouvelle analyse héritent des décisions, sans événement.
    const l2 = await list(rec.id);
    expect(l2.run.id).toBe(run2.id);
    expect(l2.items.map((i) => i.state).sort()).toEqual(['already_reviewed', 'already_reviewed']);
    expect(l2.counts.to_review).toBe(0);
    expect(
      (await call<{ events: unknown[] }>('GET', `/api/feedback-events?recordingId=${rec.id}`)).body
        .events,
    ).toHaveLength(2);
    const inherited = l2.items.find((i) => i.proposal.tier === 'clip')!;
    expect((await decide(inherited.proposal.id, { decision: 'pending' })).body).toMatchObject({
      error: { code: 'DECISION_ELSEWHERE' },
    });
    const reev = await decide(inherited.proposal.id, {
      decision: 'rejected',
      reasons: ['deja_vu'],
      reevaluate: true,
    });
    expect(reev.status).toBe(200);
    const h = (
      await call<{ events: { type: string; current: boolean }[] }>(
        'GET',
        `/api/proposals/${clip!.proposal.id}/events`,
      )
    ).body;
    expect(h.events.map((e) => [e.type, e.current])).toEqual([
      ['proposal_accepted', false],
      ['proposal_rejected', true],
    ]);
  });

  it('canari : la colonne review_status forcée en base ne change aucune réponse', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const run = await analyze(rec.id);
    const before = await list(rec.id);
    const proposalsBefore = (await call('GET', `/api/analyses/${run.id}/proposals`)).body;
    db.prepare(`UPDATE clip_proposals SET review_status = 'accepted'`).run();
    expect(await list(rec.id)).toEqual(before);
    const after = (await call('GET', `/api/analyses/${run.id}/proposals`)).body;
    expect(after).toEqual(proposalsBefore);
    expect(JSON.stringify(after)).not.toMatch(/reviewStatus|review_status/);
    expect(before.items.every((i) => i.state === 'to_review')).toBe(true);
  });

  it('redémarrage : décisions, moments et journal conservés', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acs-review-restart-'));
    const dbFile = path.join(dir, 'db.sqlite');
    await setup(dbFile, dir);
    const rec = await importAndTranscribe();
    await analyze(rec.id);
    const clip = (await list(rec.id)).items.find((i) => i.proposal.tier === 'clip')!;
    await decide(clip.proposal.id, { decision: 'rejected', reasons: ['chute_coupee'] });
    const before = await list(rec.id);
    await app.close();
    db.close();

    await setup(dbFile, dir);
    const after = await list(rec.id);
    expect(after).toEqual(before);
    expect(after.items.find((i) => i.proposal.id === clip.proposal.id)).toMatchObject({
      state: 'rejected',
      review: { reasons: ['chute_coupee'] },
    });
  });

  describe('écoute du passage (piste « tout »)', () => {
    let mixVideo: string;
    beforeAll(() => {
      mixVideo = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-review-mix-')), 180, {
        withMix: true,
      });
    }, 120_000);

    async function mixRecording() {
      const rec = (
        await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: mixVideo })
      ).body.recording;
      await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
      await services.runner.idle();
      await analyze(rec.id);
      const clip = (await list(rec.id)).items.find((i) => i.proposal.tier === 'clip')!;
      return { rec, clip };
    }
    const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
    const raw = (
      url: string,
      headers: Record<string, string> = {},
      method: 'GET' | 'HEAD' = 'GET',
    ) => app.inject({ method, url, headers });

    it('préparation mise en cache, lecture 200/206/416, HEAD, WAV mono 48 kHz, original intact, aucun appel au modèle', async () => {
      await setup();
      const before = sha(mixVideo);
      const { clip } = await mixRecording();
      const calls = model.calls.length;
      const url = `/api/proposals/${clip.proposal.id}/audio`;

      expect((await raw(url)).statusCode).toBe(409); // pas encore préparé
      const [p1, p2] = await Promise.all([
        call<{ status: string; job: { id: string } }>('POST', url, {}),
        call<{ status: string; job: { id: string } }>('POST', url, {}),
      ]);
      expect(p1.status).toBe(202);
      expect(p2.body.job.id).toBe(p1.body.job.id); // un seul traitement
      await services.runner.idle();
      const ready = await call<{ status: string; durationMs: number; windowStartMs: number }>(
        'POST',
        url,
        {},
      );
      expect(ready.status).toBe(200);
      expect(ready.body.windowStartMs).toBe(
        Math.max(0, (clip.proposal as unknown as { srcStartMs: number }).srcStartMs - 1500),
      );
      const jobsAfter = (
        db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'extract_audio_stems'`).get() as {
          n: number;
        }
      ).n;
      await call('POST', url, {});
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'extract_audio_stems'`).get() as {
            n: number;
          }
        ).n,
      ).toBe(jobsAfter);

      const full = await raw(url);
      expect(full.statusCode).toBe(200);
      const size = full.rawPayload.length;
      expect(full.headers).toMatchObject({
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': String(size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      const body = full.rawPayload;
      expect(body.subarray(0, 4).toString()).toBe('RIFF');
      expect(body.readUInt16LE(22)).toBe(1); // mono
      expect(body.readUInt32LE(24)).toBe(48_000);

      const part = await raw(url, { range: 'bytes=0-99' });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes 0-99/${size}`);
      expect(part.headers['content-length']).toBe('100');
      expect(Buffer.compare(part.rawPayload, body.subarray(0, 100))).toBe(0);
      const open = await raw(url, { range: `bytes=${size - 10}-` });
      expect(open.statusCode).toBe(206);
      expect(Buffer.compare(open.rawPayload, body.subarray(size - 10))).toBe(0);
      const suffix = await raw(url, { range: 'bytes=-20' });
      expect(suffix.headers['content-range']).toBe(`bytes ${size - 20}-${size - 1}/${size}`);
      const bad = await raw(url, { range: `bytes=${size}-` });
      expect(bad.statusCode).toBe(416);
      expect(bad.headers['content-range']).toBe(`bytes */${size}`);
      expect((await raw(url, { range: 'bytes=0-1,5-9' })).statusCode).toBe(200);
      const head = await raw(url, {}, 'HEAD');
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe(String(size));
      expect(head.rawPayload.length).toBe(0);

      expect(sha(mixVideo)).toBe(before); // original intact
      expect(model.calls.length).toBe(calls); // rien envoyé à Claude
    });

    it('fichier du cache supprimé → NOT_READY puis régénération ; chemin falsifié ou lien symbolique refusé', async () => {
      await setup();
      const { clip } = await mixRecording();
      const url = `/api/proposals/${clip.proposal.id}/audio`;
      await call('POST', url, {});
      await services.runner.idle();
      const row = db
        .prepare(`SELECT id, rel_path FROM media_derivatives WHERE params_json LIKE '%"preview"%'`)
        .get() as { id: string; rel_path: string };
      const abs = path.join(config.paths.storage, ...row.rel_path.split('/'));

      // Chemin hors de processing/ (mais dans le stockage) : refusé sans rien servir.
      const outside = path.join(config.paths.storage, 'config', 'faux.wav');
      writeFileSync(outside, readFileSync(abs));
      db.prepare('UPDATE media_derivatives SET rel_path = ? WHERE id = ?').run(
        'config/faux.wav',
        row.id,
      );
      const r1 = await raw(url);
      expect(r1.statusCode).toBe(409);
      expect(r1.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: 'NOT_READY',
      });
      expect(r1.body).not.toContain('faux.wav');

      // Lien symbolique dans processing/ vers un fichier extérieur : refusé.
      const link = abs.replace(/\.wav$/, '-lien.wav');
      let linked = true;
      try {
        symlinkSync(outside, link);
      } catch {
        linked = false; // Windows sans privilège : création de liens impossible, cas ignoré
      }
      if (linked) {
        db.prepare('UPDATE media_derivatives SET rel_path = ? WHERE id = ?').run(
          row.rel_path.replace(/\.wav$/, '-lien.wav'),
          row.id,
        );
        expect((await raw(url)).statusCode).toBe(409);
      }

      // Fichier supprimé : le dérivé est retiré, NOT_READY, puis une nouvelle préparation le recrée.
      db.prepare('UPDATE media_derivatives SET rel_path = ? WHERE id = ?').run(
        row.rel_path,
        row.id,
      );
      rmSync(abs);
      expect((await raw(url)).statusCode).toBe(409);
      expect((await call('POST', url, {})).status).toBe(202);
      await services.runner.idle();
      expect((await raw(url)).statusCode).toBe(200);
    });

    it('enregistrement sans piste « tout » : AUDIO_TRACK_MISSING', async () => {
      await setup();
      const rec = await importAndTranscribe(); // vidéo Micro + Discord seulement
      await analyze(rec.id);
      const clip = (await list(rec.id)).items[0]!;
      const r = await call<{ error: { code: string; message: string } }>(
        'POST',
        `/api/proposals/${clip.proposal.id}/audio`,
        {},
      );
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('AUDIO_TRACK_MISSING');
      expect(r.body.error.message).toMatch(/piste « tout »/);
    });
  });
});
