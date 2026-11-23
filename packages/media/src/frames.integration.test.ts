import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createColorVideo,
  FFMPEG,
  ffmpegAvailable,
  pixelAt,
} from '../../../tests/helpers/media-fixtures';
import { extractFrame, frameFilter, outputSize, toPixelRect } from './frames';

const enabled = ffmpegAvailable();
const full = { x: 0, y: 0, w: 1, h: 1 };
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 40);

describe('calculs de cadrage', () => {
  it('rectangles en pixels pairs, toujours dans l’image', () => {
    expect(toPixelRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 1920, 1080)).toEqual({
      x: 960,
      y: 540,
      w: 960,
      h: 540,
    });
    const r = toPixelRect({ x: 0.999, y: 0.999, w: 0.001, h: 0.001 }, 1921, 1081);
    expect(r.x + r.w).toBeLessThanOrEqual(1921);
    expect(r.w % 2).toBe(0);
  });

  it('taille de sortie bornée, proportions conservées', () => {
    expect(outputSize({ x: 0, y: 0, w: 1920, h: 1080 }, 1024)).toEqual({
      width: 1024,
      height: 576,
    });
    expect(outputSize({ x: 0, y: 0, w: 320, h: 180 }, 1024)).toEqual({ width: 320, height: 180 });
  });

  it('les aplats de masquage sont appliqués AVANT le recadrage', () => {
    const f = frameFilter({
      videoWidth: 320,
      videoHeight: 180,
      crop: full,
      masks: [{ x: 0, y: 0, w: 0.5, h: 1 }],
      maxWidth: 320,
    });
    expect(f.filter.indexOf('drawbox')).toBeLessThan(f.filter.indexOf('crop='));
    expect(f.filter).toContain('t=fill');
  });
});

describe.skipIf(!enabled)('extractFrame (FFmpeg réel)', () => {
  let video: string;
  let out: string;
  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acs-frames-'));
    video = createColorVideo(dir);
    out = path.join(dir, 'out');
  }, 60_000);

  const base = () => ({
    ffmpegPath: FFMPEG,
    inputPath: video,
    allowedDir: out,
    videoWidth: 320,
    videoHeight: 180,
    crop: full,
    masks: [],
    maxWidth: 1024,
  });

  it.each([
    [1000, [255, 0, 0]],
    [3000, [0, 255, 0]],
    [5000, [0, 0, 255]],
    [2100, [0, 255, 0]],
  ])('image à %i ms : couleur attendue', async (atMs, rgb) => {
    const f = await extractFrame({ ...base(), atMs, outputPath: path.join(out, `t${atMs}.jpg`) });
    expect(f).toMatchObject({ width: 320, height: 180 });
    expect(near(pixelAt(f.outputPath, 160, 90), rgb)).toBe(true);
  });

  it('les zones masquées sont recouvertes d’un aplat noir ; le reste est intact', async () => {
    const f = await extractFrame({
      ...base(),
      atMs: 1000,
      masks: [{ x: 0.5, y: 0, w: 0.5, h: 1 }],
      outputPath: path.join(out, 'masque.jpg'),
    });
    expect(near(pixelAt(f.outputPath, 60, 90), [255, 0, 0])).toBe(true);
    expect(near(pixelAt(f.outputPath, 260, 90), [0, 0, 0])).toBe(true);
  });

  it('recadre sur la zone de gameplay', async () => {
    const f = await extractFrame({
      ...base(),
      atMs: 5000,
      crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      outputPath: path.join(out, 'crop.jpg'),
    });
    expect(f).toMatchObject({ width: 160, height: 90 });
  });

  it('refuse une sortie hors du dossier autorisé', async () => {
    await expect(
      extractFrame({ ...base(), atMs: 0, outputPath: path.join(tmpdir(), 'ailleurs.jpg') }),
    ).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_PATH' });
  });
});
