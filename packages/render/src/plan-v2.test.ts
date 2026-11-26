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
    expect(g).toContain('[1:v]fps=30,drawbox=');
    expect(g).toContain('trim=end_frame=1,loop=loop=44:size=1:start=0');
    expect(g).toMatch(/anullsrc=r=48000:cl=stereo,atrim=end_sample=72000,[^;]*\[a1_0\]/u);
    expect(g).not.toMatch(/\[1:a/u);
  });

  it('vide : fond de la mise en page, aucune image source ; silence', () => {
    expect(g).toContain('color=c=0x000000:s=1080x1920:r=30,trim=end_frame=29');
    expect(g).toMatch(/anullsrc=r=48000:cl=stereo,atrim=end_sample=47520,[^;]*\[a2_0\]/u);
  });

  it('segments : aplats sur l’image source avant la disposition ; nombre exact d’images ; concaténation', () => {
    expect(g).toContain('[0:v]fps=30,drawbox=');
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

describe('fonctions de l’éditeur pas encore rendues : refus explicite, jamais ignorées', () => {
  const d = doc();
  const cases: [string, ClipProjectV2, RegExp][] = [
    [
      'masque temporel',
      {
        ...d,
        masks: [
          ...d.masks,
          {
            id: 'mask-900',
            rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
            label: 't',
            mode: 'opaque',
            srcRange: { srcStartMs: 115_000, srcEndMs: 116_000 },
          },
        ],
      },
      /masques temporels/u,
    ],
    [
      'disposition personnalisée',
      {
        ...d,
        layout: {
          ...d.layout,
          preset: 'custom',
          layers: [
            {
              id: 'l',
              role: 'gameplay',
              crop: { x: 0, y: 0, w: 1, h: 1 },
              frame: { x: 0, y: 0, w: 1, h: 1 },
              z: 0,
            },
          ],
        },
      },
      /disposition personnalisée/u,
    ],
    [
      'sous-titre manuel',
      {
        ...d,
        captions: {
          ...d.captions,
          manual: [
            {
              id: 'man-1',
              origin: 'creator',
              text: 'Salut',
              srcStartMs: 115_000,
              srcEndMs: 116_000,
              style: null,
              position: null,
            },
          ],
        },
      },
      /sous-titres manuels/u,
    ],
    [
      'flou créatif',
      {
        ...d,
        effects: [
          {
            id: 'f',
            type: 'blur_region',
            params: { sigma: 10 },
            region: { x: 0, y: 0, w: 0.2, h: 0.2 },
            timing: { anchor: 'source', srcStartMs: 115_000, srcEndMs: 116_000 },
            enabled: true,
            origin: 'creator',
            reason: '',
            signals: {},
          },
        ],
      },
      /blur_region/u,
    ],
    [
      'automatisation du gain',
      {
        ...d,
        audio: {
          ...d.audio,
          tracks: d.audio.tracks.map((t) => ({
            ...t,
            automation: [{ srcMs: 115_000, gainDb: -6 }],
          })),
        },
      },
      /automatisation/u,
    ],
    [
      'calque graphique',
      {
        ...d,
        overlays: [
          {
            id: 'o',
            kind: 'text',
            assetId: null,
            text: 'Hey',
            timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 1000 },
            frame: { x: 0, y: 0, w: 0.5, h: 0.1 },
            opacity: 1,
            z: 0,
          },
        ],
      },
      /calques/u,
    ],
    [
      'effet sonore',
      {
        ...d,
        audio: {
          ...d.audio,
          sfx: [
            {
              id: 's',
              assetId: 'a'.repeat(64),
              timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 500 },
              gainDb: 0,
            },
          ],
        },
      },
      /effets sonores/u,
    ],
  ];
  for (const [name, bad, re] of cases) {
    it(name, () => {
      expect(unsupportedRenderFeatures(bad).join(' ')).toMatch(re);
      expect(() => buildRenderPlanV2(input(bad))).toThrow(
        expect.objectContaining({ code: 'RENDER_FEATURE_UNSUPPORTED' }),
      );
      expect(() => buildFramePlan(input(bad), 1000)).toThrow(RenderPlanError);
    });
  }

  it('effet inactif (désactivé, ou effet de mouvement en mode fidèle) : aucun refus', () => {
    const off: ClipProjectV2 = {
      ...d,
      effects: [
        {
          id: 'z',
          type: 'zoom',
          params: { factor: 1.5 },
          region: { x: 0, y: 0, w: 0.5, h: 0.5 },
          timing: { anchor: 'source', srcStartMs: 115_000, srcEndMs: 116_000 },
          enabled: true,
          origin: 'creator',
          reason: '',
          signals: {},
        },
      ],
    };
    expect(off.mode).toBe('fidele');
    expect(unsupportedRenderFeatures(off)).toEqual([]);
    expect(
      unsupportedRenderFeatures({
        ...off,
        effects: [{ ...off.effects[0]!, enabled: false }],
        mode: 'enrichi',
      }),
    ).toEqual([]);
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
