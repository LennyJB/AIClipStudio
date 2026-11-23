import { describe, expect, it } from 'vitest';
import { devicesComparable } from './comparison';

const t = (...devicesUsed: ('cuda' | 'cpu')[]) => ({ devicesUsed });

describe('devicesComparable', () => {
  it('même périphérique unique pour toutes : comparable', () => {
    expect(devicesComparable([t('cuda'), t('cuda')])).toBe(true);
    expect(devicesComparable([t('cpu'), t('cpu'), t('cpu')])).toBe(true);
  });

  it('un modèle sur GPU, l’autre sur CPU : NON comparable', () => {
    expect(devicesComparable([t('cuda'), t('cpu')])).toBe(false);
    expect(devicesComparable([t('cpu'), t('cuda')])).toBe(false);
  });

  it('une transcription mixte (repli en cours de route) n’est jamais comparable', () => {
    expect(devicesComparable([t('cuda', 'cpu'), t('cuda', 'cpu')])).toBe(false);
    expect(devicesComparable([t('cuda'), t('cpu', 'cuda')])).toBe(false);
  });

  it('les transcriptions sans bloc enregistré sont ignorées', () => {
    expect(devicesComparable([t('cuda'), t()])).toBe(true);
    expect(devicesComparable([t(), t()])).toBe(true);
  });
});
