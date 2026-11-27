/** Prompt du repérage global (Claude Haiku 5.5) : trouver les moments à examiner. */
import type { CreatorProfile, GameProfile } from '@acs/shared';
import { creatorSection, DATA_RULES, gameSection } from './common';

export const TRIAGE_PROMPT_VERSION = 'triage-v1';

export function buildTriageSystem(input: { creator: CreatorProfile; game: GameProfile }): string {
  return [
    'Tu assistes un créateur de contenu qui cherche, dans l’enregistrement de ses streams, les moments qui méritent de devenir de courts clips (TikTok, Shorts, Reels).',
    'Ta tâche : lire UNE tranche de transcription et signaler les passages qui mériteraient un examen approfondi. Un autre modèle jugera ensuite chaque passage en détail.',
    '',
    '## Ce qu’il faut repérer, en priorité',
    '- L’humour et les interactions humaines : ironie (y compris dite calmement, sans exclamation), second degré, remarques inattendues, situations absurdes, malentendus, échanges ou disputes amusantes, retournements de situation, réactions spontanées.',
    '- Les moments où le contexte rend une phrase drôle : signale alors le passage depuis le début de la mise en place.',
    '- Le gameplay seulement s’il crée une situation humaine intéressante : une élimination ou une performance seule ne suffit pas.',
    '- Beaucoup de moments drôles ne produisent ni cri ni rire transcrit : lis le sens des échanges, pas seulement les exclamations.',
    '',
    creatorSection(input.creator),
    '',
    gameSection(input.game),
    '',
    DATA_RULES,
    '',
    '## Ta réponse',
    '- `moments` : pour chaque passage, `startSegmentId` et `endSegmentId` (identifiants #… EXISTANTS de cette tranche, début de la mise en place → fin de la réaction), `kind`, `strength` (`fort` si le passage est très probablement intéressant, `moyen` s’il mérite un examen), `why` (une phrase, sans citation inventée).',
    '- Signale un passage douteux en `moyen` plutôt que de le manquer, mais ne remplis pas : une tranche sans moment intéressant donne une liste vide, et c’est une réponse normale.',
    '- `streamSummary` : 600 caractères au plus, ce qui aidera à comprendre la suite du stream (blagues récurrentes, surnoms, situation de jeu). Pas de citation.',
  ].join('\n');
}

/**
 * `contentContext` (étape 9) : types de contenu du passage, ajoutés seulement quand
 * l'enregistrement n'est pas entièrement gaming ; absent, le message est inchangé.
 */
export function buildTriageUser(chunkText: string, contentContext?: string | null): string {
  return [
    ...(contentContext ? [contentContext, ''] : []),
    'Voici la tranche de transcription à examiner.',
    '',
    chunkText,
  ].join('\n');
}
