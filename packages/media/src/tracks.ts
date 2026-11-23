import type { TrackRole, TrackRoleSource } from '@acs/shared';
import type { AudioTrackInfo } from './probe';

export interface ResolvedTrack {
  audioIndex: number;
  role: TrackRole;
  roleSource: TrackRoleSource;
}

/** Mots-clés reconnus dans le nom de piste OBS (insensible à la casse et aux accents). */
const TITLE_RULES: readonly [RegExp, TrackRole][] = [
  [/\bdiscord\b/, 'discord'],
  [/\b(mic|micro|microphone|voix|voice)\b/, 'mic'],
  [/\b(tout|all|mix|global|stream|master)\b/, 'mix'],
  [/\b(jeu|game|desktop|bureau|navigateur|browser)\b/, 'game'],
];

export function roleFromTitle(title: string | null): TrackRole | null {
  if (!title) return null;
  const t = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [re, role] of TITLE_RULES) if (re.test(t)) return role;
  return null;
}

/**
 * Détermine le rôle de chaque piste, par priorité :
 *  1. rôles imposés à l'import (override) ;
 *  2. fichier à piste unique (MP4 de secours) → mix ;
 *  3. nom de piste OBS reconnu ;
 *  4. ordre configuré (AUDIO_TRACK_ROLES) ;
 *  5. inconnu.
 */
export function resolveTrackRoles(
  tracks: readonly AudioTrackInfo[],
  configured: readonly TrackRole[],
  override?: readonly TrackRole[],
): ResolvedTrack[] {
  return tracks.map((t) => {
    const forced = override?.[t.audioIndex];
    if (forced) return { audioIndex: t.audioIndex, role: forced, roleSource: 'override' };
    if (tracks.length === 1)
      return { audioIndex: t.audioIndex, role: 'mix', roleSource: 'single_track' };
    const fromTitle = roleFromTitle(t.title);
    if (fromTitle) return { audioIndex: t.audioIndex, role: fromTitle, roleSource: 'title' };
    const fromConfig = configured[t.audioIndex];
    if (fromConfig) return { audioIndex: t.audioIndex, role: fromConfig, roleSource: 'config' };
    return { audioIndex: t.audioIndex, role: 'unknown', roleSource: 'default' };
  });
}

/**
 * Pistes à transcrire : les voix séparées (micro, Discord) si elles existent —
 * cela donne naturellement « créateur » vs « coéquipiers ». Sinon, le mix.
 * La piste mix n'est jamais transcrite en plus des voix séparées (doublons).
 */
export function selectTranscriptionTracks(tracks: readonly ResolvedTrack[]): ResolvedTrack[] {
  const voices = tracks.filter((t) => t.role === 'mic' || t.role === 'discord');
  if (voices.length) return voices;
  const mix = tracks.filter((t) => t.role === 'mix');
  if (mix.length) return mix.slice(0, 1);
  return tracks.filter((t) => t.role === 'unknown').slice(0, 1);
}
