/**
 * Les transcriptions sont des DONNÉES NON FIABLES : une phrase prononcée pendant un stream
 * ne doit jamais devenir une consigne pour le moteur. Ce module :
 *  - neutralise ce qui pourrait imiter la structure du contenu préparé (balises, lignes) ;
 *  - repère les phrases qui RESSEMBLENT à une consigne, pour les signaler comme telles.
 * Il ne prétend pas bloquer toute injection : la sortie de l'IA reste bornée par un schéma
 * strict et vérifiée localement (étape 4b).
 */

/** Balise qui encadre toute parole transcrite dans le contenu préparé. */
export const UNTRUSTED_OPEN = '<transcription_non_fiable>';
export const UNTRUSTED_CLOSE = '</transcription_non_fiable>';

/**
 * Rend un texte transcrit inoffensif pour la mise en forme :
 * caractères de contrôle et retours à la ligne supprimés (une parole = une ligne),
 * chevrons et crochets remplacés (impossible d'ouvrir/fermer une balise ou d'imiter
 * l'en-tête d'une ligne « [01:02:03 #12 MIC] »).
 */
export function neutralizeTranscript(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- retirer les caractères de contrôle est le but
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
      .replace(/</g, '‹')
      .replace(/>/g, '›')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/[ \t]+/g, ' ')
      .trim()
  );
}

/** Motifs de phrases qui ressemblent à une consigne adressée à une IA (français et anglais). */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|oublie|oubliez|ignorez)\b.{0,30}\b(instructions?|consignes?|r[èe]gles?|prompt)\b/iu,
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|all|your)\b.{0,20}\b(instructions?|rules|prompt)\b/iu,
  /\b(nouvelles?|new)\s+(instructions?|consignes?)\b/iu,
  /\b(system\s+prompt|prompt\s+syst[èe]me|jailbreak)\b/iu,
  /\b(tu es|vous [êe]tes)\s+(maintenant|d[ée]sormais)\b/iu,
  /\byou are now\b/iu,
  /\b(en tant qu['’]|as an?)\s*(ia|ai|assistant|mod[èe]le|language model)\b/iu,
  /\b(r[ée]ponds?|r[ée]pondez|answer|respond)\s+(uniquement|seulement|only)\b/iu,
  /\b(mets|mettez|donne|donnez|attribue|attribuez|give|set)\b.{0,40}\b(100|cent|maximum|max)\b.{0,20}\b(score|note|points?|pertinence|relevance)?/iu,
  /\b(s[ée]lectionne|s[ée]lectionnez|choisis|choisissez|select|pick)\b.{0,30}\b(ce clip|ce moment|this clip|this moment)\b/iu,
  /\b(claude|chatgpt|gpt|anthropic|openai)\b.{0,40}\b(fais|faites|do|ignore|r[ée]ponds|dis)\b/iu,
];

/** Vrai si le texte ressemble à une consigne (il reste traité comme une simple parole). */
export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}
