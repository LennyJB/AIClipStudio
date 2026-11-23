import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bestLagMs,
  createFixtures,
  FFMPEG,
  FFPROBE,
  ffmpegAvailable,
  wavRms,
  type Fixtures,
} from '../../../tests/helpers/media-fixtures';
import { extractAudioTrack, extractAudioTracks } from './extract';
import { fingerprintFile } from './fingerprint';
import { computeWaveform, readWaveform } from './waveform';
import { probeMedia } from './probe';

const enabled = ffmpegAvailable();

describe.skipIf(!enabled)('FFmpeg réel', () => {
  let fx: Fixtures;
  let out: string;
  beforeAll(async () => {
    fx = createFixtures();
    out = await mkdtemp(path.join(tmpdir(), 'acs-out-'));
  }, 60_000);

  describe('probeMedia', () => {
    it('lit un MKV OBS à 3 pistes nommées', async () => {
      const info = await probeMedia(FFPROBE, fx.obsMkv);
      expect(info.container).toBe('mkv');
      expect(info.durationSec).toBeCloseTo(6, 0);
      expect(info.video).toMatchObject({ width: 160, height: 90, fps: 30 });
      expect(info.audioTracks.map((t) => t.title)).toEqual(['Tout', 'Micro', 'Discord']);
    });

    it('lit un MP4 à piste unique', async () => {
      const info = await probeMedia(FFPROBE, fx.singleMp4);
      expect(info.container).toBe('mp4');
      expect(info.audioTracks).toHaveLength(1);
    });

    it('accepte un MKV non finalisé en signalant la durée inconnue', async () => {
      const info = await probeMedia(FFPROBE, fx.unfinalizedMkv);
      expect(info.durationSec).toBeNull();
      expect(info.warnings).toContain('duration_unknown');
    });

    it('détecte le décalage d’une piste audio', async () => {
      const info = await probeMedia(FFPROBE, fx.delayedMkv);
      expect(info.audioTracks[0]?.startOffsetSec).toBeCloseTo(2, 1);
      expect(info.warnings).toContain('audio_track_offset');
    });

    it('rejette un fichier qui n’est pas un média', async () => {
      await expect(probeMedia(FFPROBE, fx.garbageMkv)).rejects.toMatchObject({
        code: 'MEDIA_PROBE_FAILED',
      });
    });

    it('signale un ffprobe absent', async () => {
      await expect(probeMedia('ffprobe-inexistant-xyz', fx.obsMkv)).rejects.toMatchObject({
        code: 'TOOL_MISSING',
      });
    });
  });

  describe('extractAudioTrack', () => {
    it('extrait une piste en WAV mono 16 kHz', async () => {
      const progress: number[] = [];
      const res = await extractAudioTrack({
        ffmpegPath: FFMPEG,
        inputPath: fx.obsMkv,
        audioIndex: 1,
        outputPath: path.join(out, 'obs', 'mic.wav'),
        allowedDir: out,
        expectedDurationSec: 6,
        onProgress: (r) => progress.push(r),
      });
      expect(res).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
      expect(res.durationSec).toBeCloseTo(6, 0);
      expect(progress.at(-1)).toBe(1);
      expect(existsSync(`${res.outputPath}.part`)).toBe(false);
    });

    it('extrait plusieurs pistes en un seul passage', async () => {
      const res = await extractAudioTracks({
        ffmpegPath: FFMPEG,
        inputPath: fx.obsMkv,
        targets: [
          { audioIndex: 1, outputPath: path.join(out, 'multi', 'mic.wav') },
          { audioIndex: 2, outputPath: path.join(out, 'multi', 'discord.wav') },
        ],
        allowedDir: out,
      });
      expect(res.map((r) => r.audioIndex)).toEqual([1, 2]);
      for (const r of res) expect(r.durationSec).toBeCloseTo(6, 0);
      // 440 Hz (micro) et 880 Hz (Discord) : chaque sortie contient bien sa propre piste
      expect(readFileSync(res[0]!.outputPath).equals(readFileSync(res[1]!.outputPath))).toBe(false);
      expect(readdirSync(path.join(out, 'multi')).sort()).toEqual(['discord.wav', 'mic.wav']);
    });

    it('n’écrit aucun fichier final si une des pistes échoue', async () => {
      const dir = path.join(out, 'partial');
      await expect(
        extractAudioTracks({
          ffmpegPath: FFMPEG,
          inputPath: fx.obsMkv,
          targets: [
            { audioIndex: 0, outputPath: path.join(dir, 'ok.wav') },
            { audioIndex: 9, outputPath: path.join(dir, 'ko.wav') },
          ],
          allowedDir: out,
        }),
      ).rejects.toMatchObject({ code: 'MEDIA_EXTRACT_FAILED' });
      expect(readdirSync(dir)).toEqual([]);
    });

    it('conserve l’alignement temporel d’une piste décalée (silence initial)', async () => {
      const res = await extractAudioTrack({
        ffmpegPath: FFMPEG,
        inputPath: fx.delayedMkv,
        audioIndex: 0,
        outputPath: path.join(out, 'delayed.wav'),
        allowedDir: out,
      });
      expect(res.durationSec).toBeCloseTo(6, 0);
      expect(wavRms(res.outputPath, 0, 1.8)).toBeLessThan(0.001);
      expect(wavRms(res.outputPath, 2.3, 3.5)).toBeGreaterThan(0.05);
    });

    it('récupère l’audio d’un MKV tronqué', async () => {
      const res = await extractAudioTrack({
        ffmpegPath: FFMPEG,
        inputPath: fx.truncatedMkv,
        audioIndex: 0,
        outputPath: path.join(out, 'truncated.wav'),
        allowedDir: out,
      });
      expect(res.durationSec).toBeGreaterThan(1);
      expect(res.durationSec).toBeLessThan(6);
    });

    it('nettoie le fichier temporaire en cas d’annulation', async () => {
      const dir = path.join(out, 'cancel');
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      await expect(
        extractAudioTrack({
          ffmpegPath: FFMPEG,
          inputPath: fx.longMkv,
          audioIndex: 0,
          outputPath: path.join(dir, 'long.wav'),
          allowedDir: out,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(readdirSync(dir)).toEqual([]);
    });

    it('échoue proprement sur une piste inexistante', async () => {
      await expect(
        extractAudioTrack({
          ffmpegPath: FFMPEG,
          inputPath: fx.singleMp4,
          audioIndex: 5,
          outputPath: path.join(out, 'none.wav'),
          allowedDir: out,
        }),
      ).rejects.toMatchObject({ code: 'MEDIA_EXTRACT_FAILED' });
      expect(existsSync(path.join(out, 'none.wav.part'))).toBe(false);
    });

    it('n’écrit jamais hors du dossier autorisé', async () => {
      await expect(
        extractAudioTrack({
          ffmpegPath: FFMPEG,
          inputPath: fx.obsMkv,
          audioIndex: 0,
          outputPath: path.join(fx.dir, 'evil.wav'),
          allowedDir: out,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_PATH' });
    });
  });

  describe('profils et plages source', () => {
    it('extrait une fenêtre en 48 kHz stéréo (profil éditeur)', async () => {
      const [res] = await extractAudioTracks({
        ffmpegPath: FFMPEG,
        inputPath: fx.obsMkv,
        targets: [{ audioIndex: 2, outputPath: path.join(out, 'win', 'discord.wav') }],
        allowedDir: out,
        profile: 'editor',
        range: { startMs: 1_000, endMs: 4_000 },
      });
      expect(res).toMatchObject({ sampleRate: 48000, channels: 2, bitsPerSample: 16 });
      expect(res!.durationSec).toBeCloseTo(3, 1);
    });

    it('une fenêtre reste alignée sur le temps source (piste démarrant à 2 s)', async () => {
      const [res] = await extractAudioTracks({
        ffmpegPath: FFMPEG,
        inputPath: fx.delayedMkv,
        targets: [{ audioIndex: 0, outputPath: path.join(out, 'win', 'delayed.wav') }],
        allowedDir: out,
        range: { startMs: 1_500, endMs: 3_500 },
      });
      expect(res!.durationSec).toBeCloseTo(2, 1);
      // [1,5 s ; 2 s[ source = silence ; à partir de 2 s source = son.
      expect(wavRms(res!.outputPath, 0, 0.45)).toBeLessThan(0.001);
      expect(wavRms(res!.outputPath, 0.6, 1.9)).toBeGreaterThan(0.05);
    });

    it('les échantillons d’une fenêtre correspondent à ceux de l’extraction complète', async () => {
      const full = path.join(out, 'align', 'full.wav');
      const win = path.join(out, 'align', 'win.wav');
      await extractAudioTrack({
        ffmpegPath: FFMPEG,
        inputPath: fx.pulseMkv,
        audioIndex: 0,
        outputPath: full,
        allowedDir: out,
      });
      await extractAudioTracks({
        ffmpegPath: FFMPEG,
        inputPath: fx.pulseMkv,
        targets: [{ audioIndex: 0, outputPath: win }],
        allowedDir: out,
        range: { startMs: 3_250, endMs: 5_250 },
      });
      // Décalage mesuré par corrélation : doit rester sous 10 ms (< 1 image à 60 i/s).
      expect(Math.abs(bestLagMs(full, win, 3_250))).toBeLessThanOrEqual(10);
    });

    it('refuse une plage invalide', async () => {
      await expect(
        extractAudioTracks({
          ffmpegPath: FFMPEG,
          inputPath: fx.obsMkv,
          targets: [{ audioIndex: 0, outputPath: path.join(out, 'bad.wav') }],
          allowedDir: out,
          range: { startMs: 3_000, endMs: 3_000 },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('formes d’onde', () => {
    it('calcule 100 points/s ; silence = 0, son = amplitude élevée', async () => {
      const wav = path.join(out, 'wf', 'delayed.wav');
      await extractAudioTrack({
        ffmpegPath: FFMPEG,
        inputPath: fx.delayedMkv,
        audioIndex: 0,
        outputPath: wav,
        allowedDir: out,
      });
      const res = await computeWaveform({
        wavPath: wav,
        outputPath: path.join(out, 'wf', 'delayed.dat'),
        allowedDir: out,
      });
      expect(res).toMatchObject({ sampleRate: 16000, samplesPerPoint: 160, pointsPerSecond: 100 });
      expect(res.length).toBeGreaterThanOrEqual(599);
      expect(res.length).toBeLessThanOrEqual(602);

      const wf = await readWaveform(res.outputPath);
      expect(wf.length).toBe(res.length);
      const peak = (i: number) =>
        Math.max(Math.abs(wf.data[i * 2]!), Math.abs(wf.data[i * 2 + 1]!));
      expect(peak(50)).toBe(0); // 0,5 s : silence
      expect(peak(300)).toBeGreaterThan(10); // 3 s : sinus lavfi (amplitude 1/8 ≈ 16 sur 127)
      expect(existsSync(`${res.outputPath}.part`)).toBe(false);
    });

    it('fonctionne sur un WAV stéréo 48 kHz', async () => {
      const [stem] = await extractAudioTracks({
        ffmpegPath: FFMPEG,
        inputPath: fx.obsMkv,
        targets: [{ audioIndex: 1, outputPath: path.join(out, 'wf', 'stem.wav') }],
        allowedDir: out,
        profile: 'editor',
      });
      const res = await computeWaveform({
        wavPath: stem!.outputPath,
        outputPath: path.join(out, 'wf', 'stem.dat'),
        allowedDir: out,
      });
      expect(res).toMatchObject({ sampleRate: 48000, samplesPerPoint: 480 });
    });

    it('n’écrit pas hors du dossier autorisé', async () => {
      await expect(
        computeWaveform({
          wavPath: path.join(out, 'wf', 'stem.wav'),
          outputPath: path.join(fx.dir, 'x.dat'),
          allowedDir: out,
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_PATH' });
    });
  });

  describe('fingerprintFile', () => {
    it('est stable et ne modifie pas le fichier', async () => {
      const before = statSync(fx.obsMkv).mtimeMs;
      const a = await fingerprintFile(fx.obsMkv);
      const b = await fingerprintFile(fx.obsMkv);
      expect(a).toEqual(b);
      expect(statSync(fx.obsMkv).mtimeMs).toBe(before);
      expect((await fingerprintFile(fx.singleMp4)).hash).not.toBe(a.hash);
    });
  });
});
