/**
 * Générateurs d'opérations pour les tests de propriétés (tests uniquement ; non exporté par le
 * paquet). Ils produisent des opérations plausibles sur un document donné, valides ou non :
 * les tests vérifient que les invalides sont refusées et que les valides respectent les règles.
 */
import fc from 'fast-check';
import type { Operation } from './ops';
import type { ClipProjectV2 } from './schema';

const pick = <T>(a: readonly T[]) => fc.constantFrom(...(a.length ? a : ([undefined] as never[])));

export function arbOperation(d: ClipProjectV2): fc.Arbitrary<Operation> {
  const segIds = d.segments.map((s) => s.id);
  const sources = d.segments.filter((s) => s.kind === 'source');
  const w = d.source.editWindow;
  const items = d.captions.items.slice(0, 6);
  const newId = fc.stringMatching(/^[a-z]{1,6}$/u).map((s) => `n-${s}`);
  const inWindow = fc.integer({ min: w.srcStartMs, max: w.srcEndMs });
  const srcTiming = fc
    .tuple(inWindow, fc.integer({ min: 200, max: 4_000 }))
    .map(([a, len]) => ({ anchor: 'source' as const, srcStartMs: a, srcEndMs: a + len }));
  const editTiming = fc
    .tuple(
      fc.constantFrom('start' as const, 'end' as const),
      fc.integer({ min: 0, max: 5_000 }),
      fc.integer({ min: 200, max: 3_000 }),
    )
    .map(([from, offsetMs, durMs]) => ({ anchor: 'edit' as const, from, offsetMs, durMs }));
  const rect = fc
    .tuple(
      fc.integer({ min: 0, max: 70 }),
      fc.integer({ min: 0, max: 70 }),
      fc.integer({ min: 5, max: 30 }),
      fc.integer({ min: 5, max: 30 }),
    )
    .map(([x, y, ww, h]) => ({ x: x / 100, y: y / 100, w: ww / 100, h: h / 100 }));

  const ops: fc.Arbitrary<Operation>[] = [
    fc.record({
      type: fc.constant('splitSegment' as const),
      segmentId: pick(segIds),
      atSrcMs: inWindow,
      newId,
    }),
    fc
      .record({
        type: fc.constant('trimSegment' as const),
        segmentId: pick(sources.map((s) => s.id)),
        srcStartMs: fc.option(inWindow, { nil: undefined }),
        srcEndMs: fc.option(inWindow, { nil: undefined }),
      })
      .map(
        (o) =>
          Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Operation,
      ),
    fc.record({
      type: fc.constant('moveSegment' as const),
      segmentId: pick(segIds),
      toIndex: fc.integer({ min: 0, max: 5 }),
    }),
    fc.record({ type: fc.constant('rippleDelete' as const), segmentId: pick(segIds) }),
    fc.record({ type: fc.constant('liftDelete' as const), segmentId: pick(segIds), gapId: newId }),
    fc.record({
      type: fc.constant('insertFreeze' as const),
      segmentId: pick(sources.map((s) => s.id)),
      atSrcMs: inWindow,
      freezeId: newId,
      newId: newId.map((s) => `${s}-b`),
      editDurMs: fc.integer({ min: 100, max: 3_000 }),
    }),
    fc.record({
      type: fc.constant('setMode' as const),
      mode: fc.constantFrom('fidele' as const, 'enrichi' as const),
    }),
    fc.record({
      type: fc.constant('setAudioConfig' as const),
      silent: fc.boolean(),
      loudnorm: fc.boolean(),
    }),
    fc.record({
      type: fc.constant('setTrack' as const),
      audioIndex: fc.constant(1),
      gainDb: fc.integer({ min: -30, max: 12 }),
    }),
    fc.record({
      type: fc.constant('editCaptionText' as const),
      itemId: pick(items.map((i) => i.id)),
      text: fc.option(fc.constantFrom('Bonjour', 'GG', 'mot0'), { nil: null }),
      at: fc.constant('t'),
    }),
    fc.record({
      type: fc.constant('retimeCaption' as const),
      itemId: pick(items.map((i) => i.id)),
      srcStartMs: fc.option(inWindow, { nil: null }),
      srcEndMs: fc.option(inWindow, { nil: null }),
    }),
    fc.record({
      type: fc.constant('splitCaption' as const),
      itemId: pick(items.map((i) => i.id)),
      atWord: fc.integer({ min: 1, max: 6 }),
      newId,
    }),
    fc.record({
      type: fc.constant('mergeCaptions' as const),
      firstId: pick(items.map((i) => i.id)),
      secondId: pick(items.map((i) => i.id)),
    }),
    fc
      .record({
        id: newId,
        timing: fc.oneof(srcTiming, editTiming),
        factor: fc.integer({ min: 100, max: 130 }),
      })
      .map(({ id, timing, factor }) => ({
        type: 'setEntity' as const,
        collection: 'effect' as const,
        entity: {
          id,
          type: 'punch_zoom',
          params: { factor: factor / 100 },
          region: null,
          timing,
          enabled: true,
          origin: 'creator',
          reason: '',
          signals: {},
        },
      })),
    fc
      .record({ id: newId, timing: fc.oneof(srcTiming, editTiming), frame: rect })
      .map(({ id, timing, frame }) => ({
        type: 'setEntity' as const,
        collection: 'overlay' as const,
        entity: { id, kind: 'text', assetId: null, text: 'Titre', timing, frame, opacity: 1, z: 1 },
      })),
    fc.record({ id: newId, r: srcTiming, rect }).map(({ id, r, rect: rr }) => ({
      type: 'setEntity' as const,
      collection: 'mask' as const,
      entity: {
        id,
        rect: rr,
        label: 'Zone',
        mode: 'opaque',
        srcRange: { srcStartMs: r.srcStartMs, srcEndMs: r.srcEndMs },
      },
    })),
    fc.record({
      type: fc.constant('removeEntity' as const),
      collection: fc.constant('effect' as const),
      id: pick(d.effects.map((e) => e.id)),
    }),
    fc.record({
      type: fc.constant('setLayout' as const),
      preset: fc.constantFrom(
        'facecam_top' as const,
        'gameplay_crop' as const,
        'blurred_fit' as const,
      ),
      focusX: fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
    }),
  ];
  return fc.oneof(...ops).filter((op) => !Object.values(op).includes(undefined as never));
}
