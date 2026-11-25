/**
 * Moteur de rendu, FFmpeg réel (Linux et Windows en CI). Préréglage rapide (`ultrafast`) pour
 * garder la CI courte ; la géométrie, la synchronisation et l'audio ne dépendent pas de ce choix.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyRenderOptions,
  displayCaptions,
  projectFromProposal,
  projectSegments,
  type ClipProject,
  type CreateProjectInput,
} from '@acs/timeline';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import {
  audioSamples,
  createLayoutVideo,
  createSyncVideo,
  firstBeepMs,
  firstFlashMs,
  frameAt,
  integratedLufs,
  LAYOUT_ZONES as Z,
  toneLevel,
  TONES,
  videoFps,
} from '../../../tests/helpers/render-fixtures';
import { allowedAudio, EMPTY_AUDIO_STATE, type ExportAudioState, type TrackIn } from './audio';
import { buildRenderPlan, type RenderPlan } from './plan';
import type { PresetConfig } from './presets';
import { checkOutput, runFrame, runRender } from './run';

const enabled = ffmpegAvailable();
const FONTS = fileURLToPath(new URL('../../../assets/fonts', import.meta.url));
const FAST: PresetConfig = { finalCrf: 23, x264Preset: 'ultrafast', previewHeight: 960 };
const TRACKS: TrackIn[] = [
  { audioIndex: 0, role: 'mic' },
  { audioIndex: 1, role: 'discord' },
  { audioIndex: 2, role: 'game' },
  { audioIndex: 3, role: 'mix' },
];
const MIC_ONLY: ExportAudioState = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present', otherVoices: 'absent' },
};
const norm = (r: { x: number; y: number; w: number; h: number }) => ({
  x: r.x / Z.width,
  y: r.y / Z.height,
  w: r.w / Z.width,
  h: r.h / Z.height,
});

let dir: string;
let layoutVideo: string;

function project(over: Partial<CreateProjectInput> = {}, words = true): ClipProject {
  return projectFromProposal({
    proposal: {
      id: 'p1',
      runId: 'run',
      recordingId: 'rec',
      momentId: null,
      srcStartMs: 2300,
      srcEndMs: 9300,
      punchlineMs: 6000,
      setupStartMs: 2300,
      reactionEndMs: 9000,
      editingMode: null,
    },
    source: {
      fingerprint: 'fp',
      durationMs: 12_000,
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
      facecam: norm(Z.facecam),
      masks: [{ label: 'Pseudos', ...norm(Z.mask) }],
    },
    words: words
      ? [
          {
            role: 'mic',
            words: [
              { text: 'Bonjour', srcStartMs: 3300, srcEndMs: 3700 },
              { text: 'tout', srcStartMs: 3750, srcEndMs: 4000 },
              { text: 'le', srcStartMs: 4050, srcEndMs: 4150 },
              { text: 'monde', srcStartMs: 4200, srcEndMs: 4700 },
            ],
          },
        ]
      : [],
    audio: { tracks: [{ audioIndex: 0, role: 'mic' }], captionRoles: ['mic'] },
    defaults: { mode: 'fidele', minMs: 5000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
    ...over,
  }).project;
}

const ctx = (
  rev: number,
  tracks: { audioIndex: number; role: 'mic' | 'discord' | 'game' }[] = [
    { audioIndex: 0, role: 'mic' },
  ],
) => ({
  nextRevision: rev,
  now: '2026-11-25T10:00:00.000Z',
  words: [],
  allowedCaptionRoles: ['mic' as const],
  allowedAudioTracks: tracks,
});

function plan(
  p: ClipProject,
  opts: { revision?: number; kind?: 'preview' | 'final'; state?: ExportAudioState } = {},
): RenderPlan {
  return buildRenderPlan({
    project: p,
    revision: opts.revision ?? 1,
    kind: opts.kind ?? 'preview',
    presetConfig: FAST,
    source: { width: p.source.width, height: p.source.height, fps: p.source.fps },
    audio: allowedAudio(TRACKS, opts.state ?? MIC_ONLY),
    captions: displayCaptions(projectSegments(p), p.captions.items, p.captions.corrections, {
      roles: p.captions.sources,
      pseudonymize: (t) => ({ text: t, replacements: 0 }),
    }),
    probeBytes: 5_000_000,
  });
}

let n = 0;
async function render(
  pl: RenderPlan,
  source = layoutVideo,
  extra: { signal?: AbortSignal; onProgress?: (r: number) => void; workParent?: string } = {},
) {
  n++;
  const work = path.join(extra.workParent ?? dir, `travail ${n}`);
  mkdirSync(work, { recursive: true });
  const out = path.join(work, 'clip.mp4.part');
  await runRender({
    ffmpegPath: FFMPEG,
    plan: pl,
    sourcePath: source,
    outputPath: out,
    workDir: work,
    fontsDir: FONTS,
    ...extra,
  });
  await checkOutput(FFPROBE, out, pl);
  return out;
}

const isWhite = ([r, g, b]: number[]) => r! > 225 && g! > 225 && b! > 225;
const isBlack = ([r, g, b]: number[]) => r! < 40 && g! < 40 && b! < 40;
const isGreen = ([r, g, b]: number[]) => g! > 180 && r! < 90 && b! < 90;
const isRed = ([r, g, b]: number[]) => r! > 180 && g! < 80 && b! < 80;
const isBlue = ([r, g, b]: number[]) => b! > 180 && r! < 80 && g! < 80;

function anyWhite(file: string, atSec: number): boolean {
  const f = frameAt(file, atSec);
  for (let y = 0; y < f.height; y += 8)
    for (let x = 0; x < f.width; x += 8) if (isWhite(f.rgb(x, y))) return true;
  return false;
}

describe.skipIf(!enabled)('moteur de rendu (FFmpeg réel)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acs rendu été-'));
    layoutVideo = createLayoutVideo(dir);
  }, 120_000);

  it('facecam en haut : facecam verte en haut, gameplay dessous, zone sensible jamais visible ; original intact', async () => {
    const before = createHash('sha256').update(readFileSync(layoutVideo)).digest('hex');
    const p = {
      ...project({}, false),
      captions: { ...project({}, false).captions, enabled: false, sources: [] },
    };
    const out = await render(plan(p));
    const f = frameAt(out, 2);
    expect([f.width, f.height]).toEqual([540, 960]);
    expect(isGreen(f.rgb(270, 150)), 'facecam').toBe(true);
    expect(isRed(f.rgb(40, 900)) || isBlue(f.rgb(40, 900))).toBe(true);
    expect(anyWhite(out, 2), 'zone sensible').toBe(false);
    expect(createHash('sha256').update(readFileSync(layoutVideo)).digest('hex')).toBe(before);
  }, 120_000);

  it('recadrage gameplay à droite : la zone sensible est NOIRE (aplat opaque) ; désactivée, elle réapparaît', async () => {
    const base = project({}, false);
    const p = applyRenderOptions(
      base,
      { layout: { preset: 'gameplay_crop', focusX: 1 }, captions: { enabled: false } },
      ctx(2),
    ).project;
    const out = await render(plan(p, { revision: 2 }));
    const f = frameAt(out, 2);
    expect(isBlack(f.rgb(300, 130)), 'aplat').toBe(true);
    expect(anyWhite(out, 2)).toBe(false);
    const off = applyRenderOptions(
      p,
      { masks: { modes: [{ index: 0, mode: 'off' }], acknowledgeMaskRisk: true } },
      ctx(3),
    ).project;
    const out2 = await render(plan(off, { revision: 3 }));
    expect(isWhite(frameAt(out2, 2).rgb(300, 130)), 'sans masque').toBe(true);
  }, 120_000);

  it('fond flouté : image entière au centre (masque noir compris), aucun blanc ; image fixe identique', async () => {
    const base = project({}, false);
    const p = applyRenderOptions(
      base,
      { layout: { preset: 'blurred_fit' }, captions: { enabled: false } },
      ctx(2),
    ).project;
    const pl = plan(p, { revision: 2 });
    const out = await render(pl);
    const f = frameAt(out, 2);
    // Premier plan : 540 × 302 centré verticalement (y de 328 à 630) ; zone sensible y ≈ 340–400.
    expect(isRed(f.rgb(100, 480))).toBe(true);
    expect(isBlue(f.rgb(450, 500))).toBe(true);
    expect(isBlack(f.rgb(460, 370))).toBe(true); // zone sensible (haut droite du premier plan)
    expect(anyWhite(out, 2)).toBe(false);
    const work = path.join(dir, 'image fixe');
    mkdirSync(work, { recursive: true });
    const jpg = path.join(work, 'image.jpg');
    await runFrame({
      ffmpegPath: FFMPEG,
      plan: pl,
      sourcePath: layoutVideo,
      outputPath: jpg,
      workDir: work,
      fontsDir: FONTS,
      atEditMs: 2000,
    });
    const img = frameAt(jpg, 0);
    expect([img.width, img.height]).toEqual([540, 960]);
    expect(isBlack(img.rgb(460, 370))).toBe(true);
  }, 120_000);

  it('coupe précise et synchronisation : premier bip et premier flash à 700 ms (± 1 image)', async () => {
    const sync = createSyncVideo(dir, 30);
    const base = project(
      { source: { ...project().source, width: 320, height: 180 }, framing: null },
      false,
    );
    const p = applyRenderOptions(
      base,
      { layout: { preset: 'gameplay_crop' }, captions: { enabled: false } },
      ctx(2),
    ).project;
    const pl = plan(p, { revision: 2 });
    const out = await render(pl, sync);
    const beep = firstBeepMs(audioSamples(out));
    const flash = firstFlashMs(out);
    expect(Math.abs(beep - 700), `bip ${beep}`).toBeLessThanOrEqual(34);
    expect(Math.abs(flash - 700), `flash ${flash}`).toBeLessThanOrEqual(34);
    expect(Math.abs(flash - beep)).toBeLessThanOrEqual(34);
  }, 120_000);

  it('fréquence d’images : source 120 i/s → 60 ; source 30 i/s → 30', async () => {
    const fast = createSyncVideo(dir, 120, 12, 'synchro-120.mkv');
    const base = project(
      { source: { ...project().source, width: 320, height: 180, fps: 120 }, framing: null },
      false,
    );
    const p = applyRenderOptions(
      base,
      { layout: { preset: 'gameplay_crop' }, captions: { enabled: false } },
      ctx(2),
    ).project;
    const out = await render(plan(p, { revision: 2 }), fast);
    expect(videoFps(out)).toBe(60);
    const slow = createSyncVideo(dir, 30, 12, 'synchro-30b.mkv');
    const p30 = { ...p, source: { ...p.source, fps: 30 } };
    expect(videoFps(await render(plan(p30, { revision: 2 }), slow))).toBe(30);
  }, 180_000);

  it('audio exporté : seules les pistes autorisées sont entendues ; la voix propre à « tout » n’apparaît jamais', async () => {
    const base = project({}, false);
    const noCaps = applyRenderOptions(
      base,
      { captions: { enabled: false }, audio: { loudnorm: false } },
      ctx(2),
    ).project;
    const level = (file: string) => {
      const s = audioSamples(file);
      return Object.fromEntries(Object.entries(TONES).map(([k, f]) => [k, toneLevel(s, f)]));
    };
    // Micro seul (Discord, jeu, « tout » non autorisés).
    const mic = level(await render(plan(noCaps, { revision: 2 })));
    expect(mic.mic).toBeGreaterThan(mic.discord! * 20);
    expect(mic.mic).toBeGreaterThan(mic.game! * 20);
    expect(mic.mic).toBeGreaterThan(mic.mixOnly! * 20);
    // Micro + Discord + jeu autorisés et activés : présents ; « tout » toujours absente.
    const allState: ExportAudioState = {
      consents: { discord_voices: true, game_voice_chat: false, other_voices: false },
      micComposition: { creatorVoice: 'present', otherVoices: 'absent' },
      gameComposition: { gameVoiceChat: 'absent' },
      mixComposition: null,
    };
    const three = [
      { audioIndex: 0, role: 'mic' as const },
      { audioIndex: 1, role: 'discord' as const },
      { audioIndex: 2, role: 'game' as const },
    ];
    const withAll = applyRenderOptions(
      noCaps,
      { audio: { tracks: [{ audioIndex: 1 }, { audioIndex: 2 }] } },
      ctx(3, three),
    ).project;
    const all = level(await render(plan(withAll, { revision: 3, state: allState })));
    for (const k of ['mic', 'discord', 'game'] as const)
      expect(all[k]).toBeGreaterThan(all.mixOnly! * 20);
    // Le document réclame Discord mais l'accord est retiré : rendu refusé, jamais contourné.
    expect(() => plan(withAll, { revision: 3, state: MIC_ONLY })).toThrow(
      expect.objectContaining({ code: 'EXPORT_CONSENT_REQUIRED' }),
    );
  }, 180_000);

  it('normalisation : −14 LUFS (± 1) par défaut, désactivable', async () => {
    const base = project({}, false);
    const p = applyRenderOptions(base, { captions: { enabled: false } }, ctx(2)).project;
    const on = integratedLufs(await render(plan(p, { revision: 2 })));
    expect(Math.abs(on + 14), `${on} LUFS`).toBeLessThanOrEqual(1);
    const offP = applyRenderOptions(p, { audio: { loudnorm: false } }, ctx(3)).project;
    const off = integratedLufs(await render(plan(offP, { revision: 3 })));
    expect(Math.abs(off - on), `${off} LUFS`).toBeGreaterThan(2);
  }, 180_000);

  it('sous-titres incrustés avec la police fournie, seulement pendant leur intervalle', async () => {
    const p = applyRenderOptions(project(), { layout: { preset: 'blurred_fit' } }, ctx(2)).project;
    const pl = plan(p, { revision: 2 });
    expect(pl.ass).toContain('Bonjour');
    const out = await render(pl);
    const zone = (t: number) => {
      const f = frameAt(out, t);
      let white = 0;
      // Zone sûre basse : marge 22 % de 960 px ⇒ ligne autour de y ≈ 700–760.
      for (let y = 640; y < 780; y += 2)
        for (let x = 60; x < 480; x += 2)
          if (
            isWhite(f.rgb(x, y)) ||
            (f.rgb(x, y)[1]! > 200 && f.rgb(x, y)[0]! > 200 && f.rgb(x, y)[2]! < 60)
          )
            white++;
      return white;
    };
    // Mots de 1,0 s à 2,4 s (temps montage) ; aucun sous-titre à 5 s.
    expect(zone(1.8), 'pendant').toBeGreaterThan(50);
    expect(zone(5), 'après').toBe(0);
  }, 120_000);

  it('zoom sur la chute : actif seulement dans sa fenêtre', async () => {
    const base = project({}, false);
    const p = applyRenderOptions(
      base,
      {
        layout: { preset: 'gameplay_crop', focusX: 0.3 },
        captions: { enabled: false },
        mode: 'enrichi',
      },
      ctx(2),
    ).project;
    const zoomed: ClipProject = {
      ...p,
      effects: [
        {
          id: 'z',
          type: 'punch_zoom',
          params: { factor: 1.12 },
          timing: { anchor: 'source', srcStartMs: 4300, srcEndMs: 5800 },
          enabled: true,
          origin: 'creator',
          reason: 'test',
          signals: {},
        },
      ],
    };
    const out = await render(plan(zoomed, { revision: 2 }));
    // Frontière rouge/bleu vers x ≈ 505 sans zoom ; ≈ 533 avec zoom 1,12 centré.
    expect(isBlue(frameAt(out, 1).rgb(520, 700)), 'avant').toBe(true);
    expect(isRed(frameAt(out, 2.7).rgb(520, 700)), 'pendant').toBe(true);
    expect(isBlue(frameAt(out, 5).rgb(520, 700)), 'après').toBe(true);
  }, 120_000);

  it('final 1080×1920, sortie contrôlée ; annulation propre ; chemins avec espaces et accents', async () => {
    const p = applyRenderOptions(
      project({}, false),
      { captions: { enabled: false } },
      ctx(2),
    ).project;
    const pl = plan(p, { revision: 2, kind: 'final' });
    const accents = path.join(dir, 'Clips été 2026');
    mkdirSync(accents, { recursive: true });
    const out = await render(pl, layoutVideo, { workParent: accents });
    expect(frameAt(out, 1).width).toBe(1080);
    await expect(
      checkOutput(FFPROBE, out, { ...pl, durationMs: pl.durationMs + 2000 }),
    ).rejects.toMatchObject({
      code: 'RENDER_FAILED',
    });
    const ctrl = new AbortController();
    const cancelled = render(pl, layoutVideo, {
      signal: ctrl.signal,
      onProgress: (r) => r > 0.05 && ctrl.abort(),
    });
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(existsSync(layoutVideo)).toBe(true);
  }, 180_000);
});
