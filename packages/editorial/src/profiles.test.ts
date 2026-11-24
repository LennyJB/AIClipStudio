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

describe('profils de cadrage et durée des clips', () => {
  it('les profils de cadrage du dépôt sont valides', async () => {
    const { listFramingProfiles } = await import('./profiles');
    const profiles = await listFramingProfiles(
      path.resolve(import.meta.dirname, '../../../profiles'),
    );
    expect(profiles.map((p) => p.id)).toEqual(
      expect.arrayContaining(['plein-ecran', 'exemple-facecam-bas-droite']),
    );
  });

  it('refuse une zone qui sort de l’image et un identifiant dangereux', async () => {
    const { loadFramingProfile } = await import('./profiles');
    const dir = await mkdtemp(path.join(tmpdir(), 'acs-framing-'));
    await mkdir(path.join(dir, 'framing'));
    await writeFile(
      path.join(dir, 'framing', 'x.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'x',
        displayName: 'X',
        gameplay: { x: 0.5, y: 0, w: 0.6, h: 1 },
        facecam: null,
      }),
    );
    await expect(loadFramingProfile(dir, 'x')).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
    await expect(loadFramingProfile(dir, '../x')).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
  });

  it('durée par défaut 20–80 s (profil créateur), remplaçable par le profil de jeu', async () => {
    const { loadCreatorProfile } = await import('./profiles');
    const { effectiveClipDuration } = await import('@acs/shared');
    const root = path.resolve(import.meta.dirname, '../../../profiles');
    const creator = await loadCreatorProfile(root);
    const game = await loadGameProfile(root, 'valorant');
    expect(effectiveClipDuration(creator, game)).toMatchObject({ minSeconds: 20, maxSeconds: 80 });
    expect(
      effectiveClipDuration(creator, { ...game, clipDuration: { minSeconds: 30, maxSeconds: 60 } }),
    ).toMatchObject({ minSeconds: 30, maxSeconds: 60 });
  });

  it('l’empreinte d’un profil change si son contenu change', async () => {
    const { profileHash } = await import('./profiles');
    expect(profileHash({ a: 1, b: [1, 2] })).toBe(profileHash({ b: [1, 2], a: 1 }));
    expect(profileHash({ a: 1 })).not.toBe(profileHash({ a: 2 }));
  });
});
