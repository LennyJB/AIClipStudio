import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fingerprintFile } from '@acs/media';
import {
  createColorVideo,
  FFMPEG,
  FFPROBE,
  ffmpegAvailable,
  pixelAt,
} from '../../../tests/helpers/media-fixtures';
import type { AnalysisRunDto, AnalysisWindowDto } from './analysis/repository';
import type { SettingsView } from './analysis/service';
import { buildApp } from './app';
import { loadConfig, ROOT_DIR, type AppConfig } from './config';
import { openDatabase, type Db } from './db';
import type { JobDto, RecordingDto } from './recordings/repository';
import type { Services } from './services';

const FAKE_WORKER = fileURLToPath(
  new URL('../../../tests/helpers/fake-whisper-worker.mjs', import.meta.url),
);
const enabled = ffmpegAvailable();

let video: string;
let root: string;
let app: FastifyInstance;
let services: Services;
let db: Db;
let config: AppConfig;

/** Échange micro ↔ Discord sur les 6 s de la vidéo de test. */
const SCENARIO = {
  language: 'fr',
  tracks: {
    '0': [
      { startMs: 100, endMs: 1_000, text: 'attends quoi ?' },
      { startMs: 2_600, endMs: 3_500, text: 'mdr Théo t’es nul ?' },
      { startMs: 4_600, endMs: 5_500, text: 'sérieux ?! mon mail est theo@exemple.fr' },
    ],
    '1': [
      { startMs: 1_200, endMs: 2_500, text: 'SECRETDISCORD mais non t’es sérieux ?' },
      { startMs: 3_600, endMs: 4_500, text: 'SECRETBIS haha' },
    ],
  },
};

async function setup(env: NodeJS.ProcessEnv = {}) {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-an-'));
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
      ANALYSIS_FRAMES_PER_WINDOW: '2',
      ...env,
    },
    root,
  );
  db = openDatabase(':memory:');
  ({ app, services } = buildApp({ config, db }));
}

const call = async <T>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
) => {
  const res = await app.inject(payload === undefined ? { method, url } : { method, url, payload });
  return { status: res.statusCode, body: res.json<T>(), headers: res.headers };
};

async function importAndTranscribe(): Promise<RecordingDto> {
  const rec = (await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video }))
    .body.recording;
  await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await services.runner.idle();
  return rec;
}

type RequestRes = { status: string; run: AnalysisRunDto; job: JobDto | null; reused: boolean };

async function analyze(recId: string, body: Record<string, unknown> = {}) {
  const r = await call<RequestRes>('POST', `/api/recordings/${recId}/analyses`, body);
  await services.runner.idle();
  const run = (
    await call<{ run: AnalysisRunDto; windows: AnalysisWindowDto[] }>(
      'GET',
      `/api/analyses/${r.body.run.id}`,
    )
  ).body;
  return { status: r.status, request: r.body, ...run };
}

const payload = async (runId: string, rank: number) =>
  (
    await call<{ text: string; manifest: Record<string, unknown> }>(
      'GET',
      `/api/analyses/${runId}/windows/${rank}/payload`,
    )
  ).body;

describe.skipIf(!enabled)('Analyse éditoriale — préparation locale (4a)', () => {
  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acs-an-video-'));
    video = createColorVideo(dir);
    // Racine de test : profils du dépôt + un profil de cadrage de test modifiable.
    root = mkdtempSync(path.join(tmpdir(), 'acs-an-root-'));
    cpSync(path.join(ROOT_DIR, 'profiles'), path.join(root, 'profiles'), { recursive: true });
    writeFileSync(
      path.join(root, 'profiles', 'framing', 'test-moitie.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'test-moitie',
        displayName: 'Test',
        gameplay: { x: 0, y: 0, w: 1, h: 1 },
        facecam: { x: 0, y: 0.5, w: 0.25, h: 0.5 },
        masks: [{ label: 'Pseudos', x: 0.5, y: 0, w: 0.5, h: 1 }],
      }),
    );
    process.env.FAKE_WHISPER_SCENARIO = JSON.stringify(SCENARIO);
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    db?.close();
  });

  it('refuse d’analyser sans transcription terminée', async () => {
    await setup();
    const rec = (
      await call<{ recording: RecordingDto }>('POST', '/api/recordings', { path: video })
    ).body.recording;
    const r = await call<{ error: { code: string } }>(
      'POST',
      `/api/recordings/${rec.id}/analyses`,
      {},
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ANALYSIS_NOT_READY');
  });

  it('prépare localement, sans aucun appel réseau : fenêtres, contenu consultable, estimation', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const fpBefore = (await fingerprintFile(video)).hash;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const a = await analyze(rec.id);
    expect(a.status).toBe(202);
    expect(a.request.job).toMatchObject({ type: 'prepare_analysis', lane: 'analysis' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(a.run).toMatchObject({
      status: 'completed',
      mode: 'dry_run',
      stage: 'prepared',
      spentUsd: 0,
      budgetUsd: 5,
    });
    expect(a.windows.length).toBeGreaterThanOrEqual(1);
    const w = a.windows[0]!;
    expect(w).toMatchObject({ rank: 1, origin: 'signals', status: 'prepared', frames: [] });
    expect(w.coreStartMs).toBeLessThan(w.coreEndMs);

    // Contenu qui serait transmis : micro pseudonymisé, Discord retenu (instants seulement).
    const p = await payload(a.run.id, 1);
    if (process.env.SHOW_PAYLOAD)
      writeFileSync(
        process.env.SHOW_PAYLOAD,
        [p.text, JSON.stringify(a.run.estimate, null, 1), JSON.stringify(a.windows, null, 1)].join(
          '\n',
        ),
      );
    expect(p.text).toContain('[Coéquipier 1] t’es nul ?');
    expect(p.text).not.toContain('Théo');
    expect(p.text).toContain('[e-mail masqué]');
    expect(p.text).not.toMatch(/SECRETDISCORD|SECRETBIS/);
    expect(p.text).toMatch(/DSC contenu non transmis/);
    expect(p.text).toContain('Aucune image : aucun profil de cadrage choisi.');
    expect(p.text).toContain('<transcription_non_fiable>');

    const manifest = (
      await call<{ manifest: Record<string, unknown> }>('GET', `/api/analyses/${a.run.id}/manifest`)
    ).body.manifest;
    expect(manifest).toMatchObject({ mode: 'dry_run', nothingSent: true });
    expect(manifest['tracks']).toEqual([
      expect.objectContaining({
        audioIndex: 0,
        role: 'mic',
        textTransmitted: true,
        energyMeasured: true,
      }),
      expect.objectContaining({ audioIndex: 1, role: 'discord', textTransmitted: false }),
    ]);
    // Repérage global (scope full, micro seulement).
    const tr = (await call<{ text: string }>('GET', `/api/analyses/${a.run.id}/triage/1`)).body
      .text;
    expect(tr).toContain('attends quoi ?');
    expect(tr).not.toContain('SECRETDISCORD');

    // Estimation : plafond de 5 $, versions des tarifs, coût par fenêtre.
    const est = a.run.estimate as {
      budgetUsd: number;
      pricingVersion: string;
      fit: { windowCount: number };
      totals: { maxUsd: number };
    };
    expect(est).toMatchObject({ budgetUsd: 5, pricingVersion: '2026-11-23' });
    expect(est.fit.windowCount).toBe(a.windows.length);
    expect((w.estimate as { maxUsd: number }).maxUsd).toBeGreaterThan(0);

    // Fichiers sur disque (hors processing/, jamais nettoyés par le cache).
    const dir = path.join(config.paths.storage, a.run.outputRelDir!);
    expect(a.run.outputRelDir).toMatch(/^analysis\//);
    for (const f of [
      'LISEZMOI.txt',
      'manifeste.json',
      'estimation.json',
      'fenetres/fenetre-001.txt',
      'reperage/tranche-01.txt',
    ]) {
      expect(existsSync(path.join(dir, f)), f).toBe(true);
    }
    // Requêtes EXACTES consultables avant tout appel (4b) : prompts, données, schéma.
    for (const f of ['requetes/reperage-01.json', 'requetes/fenetre-001.json']) {
      const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as {
        requestHash: string;
        body: Record<string, unknown>;
      };
      expect(r.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body).not.toHaveProperty('tools');
      expect(r.body).not.toHaveProperty('fallbacks');
      const raw = JSON.stringify(r.body);
      expect(raw).not.toMatch(/SECRETDISCORD|SECRETBIS|Théo/);
      expect(raw).toContain('transcription_non_fiable');
    }
    expect((await fingerprintFile(video)).hash).toBe(fpBefore);
  });

  it('réutilise une préparation identique ; force en crée une nouvelle', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const a = await analyze(rec.id);
    const b = await analyze(rec.id);
    expect(b.status).toBe(200);
    expect(b.request).toMatchObject({ status: 'ready', reused: true, job: null });
    expect(b.run.id).toBe(a.run.id);
    const c = await analyze(rec.id, { force: true });
    expect(c.run.id).not.toBe(a.run.id);
    expect(c.windows.map((w) => w.cacheKey)).toEqual(a.windows.map((w) => w.cacheKey));
  });

  it('Discord : accord explicite avec note obligatoire, puis texte transmis', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const url = `/api/recordings/${rec.id}/analysis-settings`;
    expect((await call('PUT', url, { discordTextAllowed: true })).status).toBe(400);
    const s = await call<{ settings: SettingsView }>('PUT', url, {
      discordTextAllowed: true,
      discordConsentNote: 'Accord oral de Théo et Max le 23/11',
    });
    expect(s.body.settings).toMatchObject({ discordTextAllowed: true });
    expect(s.body.settings.discordConsentAt).toBeTruthy();
    const a = await analyze(rec.id);
    const p = await payload(a.run.id, 1);
    expect(p.text).toContain('SECRETDISCORD');
    // Retrait de l'accord : de nouveau retenu.
    await call('PUT', url, { discordTextAllowed: false });
    const b = await analyze(rec.id);
    expect((await payload(b.run.id, 1)).text).not.toContain('SECRETDISCORD');
  });

  it('cadrage : aperçu, aucune image avant validation, images masquées après, invalidation si le profil change', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const preview = await call<{ files: { kind: string; url: string; name: string }[] }>(
      'POST',
      `/api/recordings/${rec.id}/framing-preview`,
      { profileId: 'test-moitie', atMs: 1000 },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.files.map((f) => f.kind)).toEqual(['annotated', 'gameplay']); // facecam non autorisée
    const img = await app.inject({ method: 'GET', url: preview.body.files[1]!.url });
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/recordings/${rec.id}/framing-preview/..%2F..%2Fsecret.jpg`,
        })
      ).statusCode,
    ).toBe(404);

    // Profil choisi mais non validé : toujours aucune image.
    await call('PUT', `/api/recordings/${rec.id}/analysis-settings`, {
      framingProfileId: 'test-moitie',
    });
    let a = await analyze(rec.id);
    expect(a.windows[0]!.frames).toEqual([]);
    expect((await payload(a.run.id, 1)).text).toContain('le profil de cadrage n’a pas été validé');

    // Validation : images de gameplay, zones sensibles et facecam masquées.
    const v = await call<{ settings: SettingsView }>(
      'POST',
      `/api/recordings/${rec.id}/framing-validation`,
      { profileId: 'test-moitie' },
    );
    expect(v.body.settings.framingStatus).toBe('validated');
    a = await analyze(rec.id);
    const frames = a.windows[0]!.frames as {
      derivativeId: string;
      region: string;
      atMs: number;
      width: number;
    }[];
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.region === 'gameplay' && f.width === 320)).toBe(true);
    const d = services.derivatives.repo.get(frames[0]!.derivativeId)!;
    expect(d.kind).toBe('frame');
    const file = services.derivatives.abs(d.relPath);
    const masked = pixelAt(file, 260, 40);
    expect(Math.max(...masked)).toBeLessThan(40); // zone « Pseudos » : aplat noir
    const facecam = pixelAt(file, 30, 160);
    expect(Math.max(...facecam)).toBeLessThan(40); // facecam masquée (pas d'accord)
    const visible = pixelAt(file, 120, 40);
    expect(Math.max(...visible)).toBeGreaterThan(150); // gameplay visible
    const served = await app.inject({ method: 'GET', url: `/api/frames/${d.id}` });
    expect(served.statusCode).toBe(200);
    expect((await payload(a.run.id, 1)).text).toContain(
      'gameplay recadré, zones sensibles masquées',
    );

    // Accord facecam : une image de facecam en plus.
    await call('PUT', `/api/recordings/${rec.id}/analysis-settings`, { facecamAllowed: true });
    a = await analyze(rec.id);
    expect((a.windows[0]!.frames as { region: string }[]).map((f) => f.region)).toEqual([
      'gameplay',
      'facecam',
      'gameplay',
      'facecam',
    ]);

    // Le fichier du profil change : la validation ne vaut plus, plus aucune image.
    const pf = path.join(root, 'profiles', 'framing', 'test-moitie.json');
    const original = readFileSync(pf, 'utf8');
    try {
      writeFileSync(pf, original.replace('"Pseudos"', '"Pseudos modifiés"'));
      const s = await call<{ settings: SettingsView }>(
        'GET',
        `/api/recordings/${rec.id}/analysis-settings`,
      );
      expect(s.body.settings.framingStatus).toBe('changed');
      a = await analyze(rec.id);
      expect(a.windows[0]!.frames).toEqual([]);
      expect((await payload(a.run.id, 1)).text).toContain('revalidez-le');
    } finally {
      writeFileSync(pf, original);
    }
  });

  it('une préparation restée en cours au redémarrage est marquée interrompue', async () => {
    await setup();
    const rec = await importAndTranscribe();
    const a = await analyze(rec.id);
    db.prepare(`UPDATE analysis_runs SET status = 'running' WHERE id = ?`).run(a.run.id);
    expect(services.analysis.recover()).toBe(1);
    expect(services.analysis.repo.getRun(a.run.id)).toMatchObject({ status: 'interrupted' });
  });

  it('refuse un fichier de confidentialité invalide sans en afficher le contenu', async () => {
    await setup();
    const rec = await importAndTranscribe();
    writeFileSync(
      config.analysis.privacyFile,
      JSON.stringify({ schemaVersion: 1, pseudonyms: [{ names: [], secretField: 'NomRéel' }] }),
    );
    const r = await call<{ error: { code: string; message: string } }>(
      'POST',
      `/api/recordings/${rec.id}/analyses`,
      {},
    );
    expect(r.body.error.code).toBe('PRIVACY_CONFIG_INVALID');
    expect(JSON.stringify(r.body)).not.toContain('NomRéel');
  });
});
