import { describe, expect, it } from 'vitest';
import { projectFromProposal } from '../project';
import { editMs, editToSource, totalEditDuration } from '../time';
import { checkInvariants } from './invariants';
import { migrateV1ToV2, v1MaskId } from './migrate';
import {
  applyBatch,
  applyOperation,
  documentFingerprint,
  inverseOfBatch,
  OpError,
  type Operation,
} from './ops';
import { ClipProjectV2Schema, segmentsV2, type ClipProjectV2 } from './schema';
import { fixtureV1Input, fixtureV2 } from './test-fixtures';

const fp = documentFingerprint;
const segs = (d: ClipProjectV2) => segmentsV2(d.segments);
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof OpError) return e.code;
    throw e;
  }
  return null;
};
/** Applique puis annule : le document doit redevenir EXACTEMENT identique. */
function roundTrip(d: ClipProjectV2, op: Operation, ctx = {}) {
  const a = applyOperation(d, op, ctx);
  const back = applyOperation(a.doc, a.inverse, ctx);
  expect(fp(back.doc)).toBe(fp(d));
  return a;
}

describe('migration v1 → v2', () => {
  it('fenêtre = celle du manifeste existant (±10 s), jamais élargie ; masques identifiés ; v1 intact', () => {
    const { project } = projectFromProposal(fixtureV1Input());
    const before = JSON.stringify(project);
    const v2 = migrateV1ToV2(project, {
      manifestWindow: { srcStartMs: 100_000, srcEndMs: 143_800 },
    });
    expect(JSON.stringify(project)).toBe(before);
    expect(ClipProjectV2Schema.parse(v2)).toEqual(v2);
    expect(v2.source.editWindow).toEqual({
      srcStartMs: 100_000,
      srcEndMs: 143_800,
      integrityManifestId: 'man',
    });
    expect(v2.masks).toEqual([
      {
        id: v1MaskId(0),
        rect: project.layout.masks[0]!.rect,
        label: 'Fil',
        mode: 'opaque',
        srcRange: null,
      },
    ]);
    expect(v2.segments).toEqual(project.segments);
    expect(v2.audio.tracks).toEqual([{ ...project.audio.tracks[0]!, automation: [] }]);
    expect(checkInvariants(v2)).toEqual([]);
  });

  it('vitesse ≠ 1 ou segment hors de la fenêtre du manifeste : refus explicite', () => {
    const { project } = projectFromProposal(fixtureV1Input());
    const fast = { ...project, segments: [{ ...project.segments[0]!, speed: 2 }] };
    expect(() =>
      migrateV1ToV2(fast, { manifestWindow: { srcStartMs: 0, srcEndMs: 600_000 } }),
    ).toThrow(/Vitesse/);
    expect(() =>
      migrateV1ToV2(project, { manifestWindow: { srcStartMs: 115_000, srcEndMs: 143_800 } }),
    ).toThrow(/hors de la fenêtre/);
  });
});

describe('segments : coupe, rognage, déplacement, suppressions, arrêt sur image', () => {
  const d = fixtureV2();

  it('couper puis annuler', () => {
    const a = roundTrip(d, {
      type: 'splitSegment',
      segmentId: 'seg-0',
      atSrcMs: 120_000,
      newId: 's2',
    });
    expect(a.doc.segments.map((s) => s.id)).toEqual(['seg-0', 's2']);
    expect(totalEditDuration(segs(a.doc))).toBe(totalEditDuration(segs(d)));
    expect(a.reads).toEqual(expect.arrayContaining(['segments', 'window']));
    expect(a.writes).toContain('segments');
  });

  it('rogner et allonger dans la fenêtre ; au-delà de la fenêtre : refus', () => {
    roundTrip(d, { type: 'trimSegment', segmentId: 'seg-0', srcStartMs: 100_000 });
    expect(
      code(() =>
        applyOperation(d, { type: 'trimSegment', segmentId: 'seg-0', srcStartMs: 40_000 }),
      ),
    ).toBe('INVARIANT_VIOLATED');
  });

  it('suppression AVEC décalage : la durée diminue ; SANS décalage : un vide de même durée', () => {
    const split = applyBatch(d, [
      { type: 'splitSegment', segmentId: 'seg-0', atSrcMs: 115_000, newId: 'b' },
      { type: 'splitSegment', segmentId: 'b', atSrcMs: 120_000, newId: 'c' },
    ]).doc;
    const total = totalEditDuration(segs(split));
    const ripple = roundTrip(split, { type: 'rippleDelete', segmentId: 'b' }).doc;
    expect(totalEditDuration(segs(ripple))).toBe(total - 5_000);
    const lift = roundTrip(split, { type: 'liftDelete', segmentId: 'b', gapId: 'g' }).doc;
    expect(totalEditDuration(segs(lift))).toBe(total);
    expect(lift.segments[1]).toEqual({ id: 'g', kind: 'gap', editDurMs: 5_000 });
    // Dans le vide : aucun temps source (type de retour exact).
    expect(editToSource(segs(lift), editMs(6_000))).toEqual({ kind: 'gap', segmentId: 'g' });
  });

  it('un clip ne commence ni ne finit par un vide', () => {
    const split = applyOperation(d, {
      type: 'splitSegment',
      segmentId: 'seg-0',
      atSrcMs: 120_000,
      newId: 'b',
    }).doc;
    expect(
      code(() => applyOperation(split, { type: 'liftDelete', segmentId: 'seg-0', gapId: 'g' })),
    ).toBe('INVARIANT_VIOLATED');
    expect(
      code(() => applyOperation(split, { type: 'liftDelete', segmentId: 'b', gapId: 'g' })),
    ).toBe('INVARIANT_VIOLATED');
  });

  it('arrêt sur image : inséré au point voulu, la durée augmente, la source est figée', () => {
    const a = roundTrip(d, {
      type: 'insertFreeze',
      segmentId: 'seg-0',
      atSrcMs: 125_000,
      freezeId: 'f',
      newId: 'after',
      editDurMs: 1_500,
    });
    expect(a.doc.segments.map((s) => s.kind)).toEqual(['source', 'freeze', 'source']);
    expect(totalEditDuration(segs(a.doc))).toBe(totalEditDuration(segs(d)) + 1_500);
    expect(editToSource(segs(a.doc), editMs(15_500))).toEqual({
      kind: 'source',
      srcMs: 125_000,
      segmentId: 'f',
      frozen: true,
    });
  });

  it('déplacer un segment ; durée hors des bornes absolues : refus', () => {
    const split = applyOperation(d, {
      type: 'splitSegment',
      segmentId: 'seg-0',
      atSrcMs: 120_000,
      newId: 'b',
    }).doc;
    const moved = roundTrip(split, { type: 'moveSegment', segmentId: 'b', toIndex: 0 }).doc;
    expect(moved.segments.map((s) => s.id)).toEqual(['b', 'seg-0']);
    // Ne garder que 2 s (110–112 s) : sous la borne absolue de 5 s, refus.
    const short = applyOperation(d, {
      type: 'splitSegment',
      segmentId: 'seg-0',
      atSrcMs: 112_000,
      newId: 'r',
    }).doc;
    expect(code(() => applyOperation(short, { type: 'rippleDelete', segmentId: 'r' }))).toBe(
      'INVARIANT_VIOLATED',
    );
  });

  it('élargir la fenêtre exige un nouveau manifeste et doit contenir l’actuelle', () => {
    roundTrip(d, {
      type: 'extendWindow',
      srcStartMs: 20_000,
      srcEndMs: 220_000,
      integrityManifestId: 'man2',
    });
    expect(
      code(() =>
        applyOperation(d, {
          type: 'extendWindow',
          srcStartMs: 20_000,
          srcEndMs: 220_000,
          integrityManifestId: d.source.editWindow.integrityManifestId,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      code(() =>
        applyOperation(d, {
          type: 'extendWindow',
          srcStartMs: 60_000,
          srcEndMs: 220_000,
          integrityManifestId: 'man2',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('sous-titres', () => {
  const d = fixtureV2();
  const first = d.captions.items[0]!;

  it('corriger, re-horodater, styler, puis annuler : texte de la transcription intact', () => {
    const a = roundTrip(d, { type: 'editCaptionText', itemId: first.id, text: 'Bonjour', at: 't' });
    expect(a.doc.captions.corrections[0]).toMatchObject({
      itemId: first.id,
      correctedText: 'Bonjour',
    });
    expect(a.doc.captions.items).toEqual(d.captions.items);
    roundTrip(d, {
      type: 'retimeCaption',
      itemId: first.id,
      srcStartMs: first.srcStartMs - 500,
      srcEndMs: null,
    });
    expect(
      code(() =>
        applyOperation(d, {
          type: 'retimeCaption',
          itemId: first.id,
          srcStartMs: first.srcStartMs - 5_000,
          srcEndMs: null,
        }),
      ),
    ).toBe('INVARIANT_VIOLATED');
    roundTrip(d, {
      type: 'styleCaption',
      itemId: first.id,
      style: { sizePx: 90 },
      position: { x: 0.5, y: 0.2 },
    });
  });

  it('découper puis fusionner : mêmes mots, dans le même ordre', () => {
    const split = roundTrip(d, {
      type: 'splitCaption',
      itemId: first.id,
      atWord: 1,
      newId: 'cap-new',
    }).doc;
    // Mêmes mots, dans le même ordre, pour chaque source (les sources se chevauchent dans le temps).
    const words = (doc: ClipProjectV2) =>
      ['mic', 'discord'].map((r) =>
        doc.captions.items
          .filter((i) => i.speakerRole === r)
          .flatMap((i) => i.words.map((w) => w.text)),
      );
    expect(words(split)).toEqual(words(d));
    const merged = roundTrip(split, {
      type: 'mergeCaptions',
      firstId: first.id,
      secondId: 'cap-new',
    }).doc;
    expect(fp(merged)).toBe(fp(d));
  });

  it('découper un sous-titre corrigé : refus explicite (annuler la correction d’abord)', () => {
    const corrected = applyOperation(d, {
      type: 'editCaptionText',
      itemId: first.id,
      text: 'Bonjour',
      at: 't',
    }).doc;
    expect(
      code(() =>
        applyOperation(corrected, {
          type: 'splitCaption',
          itemId: first.id,
          atWord: 1,
          newId: 'x',
        }),
      ),
    ).toBe('PRECONDITION_FAILED');
  });

  it('sous-titre manuel : ajout, retrait ; source non autorisée refusée', () => {
    const manual = {
      id: 'man-1',
      origin: 'creator',
      text: 'GG',
      srcStartMs: 120_000,
      srcEndMs: 121_000,
      style: null,
      position: null,
    };
    const a = roundTrip(d, { type: 'setEntity', collection: 'manual', entity: manual });
    roundTrip(a.doc, { type: 'removeEntity', collection: 'manual', id: 'man-1' });
    expect(
      code(() =>
        applyOperation(
          d,
          { type: 'setCaptionsConfig', sources: ['mic', 'discord'] },
          { allowedCaptionRoles: ['mic'] },
        ),
      ),
    ).toBe('EXPORT_CONSENT_REQUIRED');
  });
});

describe('masques, audio, mise en page, éléments', () => {
  const d = fixtureV2();

  it('désactiver un masque exige une confirmation explicite ; le flou n’est pas un masque', () => {
    const off = { ...d.masks[0]!, mode: 'off' };
    expect(
      code(() => applyOperation(d, { type: 'setEntity', collection: 'mask', entity: off })),
    ).toBe('MASK_RISK_NOT_ACKNOWLEDGED');
    roundTrip(d, { type: 'setEntity', collection: 'mask', entity: off, acknowledgeMaskRisk: true });
    // Un masque n'accepte aucun mode « flou ».
    expect(
      code(() =>
        applyOperation(d, {
          type: 'setEntity',
          collection: 'mask',
          entity: { ...off, mode: 'blur' },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    // Masque temporel opaque.
    roundTrip(d, {
      type: 'setEntity',
      collection: 'mask',
      entity: {
        id: 'tm',
        rect: { x: 0, y: 0, w: 0.2, h: 0.2 },
        label: 'Pseudo',
        mode: 'opaque',
        srcRange: { srcStartMs: 115_000, srcEndMs: 118_000 },
      },
    });
  });

  it('blur_region est un effet (zone requise), jamais une entrée de la collection des masques', () => {
    const blur = {
      id: 'fx-blur',
      type: 'blur_region',
      params: { sigma: 20 },
      region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      timing: { anchor: 'source', srcStartMs: 115_000, srcEndMs: 118_000 },
      enabled: true,
      origin: 'creator',
      reason: '',
      signals: {},
    };
    const a = roundTrip(d, { type: 'setEntity', collection: 'effect', entity: blur });
    expect(a.doc.masks).toEqual(d.masks);
    expect(
      code(() =>
        applyOperation(d, {
          type: 'setEntity',
          collection: 'effect',
          entity: { ...blur, region: null },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('audio : piste non autorisée refusée à l’activation ; retrait toujours possible', () => {
    const ctx = { allowedAudioIndexes: [1] };
    expect(
      code(() =>
        applyOperation(d, { type: 'setTrack', audioIndex: 2, role: 'discord', enabled: true }, ctx),
      ),
    ).toBe('EXPORT_CONSENT_REQUIRED');
    roundTrip(d, { type: 'setTrack', audioIndex: 1, enabled: false }, ctx);
    roundTrip(
      d,
      {
        type: 'setTrack',
        audioIndex: 1,
        gainDb: -6,
        automation: [{ srcMs: 120_000, gainDb: -12 }],
      },
      ctx,
    );
  });

  it('annuler un retrait de piste dont l’accord a été révoqué entre-temps : refusé', () => {
    const removed = applyOperation(
      d,
      { type: 'setTrack', audioIndex: 1, enabled: false },
      { allowedAudioIndexes: [1] },
    );
    // L'accord est révoqué : la piste 1 n'est plus autorisée.
    expect(
      code(() => applyOperation(removed.doc, removed.inverse, { allowedAudioIndexes: [] })),
    ).toBe('EXPORT_CONSENT_REQUIRED');
  });

  it('mise en page personnalisée : calques requis ; retour à un préréglage', () => {
    const layers = [
      {
        id: 'l1',
        role: 'gameplay' as const,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        frame: { x: 0, y: 0.3, w: 1, h: 0.7 },
        z: 0,
      },
      {
        id: 'l2',
        role: 'facecam' as const,
        crop: { x: 0.74, y: 0.7, w: 0.25, h: 0.28 },
        frame: { x: 0, y: 0, w: 1, h: 0.3 },
        z: 1,
      },
    ];
    const custom = roundTrip(d, { type: 'setLayout', preset: 'custom', layers }).doc;
    expect(custom.layout.layers).toHaveLength(2);
    expect(code(() => applyOperation(d, { type: 'setLayout', preset: 'custom' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      roundTrip(custom, { type: 'setLayout', preset: 'gameplay_crop' }).doc.layout.layers,
    ).toEqual([]);
  });

  it('calques graphiques : image fixe (média) ou texte ; ancrage montage ⇒ lecture de la structure', () => {
    const overlay = {
      id: 'ov-1',
      kind: 'meme',
      assetId: 'a'.repeat(64),
      text: null,
      timing: { anchor: 'edit', from: 'end', offsetMs: 0, durMs: 2_000 },
      frame: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
      opacity: 1,
      z: 2,
    };
    const a = roundTrip(d, { type: 'setEntity', collection: 'overlay', entity: overlay });
    expect(a.reads).toContain('segments');
    expect(
      code(() =>
        applyOperation(d, {
          type: 'setEntity',
          collection: 'overlay',
          entity: { ...overlay, assetId: null },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('restauration : refusée si la clé a changé depuis (précondition de l’annulation)', () => {
    const a = applyOperation(d, { type: 'setMode', mode: 'enrichi' });
    const changed = applyOperation(a.doc, { type: 'setMode', mode: 'fidele' }).doc;
    expect(code(() => applyOperation(changed, a.inverse))).toBe('PRECONDITION_FAILED');
  });

  it('lot : tout ou rien, inverse du lot exact', () => {
    const ops: Operation[] = [
      { type: 'splitSegment', segmentId: 'seg-0', atSrcMs: 120_000, newId: 'b' },
      { type: 'setMode', mode: 'enrichi' },
      { type: 'liftDelete', segmentId: 'b', gapId: 'g' }, // vide en fin : refusé
    ];
    expect(code(() => applyBatch(d, ops))).toBe('INVARIANT_VIOLATED');
    const ok = applyBatch(d, ops.slice(0, 2));
    expect(fp(applyBatch(ok.doc, inverseOfBatch(ok.applied)).doc)).toBe(fp(d));
  });

  it('opération inconnue ou champ non prévu : refus', () => {
    expect(code(() => applyOperation(d, { type: 'exec', cmd: 'rm' }))).toBe('VALIDATION_FAILED');
    expect(code(() => applyOperation(d, { type: 'setMode', mode: 'enrichi', x: 1 }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});
