/**
 * Étape 7a : la géométrie partagée (`@acs/timeline`) calcule exactement les rectangles du moteur
 * FFmpeg de l'étape 6. Garantie de cohérence entre l'aperçu canvas et l'export.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toPixelRect as mediaToPixelRect } from '@acs/media';
import { presetLayers, toPixelRect, type PresetLayoutInput } from '@acs/timeline';
import { buildVideoGraph } from './layout';

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const arbRect = fc.tuple(unit, unit, unit, unit).map(([x, y, w, h]) => ({
  x: x * 0.8,
  y: y * 0.8,
  w: 0.05 + w * (1 - x * 0.8 - 0.05),
  h: 0.05 + h * (1 - y * 0.8 - 0.05),
}));
const arbSize = fc.record({
  width: fc.integer({ min: 160, max: 3840 }).map((n) => n * 2),
  height: fc.integer({ min: 90, max: 2160 }).map((n) => n * 2),
});
const arbLayout: fc.Arbitrary<PresetLayoutInput> = fc.record({
  preset: fc.constantFrom('facecam_top', 'gameplay_crop', 'blurred_fit'),
  gameplayRect: arbRect,
  facecamRect: arbRect,
  focusX: unit,
  facecamShare: fc.double({ min: 0.25, max: 0.45, noNaN: true }),
});

describe('géométrie partagée (étape 7a)', () => {
  it('toPixelRect identique à celui de @acs/media (aplats de l’étape 6)', () => {
    fc.assert(
      fc.property(arbRect, arbSize, (r, s) => {
        expect(toPixelRect(r, s.width, s.height)).toEqual(mediaToPixelRect(r, s.width, s.height));
      }),
    );
  });

  it('les recadrages des calques sont exactement ceux du graphe FFmpeg', () => {
    fc.assert(
      fc.property(arbLayout, arbSize, (layout, src) => {
        const out = { width: 1080, height: 1920 };
        const graph = buildVideoGraph({
          srcWidth: src.width,
          srcHeight: src.height,
          outWidth: out.width,
          outHeight: out.height,
          fps: 30,
          layout: { ...layout, framingProfile: null, masks: [] },
          zooms: [],
          facecamZooms: [],
          subtitlesFile: null,
          fontsDir: 'fonts',
        });
        const crops = [...graph.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/gu)].map((m) => ({
          w: Number(m[1]),
          h: Number(m[2]),
          x: Number(m[3]),
          y: Number(m[4]),
        }));
        const layers = presetLayers(layout, src, out);
        // Même ensemble de recadrages source (l'ordre du graphe diffère de l'ordre d'empilement).
        const key = (r: { x: number; y: number; w: number; h: number }) =>
          `${r.x},${r.y},${r.w},${r.h}`;
        expect(crops.map(key).sort()).toEqual(layers.map((l) => key(l.crop)).sort());
      }),
      { numRuns: 200 },
    );
  });
});
