import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeOutputPath, isInside } from './safe-path';

const root = path.resolve('/data/storage/processing');

describe('chemins de sortie', () => {
  it('isInside', () => {
    expect(isInside(root, path.join(root, 'a', 'b.wav'))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, path.join(root, '..', 'originals', 'x.wav'))).toBe(false);
    expect(isInside(root, path.resolve('/data/storage/processing-evil/x.wav'))).toBe(false);
  });

  it('refuse d’écrire hors du dossier de travail', () => {
    expect(() => assertSafeOutputPath('/tmp/x.wav', root, '/videos/a.mkv')).toThrow(
      /dossier de travail/,
    );
  });

  it('refuse d’écraser le fichier original', () => {
    const src = path.join(root, 'a.mkv');
    expect(() => assertSafeOutputPath(src, root, src)).toThrow(/original/);
  });
});
