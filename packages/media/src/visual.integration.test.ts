/**
 * Étape 9, FFmpeg réel : activité visuelle (différence moyenne entre images clés).
 * Image fixe (webcam immobile, plateau) puis image en mouvement continu (jeu, vidéo regardée).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import { scanVisualActivity } from './visual';

const enabled = ffmpegAvailable();
let file: string;
let audioOnly: string;

describe.skipIf(!enabled)('étape 9 : activité visuelle (FFmpeg réel)', () => {
  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acs-visual-'));
    file = path.join(dir, 'static-then-moving.mkv');
    audioOnly = path.join(dir, 'audio.mka');
    execFileSync(FFMPEG, [
      ...['-v', 'error', '-nostdin', '-y'],
      ...['-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=30:d=8'],
      ...['-f', 'lavfi', '-i', "nullsrc=s=160x90:r=30:d=8,geq=lum='random(1)*255':cb=128:cr=128"],
      ...['-filter_complex', '[0][1]concat=n=2:v=1[v]', '-map', '[v]'],
      ...['-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', file],
    ]);
    execFileSync(FFMPEG, [
      ...['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2'],
      ...['-c:a', 'flac', audioOnly],
    ]);
  }, 60_000);

  it('image fixe ≈ 0, image en mouvement nettement au-dessus ; temps croissants en SourceMs ; original intact', async () => {
    const before = createHash('sha256').update(readFileSync(file)).digest('hex');
    const samples = await scanVisualActivity(FFMPEG, file);
    expect(samples.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.tMs).toBeGreaterThan(samples[i - 1]!.tMs);
    }
    const mean = (xs: { score: number }[]) => xs.reduce((a, s) => a + s.score, 0) / xs.length;
    const still = samples.filter((s) => s.tMs > 500 && s.tMs < 7500);
    const moving = samples.filter((s) => s.tMs > 9000);
    expect(mean(still)).toBeLessThan(1);
    expect(mean(moving)).toBeGreaterThan(5);
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
  });

  it('fichier sans vidéo : refus explicite, sans chemin dans le message', async () => {
    await expect(scanVisualActivity(FFMPEG, audioOnly)).rejects.toMatchObject({
      code: 'MEDIA_EXTRACT_FAILED',
      message: expect.not.stringContaining(audioOnly),
    });
  });

  it('annulation', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(scanVisualActivity(FFMPEG, file, { signal: ac.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });
});
