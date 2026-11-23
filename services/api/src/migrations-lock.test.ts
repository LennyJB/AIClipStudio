import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './db';

/**
 * Une migration publiée ne doit JAMAIS être modifiée (les bases existantes ne la
 * rejoueraient pas) : on en ajoute une nouvelle. Ce test fige l'empreinte du SQL
 * de chaque migration. Pour une NOUVELLE migration, ajouter sa ligne ci-dessous.
 */
const LOCKED: Record<number, string> = {
  1: 'b55784f6613fc6e331c1953ac6d4f841d81614980bdb302cc7be1ea647758dbb',
  2: 'f4dfc7ac93af0dcef25832912037b9c489ccda20b47e4368ae03a536296ed88a',
};

const fingerprint = (m: (typeof MIGRATIONS)[number]) =>
  createHash('sha256')
    .update(`${m.version}\n${m.name}\n${m.sql ?? ''}`)
    .digest('hex');

describe('migrations', () => {
  it('sont numérotées de 1 à N sans trou ni doublon', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('chaque migration est verrouillée et n’a pas été modifiée depuis sa publication', () => {
    for (const m of MIGRATIONS) {
      expect(
        LOCKED[m.version],
        `migration ${m.version} non verrouillée : ajoutez son empreinte`,
      ).toBeDefined();
      expect(
        fingerprint(m),
        `migration ${m.version} (${m.name}) modifiée : créez une nouvelle migration`,
      ).toBe(LOCKED[m.version]);
    }
  });
});
