import { describe, expect, it } from 'vitest';
import { decideRange, rangeHeaders } from './http-range';

const SIZE = 1000;

describe('requêtes Range', () => {
  it('sans Range → fichier entier (200)', () => {
    expect(decideRange(undefined, SIZE)).toEqual({ kind: 'full' });
    expect(rangeHeaders({ kind: 'full' }, SIZE)).toEqual({ 'content-length': '1000' });
  });

  it('plage fermée, ouverte et suffixe → 206 avec Content-Range et Content-Length exacts', () => {
    expect(decideRange('bytes=0-99', SIZE)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(rangeHeaders({ kind: 'partial', start: 0, end: 99 }, SIZE)).toEqual({
      'content-range': 'bytes 0-99/1000',
      'content-length': '100',
    });
    expect(decideRange('bytes=900-', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(decideRange('bytes=-100', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(decideRange('bytes=-5000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
    expect(decideRange('bytes=990-5000', SIZE)).toEqual({ kind: 'partial', start: 990, end: 999 });
    expect(decideRange('bytes=999-999', SIZE)).toEqual({ kind: 'partial', start: 999, end: 999 });
    expect(decideRange(' Bytes = 10 - 20 ', SIZE)).toEqual({ kind: 'partial', start: 10, end: 20 });
  });

  it('non satisfaisable → 416 avec Content-Range: bytes */taille', () => {
    for (const h of [
      'bytes=1000-',
      'bytes=1000-1001',
      'bytes=-0',
      'bytes=5-3',
      'bytes=99999999999999999999-',
    ])
      expect(decideRange(h, SIZE), h).toEqual({ kind: 'unsatisfiable' });
    expect(rangeHeaders({ kind: 'unsatisfiable' }, SIZE)).toEqual({
      'content-range': 'bytes */1000',
      'content-length': '0',
    });
  });

  it('plusieurs plages, syntaxe invalide ou If-Range → fichier entier (en-tête ignoré)', () => {
    for (const h of [
      'bytes=0-1,5-9',
      'items=0-5',
      'bytes=abc',
      'bytes=-',
      'bytes=1-2-3',
      'bytes=-1-2',
      '',
    ])
      expect(decideRange(h, SIZE), h).toEqual({ kind: 'full' });
    expect(decideRange('bytes=0-99', SIZE, '"etag"')).toEqual({ kind: 'full' });
  });

  it('fichier vide ou d’un octet', () => {
    expect(decideRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(decideRange('bytes=-1', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(decideRange(undefined, 0)).toEqual({ kind: 'full' });
    expect(decideRange('bytes=0-0', 1)).toEqual({ kind: 'partial', start: 0, end: 0 });
    expect(decideRange('bytes=-1', 1)).toEqual({ kind: 'partial', start: 0, end: 0 });
  });
});
