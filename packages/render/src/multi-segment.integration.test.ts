/**
 * Moteur multi-segments (docs/plan-etape-7.md §3.3, §5.4, PR 7c), FFmpeg réel (Linux et Windows
 * en CI). Fixtures lavfi uniquement :
 *  - numéro d'image source en code-barres ⇒ coupes vérifiées à l'image près ;
 *  - éclair et bip synchrones à chaque seconde ⇒ synchronisation après chaque coupe ;
 *  - tonalité continue ⇒ silence mesuré (Goertzel et crête) pendant un arrêt sur image et un vide ;
 *  - zone sensible blanche ⇒ aplats présents à chaque instant, arrêts sur image compris ;
 *  - piste unique « Tout », 50 segments.
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
  displayCaptions,
  migrateV1ToV2,
  projectFromProposal,
  segmentsV2,
  type ClipProjectV2,
  type CreateProjectInput,
  type SegmentV2,
} from '@acs/timeline';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import {
  audioSamples,
  beepOnsetsMs,
  createEditVideo,
  createLayoutVideo,
  decodeEditFrames,
  EDIT_TONES,
  frameAt,
  LAYOUT_ZONES as Z,
  peakAt,
  toneLevelAt,
} from '../../../tests/helpers/render-fixtures';
import { allowedAudio, EMPTY_AUDIO_STATE, type ExportAudioState, type TrackIn } from './audio';
import { buildFramePlan, buildRenderPlanV2, type RenderPlan, type RenderPlanV2Input } from './plan';
import type { PresetConfig } from './presets';
import { checkOutput, runFrame, runRender } from './run';

const enabled = ffmpegAvailable();
const FONTS = fileURLToPath(new URL('../../../assets/fonts', import.meta.url));
const FAST: PresetConfig = { finalCrf: 23, x264Preset: 'ultrafast', previewHeight: 960 };
/** Premier plan de la disposition « fond flouté » en aperçu 540×960 (source 16:9). */
const FG = { w: 540, h: 304, y: 328 };
const MIC_STATE: ExportAudioState = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present', otherVoices: 'absent' },
};
const MIX_STATE: ExportAudioState = {
  ...EMPTY_AUDIO_STATE,
  mixComposition: { discord: 'absent', gameVoiceChat: 'absent', otherVoices: 'absent' },
};

let dir: string;
let editVideo: string;
let singleTrackVideo: string;
let layoutVideo: string;

function v2Doc(o: {
  segments: SegmentV2[];
  width?: number;
  height?: number;
  role?: 'mic' | 'mix';
  words?: CreateProjectInput['words'];
  preset?: 'blurred_fit' | 'gameplay_crop' | 'facecam_top';
  masks?: boolean;
  loudnorm?: boolean;
}): ClipProjectV2 {
  const role = o.role ?? 'mic';
  const width = o.width ?? 320;
  const height = o.height ?? 180;
  const norm = (r: { x: number; y: number; w: number; h: number }) => ({
    x: r.x / Z.width,
    y: r.y / Z.height,
    w: r.w / Z.width,
    h: r.h / Z.height,
  });
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
      width,
      height,
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
    words: o.words ?? [],
    audio: { tracks: [{ audioIndex: 0, role }], captionRoles: [role] },
    defaults: { mode: 'fidele', minMs: 5000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
  }).project;
  const base = migrateV1ToV2(v1, { manifestWindow: { srcStartMs: 0, srcEndMs: 20_000 } });
  const doc = ClipProjectV2Schema.parse({
    ...base,
    segments: o.segments,
    layout: { ...base.layout, preset: o.preset ?? 'blurred_fit' },
    captions: { ...base.captions, enabled: (o.words ?? []).length > 0 },
    audio: { ...base.audio, loudnorm: { ...base.audio.loudnorm, enabled: o.loudnorm ?? false } },
  });
  expect(checkInvariants(doc)).toEqual([]);
  return doc;
}

function input(
  d: ClipProjectV2,
  o: { tracks?: TrackIn[]; state?: ExportAudioState; fps?: number } = {},
): RenderPlanV2Input {
  const tracks = o.tracks ?? [{ audioIndex: 0, role: d.audio.tracks[0]!.role as 'mic' }];
  return {
    project: d,
    revision: 1,
    kind: 'preview',
    presetConfig: FAST,
    source: { width: d.source.width, height: d.source.height, fps: o.fps ?? 30 },
    audio: allowedAudio(tracks, o.state ?? MIC_STATE),
    captions: displayCaptions(segmentsV2(d.segments), d.captions.items, d.captions.corrections, {
      roles: d.captions.enabled ? d.captions.sources : [],
      pseudonymize: (t) => ({ text: t, replacements: 0 }),
    }),
    probeBytes: 5_000_000,
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

/**
 * Écarts entre les images de sortie et le montage attendu (liste vide si tout est exact) :
 *  - vide : aucune image source ;
 *  - segment source : images source CONTIGUËS (aucune répétée ni sautée) à partir de l'image de
 *    début ; arrêt sur image : la même image partout ;
 *  - image de début : celle qui couvre l'instant source (FFmpeg < 7) ou la première à partir de
 *    cet instant (FFmpeg ≥ 7) ; identiques quand l'instant tombe sur une image.
 */
function frameProblems(
  frames: { source: number | null }[],
  pl: RenderPlan,
  fps: number,
): { segment: string; problem: string }[] {
  const out: { segment: string; problem: string }[] = [];
  const total = pl.segments!.reduce((n, s) => n + s.frames, 0);
  if (frames.length !== total)
    out.push({ segment: '*', problem: `${frames.length} images au lieu de ${total}` });
  for (const s of pl.segments!) {
    const got = frames.slice(s.firstFrame, s.firstFrame + s.frames).map((f) => f.source);
    if (s.kind === 'gap') {
      if (got.some((g) => g !== null))
        out.push({ segment: s.id, problem: `image source dans le vide : ${got}` });
      continue;
    }
    const exact = (s.srcMs! * fps) / 1000;
    const allowed = [Math.floor(exact + 1e-6), Math.ceil(exact - 1e-6)];
    const f0 = got[0];
    if (f0 === null || f0 === undefined || !allowed.includes(f0)) {
      out.push({ segment: s.id, problem: `début ${f0}, attendu ${allowed.join(' ou ')}` });
      continue;
    }
    const want = got.map((_, m) => (s.kind === 'freeze' ? f0 : f0 + m));
    const bad = got.findIndex((g, m) => g !== want[m]);
    if (bad >= 0)
      out.push({ segment: s.id, problem: `image ${bad} : ${got[bad]} au lieu de ${want[bad]}` });
  }
  return out;
}

const src = (id: string, a: number, b: number): SegmentV2 => ({
  id,
  kind: 'source',
  srcStartMs: a,
  srcEndMs: b,
  speed: 1,
});
const freeze = (id: string, at: number, dur: number): SegmentV2 => ({
  id,
  kind: 'freeze',
  srcAtMs: at,
  editDurMs: dur,
});
const gap = (id: string, dur: number): SegmentV2 => ({ id, kind: 'gap', editDurMs: dur });

/** Montage de référence : coupe, arrêt sur image, vide, saut en avant, retour en arrière. */
const EDIT: SegmentV2[] = [
  src('a', 1300, 3600),
  freeze('b', 5500, 1000),
  gap('c', 700),
  src('d', 8450, 10_200),
  src('e', 4100, 6300),
];

describe.skipIf(!enabled)('moteur multi-segments (FFmpeg réel)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acs montage été-'));
    editVideo = createEditVideo(dir);
    singleTrackVideo = createEditVideo(dir, { tracks: 1, name: 'piste unique.mkv' });
    layoutVideo = createLayoutVideo(dir, 20);
  }, 120_000);

  it('coupes exactes à l’image près : chaque image de sortie vient de l’image source attendue ; arrêt figé ; vide sans image source', async () => {
    const pl = buildRenderPlanV2(input(v2Doc({ segments: EDIT })));
    expect(pl.inputs).toHaveLength(4);
    const out = await render(pl, editVideo);
    expect(frameProblems(decodeEditFrames(out, FG), pl, 30)).toEqual([]);
  }, 180_000);

  it('audio et vidéo synchrones après chaque coupe (± 1 image) ; silence mesuré pendant l’arrêt et le vide', async () => {
    const pl = buildRenderPlanV2(input(v2Doc({ segments: EDIT })));
    const out = await render(pl, editVideo);
    const samples = audioSamples(out);
    const frames = decodeEditFrames(out, FG);
    const flashes = frames
      .map((f, j) => (f.flash && !frames[j - 1]?.flash ? (j * 1000) / 30 : null))
      .filter((t): t is number => t !== null);
    const beeps = beepOnsetsMs(samples, EDIT_TONES.beep);
    // Bips attendus : sources 2000, 3000 (a) ; 9000, 10000 (d) ; 5000, 6000 (e).
    expect(beeps.length, `bips ${beeps}`).toBe(6);
    expect(flashes.length, `éclairs ${flashes}`).toBe(6);
    beeps.forEach((b, k) => expect(Math.abs(b - flashes[k]!), `bip ${b}`).toBeLessThanOrEqual(34));
    const expectedEdit = [700, 1700, 4550, 5550, 6650, 7650];
    // Éclairs : à l'image près de l'instant attendu. Bips : écarts entre bips conservés (le
    // codage AAC décale tout le son d'une vingtaine de ms, uniformément, sans dérive).
    flashes.forEach((f, k) =>
      expect(Math.abs(f - expectedEdit[k]!), `éclairs ${flashes}`).toBeLessThanOrEqual(34),
    );
    beeps.forEach((b, k) =>
      expect(
        Math.abs(b - beeps[0]! - (expectedEdit[k]! - expectedEdit[0]!)),
        `bips ${beeps}`,
      ).toBeLessThanOrEqual(34),
    );
    // Arrêt sur image (2300–3300) et vide (3300–4000) : silence numérique (fondus exclus).
    expect(peakAt(samples, 2320, 960)).toBeLessThan(1e-3);
    expect(peakAt(samples, 3320, 660)).toBeLessThan(1e-3);
    expect(toneLevelAt(samples, EDIT_TONES.bed, 2320, 960)).toBeLessThan(1e-4);
    // Ailleurs : la tonalité continue est bien là.
    expect(toneLevelAt(samples, EDIT_TONES.bed, 1000, 500)).toBeGreaterThan(0.05);
    expect(toneLevelAt(samples, EDIT_TONES.bed, 4200, 500)).toBeGreaterThan(0.05);
  }, 180_000);

  it('raccords : fondu de 8 ms à chaque entrée et sortie de segment (aucun clic)', async () => {
    const pl = buildRenderPlanV2(
      input(v2Doc({ segments: [src('a', 1300, 4000), src('b', 7130, 10_000)] })),
    );
    expect(pl.filterComplex).toContain('afade=t=out:st=2.692:d=0.008');
    expect(pl.filterComplex).toContain('afade=t=in:st=0:d=0.008');
    const samples = audioSamples(await render(pl, editVideo));
    // Au raccord (2700 ms), l'amplitude passe par zéro au lieu d'un saut de phase brutal.
    expect(peakAt(samples, 2699.5, 1)).toBeLessThan(0.03);
    expect(peakAt(samples, 2600, 50)).toBeGreaterThan(0.2);
  }, 180_000);

  it('aplats présents à chaque instant, arrêt sur image compris ; image exacte identique', async () => {
    const d = v2Doc({
      segments: [
        src('a', 1000, 3000),
        freeze('b', 2000, 1500),
        gap('c', 500),
        src('d', 6000, 8000),
      ],
      width: Z.width,
      height: Z.height,
      masks: true,
      preset: 'gameplay_crop',
    });
    const pl = buildRenderPlanV2({
      ...input(d),
      project: { ...d, layout: { ...d.layout, focusX: 1 } },
    });
    const out = await render(pl, layoutVideo);
    const white = (t: number) => {
      const f = frameAt(out, t);
      for (let y = 0; y < f.height; y += 6)
        for (let x = 0; x < f.width; x += 6) {
          const [r, g, b] = f.rgb(x, y);
          if (r > 225 && g > 225 && b > 225) return true;
        }
      return false;
    };
    for (let t = 0.1; t < 6; t += 0.4)
      expect(white(t), `zone sensible à ${t.toFixed(1)} s`).toBe(false);
    // Aplat noir pendant l'arrêt sur image (2,0–3,5 s) ; fond noir pendant le vide (3,5–4,0 s).
    const fz = frameAt(out, 2.8);
    expect(fz.rgb(300, 130).every((v) => v < 40)).toBe(true);
    // Image exacte pendant l'arrêt et pendant le vide.
    for (const at of [2800, 3700]) {
      const work = path.join(dir, `image ${at}`);
      mkdirSync(work, { recursive: true });
      const jpg = path.join(work, 'image.jpg');
      await runFrame({
        ffmpegPath: FFMPEG,
        frame: buildFramePlan(
          { ...input(d), project: { ...d, layout: { ...d.layout, focusX: 1 } } },
          at,
        ),
        sourcePath: layoutVideo,
        outputPath: jpg,
        workDir: work,
        fontsDir: FONTS,
      });
      const img = frameAt(jpg, 0);
      expect([img.width, img.height]).toEqual([540, 960]);
      if (at === 2800)
        expect(
          img.rgb(300, 130).every((v) => v < 40),
          'aplat figé',
        ).toBe(true);
      else
        expect(
          img.rgb(270, 480).every((v) => v < 20),
          'fond du vide',
        ).toBe(true);
    }
  }, 180_000);

  it('sous-titres qui suivent les coupes : figés pendant l’arrêt, absents pendant le vide', async () => {
    const words: CreateProjectInput['words'] = [
      {
        role: 'mic',
        words: [
          { text: 'Bonjour', srcStartMs: 2100, srcEndMs: 2600 },
          { text: 'monde', srcStartMs: 2650, srcEndMs: 3100 },
        ],
      },
    ];
    // Les mots (source 2100–3100) apparaissent après un premier segment de 2 s (source 6000–8000),
    // puis un arrêt sur image à 2400 (figé), puis un vide.
    const d = v2Doc({
      segments: [
        src('a', 6000, 8000),
        src('b', 2000, 3200),
        freeze('c', 2400, 1000),
        gap('d', 800),
        src('e', 8000, 9000),
      ],
      words,
    });
    const pl = buildRenderPlanV2(input(d));
    expect(pl.ass).toContain('Bonjour');
    const out = await render(pl, editVideo);
    const caption = (t: number) => {
      const f = frameAt(out, t);
      let bright = 0;
      for (let y = 640; y < 800; y += 2)
        for (let x = 60; x < 480; x += 2) {
          const [r, g, b] = f.rgb(x, y);
          if ((r > 200 && g > 200 && b > 200) || (r > 200 && g > 200 && b < 60)) bright++;
        }
      return bright;
    };
    expect(caption(1.5), 'avant (autre segment)').toBe(0);
    expect(caption(2.5), 'pendant les mots').toBeGreaterThan(50);
    expect(caption(3.7), 'arrêt sur image : figé').toBeGreaterThan(50);
    expect(caption(4.6), 'vide : absent').toBe(0);
    expect(caption(5.5), 'après').toBe(0);
  }, 180_000);

  it('piste unique « Tout » : une seule piste, autorisée par la déclaration de composition ; silence pendant l’arrêt', async () => {
    const d = v2Doc({
      segments: [src('a', 1300, 4000), freeze('b', 4500, 1000), src('c', 7000, 9000)],
      role: 'mix',
    });
    const tracks: TrackIn[] = [{ audioIndex: 0, role: 'mix' }];
    // Sans déclaration de la composition de « Tout » : refus, aucune séparation inventée.
    expect(() => buildRenderPlanV2(input(d, { tracks, state: EMPTY_AUDIO_STATE }))).toThrow(
      expect.objectContaining({ code: 'EXPORT_CONSENT_REQUIRED' }),
    );
    const pl = buildRenderPlanV2(input(d, { tracks, state: MIX_STATE }));
    expect(pl.audio.tracks).toEqual([{ audioIndex: 0, role: 'mix', gainDb: 0 }]);
    const samples = audioSamples(await render(pl, singleTrackVideo));
    expect(toneLevelAt(samples, EDIT_TONES.bed, 500, 500)).toBeGreaterThan(0.05);
    expect(peakAt(samples, 2720, 960)).toBeLessThan(1e-3);
    expect(toneLevelAt(samples, EDIT_TONES.bed, 4000, 500)).toBeGreaterThan(0.05);
  }, 180_000);

  it('image exacte = image de l’export au même instant (zoom, sous-titres, arrêt sur image, vide)', async () => {
    const words: CreateProjectInput['words'] = [
      {
        role: 'mic',
        words: [
          { text: 'Bonjour', srcStartMs: 2100, srcEndMs: 2600 },
          { text: 'monde', srcStartMs: 2650, srcEndMs: 3100 },
        ],
      },
    ];
    const base = v2Doc({
      segments: [
        src('a', 6000, 8000),
        src('b', 2000, 3200),
        freeze('c', 2400, 1000),
        gap('d', 800),
        src('e', 8000, 9000),
      ],
      words,
      width: Z.width,
      height: Z.height,
      masks: true,
    });
    const d: ClipProjectV2 = {
      ...base,
      mode: 'enrichi',
      effects: [
        {
          id: 'z',
          type: 'punch_zoom',
          params: { factor: 1.2 },
          region: null,
          timing: { anchor: 'source', srcStartMs: 6500, srcEndMs: 7800 },
          enabled: true,
          origin: 'creator',
          reason: 'test',
          signals: {},
        },
      ],
    };
    const inp = input(d);
    const out = await render(buildRenderPlanV2(inp), layoutVideo);
    // Zoom (1,0 s), sous-titres (2,4 s), arrêt sur image figé avec sous-titres (3,7 s), vide (4,6 s).
    for (const at of [1000, 2400, 3700, 4600]) {
      const work = path.join(dir, `exacte ${at}`);
      mkdirSync(work, { recursive: true });
      const jpg = path.join(work, 'image.jpg');
      const frame = buildFramePlan(inp, at);
      await runFrame({
        ffmpegPath: FFMPEG,
        frame,
        sourcePath: layoutVideo,
        outputPath: jpg,
        workDir: work,
        fontsDir: FONTS,
      });
      const a = frameAt(jpg, 0);
      const b = frameAt(out, frame.frameTimeMs / 1000);
      // Part des points nettement différents (bords des zones, texte) : compression comprise.
      let differ = 0;
      let count = 0;
      for (let y = 0; y < a.height; y += 2)
        for (let x = 0; x < a.width; x += 2) {
          const pa = a.rgb(x, y);
          const pb = b.rgb(x, y);
          if (Math.max(...pa.map((v, c) => Math.abs(v - pb[c]!))) > 80) differ++;
          count++;
        }
      expect(differ / count, `points différents à ${at} ms`).toBeLessThan(0.002);
    }
  }, 240_000);

  it('50 segments : graphe valide (fichier de script), durée exacte, chaque segment commence à la bonne image', async () => {
    const segments: SegmentV2[] = Array.from({ length: 50 }, (_, k) =>
      src(`s${String(k).padStart(2, '0')}`, ((k * 7) % 50) * 300 + 400, ((k * 7) % 50) * 300 + 600),
    );
    const pl = buildRenderPlanV2(input(v2Doc({ segments })));
    expect(pl.inputs).toHaveLength(50);
    expect(pl.durationMs).toBe(10_000);
    // Graphe de plusieurs dizaines de milliers de caractères : avec les 50 entrées, il dépasserait la
    // limite de ligne de commande de Windows (32 767) ; il est lu depuis un fichier.
    expect(pl.filterComplex.length).toBeGreaterThan(20_000);
    const out = await render(pl, editVideo);
    expect(frameProblems(decodeEditFrames(out, FG), pl, 30)).toEqual([]);
  }, 300_000);
});
