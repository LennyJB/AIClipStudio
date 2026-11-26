/**
 * Modules purs de l'éditeur : conversions pixels ↔ ms, aimantation, rognage et déplacement ;
 * gestes → opérations (validées par le réducteur partagé) ; plan audio (silence des arrêts et des
 * vides, pistes autorisées seulement, fondus de raccord) ; horloge et double tampon avec un média
 * simulé ; compositeur (aplats posés AVANT toute copie du tampon source) ; formes d'onde ;
 * sous-titres de l'aperçu (jamais de texte non pseudonymisé).
 */
import { describe, expect, it } from 'vitest';
import {
  applyBatch,
  placeSegments,
  sceneAt,
  segmentsV2,
  type ClipProjectV2,
  type EditMs,
  type SegmentV2,
} from '@acs/timeline';
import { fixtureV2 } from '../../../../packages/timeline/src/v2/test-fixtures';
import {
  addEffect,
  addTimedMask,
  deleteSegment,
  freezeAt,
  GestureError,
  layersFromPreset,
  retimeCaption,
  setLayers,
  splitAt,
} from './actions';
import { memoryDrafts, openDrafts } from './drafts';
import { planAudio, playableTracks } from './player/audio-plan';
import { DRIFT_THRESHOLD_S, PlaybackClock, VideoSync, type VideoLike } from './player/clock';
import { Compositor, toProxyRect, type CanvasLike } from './player/compositor';
import { parseWaveform, waveformPeak } from './player/media';
import { previewCaptions } from './player/Player';
import {
  moveTargetIndex,
  msToPx,
  pxToMs,
  snap,
  snapTargets,
  SNAP_PX,
  trimFields,
} from './timeline-math';

const CTX = { allowedAudioIndexes: [1], allowedCaptionRoles: ['mic'] };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const src = (id: string, a: number, b: number): SegmentV2 => ({
  id,
  kind: 'source',
  srcStartMs: a,
  srcEndMs: b,
  speed: 1,
});
const withSegments = (segments: SegmentV2[]): ClipProjectV2 => ({ ...fixtureV2(), segments });

describe('timeline : conversions, aimantation, rognage, déplacement', () => {
  it('pixels ↔ millisecondes (aller-retour exact)', () => {
    expect(msToPx(1500, 60)).toBe(90);
    expect(pxToMs(90, 60)).toBe(1500);
    for (const z of [10, 60, 600]) expect(pxToMs(msToPx(12_345, z), z)).toBeCloseTo(12_345, 9);
  });

  it('aimantation : cible la plus proche à moins de SNAP_PX, sinon instant inchangé', () => {
    const d = withSegments([src('a', 110_000, 115_000), src('b', 120_000, 125_000)]);
    const targets = snapTargets(d, 7_000);
    const near = 5_000 + pxToMs(SNAP_PX - 1, 60);
    expect(snap(near, targets, 60)).toMatchObject({ ms: 5_000, target: { kind: 'segment' } });
    expect(snap(7_050, targets, 60).target?.kind).toBe('playhead');
    const far = 2_500;
    expect(
      snap(
        far,
        targets.filter((t) => t.kind !== 'word' && t.kind !== 'caption'),
        60,
      ).ms,
    ).toBe(far);
    expect(snap(near, targets, 60, false).ms).toBe(near);
    // Frontières de mots : présentes (en temps montage).
    expect(targets.some((t) => t.kind === 'word')).toBe(true);
  });

  it('rognage : bornes dans la fenêtre, durée minimale ; arrêt et vide réglés par leur durée', () => {
    const w = { srcStartMs: 50_000, srcEndMs: 193_800 };
    expect(trimFields(src('a', 110_000, 115_000), 'start', -100_000, w)).toEqual({
      srcStartMs: 50_000,
    });
    expect(trimFields(src('a', 110_000, 115_000), 'end', -10_000, w)).toEqual({
      srcEndMs: 110_100,
    });
    expect(trimFields(src('a', 110_000, 115_000), 'end', 0, w)).toBeNull();
    expect(
      trimFields({ id: 'f', kind: 'freeze', srcAtMs: 1, editDurMs: 1000 }, 'end', 500, w),
    ).toEqual({ editDurMs: 1500 });
    expect(trimFields({ id: 'g', kind: 'gap', editDurMs: 1000 }, 'start', 2000, w)).toEqual({
      editDurMs: 100,
    });
  });

  it('déplacement : indice de destination d’après les milieux des autres segments', () => {
    const d = withSegments([
      src('a', 110_000, 112_000),
      src('b', 120_000, 122_000),
      src('c', 130_000, 132_000),
    ]);
    expect(moveTargetIndex(d, 'a', 5_500)).toBe(2);
    expect(moveTargetIndex(d, 'c', 500)).toBe(0);
    expect(moveTargetIndex(d, 'b', 2_500)).toBe(1);
  });
});

describe('gestes → opérations validées par le réducteur', () => {
  const d = withSegments([src('a', 110_000, 120_000), src('b', 125_000, 135_000)]);
  const apply = (g: { ops: unknown[] }) => applyBatch(d, g.ops, CTX).doc;

  it('couper à la tête de lecture, supprimer avec et sans décalage, arrêt sur image', () => {
    expect(apply(splitAt(d, 4_000, uuid)).segments.map((s) => s.kind)).toEqual([
      'source',
      'source',
      'source',
    ]);
    expect(() => splitAt(d, 10, uuid)).toThrow(GestureError);
    const ripple = apply(deleteSegment(d, 'b', true, uuid));
    expect(ripple.segments).toHaveLength(1);
    // Sans décalage en bord de clip : refusé par le réducteur (un clip ne commence pas par un vide).
    expect(() => apply(deleteSegment(d, 'a', false, uuid))).toThrow(/vide/u);
    const d3 = withSegments([...d.segments, src('c', 140_000, 145_000)]);
    const lift = applyBatch(d3, deleteSegment(d3, 'b', false, uuid).ops, CTX).doc;
    expect(lift.segments.map((s) => s.kind)).toEqual(['source', 'gap', 'source']);
    const frz = apply(freezeAt(d, 3_000, 1_500, uuid));
    expect(frz.segments.map((s) => s.kind)).toEqual(['source', 'freeze', 'source', 'source']);
  });

  it('sous-titre : horaires bornés à ±2 s des mots', () => {
    const item = d.captions.items[0]!;
    const g = retimeCaption(d, item.id, item.srcStartMs - 60_000, item.srcEndMs + 60_000);
    const op = g.ops[0] as { srcStartMs: number; srcEndMs: number };
    expect(op.srcStartMs).toBe(item.srcStartMs - 2000);
    expect(op.srcEndMs).toBe(item.srcEndMs + 2000);
    expect(() => apply(g)).not.toThrow();
  });

  it('effets : chaque type du catalogue s’ajoute avec ses valeurs par défaut', () => {
    const e = withSegments(d.segments);
    for (const type of [
      'zoom',
      'flash',
      'shake',
      'blur_region',
      'fade_in',
      'fade_out',
      'duck',
      'bleep',
    ] as const) {
      expect(() => applyBatch(e, addEffect(e, type, 2_000, uuid).ops, CTX), type).not.toThrow();
    }
  });

  it('zone masquée temporelle (opaque) et disposition libre (globale ou par segment)', () => {
    const m = apply(addTimedMask(d, 2_000, uuid));
    const added = m.masks.find((x) => x.srcRange !== null)!;
    expect(added).toMatchObject({
      mode: 'opaque',
      srcRange: { srcStartMs: 111_000, srcEndMs: 113_000 },
    });
    const layers = layersFromPreset(d, { width: 1920, height: 1080 });
    expect(layers.length).toBeGreaterThan(0);
    expect(apply(setLayers(d, layers, null, 'libre')).layout.preset).toBe('custom');
    expect(apply(setLayers(d, layers, 'b', 'segment')).layout.overrides.map((o) => o.id)).toEqual([
      'b',
    ]);
    // Mêmes rectangles que le préréglage d'origine (conversion sans perte, au pixel près).
    const out = { width: 1080, height: 1920 };
    const before = sceneAt(d, 1000 as EditMs, {
      src: { width: 1920, height: 1080 },
      out,
      allowedAudioIndexes: [1],
      allowedCaptionRoles: ['mic'],
    }).layers;
    const after = sceneAt(apply(setLayers(d, layers, null, 'libre')), 1000 as EditMs, {
      src: { width: 1920, height: 1080 },
      out,
      allowedAudioIndexes: [1],
      allowedCaptionRoles: ['mic'],
    }).layers;
    const geo = (l: typeof before) =>
      l.filter((x) => x.role !== 'background').map((x) => [x.role, x.crop, x.frame]);
    expect(geo(after)).toEqual(geo(before));
  });
});

describe('plan audio de l’aperçu', () => {
  const stems = [
    { audioIndex: 1, srcStartMs: 50_000, durationMs: 143_800 },
    { audioIndex: 2, srcStartMs: 50_000, durationMs: 143_800 },
  ];
  const d0 = fixtureV2();
  const d = {
    ...d0,
    segments: [
      src('a', 110_000, 112_000),
      { id: 'f', kind: 'freeze' as const, srcAtMs: 115_000, editDurMs: 1_000 },
      { id: 'g', kind: 'gap' as const, editDurMs: 500 },
      src('b', 120_000, 125_000),
    ],
    audio: {
      ...d0.audio,
      tracks: [
        ...d0.audio.tracks,
        { audioIndex: 2, role: 'discord' as const, gainDb: 0, enabled: true, automation: [] },
      ],
    },
  };

  it('arrêt sur image et vide : aucun extrait (silence) ; raccords internes seulement', () => {
    const p = planAudio(d, [1], stems);
    expect(
      p.clips.map((c) => [c.editStartMs, c.offsetMs, c.durationMs, c.fadeInMs, c.fadeOutMs]),
    ).toEqual([
      [0, 60_000, 2_000, 0, 8],
      [3_500, 70_000, 5_000, 8, 0],
    ]);
  });

  it('piste non autorisée : jamais jouée, même activée et disponible localement', () => {
    expect(playableTracks(d, [1], stems)).toEqual([1]);
    expect(planAudio(d, [1], stems).clips.every((c) => c.audioIndex === 1)).toBe(true);
    // Contre-épreuve : autorisée par le serveur ⇒ jouée.
    expect(playableTracks(d, [1, 2], stems)).toEqual([1, 2]);
  });

  it('export sans son ⇒ aperçu muet ; lecture depuis le milieu d’un segment', () => {
    expect(planAudio({ ...d, audio: { ...d.audio, silent: true } }, [1], stems).clips).toEqual([]);
    const p = planAudio(d, [1], stems, 1_000);
    expect(p.clips[0]).toMatchObject({
      editStartMs: 1_000,
      offsetMs: 61_000,
      durationMs: 1_000,
      fadeInMs: 0,
    });
  });
});

describe('horloge et double tampon (média simulé)', () => {
  it('horloge : lecture, pause, déplacement, fin', () => {
    let now = 10;
    const c = new PlaybackClock({ now: () => now }, 5_000);
    c.seek(1_000);
    c.play();
    now += 1.5;
    expect(c.now()).toBeCloseTo(2_500);
    c.pause();
    now += 3;
    expect(c.now()).toBeCloseTo(2_500);
    c.startAt(now + 0.05);
    now += 3.05;
    expect(c.ended()).toBe(true);
    expect(c.now()).toBe(5_000);
  });

  const fake = (): VideoLike & { seeks: number; t: number } => {
    const v = {
      t: 0,
      seeks: 0,
      paused: true,
      get currentTime() {
        return v.t;
      },
      set currentTime(x: number) {
        v.t = x;
        v.seeks++;
      },
      play() {
        v.paused = false;
      },
      pause() {
        v.paused = true;
      },
    };
    return v;
  };

  it('recalage au-delà du seuil seulement ; préchargement du segment suivant ; bascule au raccord', () => {
    const a = fake();
    const b = fake();
    const s = new VideoSync([a, b]);
    s.update({ segment: 0, target: 10, frozen: false, playing: true, next: 30 });
    expect(a.currentTime).toBe(10);
    expect(b.currentTime).toBe(30); // préchargé
    a.t = 10.05; // dérive sous le seuil : pas de recalage
    const seeks = a.seeks;
    s.update({
      segment: 0,
      target: 10.05 + DRIFT_THRESHOLD_S / 2,
      frozen: false,
      playing: true,
      next: 30,
    });
    expect(a.seeks).toBe(seeks);
    s.update({ segment: 0, target: 11, frozen: false, playing: true, next: 30 });
    expect(a.currentTime).toBe(11);
    // Raccord : l'élément préchargé devient actif, sans nouvelle recherche.
    const bSeeks = b.seeks;
    s.update({ segment: 1, target: 30.01, frozen: false, playing: true, next: null });
    expect(s.current()).toBe(b);
    expect(b.seeks).toBe(bSeeks);
    expect(a.paused).toBe(true);
    // Arrêt sur image : vidéo en pause sur l'image figée.
    s.update({ segment: 1, target: 31, frozen: true, playing: true, next: null });
    expect(b.paused).toBe(true);
    expect(b.currentTime).toBe(31);
  });
});

describe('compositeur : aplats posés sur le tampon source AVANT toute copie', () => {
  type Call = { canvas: string; op: string; args: unknown[] };
  function recorder() {
    const calls: Call[] = [];
    const make = (name: string, w: number, h: number): CanvasLike => {
      const c = {
        width: w,
        height: h,
        getContext: () =>
          new Proxy(
            {},
            {
              get: (_t, op: string) => {
                if (
                  [
                    'save',
                    'restore',
                    'fillRect',
                    'drawImage',
                    'clearRect',
                    'beginPath',
                    'rect',
                    'clip',
                    'fillText',
                    'strokeText',
                  ].includes(op)
                ) {
                  return (...args: unknown[]) => calls.push({ canvas: name, op, args });
                }
                if (op === 'measureText') return () => ({ width: 10 });
                return undefined;
              },
              set: () => true,
            },
          ) as unknown as CanvasRenderingContext2D,
      };
      return c;
    };
    let k = 0;
    const names = ['source', 'work', 'tmp'];
    const out = make('out', 540, 960);
    const comp = new Compositor(out, (w, h) => make(names[k++] ?? `x${k}`, w, h));
    return { calls, comp };
  }

  it('chaque aplat est dessiné sur le tampon source avant que les calques n’en soient copiés', () => {
    const base = fixtureV2();
    const d = {
      ...base,
      masks: [
        ...base.masks,
        {
          id: 'zz',
          rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          label: '',
          mode: 'opaque' as const,
          srcRange: { srcStartMs: 100_000, srcEndMs: 200_000 },
        },
      ],
    };
    const scene = sceneAt(d, 1000 as EditMs, {
      src: { width: 1920, height: 1080 },
      out: { width: 540, height: 960 },
      allowedAudioIndexes: [1],
      allowedCaptionRoles: ['mic'],
    });
    expect(scene.masks).toHaveLength(2);
    const { calls, comp } = recorder();
    comp.render({
      scene,
      video: {} as CanvasImageSource,
      videoSize: { width: 960, height: 540 },
      src: { width: 1920, height: 1080 },
      captions: [],
      overlays: [],
      globalStyle: d.captions.style,
      facecamZoom: 1,
    });
    const firstVideo = calls.findIndex((c) => c.canvas === 'source' && c.op === 'drawImage');
    const maskFills = calls
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.canvas === 'source' && c.op === 'fillRect');
    const firstCopy = calls.findIndex((c) => c.canvas === 'work' && c.op === 'drawImage');
    expect(firstVideo).toBeGreaterThanOrEqual(0);
    expect(maskFills).toHaveLength(2);
    expect(maskFills.every(([, i]) => i > firstVideo && i < firstCopy)).toBe(true);
    // Rectangles du proxy : élargis vers l'extérieur (jamais moins masqué).
    expect(maskFills[1]![0].args).toEqual([96, 54, 96, 54]);
  });

  it('pendant un vide : aucune image source n’est dessinée (fond seul)', () => {
    const d = withSegments([
      src('a', 110_000, 115_000),
      { id: 'g', kind: 'gap', editDurMs: 1000 },
      src('b', 120_000, 125_000),
    ]);
    const scene = sceneAt(d, 5_500 as EditMs, {
      src: { width: 1920, height: 1080 },
      out: { width: 540, height: 960 },
      allowedAudioIndexes: [1],
      allowedCaptionRoles: ['mic'],
    });
    const { calls, comp } = recorder();
    comp.render({
      scene,
      video: {} as CanvasImageSource,
      videoSize: { width: 960, height: 540 },
      src: { width: 1920, height: 1080 },
      captions: [],
      overlays: [],
      globalStyle: d.captions.style,
      facecamZoom: 1,
    });
    expect(calls.some((c) => c.canvas === 'source')).toBe(false);
  });

  it('rectangle source → proxy, arrondi vers l’extérieur', () => {
    expect(
      toProxyRect(
        { x: 1, y: 1, w: 3, h: 3 },
        { width: 1920, height: 1080 },
        { width: 960, height: 540 },
      ),
    ).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });
});

describe('formes d’onde, brouillon, sous-titres de l’aperçu', () => {
  it('forme d’onde .dat : en-tête vérifié, crête sur une plage', () => {
    const buf = new ArrayBuffer(20 + 8);
    const v = new DataView(buf);
    v.setInt32(0, 1, true);
    v.setUint32(4, 1, true);
    v.setInt32(8, 48_000, true);
    v.setInt32(12, 480, true);
    v.setUint32(16, 4, true);
    new Int8Array(buf, 20).set([-10, 10, -64, 64, -128, 127, 0, 0]);
    const w = parseWaveform(buf);
    expect(w.length).toBe(4);
    expect(waveformPeak(w, 0, 20)).toBeCloseTo(64 / 128);
    expect(waveformPeak(w, 20, 30)).toBe(1);
    expect(() => parseWaveform(new ArrayBuffer(4))).toThrow();
  });

  it('IndexedDB absent (navigation privée) : repli en mémoire signalé', async () => {
    const d = await openDrafts(undefined);
    expect(d.persistent).toBe(false);
    expect(memoryDrafts().persistent).toBe(false);
  });

  it('aperçu : seuls les textes du serveur (pseudonymisés) sont affichés ; positions recalculées sur le montage affiché', () => {
    const d = fixtureV2();
    const item = d.captions.items.find((i) => i.speakerRole === 'mic' && i.srcStartMs >= 110_000)!;
    const texts = {
      version: 1,
      items: [
        {
          itemId: item.id,
          speakerRole: 'mic' as const,
          originalText: 'x',
          text: 'TEXTE SERVEUR',
          corrected: false,
          replacements: 0,
          editRanges: [],
        },
      ],
      manual: {},
      overlays: {},
    };
    const lines = previewCaptions(d, texts, ['mic']);
    expect(lines.map((l) => l.text)).toEqual(['TEXTE SERVEUR']);
    expect(lines[0]!.startMs).toBe(item.srcStartMs - 110_000);
    // Sans textes du serveur : rien (jamais le texte brut).
    expect(previewCaptions(d, null, ['mic'])).toEqual([]);
    // Source non autorisée aujourd'hui : rien.
    expect(previewCaptions(d, texts, [])).toEqual([]);
    void placeSegments(segmentsV2(d.segments));
  });
});
