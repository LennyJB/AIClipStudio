import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '@acs/shared';
import { loadGameProfile } from './profiles';

async function tempProfiles(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'acs-profiles-'));
  await mkdir(path.join(dir, 'games'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, 'games', name), content);
  }
  return dir;
}

const valid = {
  schemaVersion: 1,
  id: 'test-game',
  displayName: 'Test',
  context: 'Jeu de test',
};

describe('loadGameProfile', () => {
  it('charge un profil valide et applique les valeurs par défaut', async () => {
    const dir = await tempProfiles({ 'test-game.json': JSON.stringify(valid) });
    const p = await loadGameProfile(dir, 'test-game');
    expect(p.vocabulary).toEqual([]);
  });

  it('refuse un identifiant pouvant sortir du dossier (path traversal)', async () => {
    const dir = await tempProfiles({});
    await expect(loadGameProfile(dir, '../creator')).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
  });

  it('signale un JSON invalide', async () => {
    const dir = await tempProfiles({ 'test-game.json': '{ invalide' });
    await expect(loadGameProfile(dir, 'test-game')).rejects.toMatchObject({
      code: 'PROFILE_INVALID',
    });
  });

  it('rejette les champs inconnus (schéma strict)', async () => {
    const dir = await tempProfiles({ 'test-game.json': JSON.stringify({ ...valid, extra: 1 }) });
    await expect(loadGameProfile(dir, 'test-game')).rejects.toBeInstanceOf(AppError);
  });

  it('rejette un id incohérent avec le nom de fichier', async () => {
    const dir = await tempProfiles({ 'autre.json': JSON.stringify(valid) });
    await expect(loadGameProfile(dir, 'autre')).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
  });
});
