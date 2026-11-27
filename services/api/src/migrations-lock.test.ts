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
  3: '73e699892fa982c610fb6e3565eee1951f3f1984ef6b02b2d1c7b2f8ec6c1409',
  4: 'cab47e494ffd7c9af9e757e63420953eb7608dde9bbf6061e21f997991b8aac6',
  5: '5ffbe04478cfee08d5f947a0e7c0efba30d5d55dc2042c93d41fd26de11540bc',
  6: '2bff8bbb69a2fb4d3f2f9cc787679e1fd14a21d0cc4fe85aa00e130ccc333080',
  7: 'e615ac299ce60f203db15ab54b4526a09e9ce66d9329846e72f75b3f4b58469a',
  8: '6431b44629b6a619e4a56d6f5ca309675384964cc7840d23182e501c36dac6e9',
  9: 'e52c479056bd3ff436dca6b21d70c63c48610d7f5a20199d50f8c3aafbfb8c09',
  10: '5fab0b0f357603d98e671d083752e429cd8e9ad4d93e41849280f70605ecf88d',
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
