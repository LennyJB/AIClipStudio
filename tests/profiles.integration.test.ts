import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_GAME_PROFILE_ID,
  listGameProfileIds,
  loadCreatorProfile,
  loadGameProfile,
} from '@acs/editorial';

const PROFILES_DIR = path.resolve(fileURLToPath(new URL('../profiles', import.meta.url)));

describe('profils versionnés du dépôt', () => {
  it('le profil créateur est valide', async () => {
    const creator = await loadCreatorProfile(PROFILES_DIR);
    expect(creator.editingStyle.rules.length).toBeGreaterThan(0);
  });

  it('contient les profils de jeu attendus, tous valides', async () => {
    const ids = await listGameProfileIds(PROFILES_DIR);
    expect(ids).toEqual(
      expect.arrayContaining(['fortnite', 'minecraft', 'valorant', GENERIC_GAME_PROFILE_ID]),
    );
    for (const id of ids) {
      await expect(loadGameProfile(PROFILES_DIR, id)).resolves.toMatchObject({ id });
    }
  });
});
