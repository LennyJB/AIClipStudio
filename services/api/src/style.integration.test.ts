/**
 * Étape 10, de bout en bout par l'API : vidéos de référence et paires brut + montage analysées
 * localement (FFmpeg réel), profils (brouillon, validation, versions), application aux nouveaux
 * projets selon le format de l'extrait, apprentissage depuis l'éditeur. Faux modèle : aucun appel
 * à Claude API ; aucune vidéo n'est envoyée nulle part.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

let dir: string;
let reference: string;
let raw: string;
let pairEdited: string;
let audioOnly: string;
let master: string;
let app: FastifyInstance;
let services: Services;
let db: Db;
let config: AppConfig;

const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...args]);
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

async function setup() {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-style-api-'));
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
  const video = path.join(storage, 'original.mkv');
  copyFileSync(master, video);
  return video;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async <T = Json>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) => {
  const res = await app.inject(
    payload === undefined ? { method, url } : { method, url, payload: payload as Json },
  );
  return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
};

const importRef = async (body: Json) => {
  const r = await call('POST', '/api/style-references', body);
  return r;
};
const analyze = async (id: string) => {
  const r = await call('POST', `/api/style-references/${id}/analyze`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  expect(r.body.job).toMatchObject({ type: 'analyze_style_reference', lane: 'heavy' });
  await services.runner.idle();
  return (await call('GET', `/api/style-references/${id}`)).body.reference;
};
const profile = async (id: string) => (await call('GET', `/api/style-profiles/${id}`)).body;
const learn = (id: string) =>
  call('POST', `/api/style-profiles/${id}/learn`, { requestId: randomUUID() });
const validate = async (id: string) => {
  const p = await profile(id);
  return call('POST', `/api/style-profiles/${id}/validate`, {
    requestId: randomUUID(),
    version: p.draft.version,
    featuresHash: p.draft.hash,
  });
};
const editDraft = async (id: string, set: Json, clear: string[] = []) => {
  const p = await profile(id);
  return call('PUT', `/api/style-profiles/${id}/draft`, {
    requestId: randomUUID(),
    baseVersion: p.versions.at(-1)?.version ?? 0,
    set,
    clear,
  });
};

/** Import, transcription, analyse (faux modèle), acceptation de la proposition « clip ». */
async function acceptedClip(video: string) {
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
  const l = await call('GET', `/api/recordings/${rec.id}/proposals`);
  const clip = l.body.items.find((i: Json) => i.proposal.tier === 'clip').proposal;
  await call('POST', `/api/proposals/${clip.id}/decision`, {
    requestId: randomUUID(),
    decision: 'accepted',
  });
  await call('POST', `/api/recordings/${rec.id}/export-audio`, {
    requestId: randomUUID(),
    kind: 'declaration',
    subject: 'mic_composition',
    payload: { creatorVoice: 'present', otherVoices: 'absent' },
  });
  return { rec, clip };
}
const createProject = (pid: string) =>
  call('POST', `/api/proposals/${pid}/clip-project`, { requestId: randomUUID() });

describe.skipIf(!enabled)(
  'Étape 10 : style de montage (API, FFmpeg réel, aucun appel externe)',
  () => {
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'acs-style-fx-'));
      // Référence montée : 4 plans de couleurs différentes (coupes nettes), 12 s, son avec un silence.
      reference = path.join(dir, 'reference-autre-createur.mp4');
      ff([
        ...['-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=3'],
        ...['-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=3'],
        ...['-f', 'lavfi', '-i', 'color=c=green:s=180x320:r=30:d=3'],
        ...['-f', 'lavfi', '-i', 'color=c=white:s=180x320:r=30:d=3'],
        ...['-f', 'lavfi', '-i', 'sine=f=440:d=8:sample_rate=48000'],
        ...['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2'],
        ...['-f', 'lavfi', '-i', 'sine=f=660:d=2:sample_rate=48000'],
        ...['-filter_complex', '[0][1][2][3]concat=n=4:v=1:a=0[v];[4][5][6]concat=n=3:v=0:a=1[a]'],
        ...[
          '-map',
          '[v]',
          '-map',
          '[a]',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          reference,
        ],
      ]);
      // Brut : 60 s, son « en créneaux » non périodique (alignable) ; montage : 3 extraits du brut.
      raw = path.join(dir, 'brut.mkv');
      ff([
        ...['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=60'],
        ...['-f', 'lavfi', '-i', 'anoisesrc=d=60:c=pink:a=0.5:r=48000:seed=3'],
        ...[
          '-filter_complex',
          "[1]volume='if(gt(sin(t*1.3)+sin(t*2.7)+sin(t*0.61),0),1,0.08)':eval=frame[a]",
        ],
        ...[
          '-map',
          '0:v',
          '-map',
          '[a]',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-c:a',
          'flac',
          raw,
        ],
      ]);
      pairEdited = path.join(dir, 'montage.mp4');
      ff([
        '-i',
        raw,
        ...['-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=4'],
        ...['-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=6'],
        ...['-f', 'lavfi', '-i', 'color=c=yellow:s=180x320:r=30:d=4'],
        ...[
          '-filter_complex',
          '[0:a]atrim=5:9,asetpts=PTS-STARTPTS[a1];[0:a]atrim=20:26,asetpts=PTS-STARTPTS[a2];' +
            '[0:a]atrim=40:44,asetpts=PTS-STARTPTS[a3];[a1][a2][a3]concat=n=3:v=0:a=1[a];' +
            '[1][2][3]concat=n=3:v=1:a=0[v]',
        ],
        ...[
          '-map',
          '[v]',
          '-map',
          '[a]',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          pairEdited,
        ],
      ]);
      audioOnly = path.join(dir, 'son.mkv');
      ff(['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:a', 'flac', audioOnly]);
      master = createTalkVideo(mkdtempSync(path.join(tmpdir(), 'acs-style-video-')), 180);
      process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
        language: 'fr',
        tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
      });
    }, 180_000);

    afterEach(async () => {
      vi.restoreAllMocks();
      await app?.close();
      db?.close();
    });

    it('six profils fournis (aucun validé) ; catalogue honnête sur ce qui est mesurable', async () => {
      await setup();
      const p = (await call('GET', '/api/style-profiles')).body.profiles;
      expect(p.map((x: Json) => x.id)).toEqual([
        'gaming',
        'just_chatting',
        'reaction',
        'podcast',
        'irl',
        'mixed',
      ]);
      expect(p.every((x: Json) => x.activeVersion === null && x.builtin)).toBe(true);
      const c = (await call('GET', '/api/style/catalog')).body;
      const font = c.features.find((f: Json) => f.key === 'sous_titres.font');
      expect(font.measuredBy).toEqual(['editor']);
      expect(font.note).toMatch(/OCR/u);
      expect(c.features.find((f: Json) => f.key === 'audio.musicBed').measuredBy).toEqual([]);
    });

    it('référence montée : analysée localement, seulement des grandeurs ; aucun chemin exposé ; original intact ; aucun appel réseau', async () => {
      await setup();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const before = sha(reference);
      const r = await importRef({ kind: 'edited', path: reference, profileId: 'gaming' });
      expect(r.status).toBe(201);
      expect(JSON.stringify(r.body)).not.toContain(dir);
      expect(r.body.reference).toMatchObject({
        status: 'pending',
        fileName: 'reference-autre-createur.mp4',
      });
      const a = await analyze(r.body.reference.id);
      expect(a.status).toBe('analyzed');
      const v = a.analysis.observation.values;
      expect(v['format.vertical']).toBe(true);
      expect(v['rythme.cutsPerMinute']).toBeCloseTo(15, 0); // 3 coupes en 12 s
      expect(v['rythme.shotMedianMs']).toBeGreaterThan(2500);
      expect(v['audio.silenceShare']).toBeGreaterThan(0.1);
      expect(v['audio.loudnessLufs']).toBeLessThan(0);
      for (const k of Object.keys(v))
        expect(k).not.toMatch(/^(sous_titres|cadrage|zooms|effets)\./u);
      expect(a.analysis.limits.join(' ')).toMatch(/sous-titres, facecam/u);
      expect(JSON.stringify(a)).not.toContain(dir);
      expect(sha(reference)).toBe(before);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Même fichier : la référence existante est renvoyée.
      expect(await importRef({ kind: 'edited', path: reference })).toMatchObject({
        status: 200,
        body: { created: false },
      });
    });

    it('imports refusés : chemin relatif, paire sans brut, même fichier deux fois, vidéo sans image, paire sans son', async () => {
      await setup();
      expect((await importRef({ kind: 'edited', path: 'relatif.mp4' })).status).toBe(400);
      expect((await importRef({ kind: 'pair', path: pairEdited })).status).toBe(400);
      expect((await importRef({ kind: 'edited', path: pairEdited, rawPath: raw })).status).toBe(
        400,
      );
      expect(
        (await importRef({ kind: 'pair', path: pairEdited, rawPath: pairEdited })).body.error.code,
      ).toBe('VALIDATION_FAILED');
      expect((await importRef({ kind: 'edited', path: audioOnly })).body.error.code).toBe(
        'MEDIA_UNSUPPORTED',
      );
      expect(
        (await importRef({ kind: 'edited', path: reference, profileId: 'inexistant' })).status,
      ).toBe(404);
    });

    it('paire brut + montage : plans retrouvés dans le brut, coupes éditoriales et part conservée', async () => {
      await setup();
      const r = await importRef({
        kind: 'pair',
        path: pairEdited,
        rawPath: raw,
        profileId: 'gaming',
      });
      expect(r.status).toBe(201);
      const a = await analyze(r.body.reference.id);
      expect(a.status, JSON.stringify(a.error)).toBe('analyzed');
      expect(a.analysis.pair).toMatchObject({
        totalShots: 3,
        alignedShots: 3,
        editorialCuts: 2,
        reliable: true,
      });
      const v = a.analysis.observation.values;
      expect(v['rythme.editorialCutsPerMinute']).toBeCloseTo(8.6, 0); // 2 coupes en 14 s
      expect(v['rythme.keptRatio']).toBeCloseTo(14 / 39, 1); // 14 s gardées sur 5 → 44 s
    });

    it('profil : brouillon appris, jamais utilisé avant validation ; validation de ce qui est affiché ; valeur manuelle conservée', async () => {
      await setup();
      expect((await learn('gaming')).body.error.code).toBe('NOT_READY');
      const r = await importRef({ kind: 'edited', path: reference, profileId: 'gaming' });
      await analyze(r.body.reference.id);
      const l1 = await learn('gaming');
      expect(l1.status).toBe(200);
      expect(l1.body).toMatchObject({
        created: true,
        profile: { activeVersion: null, draftPending: true },
      });
      expect(l1.body.draft.features['rythme.cutsPerMinute']).toMatchObject({
        origin: 'learned',
        sources: ['reference'],
        samples: 1,
      });
      expect(services.style.validatedProfiles()).toEqual([]);
      // Rien de nouveau : aucune version créée.
      expect((await learn('gaming')).body.created).toBe(false);

      // Validation : l'empreinte doit être celle des valeurs affichées.
      const p = await profile('gaming');
      const bad = await call('POST', '/api/style-profiles/gaming/validate', {
        requestId: randomUUID(),
        version: p.draft.version,
        featuresHash: 'f'.repeat(64),
      });
      expect(bad.body.error.code).toBe('PRECONDITION_FAILED');
      expect((await validate('gaming')).body.profile).toMatchObject({
        activeVersion: 1,
        draftPending: false,
      });

      // Modification manuelle : nouvelle version (brouillon) ; la version validée reste la 1.
      expect((await editDraft('gaming', { 'sous_titres.sizePx': 500 })).status).toBe(400);
      const e = await editDraft('gaming', {
        'sous_titres.font': 'Inter',
        'audio.musicBed': 'discrete',
      });
      expect(e.body).toMatchObject({
        profile: { activeVersion: 1, latestVersion: 2, draftPending: true },
      });
      expect(e.body.active.features['sous_titres.font']).toBeUndefined();
      expect(e.body.changes).toEqual(['sous_titres.font', 'audio.musicBed']);
      // Concurrence : base périmée refusée.
      const stale = await call('PUT', '/api/style-profiles/gaming/draft', {
        requestId: randomUUID(),
        baseVersion: 1,
        set: { 'sous_titres.uppercase': true },
      });
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      // Une nouvelle référence ne remplace pas la valeur manuelle.
      const r2 = await importRef({
        kind: 'pair',
        path: pairEdited,
        rawPath: raw,
        profileId: 'gaming',
      });
      await analyze(r2.body.reference.id);
      const l2 = await learn('gaming');
      expect(l2.body.draft.features['sous_titres.font']).toMatchObject({
        value: 'Inter',
        origin: 'manual',
      });
      expect(l2.body.draft.features['rythme.cutsPerMinute'].samples).toBe(2);
      expect(l2.body.profile.activeVersion).toBe(1);
      // Versions immuables : la version validée est toujours celle d'origine.
      const v1 = db
        .prepare(
          "SELECT features_json FROM style_profile_versions WHERE profile_id='gaming' AND version=1",
        )
        .get() as { features_json: string };
      expect(JSON.parse(v1.features_json)['sous_titres.font']).toBeUndefined();
    });

    it('profils personnalisés : création, types, archivage ; types d’un profil fourni non modifiables', async () => {
      await setup();
      const c = await call('POST', '/api/style-profiles', {
        name: 'Mes shorts dynamiques',
        contentTypes: ['gaming', 'irl'],
      });
      expect(c.status).toBe(201);
      const id = c.body.profile.id;
      expect(
        (await call('PATCH', `/api/style-profiles/${id}`, { archived: true })).body.profile
          .archived,
      ).toBe(true);
      expect(
        (await call('PATCH', '/api/style-profiles/gaming', { contentTypes: ['irl'] })).status,
      ).toBe(400);
      expect(
        (await call('POST', '/api/style-profiles', { name: '', contentTypes: [] })).status,
      ).toBe(400);
    });

    it('création de projet : sans profil validé, document identique ; avec profil validé, style appliqué et tracé', async () => {
      const video = await setup();
      const { clip } = await acceptedClip(video);
      const plain = await createProject(clip.id);
      expect(plain.status).toBe(201);
      expect(plain.body.document.captions.style.font).toBe('Montserrat ExtraBold');
      const projectId = plain.body.project.id;
      expect((await call('GET', `/api/clip-projects/${projectId}/style`)).body).toEqual({
        applied: false,
      });

      // Second enregistrement, profil Gaming validé (pas de segmentation : extrait considéré gaming).
      await call('PUT', '/api/style-profiles/gaming/draft', {
        requestId: randomUUID(),
        baseVersion: 0,
        set: {
          'sous_titres.font': 'Inter',
          'sous_titres.uppercase': true,
          'densite.mode': 'enrichi',
          'rythme.cutsPerMinute': 14,
        },
      });
      await validate('gaming');
      const second = path.join(path.dirname(video), 'second.mkv');
      // Autre fichier (empreinte différente) : même contenu, octet final changé.
      copyFileSync(video, second);
      writeFileSync(second, Buffer.concat([readFileSync(second), Buffer.from([0])]));
      const { clip: clip2 } = await acceptedClip(second);
      const styled = await createProject(clip2.id);
      expect(styled.status, JSON.stringify(styled.body)).toBe(201);
      expect(styled.body.document.captions.style).toMatchObject({ font: 'Inter', uppercase: true });
      // Le mode indiqué par la proposition elle-même (« fidèle ») prime sur le style.
      expect(styled.body.document.mode).toBe('fidele');
      const s = (await call('GET', `/api/clip-projects/${styled.body.project.id}/style`)).body;
      expect(s).toMatchObject({
        applied: true,
        profileId: 'gaming',
        version: 1,
        contentType: 'gaming',
        values: { hints: { cutsPerMinute: 14 } },
      });
    });

    it('adaptation au passage : l’extrait Just Chatting d’un stream reçoit le profil Just Chatting', async () => {
      const video = await setup();
      for (const [id, font] of [
        ['gaming', 'Montserrat ExtraBold'],
        ['just_chatting', 'Inter'],
      ] as const) {
        await call('PUT', `/api/style-profiles/${id}/draft`, {
          requestId: randomUUID(),
          baseVersion: 0,
          set: { 'sous_titres.font': font },
        });
        await validate(id);
      }
      const { rec, clip } = await acceptedClip(video);
      // Correction du créateur : tout le stream est Just Chatting.
      await call('POST', `/api/recordings/${rec.id}/content-types/detect`, {});
      await services.runner.idle();
      const dur = (await call('GET', `/api/recordings/${rec.id}/content-types`)).body.durationMs;
      await call('PUT', `/api/recordings/${rec.id}/content-types`, {
        requestId: randomUUID(),
        segments: [{ startMs: 0, endMs: dur, type: 'just_chatting' }],
      });
      const p = await createProject(clip.id);
      expect(p.body.document.captions.style.font).toBe('Inter');
      expect(
        (await call('GET', `/api/clip-projects/${p.body.project.id}/style`)).body,
      ).toMatchObject({
        profileId: 'just_chatting',
        contentType: 'just_chatting',
      });
    });

    it('apprentissage depuis l’éditeur : décisions du créateur proposées dans un brouillon, version validée intacte', async () => {
      const video = await setup();
      await call('PUT', '/api/style-profiles/gaming/draft', {
        requestId: randomUUID(),
        baseVersion: 0,
        set: { 'rythme.cutsPerMinute': 2 },
      });
      await validate('gaming');
      const { clip } = await acceptedClip(video);
      const project = (await createProject(clip.id)).body.project.id;
      // Aucune modification : rien à apprendre de l'éditeur (seulement la valeur manuelle).
      expect((await learn('gaming')).body.error.code).toBe('NOT_READY');
      const e = await call('POST', `/api/clip-projects/${project}/edits`, {
        requestId: randomUUID(),
        base: { version: 1 },
        kind: 'do',
        ops: [{ type: 'setCaptionsConfig', style: { uppercase: true, sizePx: 90 } }],
      });
      expect(e.status, JSON.stringify(e.body)).toBe(200);
      const l = await learn('gaming');
      expect(l.status, JSON.stringify(l.body)).toBe(200);
      expect(l.body.draft.features['sous_titres.uppercase']).toMatchObject({
        value: true,
        origin: 'learned',
        sources: ['editor'],
      });
      expect(l.body.draft.features['sous_titres.sizePx'].value).toBe(90);
      // La valeur manuelle validée n'est pas remplacée par l'observation de l'éditeur.
      expect(l.body.draft.features['rythme.cutsPerMinute']).toMatchObject({
        value: 2,
        origin: 'manual',
      });
      expect(l.body.draft.evidence).toMatchObject({ projects: [project] });
      expect(l.body.draft.evidence.changedByCreator['sous_titres.uppercase']).toBe(1);
      expect(l.body.profile.activeVersion).toBe(1);
      expect(l.body.active.features['sous_titres.uppercase']).toBeUndefined();
    });

    it('suppression d’une référence : seule la fiche disparaît, le fichier est intact', async () => {
      await setup();
      const before = sha(reference);
      const r = await importRef({ kind: 'edited', path: reference });
      expect((await call('DELETE', `/api/style-references/${r.body.reference.id}`)).status).toBe(
        204,
      );
      expect((await call('GET', `/api/style-references/${r.body.reference.id}`)).status).toBe(404);
      expect(sha(reference)).toBe(before);
    });
  },
);
