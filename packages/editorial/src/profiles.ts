import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AppError,
  CONTENT_TYPES,
  ContentProfileSchema,
  CreatorProfileSchema,
  FramingProfileSchema,
  GameProfileSchema,
  type ContentProfile,
  type ContentType,
  type CreatorProfile,
  type FramingProfile,
  type GameProfile,
} from '@acs/shared';
import { stableHash } from './hash';
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

/** Profil de cadrage (profiles/framing/<id>.json). */
export async function loadFramingProfile(
  profilesDir: string,
  framingId: string,
): Promise<FramingProfile> {
  if (!/^[a-z0-9-]+$/.test(framingId)) {
    throw new AppError('PROFILE_NOT_FOUND', `Identifiant de cadrage invalide : "${framingId}"`);
  }
  const filePath = path.join(profilesDir, 'framing', `${framingId}.json`);
  const profile = parseWith(FramingProfileSchema, await readJson(filePath), filePath);
  if (profile.id !== framingId) {
    throw new AppError(
      'PROFILE_INVALID',
      `L'id "${profile.id}" ne correspond pas au nom de fichier ${framingId}.json`,
    );
  }
  return profile;
}

export async function listFramingProfiles(profilesDir: string): Promise<FramingProfile[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(profilesDir, 'framing'));
  } catch {
    return [];
  }
  const ids = entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  return Promise.all(ids.map((id) => loadFramingProfile(profilesDir, id)));
}

/** Nom de fichier d'un type de contenu (kebab-case) : `just_chatting` → `just-chatting.json`. */
export const contentProfileFile = (type: ContentType) => `${type.replace(/_/gu, '-')}.json`;

/**
 * Profils des types de contenu (profiles/content/). Tous les types sont obligatoires : un
 * fichier manquant ou invalide est une erreur explicite (jamais un format silencieusement ignoré).
 */
export async function loadContentProfiles(
  profilesDir: string,
): Promise<Record<ContentType, ContentProfile>> {
  const out = {} as Record<ContentType, ContentProfile>;
  for (const type of CONTENT_TYPES) {
    const filePath = path.join(profilesDir, 'content', contentProfileFile(type));
    const profile = parseWith(ContentProfileSchema, await readJson(filePath), filePath);
    if (profile.id !== type) {
      throw new AppError(
        'PROFILE_INVALID',
        `L'id "${profile.id}" ne correspond pas au fichier ${contentProfileFile(type)}`,
      );
    }
    out[type] = profile;
  }
  return out;
}

/** Empreinte d'un profil validé : une modification du fichier invalide sa validation. */
export function profileHash(profile: unknown): string {
  return stableHash(profile);
}
