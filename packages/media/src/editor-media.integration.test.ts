/**
 * Médias de travail de l'éditeur (étape 7, PR 7d), FFmpeg réel, fixtures lavfi :
 *  - proxy aligné sur le temps source (écart ≤ 1 image), sans son, 540 p, images clés rapprochées ;
 *  - planche de vignettes produite depuis l'image MASQUÉE : aucune zone sensible visible ;
 *  - original intact ; écriture refusée hors du dossier autorisé.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import {
  createEditVideo,
  createLayoutVideo,
  decodeEditFrames,
  frameAt,
  LAYOUT_ZONES as Z,
} from '../../../tests/helpers/render-fixtures';
import { generateProxy, PROXY_PROFILE } from './proxy';
import { generateThumbnails, thumbnailLayout } from './thumbnails';

const enabled = ffmpegAvailable();
let dir: string;
let editor: string;
let editVideo: string;
let layoutVideo: string;

const probe = (file: string) =>
  JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  ) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration: string };
  };

/** Intervalles entre images clés (s) du flux vidéo. */
function keyframeGaps(file: string): number[] {
  const out = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((l) => Number.parseFloat(l.split(',')[0]!));
  return out.slice(1).map((t, i) => t - out[i]!);
}

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

describe.skipIf(!enabled)('médias de travail de l’éditeur (FFmpeg réel)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acs médias éditeur-'));
    editor = path.join(dir, 'processing', 'editor');
    mkdirSync(editor, { recursive: true });
    editVideo = createEditVideo(dir);
    layoutVideo = createLayoutVideo(dir, 12);
  }, 120_000);

  it('proxy : aligné sur le temps source (≤ 1 image), 540 p, sans son, images clés toutes les 0,5 s ; original intact', async () => {
    const before = sha(editVideo);
    const out = path.join(editor, 'rec', 'proxy.mp4');
    // Début de fenêtre entre deux images source (8450 ms à 30 i/s) : cas le plus exigeant.
    const r = await generateProxy({
      ffmpegPath: FFMPEG,
      inputPath: editVideo,
      outputPath: out,
      allowedDir: editor,
      windowStartMs: 8450,
      windowEndMs: 14_450,
      sourceFps: 30,
    });
    expect(r).toMatchObject({ durationMs: 6000, fps: 30 });
    const info = probe(out);
    expect(info.streams.map((s) => s.codec_type)).toEqual(['video']);
    expect([info.streams[0]!.width, info.streams[0]!.height]).toEqual([960, PROXY_PROFILE.height]);
    expect(Math.abs(Number(info.format.duration) * 1000 - 6000)).toBeLessThanOrEqual(34);
    // Image j du proxy = image source (première de la fenêtre) + j, sans saut ni répétition.
    const frames = decodeEditFrames(out, { w: 960, h: 540, y: 0 });
    expect(frames).toHaveLength(180);
    const exact = (8450 * 30) / 1000;
    const f0 = frames[0]!.source!;
    expect([Math.floor(exact), Math.ceil(exact)]).toContain(f0);
    const wrong = frames.filter((f, j) => f.source !== f0 + j);
    expect(wrong).toEqual([]);
    expect(Math.max(...keyframeGaps(out))).toBeLessThanOrEqual(0.5 + 1e-3);
    expect(sha(editVideo)).toBe(before);
  }, 120_000);

  it('vignettes : planche en grille, AUCUNE zone sensible (aplat opaque sur l’image source) ; sans masque, la zone apparaît (contre-épreuve)', async () => {
    const mask = {
      x: Z.mask.x / Z.width,
      y: Z.mask.y / Z.height,
      w: Z.mask.w / Z.width,
      h: Z.mask.h / Z.height,
    };
    const make = (name: string, masks: (typeof mask)[]) =>
      generateThumbnails({
        ffmpegPath: FFMPEG,
        inputPath: layoutVideo,
        outputPath: path.join(editor, 'rec', name),
        allowedDir: editor,
        windowStartMs: 1000,
        windowEndMs: 11_000,
        videoWidth: Z.width,
        videoHeight: Z.height,
        masks,
      });
    const masked = await make('vignettes.jpg', [mask]);
    expect(masked.layout).toEqual(thumbnailLayout(1000, 11_000, Z.width, Z.height));
    expect(masked.layout).toMatchObject({
      count: 10,
      columns: 10,
      rows: 1,
      tileWidth: 160,
      tileHeight: 90,
    });
    const whites = (file: string) => {
      const f = frameAt(file, 0);
      expect([f.width, f.height]).toEqual([1600, 90]);
      let n = 0;
      for (let y = 0; y < f.height; y++)
        for (let x = 0; x < f.width; x++) {
          const [r, g, b] = f.rgb(x, y);
          if (r > 220 && g > 220 && b > 220) n++;
        }
      return n;
    };
    expect(whites(masked.outputPath), 'zone sensible visible').toBe(0);
    const open = await make('sans-masque.jpg', []);
    expect(whites(open.outputPath), 'contre-épreuve').toBeGreaterThan(100);
  }, 120_000);

  it('écriture refusée hors de processing/editor et sur l’original', async () => {
    await expect(
      generateProxy({
        ffmpegPath: FFMPEG,
        inputPath: editVideo,
        outputPath: path.join(dir, 'ailleurs', 'proxy.mp4'),
        allowedDir: editor,
        windowStartMs: 0,
        windowEndMs: 1000,
        sourceFps: 30,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_PATH' });
  });
});
