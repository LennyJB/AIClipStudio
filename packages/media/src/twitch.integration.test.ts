/**
 * Étape 8, FFmpeg réel : rediffusions Twitch (MP4, MPEG-TS), multipiste hors OBS, décalages,
 * durées absentes ou fausses, fichiers tronqués ou illisibles. Sonde + contrôle de lecture +
 * extraction (transcription mono 16 kHz, montage stéréo 48 kHz sur une fenêtre).
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import { createTwitchFixtures, type TwitchFixtures } from '../../../tests/helpers/twitch-fixtures';
import { extractAudioTracks } from './extract';
import { mediaHealth, probeMedia } from './probe';
import { applyScan, scanMedia } from './scan';
import { resolveTrackRoles } from './tracks';

const enabled = ffmpegAvailable();
let fx: TwitchFixtures;
let out: string;

const inspect = async (file: string) => {
  const info = await probeMedia(FFPROBE, file);
  return applyScan(info, await scanMedia(FFMPEG, file, info));
};
const sha = async (f: string) =>
  createHash('sha256')
    .update(await readFile(f))
    .digest('hex');

describe.skipIf(!enabled)(
  'étape 8 : rediffusions Twitch et fichiers incomplets (FFmpeg réel)',
  () => {
    beforeAll(async () => {
      fx = createTwitchFixtures();
      out = await mkdtemp(path.join(tmpdir(), 'acs-twitch-out-'));
    }, 120_000);

    it('MP4 Twitch à piste unique : lisible, une seule piste « Tout » (jamais micro/jeu/Discord), santé ok', async () => {
      const m = await inspect(fx.twitchMp4);
      expect(m.container).toBe('mp4');
      expect(m.audioTracks).toHaveLength(1);
      expect(m.audioTracks[0]).toMatchObject({ codec: 'aac', channels: 2, sampleRate: 48000 });
      expect(m.durationSec).toBeCloseTo(8, 0);
      expect(mediaHealth(m.warnings)).toEqual({ status: 'ok', issues: [] });
      // Même si l'ordre configuré dit « micro » pour la piste 0 : piste unique ⇒ mix.
      expect(resolveTrackRoles(m.audioTracks, ['mic', 'discord'])).toEqual([
        { audioIndex: 0, role: 'mix', roleSource: 'single_track' },
      ]);
    });

    it('MPEG-TS Twitch : conteneur reconnu, horodatages non nuls ramenés à 0, durée MESURÉE', async () => {
      const m = await inspect(fx.twitchTs);
      expect(m.container).toBe('mpegts');
      expect(m.audioTracks[0]!.startOffsetSec).toBeLessThan(0.1);
      expect(m.warnings).toContain('duration_estimated');
      expect(m.durationSource).toBe('scan');
      expect(m.durationSec).toBeCloseTo(8, 0);
      expect(m.scan?.measuredDurationSec).toBeGreaterThan(7.5);
      expect(mediaHealth(m.warnings).status).toBe('ok');
    });

    it('multipiste hors OBS (MP4, TS, sans nom) : pistes et index détectés ; l’ordre OBS n’est appliqué qu’aux conteneurs d’OBS', async () => {
      for (const f of [fx.multiMp4, fx.multiTs]) {
        const m = await inspect(f);
        expect(m.audioTracks.map((t) => [t.audioIndex, t.streamIndex, t.codec])).toEqual([
          [0, 1, 'aac'],
          [1, 2, 'aac'],
        ]);
        const configOrder = m.container === 'mkv' || m.container === 'mp4';
        const roles = resolveTrackRoles(m.audioTracks, ['mix', 'mic'], undefined, { configOrder });
        expect(roles.map((r) => r.role)).toEqual(
          configOrder ? ['mix', 'mic'] : ['unknown', 'unknown'],
        );
      }
    });

    it('MOV à piste unique : accepté comme MP4', async () => {
      const m = await inspect(fx.singleMov);
      expect(m.container).toBe('mp4');
      expect(m.audioTracks).toHaveLength(1);
    });

    it('décalages : vidéo commençant après le son ; piste audio trop courte ⇒ partiellement exploitable', async () => {
      const v = await inspect(fx.videoOffsetMkv);
      expect(v.video?.startOffsetSec).toBeCloseTo(1, 1);
      expect(v.warnings).toContain('video_track_offset');
      expect(mediaHealth(v.warnings).status).toBe('ok');
      const a = await inspect(fx.audioShortMp4);
      expect(a.warnings).toContain('audio_track_short');
      expect(mediaHealth(a.warnings)).toMatchObject({
        status: 'degraded',
        issues: ['audio_track_short'],
      });
    });

    it('durée absente de l’en-tête : MESURÉE en lisant les paquets', async () => {
      const probed = await probeMedia(FFPROBE, fx.noDurationMkv);
      expect(probed.durationSec).toBeNull();
      const m = applyScan(probed, await scanMedia(FFMPEG, fx.noDurationMkv, probed));
      expect(m.durationSource).toBe('scan');
      expect(m.durationSec).toBeCloseTo(8, 0);
      expect(m.warnings).not.toContain('duration_unknown');
    });

    it('MKV tronqué : durée d’en-tête FAUSSE remplacée par la durée lisible, signalé « truncated » (jamais valide)', async () => {
      const probed = await probeMedia(FFPROBE, fx.truncatedMkv);
      expect(probed.durationSec).toBeCloseTo(8, 0); // l'en-tête annonce tout le fichier
      const m = applyScan(probed, await scanMedia(FFMPEG, fx.truncatedMkv, probed));
      expect(m.warnings).toContain('truncated');
      expect(m.durationSource).toBe('scan');
      expect(m.durationSec!).toBeLessThan(6.5);
      expect(mediaHealth(m.warnings).status).toBe('degraded');
    });

    it('MP4 tronqué (index absent) ou fichier illisible : refus explicite', async () => {
      await expect(probeMedia(FFPROBE, fx.truncatedMp4)).rejects.toMatchObject({
        code: 'MEDIA_PROBE_FAILED',
      });
    });

    it('extraction : transcription WAV mono 16 kHz et montage WAV stéréo 48 kHz sur une fenêtre, depuis MP4 et TS ; originaux intacts', async () => {
      for (const [k, f] of [
        ['mp4', fx.twitchMp4],
        ['ts', fx.twitchTs],
      ] as const) {
        const before = await sha(f);
        const [t] = await extractAudioTracks({
          ffmpegPath: FFMPEG,
          inputPath: f,
          targets: [{ audioIndex: 0, outputPath: path.join(out, `${k}-transcription.wav`) }],
          profile: 'transcription',
          allowedDir: out,
        });
        expect([t!.sampleRate, t!.channels]).toEqual([16000, 1]);
        expect(t!.durationSec).toBeGreaterThan(7.8);
        const [e] = await extractAudioTracks({
          ffmpegPath: FFMPEG,
          inputPath: f,
          targets: [{ audioIndex: 0, outputPath: path.join(out, `${k}-editor.wav`) }],
          profile: 'editor',
          range: { startMs: 2000, endMs: 5000 },
          allowedDir: out,
        });
        expect([e!.sampleRate, e!.channels]).toEqual([48000, 2]);
        expect(Math.abs(e!.durationSec - 3)).toBeLessThan(0.05);
        expect(await sha(f)).toBe(before);
      }
    });
  },
);
