/**
 * Étape 10, FFmpeg réel : mesures stylistiques d'une vidéo montée (plans, passage par le noir,
 * image figée, sonie, silences) et enveloppe sonore. Lecture seule ; original intact.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import { audioEnvelope, scanAudioStyle, scanVideoStyle } from './style-scan';

const enabled = ffmpegAvailable();
let edited: string;
let silent: string;
const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...args]);

describe.skipIf(!enabled)('étape 10 : mesures stylistiques (FFmpeg réel)', () => {
  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acs-style-'));
    edited = path.join(dir, 'montage.mp4');
    silent = path.join(dir, 'muet.mkv');
    // 0–3 s mire animée, 3–3,3 s noir, 3,3–4,8 s fractale animée, 4,8–6,3 s rouge figé.
    // Son : 2 s de bip, 1 s de silence, 3,3 s de bip.
    ff([
      ...['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3'],
      ...['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=0.3'],
      ...['-f', 'lavfi', '-i', 'mandelbrot=s=320x180:r=30'],
      ...['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1.5'],
      ...['-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000'],
      ...['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1'],
      ...['-f', 'lavfi', '-i', 'sine=f=660:d=3.3:sample_rate=48000'],
      ...[
        '-filter_complex',
        '[2]trim=duration=1.5,setpts=PTS-STARTPTS[m];[0][1][m][3]concat=n=4:v=1:a=0[v];[4][5][6]concat=n=3:v=0:a=1[a]',
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
        edited,
      ],
    ]);
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=10:d=2', '-c:v', 'libx264', silent]);
  }, 60_000);

  it('image : changements de plan, passage par le noir, image figée ; original intact', async () => {
    const before = createHash('sha256').update(readFileSync(edited)).digest('hex');
    const v = await scanVideoStyle(FFMPEG, edited, 6300);
    expect(v.cutsMs.map((t) => Math.round(t / 100) / 10)).toEqual(
      expect.arrayContaining([3, 3.3, 4.8]),
    );
    expect(v.blacks).toHaveLength(1);
    expect(v.blacks[0]![0]).toBeCloseTo(3000, -2);
    expect(v.blacks[0]![1]).toBeCloseTo(3300, -2);
    expect(v.freezes).toHaveLength(1);
    expect(v.freezes[0]![0]).toBeCloseTo(4800, -2);
    expect(createHash('sha256').update(readFileSync(edited)).digest('hex')).toBe(before);
  });

  it('son : silence et sonie intégrée ; enveloppe à 20 Hz qui suit le silence', async () => {
    const a = await scanAudioStyle(FFMPEG, edited, 6300);
    expect(a.silences).toHaveLength(1);
    expect(a.silences[0]![0]).toBeCloseTo(2000, -2);
    expect(a.silences[0]![1]).toBeCloseTo(3000, -2);
    expect(a.loudness!.integratedLufs).toBeLessThan(-5);
    expect(a.loudness!.integratedLufs).toBeGreaterThan(-40);
    const e = await audioEnvelope(FFMPEG, edited);
    expect(e.rateHz).toBe(20);
    expect(e.db.length).toBeGreaterThan(120);
    expect(e.db[50]).toBeLessThan(-55); // 2,5 s : silence
    expect(e.db[10]).toBeGreaterThan(-30); // 0,5 s : bip
  });

  it('fichier sans son : refus explicite pour l’analyse sonore, sans chemin dans le message', async () => {
    await expect(scanAudioStyle(FFMPEG, silent, 2000)).rejects.toMatchObject({
      code: 'MEDIA_EXTRACT_FAILED',
      message: expect.not.stringContaining(silent),
    });
  });
});
