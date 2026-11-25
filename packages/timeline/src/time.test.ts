import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  editMs,
  editToSource,
  moveSegment,
  placeSegments,
  resolveTiming,
  SegmentSchema,
  sourceMs,
  sourceRangeToEditRanges,
  sourceToEdit,
  totalEditDuration,
  updateSegment,
  validateSegments,
  type Segment,
} from './time';

const src = (id: string, a: number, b: number, speed = 1): Segment => ({
  id,
  kind: 'source',
  srcStartMs: sourceMs(a),
  srcEndMs: sourceMs(b),
  speed,
});
const freeze = (id: string, at: number, dur: number): Segment => ({
  id,
  kind: 'freeze',
  srcAtMs: sourceMs(at),
  editDurMs: dur,
});
/** Position source attendue (échoue si l'instant est dans un vide ou hors du clip). */
const srcAt = (segs: Segment[], t: number) => {
  const p = editToSource(segs, editMs(t));
  if (p?.kind !== 'source') throw new Error(`position source attendue à ${t} ms`);
  return p;
};
const editsOf = (segs: Segment[], s: number) =>
  sourceToEdit(segs, sourceMs(s)).map((p) => p.editMs);

describe('types de temps', () => {
  it('refuse les valeurs non entières ou négatives', () => {
    expect(() => sourceMs(1.5)).toThrow(RangeError);
    expect(() => editMs(-1)).toThrow(RangeError);
  });
});

describe('coupes multiples', () => {
  // On garde [10 s, 20 s[ puis [30 s, 35 s[ : [20 s, 30 s[ est coupé.
  const segs = [src('a', 10_000, 20_000), src('b', 30_000, 35_000)];

  it('calcule les positions et la durée totale', () => {
    expect(placeSegments(segs).map((p) => [p.editStartMs, p.editEndMs])).toEqual([
      [0, 10_000],
      [10_000, 15_000],
    ]);
    expect(totalEditDuration(segs)).toBe(15_000);
  });

  it('convertit dans les deux sens', () => {
    expect(editsOf(segs, 12_000)).toEqual([2_000]);
    expect(editsOf(segs, 31_000)).toEqual([11_000]);
    expect(editToSource(segs, editMs(11_000))).toMatchObject({ srcMs: 31_000, segmentId: 'b' });
  });

  it('un passage coupé n’a aucune position de montage', () => {
    expect(editsOf(segs, 25_000)).toEqual([]);
    expect(editsOf(segs, 5_000)).toEqual([]);
  });

  it('une plage à cheval sur une coupe est découpée', () => {
    const r = sourceRangeToEditRanges(segs, sourceMs(18_000), sourceMs(32_000));
    expect(r.map((x) => [x.editStartMs, x.editEndMs, x.segmentId])).toEqual([
      [8_000, 10_000, 'a'],
      [10_000, 12_000, 'b'],
    ]);
  });

  it('les bornes : fin exclusive, hors clip → null', () => {
    expect(editsOf(segs, 20_000)).toEqual([]); // fin exclusive de « a »
    expect(editToSource(segs, editMs(15_000))).toBeNull();
    expect(editToSource(segs, editMs(14_999))).toMatchObject({ srcMs: 34_999 });
  });
});

describe('déplacement de segments', () => {
  const segs = [src('a', 0, 4_000), src('b', 10_000, 12_000), src('c', 20_000, 23_000)];

  it('recalcule les positions ; le contenu suit son segment', () => {
    const moved = moveSegment(segs, 'c', 0);
    expect(moved.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    // 21 s était à 7 s de montage ; « c » passe en premier → 1 s.
    expect(editsOf(segs, 21_000)).toEqual([7_000]);
    expect(editsOf(moved, 21_000)).toEqual([1_000]);
    // Un sous-titre ancré sur 11 s suit « b ».
    const caption = {
      anchor: 'source',
      srcStartMs: sourceMs(11_000),
      srcEndMs: sourceMs(11_500),
    } as const;
    expect(resolveTiming(segs, caption).ranges[0]).toMatchObject({ editStartMs: 5_000 });
    expect(resolveTiming(moved, caption).ranges[0]).toMatchObject({ editStartMs: 8_000 });
    expect(totalEditDuration(moved)).toBe(totalEditDuration(segs));
  });

  it('un élément ancré au montage garde sa position', () => {
    const title = { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 1_500 } as const;
    expect(resolveTiming(moveSegment(segs, 'c', 0), title).ranges[0]).toMatchObject({
      editStartMs: 0,
      editEndMs: 1_500,
    });
  });

  it('refuse un segment inconnu', () => {
    expect(() => moveSegment(segs, 'zz', 0)).toThrow(RangeError);
  });
});

describe('replays', () => {
  // Le passage [5 s, 8 s[ est montré, puis rejoué au ralenti (vitesse 0,5).
  const segs = [src('orig', 0, 8_000), src('replay', 5_000, 8_000, 0.5)];

  it('un instant source a plusieurs positions de montage', () => {
    expect(editsOf(segs, 6_000)).toEqual([6_000, 8_000 + 2_000]);
    expect(totalEditDuration(segs)).toBe(8_000 + 6_000);
  });

  it('un sous-titre apparaît à chaque occurrence, ou seulement à la première', () => {
    const t = { anchor: 'source', srcStartMs: sourceMs(6_000), srcEndMs: sourceMs(7_000) } as const;
    expect(resolveTiming(segs, t, 'all').ranges.map((r) => [r.editStartMs, r.editEndMs])).toEqual([
      [6_000, 7_000],
      [10_000, 12_000],
    ]);
    expect(resolveTiming(segs, t, 'first').ranges).toHaveLength(1);
  });

  it('les plages source qui se chevauchent sont valides', () => {
    expect(validateSegments(segs, 60_000)).toEqual([]);
  });
});

describe('arrêts sur image', () => {
  // 0–3 s, arrêt de 1,5 s sur l'image à 3 s, puis 3–5 s.
  const segs = [src('a', 0, 3_000), freeze('f', 3_000, 1_500), src('b', 3_000, 5_000)];

  it('le montage avance, la source reste figée', () => {
    expect(totalEditDuration(segs)).toBe(6_500);
    expect(editToSource(segs, editMs(3_200))).toEqual({
      kind: 'source',
      srcMs: 3_000,
      segmentId: 'f',
      frozen: true,
    });
    expect(editToSource(segs, editMs(4_400))).toMatchObject({ srcMs: 3_000, frozen: true });
    expect(editToSource(segs, editMs(4_500))).toEqual({
      kind: 'source',
      srcMs: 3_000,
      segmentId: 'b',
      frozen: false,
    });
  });

  it('un élément actif à l’image figée reste affiché pendant l’arrêt', () => {
    const r = sourceRangeToEditRanges(segs, sourceMs(2_500), sourceMs(3_500));
    expect(r.map((x) => [x.editStartMs, x.editEndMs, x.frozen])).toEqual([
      [2_500, 3_000, false],
      [3_000, 4_500, true],
      [4_500, 5_000, false],
    ]);
  });

  it('l’arrêt n’est pas une lecture du contenu (conversion ponctuelle)', () => {
    expect(editsOf(segs, 3_000)).toEqual([4_500]);
  });

  it('modifier la durée de l’arrêt décale la suite', () => {
    const longer = updateSegment(segs, 'f', { editDurMs: 2_500 });
    expect(editsOf(longer, 4_000)).toEqual([6_500]);
  });
});

describe('modification de la durée des segments', () => {
  const segs = [src('a', 0, 10_000), src('b', 20_000, 30_000)];
  const outro = { anchor: 'edit', from: 'end', offsetMs: 0, durMs: 2_000 } as const;
  const title = { anchor: 'edit', from: 'start', offsetMs: 15_000, durMs: 3_000 } as const;
  const caption = {
    anchor: 'source',
    srcStartMs: sourceMs(25_000),
    srcEndMs: sourceMs(26_000),
  } as const;

  it('rogner un segment décale les suivants ; le contenu reste sur sa parole', () => {
    const trimmed = updateSegment(segs, 'a', { srcStartMs: sourceMs(4_000) });
    expect(totalEditDuration(trimmed)).toBe(16_000);
    expect(resolveTiming(segs, caption).ranges[0]?.editStartMs).toBe(15_000);
    expect(resolveTiming(trimmed, caption).ranges[0]?.editStartMs).toBe(11_000); // 6 s (a rogné) + 5 s
    expect(srcAt(trimmed, 11_000).srcMs).toBe(25_000);
  });

  it('accélérer un segment raccourcit le montage', () => {
    const fast = updateSegment(segs, 'b', { speed: 2 });
    expect(totalEditDuration(fast)).toBe(15_000);
    expect(editsOf(fast, 26_000)).toEqual([13_000]);
    expect(srcAt(fast, 13_000).srcMs).toBe(26_000);
  });

  it('un carton de fin reste collé à la fin', () => {
    const trimmed = updateSegment(segs, 'b', { srcEndMs: sourceMs(25_000) });
    expect(resolveTiming(trimmed, outro).ranges[0]).toMatchObject({
      editStartMs: 13_000,
      editEndMs: 15_000,
    });
  });

  it('un élément ancré au montage qui sort du clip est signalé, pas déplacé', () => {
    const trimmed = updateSegment(segs, 'b', { srcEndMs: sourceMs(26_000) }); // durée 16 s
    const r = resolveTiming(trimmed, title);
    expect(r.outOfBounds).toBe(true);
    expect(r.ranges[0]).toMatchObject({ editStartMs: 15_000, editEndMs: 18_000 });
  });
});

describe('validation', () => {
  it('détecte les segments invalides', () => {
    const codes = validateSegments(
      [src('a', 5_000, 5_000), src('a', 0, 1_000, 10), src('c', 0, 90_000), freeze('d', 1_000, 0)],
      60_000,
    ).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'INVALID_RANGE',
        'DUPLICATE_ID',
        'INVALID_SPEED',
        'OUT_OF_SOURCE',
        'ZERO_DURATION',
      ]),
    );
    expect(validateSegments([]).map((i) => i.code)).toEqual(['EMPTY']);
  });

  it('le schéma Zod applique une vitesse par défaut et refuse les champs inconnus', () => {
    expect(
      SegmentSchema.parse({ id: 'a', kind: 'source', srcStartMs: 0, srcEndMs: 10 }),
    ).toMatchObject({ speed: 1 });
    expect(
      SegmentSchema.safeParse({ id: 'a', kind: 'freeze', srcAtMs: 0, editDurMs: 10, x: 1 }).success,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Tests de propriétés : montages aléatoires (coupes, replays, arrêts, */
/* vitesses, ordre quelconque)                                          */
/* ------------------------------------------------------------------ */

// Nombre de montages aléatoires par propriété (FC_RUNS=5000 npm test pour un passage approfondi).
fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 200) });

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const arbSegment = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .record({
        start: fc.integer({ min: 0, max: 600_000 }),
        len: fc.integer({ min: 50, max: 60_000 }),
        speed: fc.constantFrom(...SPEEDS),
      })
      .map(({ start, len, speed }) => ({ kind: 'source' as const, start, len, speed })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ at: fc.integer({ min: 0, max: 660_000 }), dur: fc.integer({ min: 1, max: 5_000 }) })
      .map(({ at, dur }) => ({ kind: 'freeze' as const, at, dur })),
  },
);
const arbTimeline = fc
  .array(arbSegment, { minLength: 1, maxLength: 10 })
  .map((raw) =>
    raw.map((r, i): Segment =>
      r.kind === 'source'
        ? src(`s${i}`, r.start, r.start + r.len, r.speed)
        : freeze(`f${i}`, r.at, r.dur),
    ),
  );
const tolerance = (speed: number) => Math.ceil(1.5 * speed) + 1;

describe('propriétés', () => {
  it('durée totale = somme des durées ; aucun trou en temps montage', () => {
    fc.assert(
      fc.property(arbTimeline, (segs) => {
        const placed = placeSegments(segs);
        placed.forEach((p, i) => {
          if (i > 0) expect(p.editStartMs).toBe(placed[i - 1]!.editEndMs);
        });
        expect(placed.at(-1)!.editEndMs).toBe(totalEditDuration(segs));
      }),
    );
  });

  it('source → montage → source retombe sur le même instant (à l’arrondi près)', () => {
    fc.assert(
      fc.property(arbTimeline, fc.double({ min: 0, max: 1, noNaN: true }), (segs, r) => {
        for (const seg of segs) {
          if (seg.kind !== 'source') continue;
          const s = seg.srcStartMs + Math.floor(r * (seg.srcEndMs - seg.srcStartMs - 1));
          const positions = sourceToEdit(segs, sourceMs(s));
          // Ce segment contient s : au moins une occurrence le concerne.
          const mine = positions.find((p) => p.segmentId === seg.id);
          expect(mine).toBeDefined();
          const back = srcAt(segs, mine!.editMs);
          expect(back.segmentId).toBe(seg.id);
          expect(Math.abs(back.srcMs - s)).toBeLessThanOrEqual(
            seg.speed === 1 ? 0 : tolerance(seg.speed),
          );
        }
      }),
    );
  });

  it('tout instant du montage a une source, qui le retrouve parmi ses occurrences', () => {
    fc.assert(
      fc.property(arbTimeline, fc.double({ min: 0, max: 1, noNaN: true }), (segs, r) => {
        const total = totalEditDuration(segs);
        const t = Math.min(total - 1, Math.floor(r * total));
        const pos = srcAt(segs, t);
        if (pos.frozen) return;
        const seg = segs.find((x) => x.id === pos.segmentId) as Extract<
          Segment,
          { kind: 'source' }
        >;
        const occ = sourceToEdit(segs, pos.srcMs).find((p) => p.segmentId === seg.id)!;
        expect(Math.abs(occ.editMs - t)).toBeLessThanOrEqual(
          seg.speed === 1 ? 0 : tolerance(1 / seg.speed),
        );
      }),
    );
  });

  it('conversions monotones à l’intérieur d’un segment', () => {
    fc.assert(
      fc.property(arbTimeline, (segs) => {
        for (const seg of segs) {
          if (seg.kind !== 'source') continue;
          let prev = -1;
          const step = Math.max(1, Math.floor((seg.srcEndMs - seg.srcStartMs) / 25));
          for (let s: number = seg.srcStartMs; s < seg.srcEndMs; s += step) {
            const e = sourceToEdit(segs, sourceMs(s)).find((p) => p.segmentId === seg.id)!.editMs;
            expect(e).toBeGreaterThanOrEqual(prev);
            prev = e;
          }
        }
      }),
    );
  });

  it('les morceaux d’une plage restent dans leur segment et dans le clip', () => {
    fc.assert(
      fc.property(
        arbTimeline,
        fc.integer({ min: 0, max: 660_000 }),
        fc.integer({ min: 1, max: 120_000 }),
        (segs, a, len) => {
          const placed = new Map(placeSegments(segs).map((p) => [p.segment.id, p]));
          for (const r of sourceRangeToEditRanges(segs, sourceMs(a), sourceMs(a + len))) {
            const p = placed.get(r.segmentId)!;
            expect(r.editStartMs).toBeGreaterThanOrEqual(p.editStartMs);
            expect(r.editEndMs).toBeLessThanOrEqual(p.editEndMs);
            expect(r.editEndMs).toBeGreaterThan(r.editStartMs);
          }
        },
      ),
    );
  });

  it('déplacer un segment ne change ni la durée totale ni le contenu de ce segment', () => {
    fc.assert(
      fc.property(arbTimeline, fc.nat(), fc.nat(), (segs, i, j) => {
        const seg = segs[i % segs.length]!;
        const moved = moveSegment(segs, seg.id, j % segs.length);
        expect(totalEditDuration(moved)).toBe(totalEditDuration(segs));
        const before = placeSegments(segs).find((p) => p.segment.id === seg.id)!;
        const after = placeSegments(moved).find((p) => p.segment.id === seg.id)!;
        expect(after.editEndMs - after.editStartMs).toBe(before.editEndMs - before.editStartMs);
      }),
    );
  });
});

describe('vide (suppression sans décalage)', () => {
  const gap = (id: string, dur: number): Segment => ({ id, kind: 'gap', editDurMs: dur });
  const segs = [src('a', 0, 3_000), gap('g', 2_000), src('b', 10_000, 12_000)];

  it('type de retour exact d’editToSource : source, vide, ou null hors du clip seulement', () => {
    expect(totalEditDuration(segs)).toBe(7_000);
    expect(editToSource(segs, editMs(2_999))).toEqual({
      kind: 'source',
      srcMs: 2_999,
      segmentId: 'a',
      frozen: false,
    });
    expect(editToSource(segs, editMs(3_000))).toEqual({ kind: 'gap', segmentId: 'g' });
    expect(editToSource(segs, editMs(4_999))).toEqual({ kind: 'gap', segmentId: 'g' });
    expect(editToSource(segs, editMs(5_000))).toEqual({
      kind: 'source',
      srcMs: 10_000,
      segmentId: 'b',
      frozen: false,
    });
    // null : uniquement hors du clip, jamais pour un vide.
    expect(editToSource(segs, editMs(7_000))).toBeNull();
  });

  it('un vide ne porte aucun contenu source : rien n’y est placé, le reste suit', () => {
    expect(sourceToEdit(segs, sourceMs(10_500)).map((p) => p.editMs)).toEqual([5_500]);
    const ranges = sourceRangeToEditRanges(segs, sourceMs(0), sourceMs(20_000));
    expect(ranges.map((r) => r.segmentId)).toEqual(['a', 'b']);
    expect(placeSegments(segs).map((p) => [p.editStartMs, p.editEndMs])).toEqual([
      [0, 3_000],
      [3_000, 5_000],
      [5_000, 7_000],
    ]);
  });

  it('validation : durée entière positive', () => {
    expect(validateSegments([src('a', 0, 1_000), gap('g', 0)]).map((i) => i.code)).toContain(
      'ZERO_DURATION',
    );
    expect(validateSegments([src('a', 0, 1_000), gap('g', 1.5)]).map((i) => i.code)).toContain(
      'NOT_INTEGER',
    );
  });
});
