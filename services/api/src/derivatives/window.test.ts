import { describe, expect, it } from 'vitest';
import { clipWindow } from './window';

const opts = { marginMs: 30_000, gridMs: 30_000, durationMs: 3_600_000 };

describe('clipWindow', () => {
  it('ajoute une marge et s’aligne sur la grille', () => {
    expect(clipWindow(100_000, 140_000, opts)).toEqual({ startMs: 60_000, endMs: 180_000 });
  });
  it('deux clips proches partagent la même fenêtre', () => {
    expect(clipWindow(95_000, 130_000, opts)).toEqual(clipWindow(100_000, 140_000, opts));
  });
  it('reste dans l’enregistrement', () => {
    expect(clipWindow(5_000, 10_000, opts).startMs).toBe(0);
    expect(clipWindow(3_590_000, 3_599_000, opts).endMs).toBe(3_600_000);
  });
  it('sans durée connue, ne borne pas la fin', () => {
    expect(clipWindow(3_590_000, 3_599_000, { ...opts, durationMs: null }).endMs).toBe(3_630_000);
  });
});
