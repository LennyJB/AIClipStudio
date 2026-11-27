/**
 * Bibliothèque de médias rendue par FFmpeg (PR 7f), FFmpeg réel (Linux et Windows en CI).
 * Fixtures lavfi uniquement (vidéo « cadrage » : gauche ROUGE, droite BLEUE, zone sensible
 * BLANCHE en haut à droite ; piste Micro à 440 Hz). Médias importés par `importAsset` (mêmes
 * fichiers normalisés que la bibliothèque).
 *
 * Vérifie :
 *  - calque image posé sur l'image composée, à son cadre, pendant sa plage seulement ;
 *  - un calque (même transparent ou semi-transparent) ne découvre JAMAIS une zone masquée ;
 *  - opacité appliquée ; image exacte identique à l'export ;
 *  - effet sonore placé à son instant, borné à sa durée, mixé avec l'enregistrement (Goertzel) ;
 *  - export sans son : aucun effet sonore.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importAsset, type NormalizedAsset } from '@acs/media';
import {
  checkInvariants,
  ClipProjectV2Schema,
  migrateV1ToV2,
  projectFromProposal,
  type ClipProjectV2,
  type Overlay,
  type SegmentV2,
} from '@acs/timeline';
import { halfTransparentPng, tone } from '../../../tests/helpers/asset-fixtures';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import {
  audioSamples,
  createLayoutVideo,
  frameAt,
  LAYOUT_ZONES as Z,
  toneLevelAt,
} from '../../../tests/helpers/render-fixtures';
import { allowedAudio, EMPTY_AUDIO_STATE } from './audio';
import {
  buildFramePlan,
  buildRenderPlanV2,
  type PlanAssetInput,
  type RenderPlan,
  type RenderPlanV2Input,
} from './plan';
import type { PresetConfig } from './presets';
import { checkOutput, runFrame, runRender } from './run';

const enabled = ffmpegAvailable();
const FONTS = fileURLToPath(new URL('../../../assets/fonts', import.meta.url));
const FAST: PresetConfig = { finalCrf: 23, x264Preset: 'ultrafast', previewHeight: 960 };
const STATE = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present' as const, otherVoices: 'absent' as const },
};
const IMG = '1'.repeat(64);
const SND = '2'.repeat(64);
const SFX_HZ = 2000;

let dir: string;
let video: string;
let image: NormalizedAsset;
let sound: NormalizedAsset;

const norm = (r: { x: number; y: number; w: number; h: number }) => ({
  x: r.x / Z.width,
  y: r.y / Z.height,
  w: r.w / Z.width,
  h: r.h / Z.height,
});

function doc(over: Partial<ClipProjectV2> = {}, segments?: SegmentV2[]): ClipProjectV2 {
  const v1 = projectFromProposal({
    proposal: {
      id: 'p1',
      runId: 'run',
      recordingId: 'rec',
      momentId: null,
      srcStartMs: 1000,
      srcEndMs: 7000,
      punchlineMs: 4000,
      setupStartMs: 1000,
      reactionEndMs: 7000,
      editingMode: null,
    },
    source: {
      fingerprint: 'fp',
      durationMs: 10_000,
      width: Z.width,
      height: Z.height,
      fps: 30,
      container: 'matroska',
      integrityManifestId: 'man',
    },
    framing: {
      id: 'f',
      hash: 'h',
      gameplay: { x: 0, y: 0, w: 1, h: 1 },
      facecam: null,
      masks: [{ label: 'Pseudos', ...norm(Z.mask) }],
    },
    words: [],
    audio: { tracks: [{ audioIndex: 0, role: 'mic' }], captionRoles: ['mic'] },
    defaults: { mode: 'enrichi', minMs: 5000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
  }).project;
  const base = migrateV1ToV2(v1, { manifestWindow: { srcStartMs: 0, srcEndMs: 10_000 } });
  const d = ClipProjectV2Schema.parse({
    ...base,
    ...(segments ? { segments } : {}),
    layout: {
      ...base.layout,
      preset: 'custom',
      layers: [
        {
          id: 'g',
          role: 'gameplay',
          crop: { x: 0, y: 0, w: 1, h: 1 },
          frame: { x: 0, y: 0, w: 1, h: 0.3166 },
          z: 0,
        },
      ],
      background: '#FFFF00',
    },
    captions: { ...base.captions, enabled: false },
    audio: { ...base.audio, loudnorm: { ...base.audio.loudnorm, enabled: false } },
    ...over,
  });
  expect(checkInvariants(d)).toEqual([]);
  return d;
}

const assets = (): Record<string, PlanAssetInput> => ({
  [IMG]: { kind: 'image', file: `asset-${IMG}.png`, sha256: image.fileSha256, durationMs: null },
  [SND]: {
    kind: 'audio',
    file: `asset-${SND}.wav`,
    sha256: sound.fileSha256,
    durationMs: sound.durationMs,
  },
});

function input(d: ClipProjectV2): RenderPlanV2Input {
  return {
    project: d,
    revision: 1,
    kind: 'preview',
    presetConfig: FAST,
    source: { width: Z.width, height: Z.height, fps: 30 },
    audio: allowedAudio([{ audioIndex: 0, role: 'mic' }], STATE),
    captions: [],
    assets: assets(),
    probeBytes: 5_000_000,
  };
}

let n = 0;
function work() {
  const w = path.join(dir, `travail ${++n}`);
  mkdirSync(w, { recursive: true });
  // Médias copiés dans le dossier de travail, comme le fait le service de rendu.
  copyFileSync(image.file, path.join(w, `asset-${IMG}.png`));
  copyFileSync(sound.file, path.join(w, `asset-${SND}.wav`));
  return w;
}

async function render(pl: RenderPlan) {
  const w = work();
  const out = path.join(w, 'clip.mp4.part');
  await runRender({
    ffmpegPath: FFMPEG,
    plan: pl,
    sourcePath: video,
    outputPath: out,
    workDir: w,
    fontsDir: FONTS,
  });
  await checkOutput(FFPROBE, out, pl);
  return out;
}

async function exact(inp: RenderPlanV2Input, atMs: number) {
  const w = work();
  const jpg = path.join(w, 'image.jpg');
  await runFrame({
    ffmpegPath: FFMPEG,
    frame: buildFramePlan(inp, atMs),
    sourcePath: video,
    outputPath: jpg,
    workDir: w,
    fontsDir: FONTS,
  });
  return frameAt(jpg, 0);
}

/**
 * Calque : PNG dont la moitié gauche est MAGENTA opaque et la moitié droite TRANSPARENTE, posé
 * sur la zone sensible (aplat noir) de l'image composée 540×960. Cadre : x 378–540, y 0–96.
 */
const overlay = (o: Partial<Overlay> = {}): Overlay => ({
  id: 'meme',
  kind: 'meme',
  assetId: IMG,
  text: null,
  timing: { anchor: 'edit', from: 'start', offsetMs: 2000, durMs: 2000 },
  frame: { x: 0.7, y: 0, w: 0.3, h: 0.1 },
  opacity: 1,
  z: 0,
  ...o,
});

const isMagenta = (c: [number, number, number]) => c[0] > 180 && c[1] < 80 && c[2] > 180;
const black = (c: [number, number, number]) => c.every((v) => v < 45);
const OPAQUE: [number, number] = [415, 45]; // moitié opaque du calque, sur la zone sensible
const CLEAR: [number, number] = [505, 45]; // moitié transparente, sur la zone sensible

describe.skipIf(!enabled)('bibliothèque de médias : rendu FFmpeg', () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acs médias été-'));
    video = createLayoutVideo(dir, 10);
    image = await importAsset({
      ffmpeg: FFMPEG,
      ffprobe: FFPROBE,
      input: halfTransparentPng(dir, 'meme.png', '0xFF00FF', 200, 100),
      declaredName: 'meme.png',
      workDir: path.join(dir, 'img'),
    });
    sound = await importAsset({
      ffmpeg: FFMPEG,
      ffprobe: FFPROBE,
      input: tone(dir, 'boing.wav', SFX_HZ, 0.6),
      declaredName: 'boing.wav',
      workDir: path.join(dir, 'snd'),
    });
  }, 120_000);

  it('calque image : posé à son cadre pendant sa plage ; sa partie transparente ne découvre jamais la zone masquée ; image exacte identique', async () => {
    const d = doc({ overlays: [overlay()] });
    const out = await render(buildRenderPlanV2(input(d)));
    for (const t of [2.1, 3.0, 3.9]) {
      const f = frameAt(out, t);
      expect(isMagenta(f.rgb(...OPAQUE)), `opaque à ${t} s : ${f.rgb(...OPAQUE)}`).toBe(true);
      expect(black(f.rgb(...CLEAR)), `zone masquée sous la transparence à ${t} s`).toBe(true);
    }
    for (const t of [1.0, 4.5]) {
      const f = frameAt(out, t);
      expect(black(f.rgb(...OPAQUE)), `hors plage à ${t} s : aplat seul`).toBe(true);
    }
    // Image exacte : mêmes pixels (calque visible à 3 s, absent à 1 s).
    const e = await exact(input(d), 3000);
    expect(isMagenta(e.rgb(...OPAQUE))).toBe(true);
    expect(black(e.rgb(...CLEAR))).toBe(true);
    expect(black((await exact(input(d), 1000)).rgb(...OPAQUE))).toBe(true);
  }, 180_000);

  it('opacité 50 % : mélange avec l’image composée (jamais la source non masquée)', async () => {
    const d = doc({ overlays: [overlay({ opacity: 0.5 })] });
    const out = await render(buildRenderPlanV2(input(d)));
    const [r, g, b] = frameAt(out, 3).rgb(...OPAQUE);
    // Magenta à 50 % sur un aplat NOIR : ≈ (128, 0, 128) ; sur la source blanche ce serait ≈ (255, 128, 255).
    expect(r > 90 && r < 170 && b > 90 && b < 170 && g < 50, `${[r, g, b]}`).toBe(true);
  }, 180_000);

  it('effet sonore : joué à son instant, borné à sa durée, mixé avec la piste Micro ; export sans son : absent', async () => {
    const d = doc({
      audio: {
        ...doc().audio,
        sfx: [
          {
            id: 'boing',
            assetId: SND,
            timing: { anchor: 'edit', from: 'start', offsetMs: 2000, durMs: 3000 },
            gainDb: 0,
          },
        ],
      },
    });
    const pl = buildRenderPlanV2(input(d));
    expect(pl.media!.sfx[0]).toMatchObject({ editStartMs: 2000, editEndMs: 2600 });
    const s = audioSamples(await render(pl));
    const at = (ms: number) => toneLevelAt(s, SFX_HZ, ms, 200);
    expect(at(2200)).toBeGreaterThan(0.02);
    expect(at(1500)).toBeLessThan(0.002);
    expect(at(2800)).toBeLessThan(0.002); // le son (0,6 s) n'est jamais prolongé
    expect(toneLevelAt(s, 440, 2200, 200)).toBeGreaterThan(0.02); // l'enregistrement reste là

    const silent = buildRenderPlanV2(input({ ...d, audio: { ...d.audio, silent: true } }));
    expect(silent.hasAudio).toBe(false);
    expect(silent.assets ?? []).toEqual([]);
  }, 180_000);
});
