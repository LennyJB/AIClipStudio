/**
 * Données d'entrée de l'analyse locale (étape 4a). Tous les temps sont en SourceMs :
 * millisecondes sur la timeline de l'enregistrement original.
 */

/** Qui parle, d'après le rôle de la piste. */
export type Speaker = 'creator' | 'teammates' | 'mixed';

/** Code court affiché dans le contenu préparé. */
export const SPEAKER_CODES: Record<Speaker, string> = {
  creator: 'MIC',
  teammates: 'DSC',
  mixed: 'MIX',
};

export interface AnalysisWord {
  startMs: number;
  endMs: number;
  word: string;
  probability: number;
}

export interface AnalysisSegment {
  /** Identifiant stable du segment en base (référencé par les preuves à l'étape 4b). */
  id: number;
  speaker: Speaker;
  audioIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  suspicionScore: number;
  suspicionReasons: readonly string[];
  words: readonly AnalysisWord[];
}

/** Énergie d'une piste de voix, lue dans la forme d'onde (paires min/max 8 bits). */
export interface EnergyTrack {
  speaker: Speaker;
  audioIndex: number;
  pointsPerSecond: number;
  /** Paires min/max entrelacées (-128..127). */
  peaks: Int8Array;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}
