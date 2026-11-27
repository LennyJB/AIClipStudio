/**
 * Import de médias (étape 7, PR 7f), FFmpeg réel : images et sons acceptés et NORMALISÉS
 * (PNG RGBA, WAV 48 kHz stéréo), fichiers piégés REFUSÉS avec une raison explicite.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  animatedGif,
  apng,
  halfTransparentPng,
  hugePngHeader,
  polyglot,
  solidImage,
  textFile,
  tinyVideo,
  tone,
  truncated,
} from '../../../tests/helpers/asset-fixtures';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import { DEFAULT_ASSET_LIMITS, importAsset, sha256File } from './assets';

const enabled = ffmpegAvailable();
let dir: string;
let n = 0;

const run = (input: string, declaredName = path.basename(input), limits = DEFAULT_ASSET_LIMITS) =>
  importAsset({
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    input,
    declaredName,
    workDir: path.join(dir, `work-${n++}`),
    limits,
  });

/** Raison du refus (ou « accepté »). */
async function reason(input: string, declaredName?: string, limits?: typeof DEFAULT_ASSET_LIMITS) {
  try {
    await run(input, declaredName, limits);
    return 'accepted';
  } catch (err) {
    const e = err as { code?: string; details?: { reason?: string } };
    expect(e.code).toBe('ASSET_REJECTED');
    return e.details?.reason;
  }
}

describe.runIf(enabled)('bibliothèque de médias : import (FFmpeg réel)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acs-assets-'));
  });

  it('images PNG, JPEG, WebP et GIF fixe : acceptées, normalisées en PNG RGBA, sans métadonnées, aperçu ≤ 256 px', async () => {
    for (const name of ['a.png', 'b.jpg', 'c.webp', 'd.gif']) {
      const input = solidImage(dir, name, '0x00FF00', 640, 320);
      const original = await sha256File(input);
      const r = await run(input);
      expect(r.kind).toBe('image');
      expect(r.format).toBe('png');
      expect([r.width, r.height]).toEqual([640, 320]);
      const info = JSON.parse(
        execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', r.file], {
          encoding: 'utf8',
        }),
      ) as { streams: { codec_name: string; pix_fmt: string }[] };
      expect(info.streams[0]!.codec_name).toBe('png');
      expect(info.streams[0]!.pix_fmt).toBe('rgba');
      expect(r.fileSha256).toBe(await sha256File(r.file));
      // Aperçu réduit (rapport conservé), original jamais modifié.
      const p = JSON.parse(
        execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', r.preview!], {
          encoding: 'utf8',
        }),
      ) as { streams: { width: number; height: number }[] };
      expect([p.streams[0]!.width, p.streams[0]!.height]).toEqual([256, 128]);
      expect(await sha256File(input)).toBe(original);
    }
  });

  it('transparence conservée (PNG RGBA)', async () => {
    const input = halfTransparentPng(dir, 'alpha.png', '0xFF0000', 8, 2);
    const r = await run(input);
    const raw = execFileSync(
      FFMPEG,
      ['-v', 'error', '-i', r.file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      {
        maxBuffer: 1 << 20,
      },
    );
    expect(raw[3]).toBe(255); // gauche opaque
    expect(raw[7 * 4 + 3]).toBe(0); // droite transparente
  });

  it('sons WAV, MP3, OGG, FLAC, M4A : acceptés, normalisés en WAV PCM 48 kHz stéréo, pics calculés', async () => {
    for (const name of ['t.wav', 't.mp3', 't.ogg', 't.flac', 't.m4a']) {
      const r = await run(tone(dir, name, 1000, 0.5));
      expect(r.kind, name).toBe('audio');
      expect(r.format).toBe('wav');
      expect(Math.abs(r.durationMs! - 500)).toBeLessThan(80);
      expect(r.peaks).toHaveLength(120);
      expect(Math.max(...r.peaks!)).toBeGreaterThan(0.05);
      const wav = await readFile(r.file);
      expect(wav.readUInt16LE(22)).toBe(2); // stéréo
      expect(wav.readUInt32LE(24)).toBe(48_000);
    }
  });

  it('fichiers piégés : SVG, HTML, listes de lecture, ffconcat refusés AVANT toute lecture par FFmpeg', async () => {
    const cases: [string, string][] = [
      ['x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ['x.png', '<svg xmlns="http://www.w3.org/2000/svg"></svg>                    '],
      ['x.html', '<html><body>hello</body></html>                                 '],
      ['x.mp3', '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n                       '],
      ['x.wav', 'ffconcat version 1.0\nfile /etc/passwd\n                        '],
    ];
    for (const [name, content] of cases) {
      expect(await reason(textFile(dir, name, content)), name).toBe('format');
    }
  });

  it('extension trompeuse (PNG nommé .jpg, son nommé .png) et extension inconnue refusées', async () => {
    const png = solidImage(dir, 'real.png', '0x123456');
    expect(await reason(png, 'photo.jpg')).toBe('extension_mismatch');
    expect(await reason(tone(dir, 'snd.wav'), 'image.png')).toBe('extension_mismatch');
    expect(await reason(png, 'image.exe')).toBe('extension');
    expect(await reason(png, 'image')).toBe('extension');
  });

  it('polyglottes (image + ZIP/HTML ajoutés) refusés', async () => {
    expect(await reason(polyglot(dir, solidImage(dir, 'p.png', 'red'), 'poly.png'))).toBe(
      'trailing_data',
    );
    expect(await reason(polyglot(dir, solidImage(dir, 'p.jpg', 'red'), 'poly.jpg'))).toBe(
      'trailing_data',
    );
    expect(await reason(polyglot(dir, solidImage(dir, 'p.gif', 'red'), 'poly.gif'))).toBe(
      'trailing_data',
    );
    expect(await reason(polyglot(dir, tone(dir, 'p.wav'), 'poly.wav'))).toBe('trailing_data');
  });

  it('images animées (GIF animé, APNG) refusées', async () => {
    expect(await reason(animatedGif(dir))).toBe('animated');
    expect(await reason(apng(dir, solidImage(dir, 'base.png', 'blue')))).toBe('animated');
  });

  it('dimensions énormes refusées depuis l’en-tête (aucun décodage), et limite configurable', async () => {
    expect(await reason(hugePngHeader(dir))).toBe('too_large');
    const img = solidImage(dir, 'big.png', 'white', 300, 200);
    expect(await reason(img, 'big.png', { ...DEFAULT_ASSET_LIMITS, maxImageSide: 256 })).toBe(
      'too_large',
    );
  });

  it('fichiers corrompus, vides, trop gros ou trop longs refusés ; vidéo déguisée en son refusée', async () => {
    expect(
      await reason(truncated(dir, solidImage(dir, 'tr.png', 'red', 200, 200), 'cut.png')),
    ).toBe('corrupt');
    expect(await reason(textFile(dir, 'empty.wav', ''))).toBe('empty');
    expect(
      await reason(tone(dir, 'big.wav', 440, 1), 'big.wav', {
        ...DEFAULT_ASSET_LIMITS,
        maxBytes: 1000,
      }),
    ).toBe('too_large');
    expect(
      await reason(tone(dir, 'long.wav', 440, 3), 'long.wav', {
        ...DEFAULT_ASSET_LIMITS,
        maxAudioMs: 2000,
      }),
    ).toBe('too_long');
    expect(await reason(tinyVideo(dir))).toBe('streams');
  });
});
