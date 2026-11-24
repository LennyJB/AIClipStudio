/** Prompt de l'analyse approfondie (Claude Opus 5.5, effort high) : juger une fenêtre. */
import type { CreatorProfile, GameProfile } from '@acs/shared';
import { neutralizeTranscript } from '../analysis/untrusted';
import { creatorSection, DATA_RULES, gameSection, SUMMARY_CLOSE, SUMMARY_OPEN } from './common';

export const DEEP_PROMPT_VERSION = 'deep-v1';

export const SUMMARY_PLACEHOLDER =
  '[Résumé produit par le repérage global : connu seulement après les appels de repérage.]';

export function buildDeepSystem(input: {
  creator: CreatorProfile;
  game: GameProfile;
  clip: { minSeconds: number; maxSeconds: number };
}): string {
  const { minSeconds, maxSeconds } = input.clip;
  return [
    'Tu es l’éditeur d’un créateur de contenu. Tu juges si un passage de son stream mérite de devenir un court clip vertical (TikTok, Shorts, Reels), et tu le justifies précisément.',
    '',
    '## Critères',
    '- Priorité à l’humour et aux interactions humaines : ironie (même calme), second degré, absurde, malentendus, échanges et disputes amusantes, réactions spontanées, retournements.',
    '- Une élimination, une action ou un cri ne suffisent jamais à eux seuls.',
    '- Un clip doit être compréhensible par quelqu’un qui n’a pas vu le stream : il contient la MISE EN PLACE, la CHUTE et la RÉACTION. Une phrase drôle isolée, qui n’a pas de sens sans ce qui précède, n’est pas un clip.',
    `- Durée d’un clip : entre ${minSeconds} et ${maxSeconds} secondes, mise en place comprise. Si la mise en place nécessaire est plus longue, le moment ne peut être que « secondaire ».`,
    '- La qualité prime sur la quantité. Ne propose JAMAIS un moment médiocre pour remplir : zéro moment est une réponse normale et fréquente.',
    '',
    '## Pertinence (0 à 100)',
    '- 85 à 100 : excellent, drôle ou marquant pour un public qui ne connaît pas le créateur.',
    '- 70 à 84 : très bon clip.',
    '- 50 à 69 : correct mais limité : plutôt « secondaire ».',
    '- 30 à 49 : faible ; inférieur à 30 : sans intérêt (ne le propose pas).',
    '',
    creatorSection(input.creator),
    '',
    gameSection(input.game),
    '',
    DATA_RULES,
    '',
    '## Ta réponse',
    '- `moments` : de 0 à 3 moments distincts dans la zone d’intérêt (le contexte peut servir de mise en place).',
    '- `setupSegmentId`, `punchlineSegmentId`, `reactionEndSegmentId` : identifiants #… EXISTANTS (début de la mise en place, chute, fin de la réaction), dans l’ordre chronologique.',
    '- `evidence` : les échanges qui justifient le choix. `segmentId` = un identifiant #… existant ; `quote` = un extrait COPIÉ MOT À MOT du texte de ce segment (jamais reformulé, jamais inventé). Une ligne « contenu non transmis » ne peut pas être citée.',
    '- `visualEvidence` : seulement des images réellement fournies (F1, F2…), sinon une liste vide.',
    '- `relevance` : la pertinence selon la grille ; `suggestedTier` : `clip` ou `secondaire` ; `standalone` : compréhensible sans connaître le stream ?',
    '- `tracksUsed` : les pistes utiles au clip (MIC, DSC, MIX) ; `editingHint` : `fidele` ou `enrichi` et au plus 3 idées de montage sobres.',
    '- `uncertainty` : ce qui reste incertain (transcription douteuse, réponse des coéquipiers non transmise…), sinon null.',
    '- `noClipReason` : si aucun moment n’est retenu, en une phrase ; sinon null.',
  ].join('\n');
}

/** Message de l'analyse d'une fenêtre : résumé non vérifié (facultatif) + contenu préparé. */
export function buildDeepUser(input: {
  streamSummary: string | null;
  payloadText: string;
}): string {
  const summary =
    input.streamSummary === null
      ? []
      : [
          'Contexte général du stream :',
          SUMMARY_OPEN,
          // Texte produit par un modèle à partir de données non fiables : neutralisé lui aussi.
          input.streamSummary === SUMMARY_PLACEHOLDER
            ? SUMMARY_PLACEHOLDER
            : neutralizeTranscript(input.streamSummary),
          SUMMARY_CLOSE,
          '',
        ];
  return [...summary, 'Fenêtre à juger :', '', input.payloadText].join('\n');
}
