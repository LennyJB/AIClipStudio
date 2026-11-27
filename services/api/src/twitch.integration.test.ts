/**
 * Étape 8 par l'API, FFmpeg réel (Linux et Windows en CI), aucun appel à Claude :
 *  - import de rediffusions Twitch (MP4, MPEG-TS), MOV, multipiste hors OBS ; formats refusés ;
 *  - état du fichier : tronqué, durée absente (mesurée), piste audio courte ⇒ « degraded » ;
 *  - piste unique « Tout » : transcription WAV mono 16 kHz, montage WAV stéréo 48 kHz limité à
 *    la fenêtre et mis en cache ; jamais de superposition de pistes ;
 *  - composition et accords : piste mixée bloquée tant que sa composition n'est pas déclarée,
 *    puis tant que les voix présentes n'ont pas d'accord ;
 *  - reprise après interruption ; originaux jamais modifiés ; MKV OBS inchangé.
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createFixtures,
  ffmpegAvailable,
  FFMPEG,
  FFPROBE,
  type Fixtures,
} from '../../../tests/helpers/media-fixtures';
import { createTwitchFixtures, type TwitchFixtures } from '../../../tests/helpers/twitch-fixtures';
import { buildApp } from './app';
import { loadConfig } from './config';
import { openDatabase, type Db } from './db';
import type { DerivativeDto } from './derivatives/repository';
import type { DerivativeRequestResult } from './derivatives/service';
import type { RecordingDto } from './recordings/repository';
import type { Services } from './services';

const enabled = ffmpegAvailable();
let tw: TwitchFixtures;
let obs: Fixtures;
const apps: FastifyInstance[] = [];

async function setup() {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-twitch-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    STORAGE_DIR: storage,
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: FFPROBE,
    CLIP_WINDOW_MARGIN_SEC: '1',
    CLIP_WINDOW_GRID_SEC: '1',
  });
  const db: Db = openDatabase(':memory:');
  const { app, services } = buildApp({ config, db });
  apps.push(app);
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject(
      payload === undefined ? { method, url } : { method, url, payload: payload as object },
    );
    return { status: res.statusCode, body: res.json<T>() };
  };
  return { app, services: services as Services, db, storage, call };
}
type Inst = Awaited<ReturnType<typeof setup>>;

const importRec = async (i: Inst, file: string) =>
  i.call<{ recording: RecordingDto; error?: { code: string; message: string } }>(
    'POST',
    '/api/recordings',
    { path: file },
  );
const derivatives = async (i: Inst, id: string) =>
  (await i.call<{ derivatives: DerivativeDto[] }>('GET', `/api/recordings/${id}`)).body.derivatives;
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

describe.skipIf(!enabled)('étape 8 par l’API : Twitch, mono-piste, fichiers incomplets', () => {
  beforeAll(() => {
    tw = createTwitchFixtures();
    obs = createFixtures();
  }, 180_000);

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
  });

  it('import : MP4 et TS Twitch, MOV ⇒ une piste « Tout » (single_track), santé ok ; formats et fichiers illisibles refusés explicitement', async () => {
    const i = await setup();
    for (const [file, container] of [
      [tw.twitchMp4, 'mp4'],
      [tw.twitchTs, 'mpegts'],
      [tw.singleMov, 'mp4'],
    ] as const) {
      const r = await importRec(i, file);
      expect(r.status, file).toBe(201);
      const rec = r.body.recording;
      expect(rec.container).toBe(container);
      expect(rec.audioTracks.map((t) => [t.role, t.roleSource])).toEqual([['mix', 'single_track']]);
      expect(rec.health).toEqual({ status: 'ok', issues: [] });
      expect(rec.durationSec).toBeCloseTo(8, 0);
      expect(rec.scan).toMatchObject({ headErrors: 0, tailErrors: 0 });
    }
    const avi = await importRec(i, tw.avi);
    expect(avi.status).toBe(400);
    expect(avi.body.error?.code).toBe('MEDIA_UNSUPPORTED');
    const cut = await importRec(i, tw.truncatedMp4);
    expect(cut.body.error?.code).toBe('MEDIA_PROBE_FAILED');
  }, 120_000);

  it('fichiers incomplets ou incertains : jamais présentés comme valides ; durée mesurée', async () => {
    const i = await setup();
    const trunc = (await importRec(i, tw.truncatedMkv)).body.recording;
    expect(trunc.health.status).toBe('degraded');
    expect(trunc.health.issues).toContain('truncated');
    expect(trunc.durationSource).toBe('scan');
    expect(trunc.durationSec!).toBeLessThan(6.5);
    const short = (await importRec(i, tw.audioShortMp4)).body.recording;
    expect(short.health).toMatchObject({ status: 'degraded', issues: ['audio_track_short'] });
    const noDur = (await importRec(i, tw.noDurationMkv)).body.recording;
    expect(noDur).toMatchObject({ durationSource: 'scan', health: { status: 'ok' } });
    expect(noDur.durationSec).toBeCloseTo(8, 0);
    const offset = (await importRec(i, tw.videoOffsetMkv)).body.recording;
    expect(offset.warnings).toContain('video_track_offset');
    expect(offset.health.status).toBe('ok');
    // La liste expose le même état.
    const list = await i.call<{ recordings: RecordingDto[] }>('GET', '/api/recordings');
    expect(list.body.recordings.find((r) => r.id === trunc.id)?.health.status).toBe('degraded');
  }, 120_000);

  it('multipiste : conteneur OBS (MP4) ⇒ ordre configuré, signalé à vérifier ; hors OBS (TS) ⇒ inconnu ; correction des rôles ⇒ avertissement levé', async () => {
    const i = await setup();
    const mp4 = (await importRec(i, tw.multiMp4)).body.recording;
    expect(mp4.audioTracks.map((t) => [t.role, t.roleSource])).toEqual([
      ['mix', 'config'],
      ['mic', 'config'],
    ]);
    expect(mp4.warnings).toContain('track_roles_from_config');
    const ts = (await importRec(i, tw.multiTs)).body.recording;
    expect(ts.audioTracks.map((t) => [t.role, t.roleSource])).toEqual([
      ['unknown', 'default'],
      ['unknown', 'default'],
    ]);
    expect(ts.warnings).not.toContain('track_roles_from_config');
    const fixed = await i.call<{ recording: RecordingDto }>(
      'PATCH',
      `/api/recordings/${mp4.id}/tracks`,
      { roles: ['mix', 'discord'] },
    );
    expect(fixed.body.recording.warnings).not.toContain('track_roles_from_config');
    // Deux pistes inconnues : une seule est préparée pour le montage (jamais superposées).
    await i.call('POST', `/api/recordings/${ts.id}/audio-stems`, {
      srcStartMs: 1000,
      srcEndMs: 3000,
    });
    await i.services.runner.idle();
    const stems = (await derivatives(i, ts.id)).filter((d) => d.kind === 'audio_stem');
    expect(stems.map((d) => d.audioIndex)).toEqual([0]);
  }, 120_000);

  it('piste unique « Tout » : transcription mono 16 kHz, montage stéréo 48 kHz sur la fenêtre, mis en cache ; reprise après interruption ; original intact', async () => {
    const i = await setup();
    const before = sha(tw.twitchTs);
    const rec = (await importRec(i, tw.twitchTs)).body.recording;
    const tr = await i.call<DerivativeRequestResult>(
      'POST',
      `/api/recordings/${rec.id}/transcription-audio`,
    );
    expect(tr.status).toBe(202);
    await i.services.runner.idle();
    const ders = await derivatives(i, rec.id);
    const audio = ders.filter((d) => d.kind === 'audio_transcription');
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ audioIndex: 0, params: { sampleRate: 16000, channels: 1 } });
    expect(audio[0]!.durationMs).toBeGreaterThan(7_800);

    const first = await i.call<
      DerivativeRequestResult & { window: { startMs: number; endMs: number } }
    >('POST', `/api/recordings/${rec.id}/audio-stems`, { srcStartMs: 2000, srcEndMs: 4000 });
    expect(first.status).toBe(202);
    expect(first.body.window).toEqual({ startMs: 1000, endMs: 5000 });
    await i.services.runner.idle();
    const stems = (await derivatives(i, rec.id)).filter((d) => d.kind === 'audio_stem');
    expect(stems).toHaveLength(1);
    expect(stems[0]).toMatchObject({
      audioIndex: 0,
      srcStartMs: 1000,
      srcEndMs: 5000,
      params: { sampleRate: 48000, channels: 2 },
    });
    expect(Math.abs(stems[0]!.durationMs! - 4000)).toBeLessThan(60);
    // Cache : la même demande est servie sans nouveau traitement.
    const again = await i.call<DerivativeRequestResult>(
      'POST',
      `/api/recordings/${rec.id}/audio-stems`,
      { srcStartMs: 2000, srcEndMs: 4000 },
    );
    expect(again.status).toBe(200);
    expect(again.body.jobs).toEqual([]);

    // Interruption : un traitement resté « en cours » devient interrompu, puis se relance.
    i.db
      .prepare(
        `INSERT INTO jobs (id, recording_id, type, lane, target_key, status)
         VALUES ('jx', ?, 'extract_audio_stems', 'interactive', 'k-x', 'running')`,
      )
      .run(rec.id);
    expect(i.services.runner.recover()).toBe(1);
    const relaunch = await i.call<DerivativeRequestResult>(
      'POST',
      `/api/recordings/${rec.id}/audio-stems`,
      { srcStartMs: 6000, srcEndMs: 7000 },
    );
    expect(relaunch.status).toBe(202);
    await i.services.runner.idle();
    expect((await derivatives(i, rec.id)).filter((d) => d.kind === 'audio_stem')).toHaveLength(2);
    expect(sha(tw.twitchTs)).toBe(before);
  }, 180_000);

  it('composition et accords : piste mixée bloquée sans déclaration, puis sans les accords des voix présentes ; jamais supposée autorisée', async () => {
    const i = await setup();
    const rec = (await importRec(i, tw.twitchMp4)).body.recording;
    type View = {
      decision: {
        mode: string;
        selected: { audioIndex: number }[];
        tracks: { exportable: boolean; missing: { kind: string; subject: string }[] }[];
        captionRoles: string[];
      };
    };
    const view = async () =>
      (await i.call<View>('GET', `/api/recordings/${rec.id}/export-audio`)).body.decision;
    const post = (body: Record<string, unknown>) =>
      i.call<View>('POST', `/api/recordings/${rec.id}/export-audio`, {
        requestId: randomUUID(),
        ...body,
      });

    let d = await view();
    expect(d).toMatchObject({ mode: 'none', selected: [], captionRoles: [] });
    expect(d.tracks[0]!.missing).toContainEqual({
      kind: 'declaration',
      subject: 'mix_composition',
    });

    // Déclarée avec des voix Discord : bloquée tant que l'accord manque.
    await post({
      kind: 'declaration',
      subject: 'mix_composition',
      payload: { discord: 'present', gameVoiceChat: 'absent', otherVoices: 'absent' },
    });
    d = await view();
    expect(d.mode).toBe('none');
    expect(d.tracks[0]!.missing).toEqual([{ kind: 'consent', subject: 'discord_voices' }]);
    await post({ kind: 'consent', subject: 'discord_voices', action: 'granted' });
    d = await view();
    expect(d).toMatchObject({ mode: 'mix', selected: [{ audioIndex: 0 }], captionRoles: ['mix'] });
    // Révocation : de nouveau bloquée.
    await post({ kind: 'consent', subject: 'discord_voices', action: 'revoked' });
    expect((await view()).mode).toBe('none');
  }, 120_000);

  it('non-régression OBS : MKV multipiste nommé, rôles par nom, santé ok, aucune mesure complète inutile', async () => {
    const i = await setup();
    const rec = (await importRec(i, obs.obsMkv)).body.recording;
    expect(rec.audioTracks.map((t) => [t.role, t.roleSource])).toEqual([
      ['mix', 'title'],
      ['mic', 'title'],
      ['discord', 'title'],
    ]);
    expect(rec).toMatchObject({
      container: 'mkv',
      durationSource: 'format',
      health: { status: 'ok' },
    });
    expect(rec.scan?.measuredDurationSec).toBeNull();
    const game = (await importRec(i, obs.gameMkv)).body.recording;
    expect(game.audioTracks.map((t) => t.role)).toEqual(['mix', 'mic', 'discord', 'game']);
  }, 120_000);
});
