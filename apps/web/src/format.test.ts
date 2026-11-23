import { describe, expect, it } from 'vitest';
import { describeDevices, formatDuration, formatSourceMs } from './format';

describe('formatSourceMs', () => {
  it('heures, minutes, secondes et millisecondes', () => {
    expect(formatSourceMs(0)).toBe('00:00:00.000');
    expect(formatSourceMs(3_723_045)).toBe('01:02:03.045');
    expect(formatSourceMs(8 * 3_600_000 + 59)).toBe('08:00:00.059');
  });
});

describe('formatDuration', () => {
  it('lisible', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
  });
});

describe('describeDevices', () => {
  it('n’affiche « GPU » que si tous les blocs ont tourné sur CUDA', () => {
    expect(describeDevices(['cuda'], null)).toBe('GPU (CUDA)');
    expect(describeDevices(['cpu'], null)).toBe('CPU');
    expect(describeDevices(['cpu'], 'RuntimeError: cudnn')).toBe('CPU (repli après échec CUDA)');
    expect(describeDevices(['cpu', 'cuda'], 'x')).toMatch(/^Mixte/);
    expect(describeDevices([], null)).toBe('—');
  });
});
