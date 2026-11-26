/**
 * Non-régression du moteur de l'étape 6 (docs/plan-etape-7.md §8.2, PR 7c) : les empreintes
 * ci-dessous ont été calculées avec le moteur de l'étape 6b (main au commit 55c9a6c, avant la PR
 * 7c). Un projet de l'étape 6 doit produire EXACTEMENT le même plan, par l'ancienne entrée (v1)
 * comme par la nouvelle (document v2) : mêmes rendus réutilisés, mêmes exports reconnus à jour.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrateV1ToV2 } from '@acs/timeline';
import { goldenAudio, goldenCaptions, goldenCases, type GoldenCase } from './golden-fixtures';
import { buildRenderPlan, buildRenderPlanV2 } from './plan';

const GOLDEN: Record<string, string> = {
  'défaut, final': '7414ff8703057b6c7f86015c9297f9cb5de810912312764da08f98a403ac6483',
  'défaut, aperçu': '8d6e8bd8f626c05348935dae66dfec97ba7965920e1253cc3b33dd65daf97149',
  'fond flouté': '68760065f9b7083fa83192407757fc096ea6aba050a1c26882fb5ecd3ba7972e',
  'recadrage gameplay, focus 0,2':
    'e799d88f7432a69fb827e0ed8a6c5d9e2400eb46157a612a3ef25ec7017d6621',
  'masque désactivé': 'b724988afd8cb164ab5f8f0ec1f57d97acce8aee6c4cb4b01391e0eee3a2f34d',
  'sans sous-titres, sans normalisation':
    'e9f5e5c41f9214d71d0c1cf55ed0db11fce9dd7b8a70f6ca793a62f1f1c50ab6',
  'texte corrigé, style': '3be82255e9f6c9736d897fde1878bb9a724f1d6aeaa66a703fec6a3258453ef8',
  'enrichi : chute mise en évidence et zoom':
    '53316a5eeaa968e7ebff577081a1f35087730f5ec4d81b6039f5166951aff376',
  'facecam en haut, zoom sur la facecam':
    '749ebecac7f180a53f797cc6df3066a701c26f5736d7ce395f05ac876bc38948',
  'micro et Discord, gains, sous-titres des deux':
    '7b51e8b4752aad75680190a2fb0b797f0132b56d9d80c3f81bc368dbf59fca8e',
  'export muet explicite': '8222698d8dc14117ba0b785e130bb2908b9f340d2a428589a156bab87b0ad96e',
  'piste unique « Tout »': '2baf459f1f0828724808d2eb2cff8681202d8dfb0ed77d969fb57f1898ede38e',
};

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const common = (c: GoldenCase) => ({
  revision: c.revision,
  kind: c.kind,
  source: { width: 1920, height: 1080, fps: 60 },
  audio: goldenAudio(c),
  captions: goldenCaptions(c),
  probeBytes: 5_000_000,
});

describe('projets de l’étape 6 : plan identique au moteur 6b', () => {
  it('toutes les références sont couvertes', () => {
    expect(goldenCases().map((c) => c.name)).toEqual(Object.keys(GOLDEN));
  });

  for (const c of goldenCases()) {
    it(`${c.name} : entrée v1`, () => {
      expect(hash(buildRenderPlan({ project: c.project, ...common(c) }))).toBe(GOLDEN[c.name]);
    });
    it(`${c.name} : document v2 (migré, fenêtre ±60 s)`, () => {
      const v2 = migrateV1ToV2(c.project, {
        manifestWindow: { srcStartMs: 50_000, srcEndMs: 200_000 },
      });
      expect(hash(buildRenderPlanV2({ project: v2, ...common(c) }))).toBe(GOLDEN[c.name]);
    });
  }
});
