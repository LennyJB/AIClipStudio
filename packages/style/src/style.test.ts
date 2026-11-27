import { describe, expect, it } from 'vitest';
import { migrateV1ToV2, projectFromProposal, type ClipProjectV2 } from '@acs/timeline';
import {
  FEATURE_KEYS,
  STYLE_FEATURES,
  StyleFeaturesSchema,
  alignShots,
  dominantContentType,
  editFeatures,
  editorObservation,
  learnFeatures,
  pairObservation,
  pairStructure,
  projectDefaults,
  referenceObservation,
  selectProfile,
  shotsFromCuts,
  suggestFeatures,
  type Envelope,
  type ReferenceMeasures,
  type StyleObservation,
} from './index';

const MIN = 60_000;

const measures = (over: Partial<ReferenceMeasures> = {}): ReferenceMeasures => ({
  durationMs: 60_000,
  width: 1080,
  height: 1920,
  cutsMs: [2000, 4000, 6500, 9000, 12_000, 20_000, 30_000, 31_000, 45_000],
  blacks: [],
  freezes: [],
  loudness: { integratedLufs: -14.2, rangeLu: 5.1 },
  silences: [[50_000, 53_000]],
  ...over,
});

describe('catalogue : honnêteté sur ce qui est mesurable', () => {
  it('une référence ne mesure ni sous-titres, ni facecam, ni zooms, ni effets, ni musique', () => {
    for (const k of FEATURE_KEYS) {
      const g = STYLE_FEATURES[k].group;
      const byRef = (STYLE_FEATURES[k].measuredBy as readonly string[]).includes('reference');
      if (['sous_titres', 'cadrage', 'zooms', 'effets'].includes(g)) expect(byRef, k).toBe(false);
    }
    expect(STYLE_FEATURES['audio.musicBed'].measuredBy).toEqual([]);
    for (const k of FEATURE_KEYS) {
      // Toute caractéristique qu'une vidéo de référence ne mesure pas l'explique à l'écran.
      if (!(STYLE_FEATURES[k].measuredBy as readonly string[]).includes('reference'))
        expect((STYLE_FEATURES[k] as { note?: string }).note ?? '', k).not.toBe('');
    }
  });

  it('apprentissage : une valeur fournie par une source incapable de la mesurer est ignorée', () => {
    const fake: StyleObservation = {
      source: 'reference',
      sourceId: 'r1',
      values: { 'sous_titres.font': 'Inter', 'zooms.perMinute': 4, 'audio.musicBed': 'presente' },
    };
    expect(learnFeatures([fake])).toEqual({});
  });

  it('schéma strict : clé inconnue, valeur hors bornes ou source incapable refusées', () => {
    const ok = {
      'rythme.cutsPerMinute': { value: 9, origin: 'learned', samples: 1, sources: ['reference'] },
    };
    expect(StyleFeaturesSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { inconnu: { value: 1, origin: 'manual', samples: 0, sources: [] } },
      { 'rythme.cutsPerMinute': { value: 999, origin: 'manual', samples: 0, sources: [] } },
      {
        'sous_titres.font': {
          value: 'Inter',
          origin: 'learned',
          samples: 1,
          sources: ['reference'],
        },
      },
      { 'sous_titres.color': { value: 'rouge', origin: 'manual', samples: 0, sources: [] } },
    ]) {
      expect(StyleFeaturesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('observation d’une vidéo de référence', () => {
  it('rythme, format, sonie, silences ; seulement des grandeurs (aucun instant conservé)', () => {
    const o = referenceObservation('ref-1', measures());
    expect(o.values).toMatchObject({
      'format.durationMs': 60_000,
      'format.vertical': true,
      'rythme.cutsPerMinute': 9,
      'audio.loudnessLufs': -14.2,
      'audio.loudnessRangeLu': 5.1,
      'audio.silenceShare': 0.05,
      'transitions.fadesToBlackPerMinute': 0,
    });
    expect(o.values['rythme.shotMedianMs']).toBeGreaterThan(2000);
    expect(Object.values(o.values).every((v) => typeof v !== 'object')).toBe(true);
    expect(o.values['sous_titres.font']).toBeUndefined();
  });

  it('fondus au noir : transitions, pas des plans ; écran noir final ignoré', () => {
    const m = measures({
      cutsMs: [10_000, 10_400, 30_000, 59_000],
      blacks: [
        [10_000, 10_400],
        [59_000, 60_000],
      ],
    });
    expect(shotsFromCuts(m)).toEqual([10_000, 19_600, 29_000]);
    expect(referenceObservation('r', m).values['transitions.fadesToBlackPerMinute']).toBe(1);
  });

  it('vidéo muette : aucune caractéristique sonore inventée', () => {
    const o = referenceObservation('r', measures({ loudness: null, silences: [] }));
    expect(o.values['audio.loudnessLufs']).toBeUndefined();
    expect(o.values['audio.silenceShare']).toBeUndefined();
  });
});

/** Enveloppe pseudo-aléatoire déterministe (pas de motif périodique). */
function envelope(seconds: number, seed = 7): Envelope {
  const db = new Float32Array(seconds * 20);
  let x = seed;
  let level = -30;
  for (let i = 0; i < db.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    if (i % 3 === 0) level = -50 + (x % 45);
    db[i] = level;
  }
  return { rateHz: 20, db };
}
const slice = (e: Envelope, fromS: number, toS: number) => e.db.slice(fromS * 20, toS * 20);
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('paire brut + montage : alignement sonore', () => {
  const raw = envelope(300);
  // Montage : 5–9 s, 20–23 s puis 23–26 s (raccord continu, changement de plan), 100–106 s, 40–44 s.
  const edited: Envelope = {
    rateHz: 20,
    db: concat(
      slice(raw, 5, 9),
      slice(raw, 20, 23),
      slice(raw, 23, 26),
      slice(raw, 100, 106),
      slice(raw, 40, 44),
    ),
  };
  const shots = [
    { startMs: 0, endMs: 4000 },
    { startMs: 4000, endMs: 7000 },
    { startMs: 7000, endMs: 10_000 },
    { startMs: 10_000, endMs: 16_000 },
    { startMs: 16_000, endMs: 20_000 },
  ];

  it('retrouve chaque plan dans le brut, distingue coupes éditoriales et raccords continus', () => {
    const m = alignShots(edited, raw, shots);
    expect(m.map((x) => x.rawStartMs)).toEqual([5000, 20_000, 23_000, 100_000, 40_000]);
    const s = pairStructure(m);
    expect(s).toMatchObject({
      alignedShots: 5,
      editorialCuts: 3, // 9→20, 26→100, 106→40
      continuousCuts: 1, // 23 → 23 : la scène filmée change, pas le montage
      reordered: 1, // 106 → 40 : retour en arrière
      keptMs: 20_000,
    });
    const obs = pairObservation('p', measures({ durationMs: 20_000 }), s);
    expect(obs.structureReliable).toBe(true);
    expect(obs.values['rythme.editorialCutsPerMinute']).toBe(9);
    expect(obs.values['rythme.keptRatio']).toBeCloseTo(20_000 / 101_000, 3);
  });

  it('plan muet ou sans correspondance : non aligné ; trop peu d’alignés ⇒ aucune structure déduite', () => {
    const silent = new Float32Array(80).fill(-60);
    const other = envelope(10, 99).db;
    const ed: Envelope = { rateHz: 20, db: concat(silent, other) };
    const m = alignShots(ed, raw, [
      { startMs: 0, endMs: 4000 },
      { startMs: 4000, endMs: 14_000 },
    ]);
    expect(m.map((x) => x.rawStartMs)).toEqual([null, null]);
    const obs = pairObservation('p', measures(), pairStructure(m));
    expect(obs.structureReliable).toBe(false);
    expect(obs.values['rythme.keptRatio']).toBeUndefined();
    expect(obs.values['rythme.editorialCutsPerMinute']).toBeUndefined();
  });
});

function project(): ClipProjectV2 {
  const { project: v1 } = projectFromProposal({
    proposal: {
      id: 'p1',
      runId: 'r1',
      recordingId: 'rec',
      momentId: null,
      srcStartMs: 10_000,
      srcEndMs: 70_000,
      punchlineMs: 40_000,
      setupStartMs: 10_000,
      reactionEndMs: 70_000,
      editingMode: null,
    },
    source: {
      fingerprint: 'fp',
      durationMs: 600_000,
      width: 1920,
      height: 1080,
      fps: 30,
      container: 'mkv',
      integrityManifestId: 'm1',
    },
    framing: {
      id: 'f',
      hash: 'h',
      gameplay: { x: 0, y: 0, w: 1, h: 1 },
      facecam: { x: 0, y: 0, w: 0.2, h: 0.2 },
      masks: [],
    },
    words: [],
    audio: { tracks: [], captionRoles: [] },
    defaults: { mode: 'fidele', minMs: 20_000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
  });
  return migrateV1ToV2(v1, { manifestWindow: { srcStartMs: 0, srcEndMs: 600_000 } });
}

describe('observation de l’éditeur (décisions exactes)', () => {
  it('découpage, sous-titres, facecam, zooms, effets, sonie ; changements par rapport au document initial', () => {
    const initial = project();
    const doc: ClipProjectV2 = structuredClone(initial);
    doc.segments = [
      { id: 'a', kind: 'source', srcStartMs: 10_000, srcEndMs: 20_000, speed: 1 },
      { id: 'b', kind: 'source', srcStartMs: 25_000, srcEndMs: 35_000, speed: 1 },
      { id: 'c', kind: 'freeze', srcAtMs: 35_000, editDurMs: 1000 },
      { id: 'd', kind: 'source', srcStartMs: 35_000, srcEndMs: 44_000, speed: 1 },
    ];
    doc.captions.style = { ...doc.captions.style, font: 'Inter', uppercase: true };
    doc.captions.enabled = true;
    doc.effects = [
      {
        id: 'e1',
        type: 'punch_zoom',
        params: { factor: 1.2 },
        region: null,
        timing: { anchor: 'source', srcStartMs: 30_000, srcEndMs: 31_000 },
        enabled: true,
        origin: 'creator',
        reason: '',
        signals: {},
      },
    ];
    const o = editorObservation('proj', doc, initial);
    expect(o.source).toBe('editor');
    expect(o.values).toMatchObject({
      'format.durationMs': 30_000,
      'rythme.cutsPerMinute': 6,
      'rythme.editorialCutsPerMinute': 6, // saut 20→25, entrée et sortie de l'arrêt sur image : 3 en 30 s
      'transitions.freezesPerMinute': 2,
      'sous_titres.font': 'Inter',
      'sous_titres.uppercase': true,
      'cadrage.layoutPreset': 'facecam_top',
      'cadrage.facecamUsage': 1,
      'zooms.perMinute': 2,
      'zooms.factorMedian': 1.2,
      'audio.loudnessLufs': -14,
      'densite.mode': 'fidele',
    });
    expect(o.changed).toEqual(
      expect.arrayContaining(['sous_titres.font', 'sous_titres.uppercase', 'zooms.perMinute']),
    );
    expect(o.changed).not.toContain('cadrage.layoutPreset');
  });
});

describe('apprentissage et suggestions', () => {
  const obs = (cuts: number, font?: string): StyleObservation => ({
    source: 'editor',
    sourceId: `p${cuts}`,
    values: { 'rythme.cutsPerMinute': cuts, ...(font ? { 'sous_titres.font': font } : {}) },
  });

  it('médiane, dispersion, majorité, sources et nombre d’observations', () => {
    const f = learnFeatures([obs(4, 'Inter'), obs(6, 'Inter'), obs(20, 'Montserrat ExtraBold')]);
    expect(f['rythme.cutsPerMinute']).toMatchObject({
      value: 6,
      samples: 3,
      origin: 'learned',
      sources: ['editor'],
    });
    expect(f['sous_titres.font']).toMatchObject({ value: 'Inter', samples: 3, spread: 0.667 });
  });

  it('une valeur réglée à la main n’est JAMAIS remplacée ; le profil de départ n’est pas modifié', () => {
    const validated = editFeatures({}, { set: { 'sous_titres.font': 'Montserrat ExtraBold' } });
    const frozen = JSON.stringify(validated);
    const learned = learnFeatures([obs(8, 'Inter'), obs(10, 'Inter')]);
    const { features, changes } = suggestFeatures(validated, learned);
    expect(features['sous_titres.font']).toMatchObject({
      value: 'Montserrat ExtraBold',
      origin: 'manual',
    });
    expect(features['rythme.cutsPerMinute']).toMatchObject({ value: 9, origin: 'learned' });
    expect(changes.map((c) => c.key)).toEqual(['rythme.cutsPerMinute']);
    expect(JSON.stringify(validated)).toBe(frozen);
  });

  it('édition manuelle : valeurs validées par le catalogue ; retrait possible', () => {
    expect(() => editFeatures({}, { set: { 'sous_titres.sizePx': 500 } })).toThrow(/Taille/u);
    expect(() => editFeatures({}, { set: { inconnu: 1 } })).toThrow(/inconnue/u);
    const f = editFeatures({}, { set: { 'audio.musicBed': 'discrete' } });
    expect(f['audio.musicBed']).toMatchObject({ value: 'discrete', origin: 'manual' });
    expect(editFeatures(f, { clear: ['audio.musicBed'] })).toEqual({});
  });
});

describe('application aux projets : adaptation au passage', () => {
  const ref = (id: string, types: string[], at: string) => ({
    profileId: id,
    version: 1,
    contentTypes: types as never,
    validatedAt: at,
    features: {},
  });

  it('type majoritaire de l’extrait ; sans segmentation : gaming (hypothèse historique)', () => {
    const segs = [
      { startMs: 0, endMs: 60_000, type: 'gaming' as const },
      { startMs: 60_000, endMs: 200_000, type: 'just_chatting' as const },
    ];
    expect(dominantContentType(segs, { srcStartMs: 50_000, srcEndMs: 100_000 })).toBe(
      'just_chatting',
    );
    expect(dominantContentType(segs, { srcStartMs: 0, srcEndMs: 70_000 })).toBe('gaming');
    expect(dominantContentType(null, { srcStartMs: 0, srcEndMs: 10 })).toBe('gaming');
  });

  it('profil exact, sinon Mixte ; le plus récemment validé ; aucun : rien', () => {
    const profiles = [
      ref('g1', ['gaming'], '2026-01-01'),
      ref('g2', ['gaming'], '2026-02-01'),
      ref('mix', ['mixed'], '2026-01-15'),
    ];
    expect(selectProfile(profiles, 'gaming')?.profileId).toBe('g2');
    expect(selectProfile(profiles, 'podcast')?.profileId).toBe('mix');
    expect(selectProfile(profiles, 'unknown')?.profileId).toBe('mix');
    expect(selectProfile([ref('g1', ['gaming'], 'x')], 'irl')).toBeNull();
  });

  it('valeurs représentables appliquées ; rythme et effets restent des repères', () => {
    const f = editFeatures(
      {},
      {
        set: {
          'sous_titres.font': 'Inter',
          'sous_titres.uppercase': true,
          'cadrage.layoutPreset': 'gameplay_crop',
          'densite.mode': 'enrichi',
          'rythme.cutsPerMinute': 12,
          'zooms.perMinute': 3,
          'audio.loudnessLufs': -23,
        },
      },
    );
    const { defaults, hints } = projectDefaults(f);
    expect(defaults).toEqual({
      captionStyle: { font: 'Inter', uppercase: true },
      layoutPreset: 'gameplay_crop',
      mode: 'enrichi',
      loudnorm: false,
    });
    expect(hints).toEqual({ cutsPerMinute: 12, zoomsPerMinute: 3 });
  });

  it('création de projet : sans style, document strictement identique ; avec style, réglages bornés par le cadrage', () => {
    const base = project();
    expect(base.captions.style.font).toBe('Montserrat ExtraBold');
    // facecam_top demandé sans facecam validée : refusé (disposition par défaut conservée).
    const { project: v1 } = projectFromProposal({
      proposal: {
        id: 'p',
        runId: 'r',
        recordingId: 'rec',
        momentId: null,
        srcStartMs: 0,
        srcEndMs: 30_000,
        punchlineMs: 10_000,
        setupStartMs: 0,
        reactionEndMs: 30_000,
        editingMode: null,
      },
      source: {
        fingerprint: 'fp',
        durationMs: 60_000,
        width: 1920,
        height: 1080,
        fps: 30,
        container: 'mkv',
        integrityManifestId: 'm',
      },
      framing: null,
      words: [],
      audio: { tracks: [], captionRoles: [] },
      defaults: { mode: 'fidele', minMs: 20_000, maxMs: 80_000 },
      makeId: (k, i) => `${k}-${i}`,
      style: {
        layoutPreset: 'facecam_top',
        captionStyle: { font: 'Inter' },
        captionsEnabled: true,
        mode: 'enrichi',
        loudnorm: false,
      },
    });
    expect(v1.layout.preset).toBe('blurred_fit');
    expect(v1.captions.style.font).toBe('Inter');
    expect(v1.captions.enabled).toBe(false); // aucune piste autorisée : jamais de sous-titres
    expect(v1.mode).toBe('enrichi');
    expect(v1.audio.loudnorm.enabled).toBe(false);
  });
});

void MIN;
