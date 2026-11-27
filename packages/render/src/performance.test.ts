/**
 * Budgets de performance (étape 7, PR 7f, docs/plan-etape-7.md §8.2 « 7k ») : clip de 60 s en
 * 50 segments, au maximum du schéma en calques image (50) et en effets sonores (100).
 *
 * Mesures PURES (aucun FFmpeg) du travail refait à chaque geste ou chaque image :
 *  - plan de rendu complet et image exacte (serveur, à chaque demande) ;
 *  - scène et placements (aperçu, à chaque image du canvas).
 * Budgets larges (machines de CI lentes, Windows compris) : ils détectent une régression d'ordre
 * de grandeur, pas une variation de quelques pour cent. Les valeurs mesurées sont journalisées.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  ClipProjectV2Schema,
  displayCaptions,
  imageOverlayPlacements,
  migrateV1ToV2,
  sceneAt,
  segmentsV2,
  sfxPlacements,
  type ClipProjectV2,
  type EditMs,
  type SegmentV2,
} from '@acs/timeline';
import { allowedAudio, EMPTY_AUDIO_STATE } from './audio';
import { goldenCases } from './golden-fixtures';
import {
  buildFramePlan,
  buildRenderPlanV2,
  type PlanAssetInput,
  type RenderPlanV2Input,
} from './plan';

const IMG = (k: number) => k.toString(16).padStart(64, 'c');
const SND = (k: number) => k.toString(16).padStart(64, 'd');

function heavyDoc(): ClipProjectV2 {
  const v1 = goldenCases()[0]!.project;
  const base = migrateV1ToV2(v1, { manifestWindow: { srcStartMs: 50_000, srcEndMs: 200_000 } });
  // 50 segments de 1,2 s pris tous les 2 s : 60 s de montage.
  const segments: SegmentV2[] = Array.from({ length: 50 }, (_, k) => ({
    id: `s${k}`,
    kind: 'source',
    srcStartMs: 60_000 + k * 2000,
    srcEndMs: 60_000 + k * 2000 + 1200,
    speed: 1,
  }));
  return ClipProjectV2Schema.parse({
    ...base,
    segments,
    overlays: Array.from({ length: 50 }, (_, k) => ({
      id: `o${String(k).padStart(2, '0')}`,
      kind: k % 2 ? 'meme' : 'image',
      assetId: IMG(k % 10),
      text: null,
      timing:
        k % 3
          ? { anchor: 'edit', from: 'start', offsetMs: k * 1000, durMs: 3000 }
          : { anchor: 'source', srcStartMs: 60_000 + k * 1500, srcEndMs: 63_000 + k * 1500 },
      frame: { x: (k % 5) * 0.15, y: (k % 7) * 0.1, w: 0.2, h: 0.1 },
      opacity: 0.8,
      z: k % 20,
    })),
    audio: {
      ...base.audio,
      sfx: Array.from({ length: 100 }, (_, k) => ({
        id: `x${String(k).padStart(3, '0')}`,
        assetId: SND(k % 10),
        timing: { anchor: 'edit', from: 'start', offsetMs: k * 550, durMs: 800 },
        gainDb: -3,
      })),
    },
  });
}

function input(d: ClipProjectV2): RenderPlanV2Input {
  const assets: Record<string, PlanAssetInput> = {};
  for (let k = 0; k < 10; k++) {
    assets[IMG(k)] = {
      kind: 'image',
      file: `asset-${IMG(k)}.png`,
      sha256: 'e'.repeat(64),
      durationMs: null,
    };
    assets[SND(k)] = {
      kind: 'audio',
      file: `asset-${SND(k)}.wav`,
      sha256: 'f'.repeat(64),
      durationMs: 700,
    };
  }
  return {
    project: d,
    revision: 1,
    kind: 'final',
    source: { width: 1920, height: 1080, fps: 60 },
    audio: allowedAudio(
      [
        { audioIndex: 0, role: 'mix' },
        { audioIndex: 1, role: 'mic' },
      ],
      { ...EMPTY_AUDIO_STATE, micComposition: { creatorVoice: 'present', otherVoices: 'absent' } },
    ),
    captions: displayCaptions(segmentsV2(d.segments), d.captions.items, d.captions.corrections, {
      roles: d.captions.sources,
      pseudonymize: (t) => ({ text: t, replacements: 0 }),
    }),
    assets,
    probeBytes: 5_000_000,
  };
}

/** Médiane de `n` mesures (ms). */
function median(n: number, f: () => unknown): number {
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    f();
    t.push(performance.now() - a);
  }
  return t.sort((x, y) => x - y)[Math.floor(n / 2)]!;
}

describe('performances : clip de 60 s, 50 segments, 50 calques image, 100 effets sonores', () => {
  const d = heavyDoc();
  const inp = input(d);

  it('plan de rendu complet et image exacte', () => {
    const plan = buildRenderPlanV2(inp);
    expect(plan.durationMs).toBe(60_000);
    expect(plan.segments).toHaveLength(50);
    expect(plan.assets).toHaveLength(20);
    // Graphe dans un fichier de script : aucune limite de ligne de commande (Windows : 32 Ko).
    expect(plan.filterComplex.length).toBeGreaterThan(32_000);
    const planMs = median(5, () => buildRenderPlanV2(inp));
    const frameMs = median(5, () => buildFramePlan(inp, 30_000));
    console.warn(
      `plan de rendu : ${planMs.toFixed(1)} ms ; image exacte : ${frameMs.toFixed(1)} ms`,
    );
    expect(planMs).toBeLessThan(1500);
    expect(frameMs).toBeLessThan(1000);
  });

  it('aperçu : scène et placements par image (60 s à 30 i/s) dans le budget d’une image', () => {
    const o = {
      src: { width: 1920, height: 1080 },
      out: { width: 540, height: 960 },
      allowedAudioIndexes: [1],
      allowedCaptionRoles: ['mic' as const],
    };
    const placementsMs = median(5, () => {
      imageOverlayPlacements(d);
      sfxPlacements(d, { [SND(0)]: 700 });
    });
    const frames = 60 * 30;
    const a = performance.now();
    for (let i = 0; i < frames; i++) sceneAt(d, Math.floor((i * 1000) / 30) as EditMs, o);
    const perFrame = (performance.now() - a) / frames;
    console.warn(
      `placements (recalculés à chaque geste) : ${placementsMs.toFixed(2)} ms ; scène : ${perFrame.toFixed(3)} ms par image`,
    );
    expect(placementsMs).toBeLessThan(200);
    // Une image à 60 i/s dure 16,7 ms : la scène doit en occuper une petite fraction.
    expect(perFrame).toBeLessThan(8);
  });
});
