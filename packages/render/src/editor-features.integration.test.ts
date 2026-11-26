/**
 * Fonctions de l'éditeur rendues par FFmpeg (PR 7e), FFmpeg réel (Linux et Windows en CI).
 * Fixtures lavfi uniquement :
 *  - « cadrage » 1280×720 : gauche ROUGE, droite BLEUE, facecam VERTE, zone sensible BLANCHE ;
 *  - « montage » : tonalité continue de 440 Hz (+ bips de 1 kHz chaque seconde).
 * Vérifie : masques temporels (pixels, marge), disposition libre et surcharge par segment, flou
 * créatif APRÈS les aplats (contre-épreuve), éclair, zoom localisé, calque texte, atténuation,
 * bip (Goertzel), fondu d'entrée, automatisation du gain, image exacte.
 */
import { mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkInvariants,
  ClipProjectV2Schema,
  dbToGain,
  migrateV1ToV2,
  projectFromProposal,
  type ClipProjectV2,
  type EffectV2,
  type Layer,
  type SegmentV2,
} from '@acs/timeline';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import {
  audioSamples,
  createEditVideo,
  createLayoutVideo,
  EDIT_TONES,
  frameAt,
  LAYOUT_ZONES as Z,
  toneLevelAt,
} from '../../../tests/helpers/render-fixtures';
import { allowedAudio, EMPTY_AUDIO_STATE } from './audio';
import { buildFramePlan, buildRenderPlanV2, type RenderPlan, type RenderPlanV2Input } from './plan';
import type { PresetConfig } from './presets';
import { checkOutput, runFrame, runRender } from './run';

const enabled = ffmpegAvailable();
const FONTS = fileURLToPath(new URL('../../../assets/fonts', import.meta.url));
const FAST: PresetConfig = { finalCrf: 23, x264Preset: 'ultrafast', previewHeight: 960 };
const STATE = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present' as const, otherVoices: 'absent' as const },
};

let dir: string;
let layoutVideo: string;
let editVideo: string;

const norm = (r: { x: number; y: number; w: number; h: number }) => ({
  x: r.x / Z.width,
  y: r.y / Z.height,
  w: r.w / Z.width,
  h: r.h / Z.height,
});
const src = (id: string, a: number, b: number): SegmentV2 => ({
  id,
  kind: 'source',
  srcStartMs: a,
  srcEndMs: b,
  speed: 1,
});

/** Calque plein cadre : toute la source, en haut de l'image 540×960 (0 ≤ y < 304). */
const FULL: Layer = {
  id: 'g',
  role: 'gameplay',
  crop: { x: 0, y: 0, w: 1, h: 1 },
  frame: { x: 0, y: 0, w: 1, h: 0.3166 },
  z: 0,
};
/** Point de la source (1280×720) → point de l'aperçu 540×960 avec le calque FULL. */
const P = (sx: number, sy: number): [number, number] => [
  Math.floor((sx * 540) / 1280),
  Math.floor((sy * 304) / 720),
];

function doc(o: {
  segments: SegmentV2[];
  width: number;
  height: number;
  masks?: boolean;
  over?: Partial<ClipProjectV2>;
}): ClipProjectV2 {
  const v1 = projectFromProposal({
    proposal: {
      id: 'p1',
      runId: 'run',
      recordingId: 'rec',
      momentId: null,
      srcStartMs: 1000,
      srcEndMs: 9000,
      punchlineMs: 5000,
      setupStartMs: 1000,
      reactionEndMs: 9000,
      editingMode: null,
    },
    source: {
      fingerprint: 'fp',
      durationMs: 20_000,
      width: o.width,
      height: o.height,
      fps: 30,
      container: 'matroska',
      integrityManifestId: 'man',
    },
    framing: o.masks
      ? {
          id: 'f',
          hash: 'h',
          gameplay: { x: 0, y: 0, w: 1, h: 1 },
          facecam: norm(Z.facecam),
          masks: [{ label: 'Pseudos', ...norm(Z.mask) }],
        }
      : null,
    words: [],
    audio: { tracks: [{ audioIndex: 0, role: 'mic' }], captionRoles: ['mic'] },
    defaults: { mode: 'enrichi', minMs: 5000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
  }).project;
  const base = migrateV1ToV2(v1, { manifestWindow: { srcStartMs: 0, srcEndMs: 20_000 } });
  const d = ClipProjectV2Schema.parse({
    ...base,
    segments: o.segments,
    layout: { ...base.layout, preset: 'custom', layers: [FULL], background: '#FFFF00' },
    captions: { ...base.captions, enabled: false },
    audio: { ...base.audio, loudnorm: { ...base.audio.loudnorm, enabled: false } },
    ...o.over,
  });
  expect(checkInvariants(d)).toEqual([]);
  return d;
}

function input(d: ClipProjectV2, extra: Partial<RenderPlanV2Input> = {}): RenderPlanV2Input {
  return {
    project: d,
    revision: 1,
    kind: 'preview',
    presetConfig: FAST,
    source: { width: d.source.width, height: d.source.height, fps: 30 },
    audio: allowedAudio([{ audioIndex: 0, role: 'mic' }], STATE),
    captions: [],
    probeBytes: 5_000_000,
    ...extra,
  };
}

let n = 0;
async function render(pl: RenderPlan, source: string) {
  n++;
  const work = path.join(dir, `travail ${n}`);
  mkdirSync(work, { recursive: true });
  const out = path.join(work, 'clip.mp4.part');
  await runRender({
    ffmpegPath: FFMPEG,
    plan: pl,
    sourcePath: source,
    outputPath: out,
    workDir: work,
    fontsDir: FONTS,
  });
  await checkOutput(FFPROBE, out, pl);
  return out;
}

async function exact(inp: RenderPlanV2Input, atMs: number, source: string) {
  n++;
  const work = path.join(dir, `image ${n}`);
  mkdirSync(work, { recursive: true });
  const jpg = path.join(work, 'image.jpg');
  await runFrame({
    ffmpegPath: FFMPEG,
    frame: buildFramePlan(inp, atMs),
    sourcePath: source,
    outputPath: jpg,
    workDir: work,
    fontsDir: FONTS,
  });
  return frameAt(jpg, 0);
}

const effect = (e: Partial<EffectV2> & Pick<EffectV2, 'id' | 'type' | 'params'>): EffectV2 => ({
  region: null,
  timing: { anchor: 'edit', from: 'start', offsetMs: 2000, durMs: 2000 },
  enabled: true,
  origin: 'creator',
  reason: '',
  signals: {},
  ...e,
});

const black = (c: [number, number, number]) => c.every((v) => v < 45);
const isRed = (c: [number, number, number]) => c[0] > 160 && c[1] < 90 && c[2] < 90;
const isBlue = (c: [number, number, number]) => c[2] > 160 && c[0] < 90 && c[1] < 90;

describe.skipIf(!enabled)('fonctions de l’éditeur (FFmpeg réel)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acs éditeur été-'));
    layoutVideo = createLayoutVideo(dir, 20);
    editVideo = createEditVideo(dir);
  }, 120_000);

  it('masque temporel : aplat pendant sa plage (marge comprise), absent ailleurs ; fond de la disposition libre ; zone sensible toujours masquée', async () => {
    const rect = { x: 100, y: 200, w: 300, h: 300 }; // zone rouge
    const base = doc({
      segments: [src('a', 1000, 9000)],
      width: Z.width,
      height: Z.height,
      masks: true,
    });
    const d = ClipProjectV2Schema.parse({
      ...base,
      masks: [
        ...base.masks,
        {
          id: 'zz-temp',
          rect: norm(rect),
          label: 'Notification',
          mode: 'opaque',
          srcRange: { srcStartMs: 3000, srcEndMs: 5000 },
        },
      ],
    });
    const pl = buildRenderPlanV2(input(d));
    const out = await render(pl, layoutVideo);
    const [mx, my] = P(rect.x + 150, rect.y + 150);
    const [wx, wy] = P(Z.mask.x + Z.mask.w / 2, Z.mask.y + Z.mask.h / 2);
    // 1,95 s et 4,05 s : hors de la plage nominale, dans la marge de sécurité (jamais moins masqué).
    for (const t of [1.95, 2.05, 2.5, 3.5, 3.95, 4.05]) {
      const f = frameAt(out, t);
      expect(black(f.rgb(mx, my)), `masque temporel à ${t} s`).toBe(true);
      expect(black(f.rgb(wx, wy)), `zone sensible à ${t} s`).toBe(true);
    }
    for (const t of [1.0, 4.5]) {
      const f = frameAt(out, t);
      expect(isRed(f.rgb(mx, my)), `hors plage à ${t} s : ${f.rgb(mx, my)}`).toBe(true);
      expect(black(f.rgb(wx, wy))).toBe(true);
    }
    // Fond jaune sous le calque (disposition libre).
    const f = frameAt(out, 1);
    const [r, g, b] = f.rgb(270, 700);
    expect(r > 200 && g > 200 && b < 80, `fond ${[r, g, b]}`).toBe(true);
    // Image exacte : même aplat.
    expect(black((await exact(input(d), 2500, layoutVideo)).rgb(mx, my))).toBe(true);
    expect(isRed((await exact(input(d), 4500, layoutVideo)).rgb(mx, my))).toBe(true);
  }, 180_000);

  it('surcharge par segment : seul le second segment montre la facecam en plein cadre', async () => {
    const base = doc({
      segments: [src('a', 1000, 4000), src('b', 5000, 8000)],
      width: Z.width,
      height: Z.height,
    });
    const d = ClipProjectV2Schema.parse({
      ...base,
      layout: {
        ...base.layout,
        overrides: [
          {
            id: 'b',
            layers: [
              {
                id: 'cam',
                role: 'facecam',
                crop: norm(Z.facecam),
                frame: { x: 0, y: 0, w: 1, h: 1 },
                z: 0,
              },
            ],
          },
        ],
      },
    });
    const out = await render(buildRenderPlanV2(input(d)), layoutVideo);
    const g1 = frameAt(out, 1.5).rgb(270, 480);
    const g2 = frameAt(out, 4.5).rgb(270, 480);
    expect(g1[0] > 200 && g1[2] < 80, `segment a : fond jaune ${g1}`).toBe(true);
    expect(g2[1] > 160 && g2[0] < 90 && g2[2] < 90, `segment b : facecam verte ${g2}`).toBe(true);
  }, 180_000);

  it('flou créatif APRÈS les aplats : la zone sensible reste noire sous le flou ; le flou agit ailleurs', async () => {
    const blurRect = { x: 560, y: 0, w: 720, h: 360 }; // frontière rouge/bleu + zone sensible
    const d = doc({
      segments: [src('a', 1000, 9000)],
      width: Z.width,
      height: Z.height,
      masks: true,
      over: {
        effects: [
          effect({
            id: 'blur',
            type: 'blur_region',
            params: { sigma: 25 },
            region: norm(blurRect),
            timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 8000 },
          }),
        ],
      },
    });
    const out = await render(buildRenderPlanV2(input(d)), layoutVideo);
    const f = frameAt(out, 2);
    // Centre de la zone sensible : toujours noir (un flou appliqué AVANT l'aplat la rendrait grise).
    expect(black(f.rgb(...P(Z.mask.x + Z.mask.w / 2, Z.mask.y + Z.mask.h / 2)))).toBe(true);
    // Frontière rouge/bleu floutée : mélange des deux couleurs.
    const [r, , b] = f.rgb(...P(640, 300));
    expect(r > 50 && b > 50, `frontière floutée ${[r, b]}`).toBe(true);
    // Hors de la zone du flou : couleurs franches.
    expect(isRed(f.rgb(...P(300, 600)))).toBe(true);
  }, 180_000);

  it('contre-épreuve : un flou n’est pas un aplat (sans masque, la zone sensible reste visible sous le flou)', async () => {
    const d = doc({
      segments: [src('a', 1000, 9000)],
      width: Z.width,
      height: Z.height,
      masks: false,
      over: {
        effects: [
          effect({
            id: 'blur',
            type: 'blur_region',
            params: { sigma: 25 },
            region: norm(Z.mask),
            timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 8000 },
          }),
        ],
      },
    });
    const out = await render(buildRenderPlanV2(input(d)), layoutVideo);
    const c = frameAt(out, 2).rgb(...P(Z.mask.x + Z.mask.w / 2, Z.mask.y + Z.mask.h / 2));
    expect(black(c), `le flou laisse passer la zone : ${c}`).toBe(false);
  }, 180_000);

  it('éclair et zoom localisé : image blanchie au début de l’éclair ; zoom ×2 centré sur la zone rouge', async () => {
    const d = doc({
      segments: [src('a', 1000, 9000)],
      width: Z.width,
      height: Z.height,
      over: {
        effects: [
          effect({
            id: 'fl',
            type: 'flash',
            params: { intensity: 1 },
            timing: { anchor: 'edit', from: 'start', offsetMs: 1000, durMs: 600 },
          }),
          effect({
            id: 'zm',
            type: 'zoom',
            params: { factor: 2 },
            region: norm({ x: 100, y: 200, w: 200, h: 200 }),
            timing: { anchor: 'edit', from: 'start', offsetMs: 4000, durMs: 2000 },
          }),
        ],
      },
    });
    const out = await render(buildRenderPlanV2(input(d)), layoutVideo);
    const w = frameAt(out, 1.05).rgb(...P(900, 400));
    expect(
      w.every((v) => v > 200),
      `éclair ${w}`,
    ).toBe(true);
    expect(isBlue(frameAt(out, 2).rgb(...P(900, 400)))).toBe(true);
    // Avant le zoom, (420, 100) de l'aperçu est dans la moitié bleue ; au plateau du zoom centré
    // sur la zone rouge, il montre du rouge.
    expect(isBlue(frameAt(out, 3).rgb(420, 100))).toBe(true);
    expect(isRed(frameAt(out, 5).rgb(420, 100)), `zoom ${frameAt(out, 5).rgb(420, 100)}`).toBe(
      true,
    );
  }, 180_000);

  it('calque texte : texte dessiné dans son cadre pendant sa plage seulement (ASS, police fournie)', async () => {
    const d = doc({
      segments: [src('a', 1000, 9000)],
      width: Z.width,
      height: Z.height,
      over: {
        overlays: [
          {
            id: 'txt',
            kind: 'text',
            assetId: null,
            text: 'WOW',
            timing: { anchor: 'edit', from: 'start', offsetMs: 2000, durMs: 2000 },
            frame: { x: 0.1, y: 0.6, w: 0.8, h: 0.12 },
            opacity: 1,
            z: 0,
          },
        ],
      },
    });
    const pl = buildRenderPlanV2(input(d, { overlayTexts: { txt: 'WOW' } }));
    const out = await render(pl, layoutVideo);
    const whites = (t: number) => {
      const f = frameAt(out, t);
      let k = 0;
      for (let y = 576; y < 691; y += 2)
        for (let x = 54; x < 486; x += 2) {
          const [r, g, b] = f.rgb(x, y);
          if (r > 220 && g > 220 && b > 220) k++;
        }
      return k;
    };
    expect(whites(3)).toBeGreaterThan(200);
    expect(whites(5)).toBe(0);
  }, 180_000);

  it('audio : atténuation (−20 dB), bip à 1,5 kHz qui coupe la piste, fondu d’entrée, automatisation', async () => {
    const base = doc({ segments: [src('a', 1000, 11_000)], width: 320, height: 180 });
    const d = ClipProjectV2Schema.parse({
      ...base,
      effects: [
        effect({
          id: 'a-fade',
          type: 'fade_in',
          params: {},
          timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 1000 },
        }),
        effect({
          id: 'b-duck',
          type: 'duck',
          params: { gainDb: -20 },
          timing: { anchor: 'edit', from: 'start', offsetMs: 2000, durMs: 1500 },
        }),
        effect({
          id: 'c-bleep',
          type: 'bleep',
          params: { frequencyHz: 1500 },
          timing: { anchor: 'source', srcStartMs: 6000, srcEndMs: 6600 },
        }),
      ],
      audio: {
        ...base.audio,
        tracks: base.audio.tracks.map((t) => ({
          ...t,
          // −12 dB de 8 s à 9 s (source), soit 7 s à 8 s du montage.
          automation: [
            { srcMs: 7900, gainDb: 0 },
            { srcMs: 8000, gainDb: -12 },
            { srcMs: 9000, gainDb: -12 },
            { srcMs: 9100, gainDb: 0 },
          ],
        })),
      },
    });
    const samples = audioSamples(await render(buildRenderPlanV2(input(d)), editVideo));
    const bed = (at: number, dur = 300) => toneLevelAt(samples, EDIT_TONES.bed, at, dur);
    const ref = bed(1300, 500);
    expect(ref).toBeGreaterThan(0.05);
    // Fondu d'entrée : bien plus faible au début.
    expect(bed(50, 100) / ref).toBeLessThan(0.3);
    // Atténuation de −20 dB au plateau (rampe de 20 ms exclue).
    expect(bed(2300, 1000) / ref).toBeCloseTo(dbToGain(-20), 1);
    // Bip : piste coupée et ton de 1,5 kHz présent.
    expect(bed(5100, 400) / ref).toBeLessThan(0.02);
    // Ton au niveau BLEEP_LEVEL (0,25), soit le niveau de la tonalité de fond (0,25).
    expect(toneLevelAt(samples, 1500, 5100, 400) / ref).toBeCloseTo(1, 1);
    expect(toneLevelAt(samples, 1500, 4000, 400)).toBeLessThan(0.005);
    // Automatisation : −12 dB entre 7,1 s et 7,9 s du montage, pleine ensuite.
    expect(bed(7200, 600) / ref).toBeCloseTo(dbToGain(-12), 1);
    expect(bed(8400, 500) / ref).toBeGreaterThan(0.85);
  }, 180_000);
});
