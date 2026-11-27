/**
 * Plan de rendu du document v2 (étape 7, PR 7c) : placement des segments sur la grille d'images,
 * arrêt sur image et vide (silence numérique), raccords, entrées FFmpeg, refus explicites des
 * fonctions de l'éditeur pas encore rendues, image exacte.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  ClipProjectV2Schema,
  displayCaptions,
  migrateV1ToV2,
  segmentsV2,
  type ClipProjectV2,
  type SegmentV2,
} from '@acs/timeline';
import { allowedAudio, EMPTY_AUDIO_STATE } from './audio';
import { goldenCases } from './golden-fixtures';
import {
  buildFramePlan,
  buildRenderPlanV2,
  RenderPlanError,
  unsupportedRenderFeatures,
  type PlanAssetInput,
  type RenderPlanV2Input,
} from './plan';

const MIC = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present' as const, otherVoices: 'absent' as const },
};

function doc(segments?: SegmentV2[]): ClipProjectV2 {
  const v1 = goldenCases()[0]!.project;
  const d = migrateV1ToV2(v1, { manifestWindow: { srcStartMs: 50_000, srcEndMs: 200_000 } });
  return segments ? ClipProjectV2Schema.parse({ ...d, segments }) : d;
}

function input(d: ClipProjectV2, fps = 30): RenderPlanV2Input {
  return {
    project: d,
    revision: 1,
    kind: 'final',
    source: { width: 1920, height: 1080, fps },
    audio: allowedAudio(
      [
        { audioIndex: 0, role: 'mix' },
        { audioIndex: 1, role: 'mic' },
      ],
      MIC,
    ),
    captions: displayCaptions(segmentsV2(d.segments), d.captions.items, d.captions.corrections, {
      roles: d.captions.sources,
      pseudonymize: (t) => ({ text: t, replacements: 0 }),
    }),
    probeBytes: 5_000_000,
  };
}

const src = (id: string, a: number, b: number): SegmentV2 => ({
  id,
  kind: 'source',
  srcStartMs: a,
  srcEndMs: b,
  speed: 1,
});
const EDIT: SegmentV2[] = [
  src('a', 110_000, 120_010),
  { id: 'b', kind: 'freeze', srcAtMs: 125_000, editDurMs: 1500 },
  { id: 'c', kind: 'gap', editDurMs: 990 },
  src('d', 130_000, 140_000),
];

describe('placement des segments', () => {
  it('coupes sur la grille d’images, sans dérive : total = images de la durée totale', () => {
    const pl = buildRenderPlanV2(input(doc(EDIT), 30));
    expect(pl.durationMs).toBe(22_500);
    expect(pl.segments!.map((s) => [s.kind, s.firstFrame, s.frames, s.input, s.srcMs])).toEqual([
      ['source', 0, 301, 0, 110_000], // 10 010 ms ⇒ 300,3 images : la coupe tombe sur l'image 301
      ['freeze', 301, 45, 1, 125_000],
      ['gap', 346, 29, null, null],
      ['source', 375, 300, 2, 130_000],
    ]);
    expect(pl.segments!.reduce((n, s) => n + s.frames, 0)).toBe(675); // 22,5 s × 30
    expect(pl.inputs).toEqual([
      { srcStartMs: 110_000, durationMs: 10_010 },
      { srcStartMs: 125_000, durationMs: 0 },
      { srcStartMs: 130_000, durationMs: 10_000 },
    ]);
  });

  it('fréquence non entière (59,94) : aucune image perdue ni ajoutée sur 50 coupes', () => {
    const segs = Array.from({ length: 50 }, (_, k) =>
      src(`s${k}`, 110_000 + k * 400, 110_000 + k * 400 + 401),
    );
    const pl = buildRenderPlanV2(input(doc(segs), 59.94));
    const total = pl.segments!.reduce((n, s) => n + s.frames, 0);
    expect(total).toBe(Math.ceil((pl.durationMs * 59.94) / 1000 - 1e-6));
    pl.segments!.forEach((s, k) => {
      if (k)
        expect(s.firstFrame).toBe(pl.segments![k - 1]!.firstFrame + pl.segments![k - 1]!.frames);
    });
  });
});

describe('graphe multi-segments', () => {
  const pl = buildRenderPlanV2(input(doc(EDIT), 30));
  const g = pl.filterComplex;

  it('arrêt sur image : une image, répétée, mêmes aplats ; SILENCE numérique (aucune boucle du son)', () => {
    expect(g).toContain('[1:v]setpts=PTS-STARTPTS,fps=30,drawbox=');
    expect(g).toContain('trim=end_frame=1,loop=loop=44:size=1:start=0');
    expect(g).toMatch(/anullsrc=r=48000:cl=stereo,atrim=end_sample=72000,[^;]*\[a1_0\]/u);
    expect(g).not.toMatch(/\[1:a/u);
  });

  it('vide : fond de la mise en page, aucune image source ; silence', () => {
    expect(g).toContain('color=c=0x000000:s=1080x1920:r=30,trim=end_frame=29');
    expect(g).toMatch(/anullsrc=r=48000:cl=stereo,atrim=end_sample=47520,[^;]*\[a2_0\]/u);
  });

  it('segments : aplats sur l’image source avant la disposition ; nombre exact d’images ; concaténation', () => {
    expect(g).toContain('[0:v]setpts=PTS-STARTPTS,fps=30,drawbox=');
    expect(g).toContain('trim=end_frame=301,setpts=PTS-STARTPTS[s0]');
    expect(g).toContain('[v0][v1][v2][v3]concat=n=4:v=1:a=0[cat]');
    expect(g).toContain('[a0_0][a1_0][a2_0][a3_0]concat=n=4:v=0:a=1,volume=0dB[t0]');
    expect(g).toMatch(/\[t0\]loudnorm=I=-14:TP=-1\.5:LRA=11,aresample=48000\[a\]$/u);
  });

  it('raccords : fondu de 8 ms aux seuls raccords (ni au début ni à la fin du clip)', () => {
    const first = g.split(';').find((p) => p.endsWith('[a0_0]'))!;
    const last = g.split(';').find((p) => p.endsWith('[a3_0]'))!;
    expect(first).not.toContain('afade=t=in');
    expect(first).toContain('afade=t=out:st=10.002:d=0.008');
    expect(last).toContain('afade=t=in:st=0:d=0.008');
    expect(last).not.toContain('afade=t=out');
  });

  it('aucun texte de transcription ni chemin dans le graphe', () => {
    expect(g).not.toMatch(/mot\d/u);
    expect(g).toContain('subtitles=subs.ass:fontsdir=fonts');
  });

  it('déterministe : même document ⇒ même plan (empreinte stable)', () => {
    expect(canonicalJson(buildRenderPlanV2(input(doc(EDIT), 30)))).toBe(canonicalJson(pl));
  });

  it('zoom de la facecam exprimé dans le temps de chaque branche', () => {
    const d = doc([src('a', 110_000, 120_000), src('b', 126_000, 136_000)]);
    const withZoom: ClipProjectV2 = {
      ...d,
      mode: 'enrichi',
      effects: [
        {
          id: 'r',
          type: 'reaction_hold',
          params: { factor: 1.08 },
          region: null,
          timing: { anchor: 'source', srcStartMs: 127_000, srcEndMs: 129_000 },
          enabled: true,
          origin: 'creator',
          reason: 't',
          signals: {},
        },
      ],
    };
    const graph = buildRenderPlanV2(input(withZoom)).filterComplex;
    // Source 127–129 s ⇒ montage 11–13 s ⇒ 1–3 s dans la branche du second segment.
    expect(graph).toMatch(
      /\[cam_in_1\][^;]*zoompan=z='1\+0\.08\*clip\(min\(\(it-1\)\/0\.25,\(3-it\)\/0\.25\),0,1\)'/u,
    );
    expect(graph.split(';').find((p) => p.startsWith('[cam_in_0]'))).not.toContain('zoompan');
  });
});

describe('bibliothèque de médias (PR 7f) : calques image et effets sonores', () => {
  const d = doc(EDIT);
  const IMG = 'b'.repeat(64);
  const SND = 'a'.repeat(64);
  const withMedia: ClipProjectV2 = {
    ...d,
    overlays: [
      {
        id: 'o',
        kind: 'meme',
        assetId: IMG,
        text: null,
        timing: { anchor: 'edit', from: 'start', offsetMs: 1000, durMs: 2000 },
        frame: { x: 0.25, y: 0.5, w: 0.5, h: 0.1 },
        opacity: 0.5,
        z: 0,
      },
    ],
    audio: {
      ...d.audio,
      sfx: [
        {
          id: 's',
          assetId: SND,
          timing: { anchor: 'edit', from: 'start', offsetMs: 500, durMs: 5000 },
          gainDb: -3,
        },
      ],
    },
  };
  const assets: Record<string, PlanAssetInput> = {
    [IMG]: {
      kind: 'image' as const,
      file: `asset-${IMG}.png`,
      sha256: 'c'.repeat(64),
      durationMs: null,
    },
    [SND]: {
      kind: 'audio' as const,
      file: `asset-${SND}.wav`,
      sha256: 'd'.repeat(64),
      durationMs: 800,
    },
  };

  it('média non fourni (absent de la bibliothèque ou manquant sur le disque) : refus explicite ASSET_MISSING', () => {
    for (const a of [{}, { [IMG]: assets[IMG]! }, { [SND]: assets[SND]! }]) {
      expect(() => buildRenderPlanV2({ ...input(withMedia), assets: a })).toThrow(
        expect.objectContaining({ code: 'ASSET_MISSING' }),
      );
      expect(() => buildFramePlan({ ...input(withMedia), assets: a }, 1500)).toThrow(
        RenderPlanError,
      );
    }
    // Mauvais type (un son à la place d'une image) : refusé aussi.
    expect(() =>
      buildRenderPlanV2({
        ...input(withMedia),
        assets: { ...assets, [IMG]: { ...assets[SND]!, file: `asset-${IMG}.wav` } },
      }),
    ).toThrow(expect.objectContaining({ code: 'ASSET_MISSING' }));
    expect(unsupportedRenderFeatures(withMedia)).toEqual([]);
  });

  it('nom de fichier d’un média : forme fixe uniquement (aucun chemin dans le graphe ni les arguments)', () => {
    for (const file of ['../x.png', '/etc/passwd', `asset-${IMG}.png;rm`, 'a b.png']) {
      expect(() =>
        buildRenderPlanV2({
          ...input(withMedia),
          assets: { ...assets, [IMG]: { ...assets[IMG]!, file } },
        }),
      ).toThrow(RangeError);
    }
  });

  it('plan : entrées des médias après la source, calque posé sur l’image composée (cadre arrondi, opacité, plage), son placé et mixé avant la normalisation', () => {
    const pl = buildRenderPlanV2({ ...input(withMedia), assets });
    const n = pl.inputs!.length;
    expect(pl.assets!.map((a) => [a.id, a.kind, a.file])).toEqual(
      [
        [SND, 'audio', `asset-${SND}.wav`],
        [IMG, 'image', `asset-${IMG}.png`],
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    const imgInput = n + pl.assets!.findIndex((a) => a.id === IMG);
    const sndInput = n + pl.assets!.findIndex((a) => a.id === SND);
    const g = pl.filterComplex;
    expect(g).toContain(`[${imgInput}:v]format=rgba[im${imgInput}_0]`);
    expect(g).toContain(`scale=540:192:flags=lanczos,colorchannelmixer=aa=0.5[ovi0]`);
    expect(g).toContain(
      `overlay=x=270:y=960:format=auto:eof_action=repeat:enable='gte(t,1)*lt(t,3)'[ov0]`,
    );
    // Calques après la composition, textes après les calques.
    expect(g.indexOf('[ovbase]')).toBeLessThan(g.indexOf('[ov0]'));
    // Son : 800 ms au plus (durée du son), placé à 0,5 s, gain −3 dB, silence jusqu'à la fin.
    expect(g).toContain(
      `[sx${sndInput}_0]atrim=start_sample=0:end_sample=38400,asetpts=PTS-STARTPTS,volume=-3dB,adelay=delays=24000S:all=1,apad,atrim=end_sample=${22_500 * 48}[fx0]`,
    );
    expect(g).toMatch(/\[fx0\]amix=inputs=\d+/u);
    expect(g.indexOf('[fx0]amix')).toBeLessThan(g.indexOf('loudnorm'));
    expect(pl.media!.sfx).toEqual([
      { id: 's', assetId: SND, editStartMs: 500, editEndMs: 1300, offsetMs: 0, gainDb: -3 },
    ]);
  });

  it('export sans son : aucun effet sonore ; calques inchangés', () => {
    const silent = { ...withMedia, audio: { ...withMedia.audio, silent: true } };
    const pl = buildRenderPlanV2({ ...input(silent), assets: { [IMG]: assets[IMG]! } });
    expect(pl.assets!.map((a) => a.kind)).toEqual(['image']);
    expect(pl.filterComplex).not.toContain('adelay');
  });

  it('image exacte : seules les images visibles à l’instant sont des entrées', () => {
    expect(buildFramePlan({ ...input(withMedia), assets }, 500).assets).toEqual([]);
    const f = buildFramePlan({ ...input(withMedia), assets }, 1500);
    expect(f.assets.map((a) => a.id)).toEqual([IMG]);
    expect(f.graph).toContain(`[1:v]format=rgba,setpts=`);
    // Pendant un vide : aucune entrée source, l'image est l'entrée 0.
    const gap = buildFramePlan(
      {
        ...input({
          ...withMedia,
          overlays: [
            {
              ...withMedia.overlays[0]!,
              timing: { anchor: 'edit', from: 'start', offsetMs: 11_600, durMs: 500 },
            },
          ],
        }),
        assets,
      },
      11_700,
    );
    expect(gap.input).toBeNull();
    expect(gap.graph).toContain('[0:v]format=rgba');
  });
});

describe('image exacte', () => {
  const pl = (at: number) => buildFramePlan(input(doc(EDIT), 30), at);

  it('segment source : instant source de l’image de sortie, horodatée à cet instant', () => {
    const f = pl(5000);
    expect(f.input).toEqual({ srcMs: 115_000 });
    expect(f.frameTimeMs).toBe(5000);
    expect(f.graph).toContain('trim=end_frame=1,setpts=5/TB');
    expect(f.graph).toContain('subtitles=subs.ass');
  });

  it('arrêt sur image : l’image figée, quel que soit l’instant de l’arrêt', () => {
    expect(pl(10_500).input).toEqual({ srcMs: 125_000 });
    expect(pl(11_400).input).toEqual({ srcMs: 125_000 });
  });

  it('vide : le fond seul, aucune lecture de la source', () => {
    const f = pl(12_000);
    expect(f.input).toBeNull();
    expect(f.graph).toMatch(/^color=c=0x000000:s=1080x1920/u);
    expect(f.graph).not.toContain('[0:v]');
  });

  it('instant borné au clip', () => {
    expect(pl(-50).atEditMs).toBe(0);
    expect(pl(999_999).atEditMs).toBe(22_499);
  });
});

describe('fond du vide : couleur de la mise en page', () => {
  it('couleur choisie utilisée pour le vide (et seulement des chiffres hexadécimaux dans le graphe)', () => {
    const d = { ...doc(EDIT), layout: { ...doc(EDIT).layout, background: '#12ab9F' } };
    expect(buildRenderPlanV2(input(d)).filterComplex).toContain('color=c=0x12AB9F:');
  });
});
