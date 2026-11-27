/**
 * Catalogue des caractéristiques stylistiques (étape 10). Pour chacune : ce qu'elle décrit, son
 * type, ses bornes, et SURTOUT quelles sources peuvent réellement la mesurer avec les outils
 * disponibles. Une caractéristique qu'aucune source ne mesure n'est jamais « apprise » : elle ne
 * peut être que réglée à la main par le créateur.
 *
 * Sources :
 *  - `reference` : vidéo déjà montée (même d'un autre créateur), analysée localement par FFmpeg :
 *    coupes, fondus au noir, arrêts sur image, sonie, silences, format. AUCUNE reconnaissance de
 *    texte, de visage ni de musique n'est disponible : sous-titres, facecam, zooms, effets et
 *    musique d'une référence ne sont PAS mesurables ;
 *  - `pair` : vidéo brute + sa version montée : en plus, alignement sonore des plans montés sur le
 *    brut (part conservée, coupes éditoriales distinguées des changements de scène du brut) ;
 *  - `editor` : décisions EXACTES du créateur dans l'éditeur (document de montage) : sous-titres,
 *    disposition facecam, zooms, effets visuels et sonores, calques, sonie, découpage.
 */
import { CAPTION_FONTS, LAYOUT_PRESETS } from '@acs/timeline';

export const STYLE_SOURCES = ['reference', 'pair', 'editor'] as const;
export type StyleSource = (typeof STYLE_SOURCES)[number];

export type FeatureKind =
  | { kind: 'number'; min: number; max: number; unit: string; integer?: boolean }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: readonly string[] }
  | { kind: 'color' };

export interface FeatureDef {
  group: StyleGroup;
  label: string;
  type: FeatureKind;
  /** Sources capables de la mesurer (vide : réglage manuel seulement). */
  measuredBy: readonly StyleSource[];
  /** Explication affichée quand aucune source ne la mesure, ou pour une limite propre. */
  note?: string;
}

export const STYLE_GROUPS = [
  'rythme',
  'format',
  'sous_titres',
  'cadrage',
  'zooms',
  'transitions',
  'effets',
  'audio',
  'densite',
] as const;
export type StyleGroup = (typeof STYLE_GROUPS)[number];

export const STYLE_GROUP_LABELS: Record<StyleGroup, string> = {
  rythme: 'Rythme et durée des plans',
  format: 'Format',
  sous_titres: 'Sous-titres',
  cadrage: 'Cadrage et facecam',
  zooms: 'Zooms et mouvements',
  transitions: 'Transitions',
  effets: 'Effets visuels et sonores',
  audio: 'Son, musique et ambiance',
  densite: 'Densité du montage',
};

const NO_OCR =
  'Non mesurable dans une vidéo de référence : aucune reconnaissance de texte (OCR) disponible. Appris depuis vos décisions dans l’éditeur, ou réglé à la main.';
const NO_VISION =
  'Non mesurable dans une vidéo de référence : aucune reconnaissance d’image (visage, zoom, effet) disponible. Appris depuis vos décisions dans l’éditeur, ou réglé à la main.';

const num = (min: number, max: number, unit: string, integer = false): FeatureKind => ({
  kind: 'number',
  min,
  max,
  unit,
  ...(integer ? { integer } : {}),
});
const ALL: readonly StyleSource[] = ['reference', 'pair', 'editor'];
const VIDEO: readonly StyleSource[] = ['reference', 'pair'];
const EDITOR: readonly StyleSource[] = ['editor'];

export const STYLE_FEATURES = {
  // Rythme
  'rythme.cutsPerMinute': {
    group: 'rythme',
    label: 'Coupes par minute',
    type: num(0, 240, '/min'),
    measuredBy: ALL,
    note: 'Référence : changements de plan visibles (y compris ceux de la scène filmée). Paire : seules les coupes éditoriales comptent à part.',
  },
  'rythme.shotMedianMs': {
    group: 'rythme',
    label: 'Durée médiane d’un plan',
    type: num(100, 600_000, 'ms', true),
    measuredBy: ALL,
  },
  'rythme.shotShortMs': {
    group: 'rythme',
    label: 'Plans courts (10e centile)',
    type: num(50, 600_000, 'ms', true),
    measuredBy: ALL,
  },
  'rythme.shotLongMs': {
    group: 'rythme',
    label: 'Plans longs (90e centile)',
    type: num(100, 3_600_000, 'ms', true),
    measuredBy: ALL,
  },
  'rythme.editorialCutsPerMinute': {
    group: 'rythme',
    label: 'Coupes éditoriales par minute',
    type: num(0, 240, '/min'),
    measuredBy: ['pair', 'editor'],
    note: 'Saut dans le temps du brut : mesurable seulement avec la vidéo brute (paire) ou dans l’éditeur.',
  },
  'rythme.keptRatio': {
    group: 'rythme',
    label: 'Part du brut conservée',
    type: num(0, 1, 'ratio'),
    measuredBy: ['pair', 'editor'],
    note: 'Exige la vidéo brute (paire) ou l’éditeur : une vidéo montée seule ne dit rien de ce qui a été retiré.',
  },
  // Format
  'format.durationMs': {
    group: 'format',
    label: 'Durée du montage',
    type: num(1000, 3_600_000, 'ms', true),
    measuredBy: ALL,
  },
  'format.vertical': {
    group: 'format',
    label: 'Format vertical',
    type: { kind: 'boolean' },
    measuredBy: VIDEO,
  },
  // Sous-titres
  'sous_titres.enabled': {
    group: 'sous_titres',
    label: 'Sous-titres affichés',
    type: { kind: 'boolean' },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.font': {
    group: 'sous_titres',
    label: 'Police',
    type: { kind: 'enum', options: CAPTION_FONTS },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.sizePx': {
    group: 'sous_titres',
    label: 'Taille',
    type: num(40, 120, 'px', true),
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.color': {
    group: 'sous_titres',
    label: 'Couleur',
    type: { kind: 'color' },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.highlightColor': {
    group: 'sous_titres',
    label: 'Couleur du mot prononcé',
    type: { kind: 'color' },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.outlinePx': {
    group: 'sous_titres',
    label: 'Contour',
    type: num(0, 12, 'px', true),
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.position': {
    group: 'sous_titres',
    label: 'Position',
    type: { kind: 'enum', options: ['top', 'middle', 'bottom_safe'] },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.uppercase': {
    group: 'sous_titres',
    label: 'Majuscules',
    type: { kind: 'boolean' },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.maxCharsPerLine': {
    group: 'sous_titres',
    label: 'Caractères par ligne',
    type: num(16, 42, 'car.', true),
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.maxLines': {
    group: 'sous_titres',
    label: 'Lignes',
    type: num(1, 2, 'lignes', true),
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.karaoke': {
    group: 'sous_titres',
    label: 'Animation mot à mot (karaoké)',
    type: { kind: 'boolean' },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  'sous_titres.emphasizePunchline': {
    group: 'sous_titres',
    label: 'Chute mise en valeur',
    type: { kind: 'boolean' },
    measuredBy: EDITOR,
    note: NO_OCR,
  },
  // Cadrage et facecam
  'cadrage.layoutPreset': {
    group: 'cadrage',
    label: 'Disposition',
    type: { kind: 'enum', options: LAYOUT_PRESETS },
    measuredBy: EDITOR,
    note: NO_VISION,
  },
  'cadrage.facecamUsage': {
    group: 'cadrage',
    label: 'Part des clips avec facecam',
    type: num(0, 1, 'ratio'),
    measuredBy: EDITOR,
    note: NO_VISION,
  },
  'cadrage.facecamShare': {
    group: 'cadrage',
    label: 'Hauteur de la facecam',
    type: num(0.25, 0.45, 'ratio'),
    measuredBy: EDITOR,
    note: NO_VISION,
  },
  // Zooms
  'zooms.perMinute': {
    group: 'zooms',
    label: 'Zooms par minute',
    type: num(0, 120, '/min'),
    measuredBy: EDITOR,
    note: NO_VISION,
  },
  'zooms.factorMedian': {
    group: 'zooms',
    label: 'Intensité médiane des zooms',
    type: num(1, 3, '×'),
    measuredBy: EDITOR,
    note: NO_VISION,
  },
  // Transitions
  'transitions.fadesToBlackPerMinute': {
    group: 'transitions',
    label: 'Fondus au noir par minute',
    type: num(0, 60, '/min'),
    measuredBy: VIDEO,
    note: 'Seuls les passages par le noir sont mesurables ; fondus enchaînés et transitions animées ne le sont pas.',
  },
  'transitions.freezesPerMinute': {
    group: 'transitions',
    label: 'Arrêts sur image par minute',
    type: num(0, 60, '/min'),
    measuredBy: ALL,
  },
  // Effets
  'effets.visualPerMinute': {
    group: 'effets',
    label: 'Effets visuels par minute',
    type: num(0, 120, '/min'),
    measuredBy: EDITOR,
    note: NO_VISION,
  },
  'effets.soundPerMinute': {
    group: 'effets',
    label: 'Effets sonores par minute',
    type: num(0, 120, '/min'),
    measuredBy: EDITOR,
    note: 'Non mesurable dans une vidéo de référence : un effet sonore ne se distingue pas du reste du son sans reconnaissance audio.',
  },
  'effets.overlaysPerMinute': {
    group: 'effets',
    label: 'Images et textes ajoutés par minute',
    type: num(0, 120, '/min'),
    measuredBy: EDITOR,
    note: NO_VISION,
  },
  // Audio
  'audio.loudnessLufs': {
    group: 'audio',
    label: 'Sonie intégrée',
    type: num(-60, 0, 'LUFS'),
    measuredBy: ALL,
  },
  'audio.loudnessRangeLu': {
    group: 'audio',
    label: 'Plage de sonie',
    type: num(0, 40, 'LU'),
    measuredBy: VIDEO,
  },
  'audio.silenceShare': {
    group: 'audio',
    label: 'Part de silence',
    type: num(0, 1, 'ratio'),
    measuredBy: VIDEO,
  },
  'audio.musicBed': {
    group: 'audio',
    label: 'Musique de fond',
    type: { kind: 'enum', options: ['aucune', 'discrete', 'presente'] },
    measuredBy: [],
    note: 'Non mesurable : séparer la musique de la voix demanderait une analyse audio qui n’est pas disponible. Réglage manuel seulement.',
  },
  // Densité
  'densite.score': {
    group: 'densite',
    label: 'Densité générale',
    type: num(0, 1, 'indice'),
    measuredBy: ALL,
    note: 'Indice dérivé : coupes, zooms, effets et arrêts sur image par minute (seulement ce que la source mesure).',
  },
  // Mode
  'densite.mode': {
    group: 'densite',
    label: 'Mode de montage',
    type: { kind: 'enum', options: ['fidele', 'enrichi'] },
    measuredBy: EDITOR,
    note: 'Choix fait dans l’éditeur (fidèle ou enrichi) : il n’existe pas dans une vidéo de référence.',
  },
} as const satisfies Record<string, FeatureDef>;

export type FeatureKey = keyof typeof STYLE_FEATURES;
export const FEATURE_KEYS = Object.keys(STYLE_FEATURES) as FeatureKey[];
export const featureDef = (k: FeatureKey): FeatureDef => STYLE_FEATURES[k];
