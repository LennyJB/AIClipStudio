/**
 * Audio exporté : quelles pistes peuvent être exportées, et quels sous-titres affichés.
 * docs/plan-etape-6.md §6.4 et §7.5. Fonction PURE, revérifiée à chaque rendu quel que soit le
 * contenu du document (un document ne peut jamais « ajouter » une piste non autorisée).
 *
 * Règle unique : une piste n'est exportable que si CHAQUE catégorie de voix de tiers qu'elle peut
 * contenir est soit déclarée absente, soit couverte par le consentement correspondant. Une
 * composition non déclarée est traitée comme « peut tout contenir ».
 */
import type { CaptionRole } from '@acs/timeline';
import { z } from 'zod';

export const VOICE_CATEGORIES = ['discord_voices', 'game_voice_chat', 'other_voices'] as const;
export type VoiceCategory = (typeof VOICE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<VoiceCategory, string> = {
  discord_voices: 'voix Discord',
  game_voice_chat: 'chat vocal du jeu',
  other_voices: 'autres voix de tiers',
};

const presence = z.enum(['present', 'absent']);
export const MixCompositionSchema = z
  .object({ discord: presence, gameVoiceChat: presence, otherVoices: presence })
  .strict();
export const GameCompositionSchema = z.object({ gameVoiceChat: presence }).strict();
export type MixComposition = z.infer<typeof MixCompositionSchema>;
export type GameComposition = z.infer<typeof GameCompositionSchema>;

export interface ExportAudioState {
  consents: Record<VoiceCategory, boolean>;
  /** Déclaration pour la piste « tout » (ou la piste unique / inconnue), null si absente. */
  mixComposition: MixComposition | null;
  /** Déclaration pour la piste jeu, null si absente. */
  gameComposition: GameComposition | null;
}

export const EMPTY_AUDIO_STATE: ExportAudioState = {
  consents: { discord_voices: false, game_voice_chat: false, other_voices: false },
  mixComposition: null,
  gameComposition: null,
};

export type TrackRoleIn = 'mic' | 'discord' | 'game' | 'mix' | 'unknown';

export interface TrackIn {
  audioIndex: number;
  role: TrackRoleIn;
}

export type MissingRequirement =
  | { kind: 'declaration'; subject: 'mix_composition' | 'game_composition' }
  | { kind: 'consent'; subject: VoiceCategory };

export interface TrackVerdict {
  audioIndex: number;
  role: TrackRoleIn;
  exportable: boolean;
  /** Ce qui manque pour que la piste soit exportable (vide si exportable). */
  missing: MissingRequirement[];
  reason: string;
}

export interface AudioDecision {
  tracks: TrackVerdict[];
  /**
   *  - individual : pistes séparées exportables (jamais superposées à la piste « tout ») ;
   *  - mix        : piste « tout » seule, faute de piste séparée exploitable ;
   *  - none       : rien d'exportable (refus au rendu, sauf export muet choisi explicitement).
   */
  mode: 'individual' | 'mix' | 'none';
  selected: TrackIn[];
  /** Sous-titres affichables : mêmes règles que l'audio. */
  captionRoles: CaptionRole[];
  /** Exigences manquantes pour que l'export ait de l'audio, si mode = none. */
  missing: MissingRequirement[];
}

function categoriesFor(
  role: TrackRoleIn,
  s: ExportAudioState,
): { needs: VoiceCategory[]; missingDeclaration: MissingRequirement | null } {
  switch (role) {
    case 'mic':
      return { needs: [], missingDeclaration: null };
    case 'discord':
      return { needs: ['discord_voices'], missingDeclaration: null };
    case 'game':
      if (!s.gameComposition) {
        return {
          needs: ['game_voice_chat'],
          missingDeclaration: { kind: 'declaration', subject: 'game_composition' },
        };
      }
      return {
        needs: s.gameComposition.gameVoiceChat === 'present' ? ['game_voice_chat'] : [],
        missingDeclaration: null,
      };
    case 'mix':
    case 'unknown': {
      const c = s.mixComposition;
      if (!c) {
        return {
          needs: [...VOICE_CATEGORIES],
          missingDeclaration: { kind: 'declaration', subject: 'mix_composition' },
        };
      }
      const needs: VoiceCategory[] = [];
      if (c.discord === 'present') needs.push('discord_voices');
      if (c.gameVoiceChat === 'present') needs.push('game_voice_chat');
      if (c.otherVoices === 'present') needs.push('other_voices');
      return { needs, missingDeclaration: null };
    }
  }
}

export function trackVerdict(t: TrackIn, s: ExportAudioState): TrackVerdict {
  const { needs, missingDeclaration } = categoriesFor(t.role, s);
  const missing: MissingRequirement[] = [];
  // Sans déclaration, la piste est refusée même si tous les consentements existent : la
  // déclaration est un fait à établir par le créateur, jamais supposé.
  if (missingDeclaration) missing.push(missingDeclaration);
  for (const n of needs) if (!s.consents[n]) missing.push({ kind: 'consent', subject: n });
  const exportable = missing.length === 0;
  return {
    audioIndex: t.audioIndex,
    role: t.role,
    exportable,
    missing,
    reason: exportable
      ? needs.length
        ? `autorisée (${needs.map((n) => CATEGORY_LABELS[n]).join(', ')} : accord donné)`
        : t.role === 'mic'
          ? 'voix du créateur'
          : 'aucune voix de tiers déclarée'
      : `bloquée : ${describeMissing(missing)}`,
  };
}

export function describeMissing(missing: readonly MissingRequirement[]): string {
  return missing
    .map((m) =>
      m.kind === 'declaration'
        ? m.subject === 'mix_composition'
          ? 'composition de la piste « tout » non déclarée'
          : 'présence du chat vocal dans la piste jeu non déclarée'
        : `accord requis : ${CATEGORY_LABELS[m.subject]}`,
    )
    .join(' ; ');
}

const INDIVIDUAL: readonly TrackRoleIn[] = ['mic', 'discord', 'game'];

export function allowedAudio(tracks: readonly TrackIn[], s: ExportAudioState): AudioDecision {
  const verdicts = [...tracks]
    .sort((a, b) => a.audioIndex - b.audioIndex)
    .map((t) => trackVerdict(t, s));
  const individuals = verdicts.filter((v) => INDIVIDUAL.includes(v.role));
  const okIndividuals = individuals.filter((v) => v.exportable);
  // La piste « tout » (ou unique / inconnue) : la première seulement, jamais plusieurs.
  const mixLike = verdicts.find((v) => v.role === 'mix' || v.role === 'unknown') ?? null;

  let mode: AudioDecision['mode'];
  let selected: TrackIn[];
  if (okIndividuals.length) {
    mode = 'individual';
    selected = okIndividuals.map(({ audioIndex, role }) => ({ audioIndex, role }));
  } else if (mixLike?.exportable) {
    mode = 'mix';
    selected = [{ audioIndex: mixLike.audioIndex, role: mixLike.role }];
  } else {
    mode = 'none';
    selected = [];
  }

  const captionRoles: CaptionRole[] = [];
  if (verdicts.some((v) => v.role === 'mic' && v.exportable)) captionRoles.push('mic');
  if (verdicts.some((v) => v.role === 'discord' && v.exportable)) captionRoles.push('discord');
  if (mixLike?.exportable) captionRoles.push('mix');

  const missing =
    mode === 'none'
      ? dedupe([...(mixLike?.missing ?? []), ...individuals.flatMap((v) => v.missing)])
      : [];
  return { tracks: verdicts, mode, selected, captionRoles, missing };
}

function dedupe(list: MissingRequirement[]): MissingRequirement[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const k = `${m.kind}:${m.subject}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
