import { describe, expect, it } from 'vitest';
import { totalEditDuration } from '../time';
import { imageOverlayPlacements, overlayPixelRect, sfxPlacements } from './media';
import { applyBatch, type Operation } from './ops';
import { segmentsV2, type ClipProjectV2, type Overlay, type Sfx } from './schema';
import { fixtureV2 } from './test-fixtures';

const IMG = 'b'.repeat(64);
const SND = 'a'.repeat(64);
const ctx = { allowedAudioIndexes: [1], allowedCaptionRoles: ['mic' as const] };
// Montage : [110–115 s] [arrêt 1,5 s sur 115 s] [115–120 s] [vide 3 s] [125–133,8 s]
const cuts: Operation[] = [
  { type: 'splitSegment', segmentId: 'seg-0', atSrcMs: 120_000, newId: 'b' },
  { type: 'splitSegment', segmentId: 'b', atSrcMs: 125_000, newId: 'c' },
  { type: 'liftDelete', segmentId: 'b', gapId: 'gap' },
  {
    type: 'insertFreeze',
    segmentId: 'seg-0',
    atSrcMs: 115_000,
    freezeId: 'f',
    newId: 'a2',
    editDurMs: 1_500,
  },
];
const edited = applyBatch(fixtureV2(), cuts, ctx).doc;

const sfx = (s: Partial<Sfx>): Sfx => ({
  id: 's',
  assetId: SND,
  timing: { anchor: 'edit', from: 'start', offsetMs: 1000, durMs: 10_000 },
  gainDb: -6,
  ...s,
});
const withSfx = (d: ClipProjectV2, list: Sfx[]): ClipProjectV2 => ({
  ...d,
  audio: { ...d.audio, sfx: list },
});

describe('effets sonores : placement partagé aperçu / export', () => {
  it('ancré au montage : joué une fois à son instant, borné à la durée du son', () => {
    expect(sfxPlacements(withSfx(edited, [sfx({})]), { [SND]: 800 })).toEqual([
      { id: 's', assetId: SND, editStartMs: 1000, editEndMs: 1800, offsetMs: 0, gainDb: -6 },
    ]);
  });

  it('ancré au contenu : suit les coupes (reprise à la bonne position), silence pendant l’arrêt sur image et le vide', () => {
    // Son de 10 s ancré sur 114–124 s (source) : 114–115 s → montage 4–5 s ; arrêt (silence) ;
    // 115–120 s → montage 6,5–11,5 s, reprise à 1 s dans le son ; 120–124 s coupé (vide).
    const d = withSfx(edited, [
      sfx({ timing: { anchor: 'source', srcStartMs: 114_000, srcEndMs: 124_000 } }),
    ]);
    expect(sfxPlacements(d, { [SND]: 10_000 })).toEqual([
      { id: 's', assetId: SND, editStartMs: 4000, editEndMs: 5000, offsetMs: 0, gainDb: -6 },
      { id: 's', assetId: SND, editStartMs: 6500, editEndMs: 11_500, offsetMs: 1000, gainDb: -6 },
    ]);
  });

  it('durée inconnue (média manquant) : rien n’est joué ; export sans son : aucun effet sonore', () => {
    expect(sfxPlacements(withSfx(edited, [sfx({})]), {})).toEqual([]);
    const silent = withSfx({ ...edited, audio: { ...edited.audio, silent: true } }, [sfx({})]);
    expect(sfxPlacements(silent, { [SND]: 800 })).toEqual([]);
  });

  it('jamais au-delà de la fin du clip', () => {
    const total = totalEditDuration(segmentsV2(edited.segments));
    const d = withSfx(edited, [
      sfx({ timing: { anchor: 'edit', from: 'end', offsetMs: 0, durMs: 500 } }),
    ]);
    const [p] = sfxPlacements(d, { [SND]: 5000 });
    expect(p).toMatchObject({ editStartMs: total - 500, editEndMs: total });
  });
});

describe('calques image : plages et cadre en pixels', () => {
  const ov = (o: Partial<Overlay>): Overlay => ({
    id: 'o',
    kind: 'image',
    assetId: IMG,
    text: null,
    timing: { anchor: 'source', srcStartMs: 114_000, srcEndMs: 116_000 },
    frame: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
    opacity: 1,
    z: 0,
    ...o,
  });

  it('ancré au contenu : visible pendant l’arrêt sur image (image figée), coupé avec le contenu ; tri par empilement', () => {
    const d: ClipProjectV2 = {
      ...edited,
      overlays: [
        ov({ id: 'haut', z: 2 }),
        ov({ id: 'bas', z: 1, timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 500 } }),
        { ...ov({ id: 'texte', kind: 'text', assetId: null }), text: 'Salut' },
      ],
    };
    expect(imageOverlayPlacements(d).map((p) => [p.id, p.startMs, p.endMs])).toEqual([
      ['bas', 0, 500],
      ['haut', 4000, 5000],
      ['haut', 5000, 6500],
      ['haut', 6500, 7500],
    ]);
  });

  it('cadre normalisé → pixels : arrondi commun, au moins 1 px, jamais hors de l’image', () => {
    expect(overlayPixelRect({ x: 0.7, y: 0, w: 0.3, h: 0.1 }, 540, 960)).toEqual({
      x: 378,
      y: 0,
      w: 162,
      h: 96,
    });
    expect(overlayPixelRect({ x: 0.7, y: 0, w: 0.3, h: 0.1 }, 1080, 1920)).toEqual({
      x: 756,
      y: 0,
      w: 324,
      h: 192,
    });
    expect(overlayPixelRect({ x: 0.9999, y: 0, w: 0.0001, h: 0.0001 }, 540, 960)).toEqual({
      x: 539,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});
