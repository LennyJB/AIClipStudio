import { describe, expect, it } from 'vitest';
import { presetLayers } from '../geometry';
import { applyBatch, type Operation } from './ops';
import { automationGainDb, sceneAt } from './scene';
import { fixtureV2 } from './test-fixtures';

const o = {
  src: { width: 1920, height: 1080 },
  out: { width: 1080, height: 1920 },
  allowedAudioIndexes: [1],
  allowedCaptionRoles: ['mic' as const],
};
const base = fixtureV2();
// Montage : [110–115 s] [arrêt 1,5 s sur 115 s] [115–120 s] [vide 3 s] [125–133,8 s]
const ops: Operation[] = [
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
  { type: 'setMode', mode: 'enrichi' },
  {
    type: 'setEntity',
    collection: 'mask',
    entity: {
      id: 'tm',
      rect: { x: 0, y: 0, w: 0.25, h: 0.25 },
      label: 'Pseudo',
      mode: 'opaque',
      srcRange: { srcStartMs: 114_000, srcEndMs: 116_000 },
    },
  },
  {
    type: 'setEntity',
    collection: 'sfx',
    entity: {
      id: 'boom',
      assetId: 'b'.repeat(64),
      timing: { anchor: 'source', srcStartMs: 114_500, srcEndMs: 115_500 },
      gainDb: 0,
    },
  },
  {
    type: 'setEntity',
    collection: 'overlay',
    entity: {
      id: 'titre',
      kind: 'text',
      assetId: null,
      text: 'Fin',
      timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 30_000 },
      frame: { x: 0, y: 0, w: 1, h: 0.1 },
      opacity: 1,
      z: 3,
    },
  },
  {
    type: 'setEntity',
    collection: 'effect',
    entity: {
      id: 'flou',
      type: 'blur_region',
      params: { sigma: 10 },
      region: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      timing: { anchor: 'source', srcStartMs: 110_000, srcEndMs: 134_000 },
      enabled: true,
      origin: 'creator',
      reason: '',
      signals: {},
    },
  },
];
const d = applyBatch(base, ops).doc;
const at = (t: number) => sceneAt(d, t, o);

describe('scène : arrêt sur image', () => {
  it('image figée avec les aplats de l’instant figé ; silence des pistes de l’enregistrement', () => {
    const s = at(5_500); // dans l'arrêt (5 000–6 500 ms)
    expect(s.position).toEqual({ kind: 'source', srcMs: 115_000, segmentId: 'f', frozen: true });
    expect(s.layers.length).toBeGreaterThan(0);
    expect(s.masks).toHaveLength(2); // masque du profil + masque temporel actif à 115 s
    expect(s.audio.sourceAudible).toBe(false);
    expect(s.audio.tracks).toEqual([]);
  });

  it('effet sonore ancré au contenu : joué une seule fois, pas pendant l’arrêt', () => {
    expect(at(4_600).audio.sfxIds).toEqual(['boom']); // 114,6 s, avant l'arrêt
    expect(at(5_500).audio.sfxIds).toEqual([]); // pendant l'arrêt
  });

  it('élément ancré au montage : continue pendant l’arrêt ; sous-titre de l’instant figé : affiché figé', () => {
    const s = at(5_500);
    expect(s.overlayIds).toEqual(['titre']);
    const frozenCaption = d.captions.items.find(
      (i) => i.speakerRole === 'mic' && i.srcStartMs <= 115_000 && 115_000 < i.srcEndMs,
    );
    if (frozenCaption) expect(s.captionIds).toContain(frozenCaption.id);
  });
});

describe('scène : vide (suppression sans décalage)', () => {
  it('fond seul : aucun calque source, aucun aplat nécessaire, silence, aucun élément ancré au contenu', () => {
    const s = at(12_000); // vide : 11 500–14 500 ms
    expect(s.position).toEqual({ kind: 'gap', segmentId: 'gap' });
    expect(s.layers).toEqual([]);
    expect(s.masks).toEqual([]);
    expect(s.background).toBe('#000000');
    expect(s.captionIds).toEqual([]);
    expect(s.effects).toEqual([]); // le flou localisé n'a pas d'image source à traiter
    expect(s.audio).toEqual({ sourceAudible: false, tracks: [], sfxIds: [] });
    expect(s.overlayIds).toEqual(['titre']); // ancré au montage : continue
  });

  it('hors du clip : position null', () => {
    expect(at(1_000_000).position).toBeNull();
  });
});

describe('scène : masques, effets, audio, géométrie', () => {
  it('aplats opaques seulement ; un masque désactivé n’est jamais dessiné et reste signalé', () => {
    const off = applyBatch(d, [
      {
        type: 'setEntity',
        collection: 'mask',
        entity: { ...d.masks.find((m) => m.id === 'tm')!, mode: 'off' },
        acknowledgeMaskRisk: true,
      },
    ]).doc;
    const s = sceneAt(off, 4_500, o);
    expect(s.masks).toHaveLength(1);
    expect(s.disabledMaskIds).toEqual(['tm']);
  });

  it('blur_region : effet créatif, listé dans les effets (appliqué après les aplats), jamais dans les masques', () => {
    const s = at(1_000);
    expect(s.effects.map((e) => e.type)).toEqual(['blur_region']);
    expect(s.masks).toHaveLength(1);
  });

  it('pistes : seules les pistes autorisées et activées sont audibles ; export sans son : aucune', () => {
    expect(at(1_000).audio.tracks).toEqual([{ audioIndex: 1, gainDb: 0 }]);
    expect(sceneAt(d, 1_000, { ...o, allowedAudioIndexes: [] }).audio.tracks).toEqual([]);
    const silent = applyBatch(d, [{ type: 'setAudioConfig', silent: true }]).doc;
    expect(sceneAt(silent, 1_000, o).audio).toEqual({
      sourceAudible: false,
      tracks: [],
      sfxIds: [],
    });
  });

  it('automatisation du gain : linéaire entre les points, constante aux bords', () => {
    const pts = [
      { srcMs: 1_000, gainDb: 0 },
      { srcMs: 2_000, gainDb: -10 },
    ];
    expect(automationGainDb([], 5)).toBe(0);
    expect(automationGainDb(pts, 0)).toBe(0);
    expect(automationGainDb(pts, 1_500)).toBe(-5);
    expect(automationGainDb(pts, 9_000)).toBe(-10);
  });

  it('géométrie : calques identiques à presetLayers (même calcul que le graphe FFmpeg)', () => {
    expect(at(1_000).layers).toEqual(
      presetLayers({ ...d.layout, preset: 'facecam_top' }, o.src, o.out).sort((a, b) => a.z - b.z),
    );
  });
});

describe('scène : autorisations explicites (sous-titres et audio)', () => {
  // Discord était autorisé : ses sous-titres sont dans le document.
  const withDiscord = applyBatch(
    base,
    [{ type: 'setCaptionsConfig', sources: ['mic', 'discord'] }],
    { allowedCaptionRoles: ['mic', 'discord'] },
  ).doc;
  const discordItem = withDiscord.captions.items.find(
    (i) => i.speakerRole === 'discord' && i.srcStartMs >= 111_000,
  )!;
  // Instant montage où la ligne Discord est affichée (segment unique : 110 s → 0 ms).
  const t = discordItem.srcStartMs - 110_000 + 50;

  it('Discord autorisé : ses sous-titres sont affichés', () => {
    const s = sceneAt(withDiscord, t, { ...o, allowedCaptionRoles: ['mic', 'discord'] });
    expect(s.captionIds).toContain(discordItem.id);
  });

  it('accord Discord révoqué : ses sous-titres disparaissent, même si le document les contient encore', () => {
    const s = sceneAt(withDiscord, t, { ...o, allowedCaptionRoles: ['mic'] });
    expect(withDiscord.captions.sources).toContain('discord');
    expect(s.captionIds).not.toContain(discordItem.id);
    expect(
      s.captionIds.every(
        (id) => withDiscord.captions.items.find((i) => i.id === id)?.speakerRole !== 'discord',
      ),
    ).toBe(true);
    // Aucune source autorisée : aucun sous-titre issu d'une piste.
    expect(sceneAt(withDiscord, t, { ...o, allowedCaptionRoles: [] }).captionIds).toEqual([]);
  });

  it('sous-titres manuels (écrits par le créateur) : indépendants des accords de voix', () => {
    const manual = applyBatch(withDiscord, [
      {
        type: 'setEntity',
        collection: 'manual',
        entity: {
          id: 'man-1',
          origin: 'creator',
          text: 'GG',
          srcStartMs: 111_000,
          srcEndMs: 112_000,
          style: null,
          position: null,
        },
      },
    ]).doc;
    expect(sceneAt(manual, 1_500, { ...o, allowedCaptionRoles: [] }).captionIds).toEqual(['man-1']);
  });

  it('audio : aucune piste autorisée par défaut ; liste vide = aucune piste', () => {
    const s = sceneAt(base, 1_000, { ...o, allowedAudioIndexes: [] });
    expect(s.audio.tracks).toEqual([]);
  });
});

describe('scène : sourceAudible cohérent avec les pistes réellement jouées', () => {
  it('vrai seulement si au moins une piste autorisée ET activée est jouée', () => {
    expect(sceneAt(base, 1_000, o).audio).toMatchObject({
      sourceAudible: true,
      tracks: [{ audioIndex: 1 }],
    });
  });

  it('faux si la seule piste n’est plus autorisée (accord révoqué)', () => {
    expect(sceneAt(base, 1_000, { ...o, allowedAudioIndexes: [] }).audio).toEqual({
      sourceAudible: false,
      tracks: [],
      sfxIds: [],
    });
  });

  it('faux si la seule piste autorisée est retirée du montage', () => {
    const off = applyBatch(base, [{ type: 'setTrack', audioIndex: 1, enabled: false }]).doc;
    expect(sceneAt(off, 1_000, o).audio.sourceAudible).toBe(false);
  });

  it('faux si le projet n’a aucune piste audio', () => {
    const none = { ...base, audio: { ...base.audio, tracks: [] } };
    expect(sceneAt(none, 1_000, o).audio.sourceAudible).toBe(false);
  });
});
