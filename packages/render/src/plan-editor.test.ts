/**
 * Plan de rendu des fonctions de l'éditeur (PR 7e) : disposition libre et surcharges, masques
 * temporels (marge de sécurité), sous-titres réglés et manuels, calques texte, flou créatif APRÈS
 * les aplats, zooms localisés, secousse, éclair, automatisation, atténuation, bips et fondus.
 * Aucun texte du document n'entre dans le graphe ; tout texte passe par l'ASS échappé.
 */
import { describe, expect, it } from 'vitest';
import {
  ClipProjectV2Schema,
  displayCaptions,
  MASK_TIME_MARGIN_MS,
  migrateV1ToV2,
  segmentLayers,
  segmentsV2,
  type ClipProjectV2,
  type EffectV2,
  type SegmentV2,
} from '@acs/timeline';
import { allowedAudio, EMPTY_AUDIO_STATE } from './audio';
import { goldenCases } from './golden-fixtures';
import {
  buildFramePlan,
  buildRenderPlanV2,
  needsEditorGraph,
  unsupportedRenderFeatures,
  type RenderPlanV2Input,
} from './plan';

const MIC = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present' as const, otherVoices: 'absent' as const },
};

const src = (id: string, a: number, b: number): SegmentV2 => ({
  id,
  kind: 'source',
  srcStartMs: a,
  srcEndMs: b,
  speed: 1,
});
const TWO: SegmentV2[] = [src('a', 110_000, 120_000), src('b', 125_000, 135_000)];

function doc(over: Partial<ClipProjectV2> = {}, segments: SegmentV2[] = TWO): ClipProjectV2 {
  const v1 = goldenCases()[0]!.project;
  const d = migrateV1ToV2(v1, { manifestWindow: { srcStartMs: 50_000, srcEndMs: 200_000 } });
  const byId = <T extends { id: string }>(a: T[] | undefined) =>
    a && [...a].sort((x, y) => (x.id < y.id ? -1 : 1));
  return ClipProjectV2Schema.parse({
    ...d,
    segments,
    ...over,
    ...(over.effects ? { effects: byId(over.effects) } : {}),
  });
}

function input(
  d: ClipProjectV2,
  extra: Partial<RenderPlanV2Input> = {},
  fps = 30,
): RenderPlanV2Input {
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
    ...extra,
  };
}

const effect = (e: Partial<EffectV2> & Pick<EffectV2, 'id' | 'type' | 'params'>): EffectV2 => ({
  region: null,
  timing: { anchor: 'source', srcStartMs: 112_000, srcEndMs: 114_000 },
  enabled: true,
  origin: 'creator',
  reason: '',
  signals: {},
  ...e,
});

const part = (g: string, start: string) => g.split(';').filter((p) => p.startsWith(start));

describe('masques temporels', () => {
  const timed = (srcStartMs: number, srcEndMs: number) =>
    doc({
      masks: [
        ...doc().masks,
        {
          id: 'mask-900',
          rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
          label: 't',
          mode: 'opaque',
          srcRange: { srcStartMs, srcEndMs },
        },
      ],
    });

  it('aplat avec plage + marge, dans le temps de la branche, AVANT tout recadrage', () => {
    const g = buildRenderPlanV2(input(timed(112_000, 113_000))).filterComplex;
    const m = MASK_TIME_MARGIN_MS / 1000;
    const branch = part(g, '[0:v]')[0]!;
    expect(branch).toContain(
      `drawbox=x=0:y=0:w=192:h=108:color=black@1:t=fill:enable='between(t,${2 - m},${3 + m})'`,
    );
    // Masque du profil (permanent) puis masque temporel, avant la mise en cadence de la branche.
    expect(branch.indexOf('drawbox')).toBeLessThan(branch.indexOf('trim=end_frame'));
    // Absent de la seconde branche (plage hors du segment).
    expect(part(g, '[1:v]')[0]).not.toContain('enable=');
  });

  it('plage couvrant toute la branche : aplat permanent dans la branche', () => {
    const g = buildRenderPlanV2(input(timed(100_000, 130_000))).filterComplex;
    expect(part(g, '[0:v]')[0]!.match(/drawbox/gu)).toHaveLength(2);
    expect(part(g, '[1:v]')[0]!.match(/enable=/gu)).toHaveLength(1);
  });

  it('arrêt sur image : aplat statique si l’image figée est dans la plage (marge comprise)', () => {
    const segs: SegmentV2[] = [
      src('a', 110_000, 120_000),
      { id: 'f', kind: 'freeze', srcAtMs: 113_050, editDurMs: 1000 },
      src('b', 125_000, 135_000),
    ];
    const d = doc({ masks: timed(112_000, 113_000).masks }, segs);
    const g = buildRenderPlanV2(input(d)).filterComplex;
    const frz = part(g, '[1:v]')[0]!;
    expect(frz.match(/drawbox/gu)).toHaveLength(2);
    expect(frz).not.toContain('enable=');
  });

  it('image exacte : aplat présent pendant la plage, absent hors plage', () => {
    const d = timed(112_000, 113_000);
    expect(buildFramePlan(input(d), 2_500).graph.match(/drawbox/gu)).toHaveLength(2);
    expect(buildFramePlan(input(d), 5_000).graph.match(/drawbox/gu)).toHaveLength(1);
  });

  it('un masque temporel désactivé n’est pas appliqué (et ne force pas le graphe de l’éditeur)', () => {
    const d = timed(112_000, 113_000);
    const off = {
      ...d,
      masks: d.masks.map((m) => (m.srcRange ? { ...m, mode: 'off' as const } : m)),
    };
    expect(buildRenderPlanV2(input(off)).filterComplex).not.toContain('enable=');
  });
});

describe('disposition libre et surcharges par segment', () => {
  const layers = [
    {
      id: 'g',
      role: 'gameplay' as const,
      crop: { x: 0, y: 0, w: 0.5, h: 1 },
      frame: { x: 0, y: 0.5, w: 1, h: 0.5 },
      z: 0,
    },
    {
      id: 'c',
      role: 'facecam' as const,
      crop: { x: 0.75, y: 0.7, w: 0.25, h: 0.3 },
      frame: { x: 0.1, y: 0.05, w: 0.8, h: 0.4 },
      z: 1,
    },
  ];

  it('disposition custom : fond, recadrages et cadres de la géométrie partagée', () => {
    const d = doc({ layout: { ...doc().layout, preset: 'custom', layers, background: '#123456' } });
    const g = buildRenderPlanV2(input(d)).filterComplex;
    const placed = segmentLayers(d, 'a', {
      src: { width: 1920, height: 1080 },
      out: { width: 1080, height: 1920 },
    });
    expect(g).toContain('drawbox=x=0:y=0:w=iw:h=ih:color=0x123456@1:t=fill[cc_0_0]');
    for (const [i, l] of placed.entries()) {
      expect(g).toContain(
        `[cl_0_${i}]crop=${l.crop.w}:${l.crop.h}:${l.crop.x}:${l.crop.y},scale=${l.frame.w}:${l.frame.h}`,
      );
      expect(g).toContain(`overlay=${l.frame.x}:${l.frame.y}`);
    }
  });

  it('surcharge d’un segment : seul ce segment change de disposition', () => {
    const d = doc({ layout: { ...doc().layout, overrides: [{ id: 'b', layers }] } });
    const g = buildRenderPlanV2(input(d)).filterComplex;
    expect(g).toContain('[cl_1_0]');
    expect(g).not.toContain('[cl_0_0]');
    expect(needsEditorGraph(d, [])).toBe(true);
  });

  it('un seul segment avec disposition libre : graphe de l’éditeur (une entrée par segment)', () => {
    const d = doc({ layout: { ...doc().layout, preset: 'custom', layers } }, [
      src('a', 110_000, 130_000),
    ]);
    const plan = buildRenderPlanV2(input(d));
    expect(plan.inputs).toHaveLength(1);
    expect(plan.filterComplex).toContain('[cl_0_1]');
  });
});

describe('sous-titres réglés, sous-titres manuels et calques texte', () => {
  const manual = {
    id: 'man-1',
    origin: 'creator' as const,
    text: 'Salut {\\b1} Bob',
    srcStartMs: 115_000,
    srcEndMs: 116_000,
    style: { color: '#FF0000' },
    position: { x: 0.5, y: 0.3 },
  };

  it('sous-titre manuel : texte pseudonymisé fourni par le serveur, style propre, position', () => {
    const d = doc({ captions: { ...doc().captions, manual: [manual] } });
    const plan = buildRenderPlanV2(input(d, { manualCaptions: { 'man-1': 'Salut {\\b1} [ami]' } }));
    expect(plan.ass).toContain('Style: S1,');
    expect(plan.ass).toMatch(
      /Dialogue: 0,0:00:05\.00,0:00:06\.00,S1,,0,0,0,,\{\\an5\\pos\(540,576\)\}/u,
    );
    // Accolades et barre oblique inverse neutralisées : aucune balise injectée.
    expect(plan.ass).toContain('Salut ｛＼b1｝ [ami]');
    expect(plan.filterComplex).not.toContain('Salut');
    expect(plan.srt).toContain('Salut {\\b1} [ami]');
  });

  it('texte affiché manquant : refus (jamais de texte non pseudonymisé)', () => {
    const d = doc({ captions: { ...doc().captions, manual: [manual] } });
    expect(() => buildRenderPlanV2(input(d))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('horaires réglés : la ligne suit les nouveaux horaires, sans mise en évidence mot à mot', () => {
    const base = doc();
    const item = base.captions.items.find(
      (i) => i.speakerRole === 'mic' && i.srcStartMs >= 112_000,
    )!;
    const d = doc({
      captions: {
        ...base.captions,
        overrides: [
          {
            id: item.id,
            srcStartMs: item.srcStartMs - 500,
            srcEndMs: item.srcEndMs,
            style: null,
            position: null,
          },
        ],
      },
    });
    const plan = buildRenderPlanV2(input(d));
    const start = (item.srcStartMs - 500 - 110_000) / 1000;
    expect(plan.ass).toContain(`Dialogue: 0,0:00:${start.toFixed(2).padStart(5, '0')}`);
    // Texte seul : aucun graphe de l'éditeur pour un réglage de texte.
    expect(plan.inputs).toHaveLength(2);
  });

  it('calque texte : style dédié, centre du cadre, taille et opacité ; texte échappé', () => {
    const d = doc({
      overlays: [
        {
          id: 'o1',
          kind: 'text',
          assetId: null,
          text: 'Wow',
          timing: { anchor: 'edit', from: 'start', offsetMs: 1000, durMs: 2000 },
          frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 },
          opacity: 0.5,
          z: 2,
        },
      ],
    });
    const plan = buildRenderPlanV2(input(d, { overlayTexts: { o1: 'Wow {\\pos(0,0)}' } }));
    expect(plan.ass).toContain('Style: Overlay,Montserrat ExtraBold');
    expect(plan.ass).toContain(
      'Dialogue: 3,0:00:01.00,0:00:03.00,Overlay,,0,0,0,,{\\an5\\pos(540,288)\\fs134\\alpha&H80&}Wow ｛＼pos(0,0)｝',
    );
    expect(plan.filterComplex).not.toContain('Wow');
    expect(unsupportedRenderFeatures(d)).toEqual([]);
    expect(() => buildRenderPlanV2(input(d))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

describe('effets visuels', () => {
  const enrichi = (effects: EffectV2[], over: Partial<ClipProjectV2> = {}) =>
    doc({ mode: 'enrichi', effects, ...over });

  it('flou créatif : APRÈS les aplats, jamais compté comme un masque', () => {
    const d = enrichi([
      effect({
        id: 'b',
        type: 'blur_region',
        params: { sigma: 12 },
        region: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      }),
    ]);
    const g = buildRenderPlanV2(input(d)).filterComplex;
    const parts = g.split(';');
    const masked = parts.findIndex((p) => p.startsWith('[0:v]') && p.includes('drawbox'));
    const blur = parts.findIndex((p) => p.includes('gblur=sigma=12'));
    expect(masked).toBeGreaterThanOrEqual(0);
    expect(blur).toBeGreaterThan(masked);
    expect(g).toContain("overlay=960:540:enable='between(t,2,4)'");
    // Les aplats sont toujours là : le flou ne remplace aucun masque.
    expect(g.match(/drawbox=x=1382/gu)?.length).toBe(2);
  });

  it('flou créatif actif même en mode fidèle (pas un effet de mouvement)', () => {
    const d = doc({
      effects: [
        effect({
          id: 'b',
          type: 'blur_region',
          params: { sigma: 12 },
          region: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        }),
      ],
    });
    expect(d.mode).toBe('fidele');
    expect(buildRenderPlanV2(input(d)).filterComplex).toContain('gblur=sigma=12');
  });

  it('zoom localisé : centre du zoom = centre de la zone dans l’image composée', () => {
    const d = enrichi([
      effect({
        id: 'z',
        type: 'zoom',
        params: { factor: 2 },
        region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      }),
    ]);
    const g = buildRenderPlanV2(input(d)).filterComplex;
    expect(g).toContain("zoompan=z='1+1*clip(min((it-2)/0.25,(4-it)/0.25),0,1)'");
    expect(g).toMatch(
      /x='clip\(if\(between\(it,2,4\),0\.5,0\.5\)\*iw-iw\/zoom\/2,0,iw-iw\/zoom\)'/u,
    );
  });

  it('secousse et éclair : expressions du temps montage, même enveloppe que l’aperçu', () => {
    const d = enrichi([
      effect({ id: 's', type: 'shake', params: { amplitude: 0.02 } }),
      effect({
        id: 'f',
        type: 'flash',
        params: { intensity: 0.6 },
        timing: { anchor: 'edit', from: 'start', offsetMs: 5000, durMs: 500 },
      }),
    ]);
    const g = buildRenderPlanV2(input(d)).filterComplex;
    expect(g).toContain('[fxsa][fxsb]overlay=x=');
    expect(g).toContain('round(21.6*sin(2*PI*9*(t-2)))');
    expect(g).toContain('colorchannelmixer=aa=0.6,fade=t=out:st=5:d=0.5:alpha=1[fxfl0]');
    expect(g).toContain("overlay=eof_action=pass:enable='between(t,5,5.5)'");
  });

  it('effets de mouvement inactifs en mode fidèle (aucun filtre)', () => {
    const d = doc({ effects: [effect({ id: 's', type: 'shake', params: { amplitude: 0.02 } })] });
    expect(buildRenderPlanV2(input(d)).filterComplex).not.toContain('fxsa');
  });
});

describe('audio : automatisation, atténuation, bips, fondus', () => {
  it('automatisation : gain variable en temps source dans la branche', () => {
    const base = doc();
    const d = doc({
      audio: {
        ...base.audio,
        tracks: base.audio.tracks.map((t) => ({
          ...t,
          automation: [
            { srcMs: 111_000, gainDb: 0 },
            { srcMs: 112_000, gainDb: -20 },
          ],
        })),
      },
    });
    const g = buildRenderPlanV2(input(d)).filterComplex;
    const branch = part(g, '[0:a:1]')[0]!;
    expect(branch).toContain('asetnsamples=n=64:p=0,volume=');
    expect(branch).toContain('if(lt((110+t),111),0,');
    expect(branch).toContain(':eval=frame');
  });

  it('atténuation et bip : pistes atténuées puis coupées, ton mixé ; fondus sur le mixage', () => {
    const d = doc({
      effects: [
        effect({ id: 'd', type: 'duck', params: { gainDb: -18 } }),
        effect({
          id: 'b',
          type: 'bleep',
          params: { frequencyHz: 1200 },
          timing: { anchor: 'source', srcStartMs: 115_000, srcEndMs: 115_500 },
        }),
        effect({
          id: 'fi',
          type: 'fade_in',
          params: {},
          timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 1000 },
        }),
      ],
    });
    const g = buildRenderPlanV2(input(d)).filterComplex;
    expect(g).toContain('pow(10,-18*clip(min((t-2)/0.02,(4-t)/0.02),0,1)/20)');
    expect(g).toContain('(1-clip(min((t-5)/0.005,(5.5-t)/0.005),0,1))');
    expect(g).toContain('sine=frequency=1200:sample_rate=48000:duration=20');
    expect(g).toContain('[t0][tone0]amix=inputs=2');
    expect(g).toMatch(/loudnorm=[^;]*,asetnsamples=n=64:p=0,volume='if\(between\(t,0,1\)/u);
  });

  it('effets audio sans piste exportée (export muet) : aucun filtre audio', () => {
    const base = doc();
    const d = doc({
      audio: { ...base.audio, silent: true },
      effects: [effect({ id: 'b', type: 'bleep', params: { frequencyHz: 1000 } })],
    });
    const plan = buildRenderPlanV2(input(d));
    expect(plan.hasAudio).toBe(false);
    expect(plan.filterComplex).not.toContain('sine=');
  });
});

describe('toutes les fonctions du document v2 sont rendues (calques image et effets sonores : media-library.integration.test.ts)', () => {
  it('aucune fonction du document v2 n’est refusée', () => {
    const d = doc({
      mode: 'enrichi',
      effects: (
        ['zoom', 'flash', 'shake', 'blur_region', 'fade_in', 'fade_out', 'duck', 'bleep'] as const
      ).map((type, i) =>
        effect({
          id: `e${i}`,
          type,
          params:
            type === 'zoom'
              ? { factor: 1.5 }
              : type === 'flash'
                ? { intensity: 0.5 }
                : type === 'shake'
                  ? { amplitude: 0.01 }
                  : type === 'blur_region'
                    ? { sigma: 5 }
                    : type === 'duck'
                      ? { gainDb: -6 }
                      : type === 'bleep'
                        ? { frequencyHz: 1000 }
                        : {},
          region: type === 'zoom' || type === 'blur_region' ? { x: 0, y: 0, w: 0.3, h: 0.3 } : null,
        }),
      ),
    });
    expect(unsupportedRenderFeatures(d)).toEqual([]);
    expect(() => buildRenderPlanV2(input(d))).not.toThrow();
    expect(() => buildFramePlan(input(d), 3000)).not.toThrow();
  });
});
