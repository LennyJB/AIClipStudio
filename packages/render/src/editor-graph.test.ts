/**
 * Même enveloppe dans l'aperçu et dans l'export (PR 7e) : les expressions FFmpeg produites par
 * `editor-graph.ts` sont ÉVALUÉES (mini-évaluateur du sous-ensemble utilisé) et comparées, instant
 * par instant, aux fonctions pures de `@acs/timeline` qu'utilisent le canvas et Web Audio.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  audioEffectGainsAt,
  automationGainDb,
  dbToGain,
  flashAlphaAt,
  MASK_TIME_MARGIN_MS,
  shakeOffsetAt,
  zoomCenterAt,
  zoomFactorAt,
} from '@acs/timeline';
import {
  automationFilter,
  compositeEffectParts,
  maskFilters,
  masterFadeFilter,
  sourceEffectsFilter,
  zoompanCentered,
} from './editor-graph';

/* ------------------------- Mini-évaluateur d'expressions ------------------------- */

type Env = Record<string, number>;
const FUNCS: Record<string, (...a: number[]) => number> = {
  clip: (x, a, b) => Math.min(b!, Math.max(a!, x!)),
  min: (a, b) => Math.min(a!, b!),
  max: (a, b) => Math.max(a!, b!),
  between: (x, a, b) => (x! >= a! && x! <= b! ? 1 : 0),
  lt: (a, b) => (a! < b! ? 1 : 0),
  gte: (a, b) => (a! >= b! ? 1 : 0),
  sin: (x) => Math.sin(x!),
  pow: (a, b) => a! ** b!,
  // FFmpeg : round() arrondit à l'entier le plus proche, demi vers l'extérieur.
  round: (x) => Math.sign(x!) * Math.round(Math.abs(x!)),
};

export function evalExpr(src: string, env: Env): number {
  let i = 0;
  const peek = () => src[i];
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const factor = (): number => {
    const c = peek();
    if (c === '-') {
      i++;
      return -factor();
    }
    if (c === '(') {
      i++;
      const v = expr();
      i++; // ')'
      return v;
    }
    const num = /^[0-9.]+(e-?\d+)?/u.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[A-Za-z_]+/u.exec(src.slice(i));
    if (!id) throw new Error(`expression illisible à ${i} : ${src.slice(i, i + 20)}`);
    i += id[0].length;
    if (peek() === '(') {
      i++;
      const args: number[] = [];
      if (id[0] === 'if') {
        const cond = expr();
        i++; // ','
        const a = expr();
        i++;
        const b = expr();
        i++; // ')'
        return cond !== 0 ? a : b;
      }
      for (;;) {
        args.push(expr());
        if (src[i++] === ')') break;
      }
      const f = FUNCS[id[0]];
      if (!f) throw new Error(`fonction inconnue : ${id[0]}`);
      return f(...args);
    }
    if (id[0] === 'PI') return Math.PI;
    if (!(id[0] in env)) throw new Error(`variable inconnue : ${id[0]}`);
    return env[id[0]]!;
  };
  const v = expr();
  if (i !== src.length) throw new Error(`reste non lu : ${src.slice(i)}`);
  return v;
}

const quoted = (filter: string, key: string) => {
  const m = new RegExp(`${key}='([^']*)'`, 'u').exec(filter);
  if (!m) throw new Error(`${key} absent de ${filter}`);
  return m[1]!;
};

const window = fc
  .tuple(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 300, max: 10_000 }))
  .map(([a, d]) => ({ startS: a / 1000, endS: (a + d) / 1000 }));

describe('évaluateur', () => {
  it('opérateurs et fonctions du sous-ensemble', () => {
    expect(evalExpr('1+2*3-4/2', {})).toBe(5);
    expect(evalExpr('if(lt(t,2),clip(t,0,1),-3)', { t: 5 })).toBe(-3);
    expect(evalExpr('pow(10,-20/20)', {})).toBeCloseTo(0.1);
  });
});

describe('zooms : même facteur et même centre', () => {
  it('propriété : facteur de zoompan = zoomFactorAt, centre = zoomCenterAt', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(window, fc.double({ min: 1, max: 3, noNaN: true })), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        fc.double({ min: 0, max: 60, noNaN: true }),
        (ws, c, t) => {
          const zooms = ws.map(([w, f]) => ({ ...w, factor: Number(f.toFixed(4)) }));
          const pieces = ws.map(([w]) => ({ ...w, cx: Number(c.toFixed(4)), cy: 0.25 }));
          const f = zoompanCentered(zooms, pieces, 1080, 1920, 30);
          const z = evalExpr(quoted(f, 'z'), { it: t });
          expect(z).toBeCloseTo(zoomFactorAt(zooms, t), 3);
          const center = zoomCenterAt(pieces, t);
          const x = evalExpr(quoted(f, 'x'), { it: t, iw: 1080, zoom: z });
          expect(x).toBeCloseTo(
            Math.min(Math.max(center.cx * 1080 - 1080 / z / 2, 0), 1080 - 1080 / z),
            2,
          );
        },
      ),
    );
  });
});

describe('secousse et éclair', () => {
  it('propriété : décalage de la secousse = shakeOffsetAt (pixels entiers)', () => {
    fc.assert(
      fc.property(
        window,
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        fc.double({ min: 0, max: 60, noNaN: true }),
        (w, a, t) => {
          const amplitude = Number(a.toFixed(4));
          const { parts } = compositeEffectParts(
            '[in]',
            { zooms: [], zoomPieces: [], shakes: [{ ...w, amplitude }], flashes: [] },
            { width: 1080, height: 1920, fps: 30 },
          );
          const ov = parts.find((p) => p.includes('overlay=x='))!;
          const want = shakeOffsetAt({ ...w, amplitude }, t, 1080);
          // Bord de fin : l'aperçu exclut endS ; l'expression aussi (lt(t, e)).
          expect(evalExpr(quoted(ov, 'x'), { t })).toBeCloseTo(want.dx, 6);
          expect(evalExpr(quoted(ov, 'y'), { t })).toBeCloseTo(want.dy, 6);
        },
      ),
    );
  });

  it('éclair : opacité = intensité × (1 − progression), activé sur la fenêtre', () => {
    const { parts } = compositeEffectParts(
      '[in]',
      {
        zooms: [],
        zoomPieces: [],
        shakes: [],
        flashes: [{ startS: 2, endS: 2.5, intensity: 0.6 }],
      },
      { width: 1080, height: 1920, fps: 30 },
    );
    expect(parts[0]).toContain('colorchannelmixer=aa=0.6,fade=t=out:st=2:d=0.5:alpha=1');
    // fade=t=out : alpha × (1 − (t − st)/d), soit exactement flashAlphaAt.
    for (const t of [2, 2.1, 2.25, 2.49]) {
      expect(0.6 * (1 - (t - 2) / 0.5)).toBeCloseTo(
        flashAlphaAt({ startS: 2, endS: 2.5, intensity: 0.6 }, t),
        9,
      );
    }
    expect(parts[1]).toContain("enable='between(t,2,2.5)'");
  });
});

describe('audio : mêmes gains', () => {
  it('propriété : atténuation et bip sur les pistes = audioEffectGainsAt().source', () => {
    fc.assert(
      fc.property(
        window,
        window,
        fc.integer({ min: -60, max: 0 }),
        fc.double({ min: 0, max: 60, noNaN: true }),
        (wd, wb, g, t) => {
          const fx = [
            { type: 'duck' as const, params: { gainDb: g }, ...wd },
            { type: 'bleep' as const, params: { frequencyHz: 1000 }, ...wb },
          ];
          const f = sourceEffectsFilter(fx)!;
          expect(evalExpr(quoted(f, 'volume'), { t })).toBeCloseTo(
            audioEffectGainsAt(fx, t).source,
            6,
          );
        },
      ),
    );
  });

  it('propriété : fondus du mixage = audioEffectGainsAt().master (hors bornes exactes)', () => {
    fc.assert(
      fc.property(window, window, fc.double({ min: 0, max: 60, noNaN: true }), (wi, wo, t) => {
        const fx = [
          { type: 'fade_in' as const, params: {}, ...wi },
          { type: 'fade_out' as const, params: {}, ...wo },
        ];
        fc.pre(Math.abs(t - wi.endS) > 1e-6 && Math.abs(t - wo.endS) > 1e-6);
        const f = masterFadeFilter(fx)!;
        expect(evalExpr(quoted(f, 'volume'), { t })).toBeCloseTo(
          audioEffectGainsAt(fx, t).master,
          6,
        );
      }),
    );
  });

  it('propriété : automatisation de la branche = automationGainDb (temps source)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 100_000, max: 140_000 }), { minLength: 1, maxLength: 12 }),
        fc.array(fc.integer({ min: -60, max: 12 }), { minLength: 12, maxLength: 12 }),
        fc.integer({ min: 0, max: 20_000 }),
        (times, gains, offset) => {
          const points = [...times]
            .sort((a, b) => a - b)
            .map((srcMs, i) => ({ srcMs, gainDb: gains[i]! }));
          const f = automationFilter(points, 110_000, 130_000)!;
          const t = offset / 1000;
          const got = evalExpr(quoted(f, 'volume'), { t });
          expect(got).toBeCloseTo(dbToGain(automationGainDb(points, 110_000 + offset)), 4);
        },
      ),
    );
  });
});

describe('masques temporels : plage + marge, dans le temps de la branche', () => {
  it('propriété : l’aplat couvre tout instant de la plage (jamais moins masqué)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100_000, max: 140_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        (a, d, offset) => {
          const mask = {
            id: 'm',
            rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
            label: '',
            mode: 'opaque' as const,
            srcRange: { srcStartMs: a, srcEndMs: a + d },
          };
          const f = maskFilters(
            [mask],
            { width: 1920, height: 1080 },
            {
              srcStartMs: 110_000,
              srcEndMs: 130_000,
              frozenAtMs: null,
            },
          );
          const src = 110_000 + offset;
          const inside = src >= a && src < a + d;
          if (!f.length) {
            expect(inside).toBe(false);
            return;
          }
          const enable = /enable='([^']*)'/u.exec(f[0]!)?.[1];
          const on = enable ? evalExpr(enable, { t: offset / 1000 }) === 1 : true;
          if (inside) expect(on).toBe(true);
          // Hors de la plage + marge : aucun aplat.
          if (src < a - MASK_TIME_MARGIN_MS - 1 || src > a + d + MASK_TIME_MARGIN_MS + 1) {
            expect(on).toBe(false);
          }
        },
      ),
    );
  });
});
