import { describe, expect, it } from 'vitest';
import { displayCaptions, groupWords, type CaptionWord, type RoleWords } from './captions';
import {
  adjustBounds,
  applyRenderOptions,
  canonicalJson,
  ClipProjectSchema,
  durationAccepted,
  migrateProject,
  ProjectError,
  projectBounds,
  projectFromProposal,
  projectSegments,
  RenderOptionsPatchSchema,
  snapToWordBoundary,
  type CreateProjectInput,
  type PatchContext,
} from './project';

/** Mots réguliers : « motN » de 300 ms tous les 400 ms, entre from et to. */
function words(from: number, to: number, prefix = 'mot'): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (let t = from, i = 0; t + 300 <= to; t += 400, i++) {
    out.push({ text: ` ${prefix}${i}`, srcStartMs: t, srcEndMs: t + 300 });
  }
  return out;
}

const MIC: RoleWords = { role: 'mic', words: words(90_000, 150_000) };
const DSC: RoleWords = { role: 'discord', words: words(100_000, 140_000, 'coéquipier') };

function input(over: Partial<CreateProjectInput> = {}): CreateProjectInput {
  return {
    proposal: {
      id: 'p1',
      runId: 'run',
      recordingId: 'rec',
      momentId: 'm1',
      srcStartMs: 110_000,
      srcEndMs: 133_800,
      punchlineMs: 125_000,
      setupStartMs: 110_400,
      reactionEndMs: 133_000,
      editingMode: null,
    },
    source: {
      fingerprint: 'fp',
      durationMs: 600_000,
      width: 1920,
      height: 1080,
      fps: 60,
      container: 'matroska',
      integrityManifestId: 'man',
    },
    framing: {
      id: 'facecam',
      hash: 'h',
      gameplay: { x: 0, y: 0, w: 1, h: 1 },
      facecam: { x: 0.74, y: 0.7, w: 0.25, h: 0.28 },
      masks: [{ label: 'Fil', x: 0.72, y: 0.04, w: 0.27, h: 0.2 }],
    },
    words: [MIC, DSC],
    audio: { tracks: [{ audioIndex: 1, role: 'mic' }], captionRoles: ['mic'] },
    defaults: { mode: 'fidele', minMs: 20_000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
    ...over,
  };
}

const ctx = (over: Partial<PatchContext> = {}): PatchContext => ({
  nextRevision: 2,
  now: '2026-11-24T10:00:00.000Z',
  words: [...MIC.words, ...DSC.words],
  allowedCaptionRoles: ['mic'],
  allowedAudioIndexes: [1],
  ...over,
});

describe('projectFromProposal', () => {
  it('crée un document valide : bornes de la proposition, repères, facecam, masques opaques', () => {
    const { project, warnings } = projectFromProposal(input());
    expect(ClipProjectSchema.parse(project)).toEqual(project);
    expect(project.segments).toEqual([
      { id: 'seg-0', kind: 'source', srcStartMs: 110_000, srcEndMs: 133_800, speed: 1 },
    ]);
    expect(project.anchors).toEqual({
      setupStartMs: 110_400,
      punchlineMs: 125_000,
      reactionEndMs: 133_000,
    });
    expect(project.layout.preset).toBe('facecam_top');
    expect(project.layout.masks).toEqual([
      { rect: { x: 0.72, y: 0.04, w: 0.27, h: 0.2 }, label: 'Fil', mode: 'opaque' },
    ]);
    expect(project.mode).toBe('fidele');
    expect(project.audio.loudnorm).toEqual({ enabled: true, targetLufs: -14 });
    expect(project.effects).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('micro par défaut : Discord jamais activé à la création, même autorisé', () => {
    const { project } = projectFromProposal(
      input({
        audio: { tracks: [{ audioIndex: 1, role: 'mic' }], captionRoles: ['mic', 'discord'] },
      }),
    );
    expect(project.captions.sources).toEqual(['mic']);
    // Les lignes Discord sont préparées (pour une activation ultérieure) mais pas affichées.
    expect(project.captions.items.some((i) => i.speakerRole === 'discord')).toBe(true);
  });

  it('sous-titres préparés sur la fenêtre ±10 s, sans chevauchement par locuteur', () => {
    const { project } = projectFromProposal(input());
    const mic = project.captions.items.filter((i) => i.speakerRole === 'mic');
    expect(mic[0]!.srcStartMs).toBeGreaterThanOrEqual(100_000);
    expect(mic.at(-1)!.srcEndMs).toBeLessThanOrEqual(143_800);
    for (let i = 1; i < mic.length; i++)
      expect(mic[i]!.srcStartMs).toBeGreaterThanOrEqual(mic[i - 1]!.srcEndMs);
  });

  it('sans cadrage validé : plein cadre flouté et avertissement', () => {
    const { project, warnings } = projectFromProposal(input({ framing: null }));
    expect(project.layout.preset).toBe('blurred_fit');
    expect(project.layout.masks).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain('FRAMING_NOT_VALIDATED');
  });

  it('mode issu de editingHint, sinon du profil créateur', () => {
    const p = input();
    expect(
      projectFromProposal({ ...p, proposal: { ...p.proposal, editingMode: 'enrichi' } }).project
        .mode,
    ).toBe('enrichi');
  });

  it('durée hors plage effective : avertissement ; hors 5–180 s : refus', () => {
    const p = input();
    const short = projectFromProposal({ ...p, proposal: { ...p.proposal, srcEndMs: 120_000 } });
    expect(short.warnings.map((w) => w.code)).toContain('DURATION_OUT_OF_RANGE');
    expect(() =>
      projectFromProposal({ ...p, proposal: { ...p.proposal, srcEndMs: 113_000 } }),
    ).toThrow(ProjectError);
    expect(() =>
      projectFromProposal({ ...p, proposal: { ...p.proposal, srcEndMs: 300_000 } }),
    ).toThrow(/limites absolues/);
  });

  it('aucune piste exportable : avertissement explicite', () => {
    const { warnings } = projectFromProposal(input({ audio: { tracks: [], captionRoles: [] } }));
    expect(warnings.map((w) => w.code)).toEqual(['NO_CAPTIONS', 'AUDIO_UNAVAILABLE']);
  });

  it('empreinte stable : JSON canonique indépendant de l’ordre des clés', () => {
    const { project } = projectFromProposal(input());
    const shuffled = JSON.parse(JSON.stringify(project, Object.keys(project).reverse())) as unknown;
    expect(canonicalJson(project)).toBe(
      canonicalJson(migrateProject(JSON.parse(canonicalJson(project)))),
    );
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    expect(typeof shuffled).toBe('object');
  });

  it('migrateProject refuse une version inconnue', () => {
    expect(() => migrateProject({ schemaVersion: 2 })).toThrow(/Version de document inconnue/);
  });
});

describe('ajustement des bornes (±10 s, calage sur les mots)', () => {
  const base = () => projectFromProposal(input()).project;
  const allWords = [...MIC.words, ...DSC.words];

  it('cale sur la frontière de mot la plus proche', () => {
    // 112 150 tombe dans le mot [112 000, 112 300] (micro) : calé sur 112 000 ou 112 300.
    const r = adjustBounds(base(), { startMs: 112_150 }, allWords);
    expect([112_000, 112_300]).toContain(r.snapped.startMs);
    expect(r.snapped.endMs).toBe(133_800);
  });

  it('refuse au-delà de ±10 s et hors 5–180 s', () => {
    expect(() => adjustBounds(base(), { startMs: 99_999 }, allWords)).toThrow(/±10 s/);
    expect(() => adjustBounds(base(), { endMs: 143_801 }, allWords)).toThrow(/±10 s/);
    expect(() => adjustBounds(base(), { startMs: 120_000, endMs: 124_000 }, allWords)).toThrow(
      /limites absolues/,
    );
  });

  it('alerte si le contexte ou la réaction risquent d’être coupés', () => {
    const r = adjustBounds(base(), { startMs: 115_000, endMs: 130_000 }, []);
    expect(r.warnings.map((w) => w.code)).toEqual(['CONTEXT_MAY_BE_CUT', 'REACTION_MAY_BE_CUT']);
  });

  it('un mot trop long pour être calé est signalé, pas coupé silencieusement', () => {
    const long = [{ srcStartMs: 108_000, srcEndMs: 116_000 }];
    const r = snapToWordBoundary(112_000, long, { min: 100_000, max: 143_800 });
    expect(r).toEqual({ ms: 112_000, cut: true });
  });

  it('toute modification des bornes annule une confirmation de durée', () => {
    const p = input();
    let proj = projectFromProposal({
      ...p,
      proposal: { ...p.proposal, srcEndMs: 125_000 },
    }).project;
    proj = applyRenderOptions(proj, { confirmDuration: true }, ctx()).project;
    expect(durationAccepted(proj, 2)).toBe(true);
    expect(durationAccepted(proj, 3)).toBe(false);
    const moved = applyRenderOptions(
      proj,
      { bounds: { endMs: 126_000 } },
      ctx({ nextRevision: 3 }),
    ).project;
    expect(moved.durationPolicy.outOfRangeConfirmedForRevision).toBeNull();
    expect(projectBounds(moved).endMs).toBe(126_000);
  });
});

describe('réglages (PATCH)', () => {
  const base = () => projectFromProposal(input()).project;

  it('schéma strict : clé inconnue ou demande vide refusées', () => {
    expect(RenderOptionsPatchSchema.safeParse({}).success).toBe(false);
    expect(RenderOptionsPatchSchema.safeParse({ layout: { zoom: 2 } }).success).toBe(false);
    expect(
      RenderOptionsPatchSchema.safeParse({ captions: { style: { sizePx: 500 } } }).success,
    ).toBe(false);
  });

  it('désactiver un masque exige une confirmation du risque, et le signale', () => {
    expect(() =>
      applyRenderOptions(base(), { masks: { modes: [{ index: 0, mode: 'off' }] } }, ctx()),
    ).toThrow(/acknowledgeMaskRisk/);
    const r = applyRenderOptions(
      base(),
      { masks: { modes: [{ index: 0, mode: 'off' }], acknowledgeMaskRisk: true } },
      ctx(),
    );
    expect(r.warnings.map((w) => w.code)).toContain('MASKS_DISABLED');
  });

  it('sous-titres Discord refusés sans autorisation, acceptés avec', () => {
    expect(() =>
      applyRenderOptions(base(), { captions: { sources: ['mic', 'discord'] } }, ctx()),
    ).toThrow(expect.objectContaining({ code: 'EXPORT_CONSENT_REQUIRED' }));
    const r = applyRenderOptions(
      base(),
      { captions: { sources: ['mic', 'discord'] } },
      ctx({ allowedCaptionRoles: ['mic', 'discord'] }),
    );
    expect(r.project.captions.sources).toEqual(['mic', 'discord']);
  });

  it('une piste non retenue ne peut pas être ajoutée ; une piste retenue peut être retirée', () => {
    expect(() =>
      applyRenderOptions(base(), { audio: { tracks: [{ audioIndex: 2, enabled: true }] } }, ctx()),
    ).toThrow(expect.objectContaining({ code: 'EXPORT_CONSENT_REQUIRED' }));
    const r = applyRenderOptions(
      base(),
      { audio: { tracks: [{ audioIndex: 1, enabled: false }], loudnorm: false } },
      ctx(),
    );
    expect(r.project.audio.tracks[0]!.enabled).toBe(false);
    expect(r.project.audio.loudnorm.enabled).toBe(false);
    // Réactiver une piste qui n'est plus autorisée (accord révoqué) : refus.
    expect(() =>
      applyRenderOptions(
        r.project,
        { audio: { tracks: [{ audioIndex: 1, enabled: true }] } },
        ctx({ allowedAudioIndexes: [] }),
      ),
    ).toThrow(/non autorisée/);
  });

  it('corrections : texte d’origine conservé, tracé, annulable ; source intacte', () => {
    const p = base();
    const item = p.captions.items.find((i) => i.speakerRole === 'mic')!;
    const before = JSON.stringify(p.captions.items);
    const r = applyRenderOptions(
      p,
      { corrections: [{ itemId: item.id, text: 'Texte\u0007 corrigé' }] },
      ctx(),
    );
    const RenderPatch = RenderOptionsPatchSchema.parse({
      corrections: [{ itemId: item.id, text: '  a\nb ' }],
    });
    expect(RenderPatch.corrections![0]!.text).toBe('a b');
    expect(r.project.captions.corrections).toEqual([
      {
        itemId: item.id,
        originalText: item.words.map((w) => w.text).join(' '),
        correctedText: 'Texte\u0007 corrigé',
        revision: 2,
        at: '2026-11-24T10:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(r.project.captions.items)).toBe(before);
    const undone = applyRenderOptions(
      r.project,
      { corrections: [{ itemId: item.id, text: null }] },
      ctx({ nextRevision: 3 }),
    );
    expect(undone.project.captions.corrections).toEqual([]);
    expect(() =>
      applyRenderOptions(p, { corrections: [{ itemId: 'x', text: 'a' }] }, ctx()),
    ).toThrow(/inconnue/);
  });

  it('facecam_top impossible sans facecam', () => {
    const p = projectFromProposal(input({ framing: null })).project;
    expect(() => applyRenderOptions(p, { layout: { preset: 'facecam_top' } }, ctx())).toThrow(
      /facecam/,
    );
  });
});

describe('sous-titres affichés', () => {
  it('regroupement : lignes bornées, coupure aux pauses et à la ponctuation', () => {
    const ws: CaptionWord[] = [
      { text: 'Bon', srcStartMs: 0, srcEndMs: 200 },
      { text: 'alors.', srcStartMs: 250, srcEndMs: 500 },
      { text: 'On', srcStartMs: 550, srcEndMs: 700 },
      { text: 'y', srcStartMs: 750, srcEndMs: 800 },
      { text: 'va', srcStartMs: 2000, srcEndMs: 2200 },
    ];
    const items = groupWords({ role: 'mic', words: ws }, 0, 10_000, (r, i) => `${r}-${i}`);
    expect(items.map((i) => i.words.map((w) => w.text).join(' '))).toEqual([
      'Bon alors.',
      'On y',
      'va',
    ]);
    // Durée minimale d'affichage sans chevaucher la suivante.
    expect(items[0]!.srcEndMs).toBeLessThanOrEqual(items[1]!.srcStartMs);
    expect(items[2]!.srcEndMs - items[2]!.srcStartMs).toBe(700);
  });

  it('texte affiché = correction puis pseudonymisation ; temps montage via les segments', () => {
    const { project } = projectFromProposal(input());
    const it0 = project.captions.items.find(
      (i) => i.speakerRole === 'mic' && i.srcStartMs >= 110_000,
    )!;
    const corrected = applyRenderOptions(
      project,
      { corrections: [{ itemId: it0.id, text: 'Salut Jean' }] },
      ctx(),
    ).project;
    const shown = displayCaptions(
      projectSegments(corrected),
      corrected.captions.items,
      corrected.captions.corrections,
      {
        roles: ['mic'],
        pseudonymize: (t) => ({
          text: t.replace('Jean', 'Personne A'),
          replacements: t.includes('Jean') ? 1 : 0,
        }),
      },
    );
    const line = shown.find((s) => s.itemId === it0.id)!;
    expect(line).toMatchObject({ text: 'Salut Personne A', corrected: true, replacements: 1 });
    expect(line.originalText).not.toContain('Personne');
    expect(line.editRanges[0]!.editStartMs).toBe(it0.srcStartMs - 110_000);
    // Rôles non demandés : jamais affichés ; lignes hors du clip : absentes.
    expect(shown.every((s) => s.speakerRole === 'mic')).toBe(true);
    expect(shown.every((s) => s.editRanges.length > 0)).toBe(true);
    expect(shown.length).toBeLessThan(
      project.captions.items.filter((i) => i.speakerRole === 'mic').length,
    );
  });
});
