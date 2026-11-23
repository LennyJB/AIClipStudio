import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  CreatorProfileSchema,
  GameProfileSchema,
  type CreatorProfile,
  type GameProfile,
} from '@acs/shared';
import type { z } from 'zod';

export const GENERIC_GAME_PROFILE_ID = 'generic';

async function readJson(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new AppError('PROFILE_NOT_FOUND', `Profil introuvable : ${filePath}`, { cause });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new AppError('PROFILE_INVALID', `JSON invalide dans ${filePath}`, { cause });
  }
}

function parseWith<T extends z.ZodType>(schema: T, data: unknown, filePath: string): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError('PROFILE_INVALID', `Profil invalide : ${filePath}`, {
      details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export async function loadCreatorProfile(profilesDir: string): Promise<CreatorProfile> {
  const filePath = path.join(profilesDir, 'creator.json');
  return parseWith(CreatorProfileSchema, await readJson(filePath), filePath);
}

export async function loadGameProfile(profilesDir: string, gameId: string): Promise<GameProfile> {
  // L'identifiant sert à construire un chemin : on refuse tout ce qui n'est pas kebab-case.
  if (!/^[a-z0-9-]+$/.test(gameId)) {
    throw new AppError('PROFILE_NOT_FOUND', `Identifiant de jeu invalide : "${gameId}"`);
  }
  const filePath = path.join(profilesDir, 'games', `${gameId}.json`);
  const profile = parseWith(GameProfileSchema, await readJson(filePath), filePath);
  if (profile.id !== gameId) {
    throw new AppError(
      'PROFILE_INVALID',
      `L'id "${profile.id}" ne correspond pas au nom de fichier ${gameId}.json`,
    );
  }
  return profile;
}

export async function listGameProfileIds(profilesDir: string): Promise<string[]> {
  const entries = await readdir(path.join(profilesDir, 'games'));
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}
