import { describe, expect, it } from 'vitest';
import { applyRenderOptions, canonicalJson, projectFromProposal } from '../project';
import { migrateV1ToV2 } from './migrate';
import { applyBatch, applyOperation, OpError, type Operation } from './ops';
import { fixtureV1Input, fixtureV2 } from './test-fixtures';
import { diffToRestore, projectToV1 } from './v1-compat';

const window = { srcStartMs: 50_000, srcEndMs: 193_800 };
const d = fixtureV2(window);

describe('projection v1 exacte (transition 7b → 7e)', () => {
  it('document issu de l’étape 6 : projection = document v1 d’origine (aller-retour sans perte)', () => {
    const { project } = projectFromProposal(fixtureV1Input());
    const v2 = migrateV1ToV2(project, { manifestWindow: window });
    const v1 = projectToV1(v2);
    expect(v1).not.toBeNull();
    // Mêmes données (ordre canonique des items mis à part).
    expect(canonicalJson(migrateV1ToV2(v1!, { manifestWindow: window }))).toBe(canonicalJson(v2));
  });

  it('modifications compatibles étape 6 (mode, piste, correction) : toujours projetables', () => {
    const ops: Operation[] = [
      { type: 'setMode', mode: 'enrichi' },
      { type: 'setTrack', audioIndex: 1, gainDb: -3 },
      { type: 'editCaptionText', itemId: d.captions.items[0]!.id, text: 'Salut', at: 't' },
    ];
    expect(projectToV1(applyBatch(d, ops).doc)).not.toBeNull();
  });

  it.each<[string, Operation]>([
    [
      'vide (suppression sans décalage)',
      { type: 'splitSegment', segmentId: 'seg-0', atSrcMs: 120_000, newId: 'b' },
    ],
    [
      'automatisation du gain',
      { type: 'setTrack', audioIndex: 1, automation: [{ srcMs: 120_000, gainDb: -6 }] },
    ],
    ['fond de mise en page', { type: 'setLayout', background: '#112233' }],
    [
      'masque temporel',
      {
        type: 'setEntity',
        collection: 'mask',
        entity: {
          id: 'tm',
          rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
          label: 'x',
          mode: 'opaque',
          srcRange: { srcStartMs: 115_000, srcEndMs: 116_000 },
        },
      },
    ],
    [
      'calque texte',
      {
        type: 'setEntity',
        collection: 'overlay',
        entity: {
          id: 'o',
          kind: 'text',
          assetId: null,
          text: 'Titre',
          timing: { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 1_000 },
          frame: { x: 0, y: 0, w: 1, h: 0.1 },
          opacity: 1,
          z: 1,
        },
      },
    ],
    [
      'sous-titre manuel',
      {
        type: 'setEntity',
        collection: 'manual',
        entity: {
          id: 'm',
          origin: 'creator',
          text: 'GG',
          srcStartMs: 111_000,
          srcEndMs: 112_000,
          style: null,
          position: null,
        },
      },
    ],
  ])('fonction de l’éditeur (%s) : aucune projection (jamais approximative)', (label, op) => {
    let doc = applyOperation(d, op).doc;
    if (label.startsWith('vide')) {
      doc = applyBatch(doc, [
        { type: 'splitSegment', segmentId: 'b', atSrcMs: 125_000, newId: 'c' },
        { type: 'liftDelete', segmentId: 'b', gapId: 'g' },
      ]).doc;
    }
    expect(projectToV1(doc)).toBeNull();
  });
});

describe('diffToRestore : un PATCH v1 devient une restauration exacte', () => {
  it('transforme exactement un document en un autre, et seulement les clés modifiées', () => {
    const v1 = projectToV1(d)!;
    const patched = applyRenderOptions(
      v1,
      { layout: { preset: 'gameplay_crop' }, audio: { loudnorm: false } },
      {
        nextRevision: 2,
        now: 't',
        words: [],
        allowedCaptionRoles: ['mic'],
        allowedAudioTracks: [{ audioIndex: 1, role: 'mic' }],
      },
    ).project;
    const target = migrateV1ToV2(patched, { manifestWindow: window });
    const ops = diffToRestore(d, target);
    expect(ops).toHaveLength(1);
    const restore = ops[0] as Extract<Operation, { type: 'restore' }>;
    const keys = restore.entries.map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(['audio.config', 'layout']));
    expect(keys).not.toContain('segments');
    expect(keys.some((k) => k.startsWith('caption:'))).toBe(false);
    expect(canonicalJson(applyBatch(d, ops).doc)).toBe(canonicalJson(target));
  });

  it('aucune différence : aucune opération', () => {
    expect(diffToRestore(d, d)).toEqual([]);
  });

  it('différence hors des clés d’état : refus explicite (jamais d’écriture partielle)', () => {
    const other = { ...d, anchors: { ...d.anchors, punchlineMs: d.anchors.punchlineMs + 1 } };
    expect(() => diffToRestore(d, other)).toThrow(OpError);
  });

  it('désactiver un masque : la restauration exige la confirmation, transmise par l’appelant', () => {
    const target = { ...d, masks: d.masks.map((m) => ({ ...m, mode: 'off' as const })) };
    expect(() => diffToRestore(d, target)).toThrow(/confirmez le risque/);
    const ops = diffToRestore(d, target, { acknowledgeMaskRisk: true });
    expect(applyBatch(d, ops).doc.masks[0]!.mode).toBe('off');
  });
});
