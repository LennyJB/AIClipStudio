import { describe, expect, it } from 'vitest';
import { DeepResultSchema, parseModelJson, toApiSchema, TriageResultSchema } from './schemas';

const FORBIDDEN = [
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'oneOf',
  'not',
  '$schema',
];

function walk(node: unknown, visit: (o: Record<string, unknown>) => void) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

const moment = {
  suggestedTier: 'clip',
  title: 'Le call inversé',
  explanation: 'Il annonce A puis tout le monde part en B, échange absurde.',
  categories: ['malentendu', 'humour'],
  relevance: 82,
  setupSegmentId: 4,
  punchlineSegmentId: 6,
  reactionEndSegmentId: 7,
  standalone: true,
  evidence: [{ segmentId: 6, quote: 'on va en A', role: 'chute' }],
  visualEvidence: [],
  tracksUsed: ['MIC'],
  editingHint: { mode: 'fidele', ideas: [] },
  uncertainty: null,
};

describe('schéma envoyé à l’API', () => {
  it.each([
    ['repérage', TriageResultSchema],
    ['analyse', DeepResultSchema],
  ])(
    '%s : aucun mot-clé non pris en charge, objets fermés, tous les champs requis',
    (_, schema) => {
      const s = toApiSchema(schema);
      walk(s, (o) => {
        for (const k of FORBIDDEN) expect(o, k).not.toHaveProperty(k);
        if (o['type'] === 'object') {
          expect(o['additionalProperties']).toBe(false);
          expect(Object.keys((o['properties'] as object) ?? {}).sort()).toEqual(
            [...((o['required'] as string[]) ?? [])].sort(),
          );
        }
        if (o['minItems'] !== undefined) expect([0, 1]).toContain(o['minItems']);
      });
    },
  );
});

describe('validation stricte des réponses', () => {
  it('accepte une réponse valide, y compris zéro moment', () => {
    expect(
      parseModelJson(DeepResultSchema, JSON.stringify({ moments: [moment], noClipReason: null }))
        .ok,
    ).toBe(true);
    expect(
      parseModelJson(
        DeepResultSchema,
        JSON.stringify({ moments: [], noClipReason: 'Rien de drôle.' }),
      ).ok,
    ).toBe(true);
  });

  it.each([
    ['JSON invalide', '{"moments": ['],
    ['champ inconnu', JSON.stringify({ moments: [], noClipReason: null, commande: 'rm -rf' })],
    [
      'pertinence hors bornes',
      JSON.stringify({ moments: [{ ...moment, relevance: 150 }], noClipReason: null }),
    ],
    [
      'pertinence décimale',
      JSON.stringify({ moments: [{ ...moment, relevance: 80.5 }], noClipReason: null }),
    ],
    [
      'catégorie inconnue',
      JSON.stringify({ moments: [{ ...moment, categories: ['kill'] }], noClipReason: null }),
    ],
    [
      'aucune preuve',
      JSON.stringify({ moments: [{ ...moment, evidence: [] }], noClipReason: null }),
    ],
    [
      'trop de moments',
      JSON.stringify({ moments: [moment, moment, moment, moment], noClipReason: null }),
    ],
    [
      'image mal nommée',
      JSON.stringify({
        moments: [{ ...moment, visualEvidence: [{ frameLabel: '../x', note: '' }] }],
        noClipReason: null,
      }),
    ],
    [
      'identifiant négatif',
      JSON.stringify({ moments: [{ ...moment, setupSegmentId: -3 }], noClipReason: null }),
    ],
  ])('rejette : %s', (_, text) => {
    const r = parseModelJson(DeepResultSchema, text);
    expect(r.ok).toBe(false);
  });

  it('repérage : rejette une force inconnue et un résumé trop long', () => {
    const base = {
      moments: [{ startSegmentId: 1, endSegmentId: 2, kind: 'ironie', strength: 'fort', why: 'x' }],
      streamSummary: '',
    };
    expect(parseModelJson(TriageResultSchema, JSON.stringify(base)).ok).toBe(true);
    expect(
      parseModelJson(
        TriageResultSchema,
        JSON.stringify({ ...base, streamSummary: 'x'.repeat(801) }),
      ).ok,
    ).toBe(false);
    expect(
      parseModelJson(
        TriageResultSchema,
        JSON.stringify({ ...base, moments: [{ ...base.moments[0], strength: 'énorme' }] }),
      ).ok,
    ).toBe(false);
  });
});
