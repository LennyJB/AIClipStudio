/**
 * Application d'un profil stylistique VALIDÉ à un nouveau projet de clip (fonctions PURES).
 *
 *  - choix du profil selon le type de contenu du passage (étape 9) : profil du type exact, sinon
 *    profil « Mixte » (tout type) ; parmi plusieurs, le plus récemment validé ;
 *  - valeurs appliquées : seulement celles que le document sait représenter (style des
 *    sous-titres, disposition, hauteur de la facecam, mode, normalisation de la sonie). Le rythme,
 *    les zooms et les effets restent des REPÈRES affichés : ils ne sont jamais inventés dans le
 *    montage (aucune coupe ni aucun effet ajouté automatiquement).
 */
import { CaptionStyleSchema, type CaptionStyle, type LAYOUT_PRESETS } from '@acs/timeline';
import type { SegmentContentType } from '@acs/shared';
import type { StyleFeatures } from './features';

export type StyleTarget = SegmentContentType | 'mixed';

export interface ValidatedProfileRef {
  profileId: string;
  version: number;
  contentTypes: readonly StyleTarget[];
  validatedAt: string;
  features: StyleFeatures;
}

/** Type de contenu majoritaire d'une plage (temps source) ; `unknown` si non établi. */
export function dominantContentType(
  segments: readonly { startMs: number; endMs: number; type: SegmentContentType }[] | null,
  range: { srcStartMs: number; srcEndMs: number },
): SegmentContentType {
  if (!segments) return 'gaming'; // sans segmentation : hypothèse historique (gaming)
  const acc = new Map<SegmentContentType, number>();
  for (const s of segments) {
    const o = Math.min(s.endMs, range.srcEndMs) - Math.max(s.startMs, range.srcStartMs);
    if (o > 0) acc.set(s.type, (acc.get(s.type) ?? 0) + o);
  }
  const best = [...acc.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best?.[0] ?? 'unknown';
}

export function selectProfile(
  profiles: readonly ValidatedProfileRef[],
  type: SegmentContentType,
): ValidatedProfileRef | null {
  const newest = (xs: ValidatedProfileRef[]) =>
    xs.sort((a, b) =>
      a.validatedAt < b.validatedAt ? 1 : a.validatedAt > b.validatedAt ? -1 : 0,
    )[0] ?? null;
  if (type !== 'unknown') {
    const exact = newest(profiles.filter((p) => p.contentTypes.includes(type)));
    if (exact) return exact;
  }
  return newest(profiles.filter((p) => p.contentTypes.includes('mixed')));
}

export interface ProjectStyleDefaults {
  captionStyle?: Partial<CaptionStyle>;
  captionsEnabled?: boolean;
  layoutPreset?: (typeof LAYOUT_PRESETS)[number];
  facecamShare?: number;
  mode?: 'fidele' | 'enrichi';
  loudnorm?: boolean;
}

/** Repères affichés dans l'éditeur (jamais appliqués automatiquement). */
export interface StyleHints {
  cutsPerMinute?: number;
  shotMedianMs?: number;
  zoomsPerMinute?: number;
  effectsPerMinute?: number;
  soundEffectsPerMinute?: number;
  densityScore?: number;
}

const val = <T>(f: StyleFeatures, k: keyof StyleFeatures): T | undefined =>
  f[k]?.value as T | undefined;

export function projectDefaults(f: StyleFeatures): {
  defaults: ProjectStyleDefaults;
  hints: StyleHints;
} {
  const caption: Partial<CaptionStyle> = {};
  const map: [keyof StyleFeatures, keyof CaptionStyle][] = [
    ['sous_titres.font', 'font'],
    ['sous_titres.sizePx', 'sizePx'],
    ['sous_titres.color', 'color'],
    ['sous_titres.highlightColor', 'highlightColor'],
    ['sous_titres.outlinePx', 'outlinePx'],
    ['sous_titres.position', 'position'],
    ['sous_titres.uppercase', 'uppercase'],
    ['sous_titres.maxCharsPerLine', 'maxCharsPerLine'],
    ['sous_titres.maxLines', 'maxLines'],
    ['sous_titres.karaoke', 'karaoke'],
    ['sous_titres.emphasizePunchline', 'emphasizePunchline'],
  ];
  for (const [k, c] of map) {
    const v = f[k]?.value;
    if (v !== undefined) (caption as Record<string, unknown>)[c] = v;
  }
  // Valeurs revérifiées par le schéma du document (jamais une valeur hors bornes).
  const checked = CaptionStyleSchema.partial().safeParse(caption);
  const defaults: ProjectStyleDefaults = {};
  if (checked.success && Object.keys(checked.data).length)
    defaults.captionStyle = checked.data as Partial<CaptionStyle>;
  const enabled = val<boolean>(f, 'sous_titres.enabled');
  if (enabled !== undefined) defaults.captionsEnabled = enabled;
  const preset = val<ProjectStyleDefaults['layoutPreset']>(f, 'cadrage.layoutPreset');
  if (preset) defaults.layoutPreset = preset;
  const share = val<number>(f, 'cadrage.facecamShare');
  if (share !== undefined) defaults.facecamShare = share;
  const mode = val<'fidele' | 'enrichi'>(f, 'densite.mode');
  if (mode) defaults.mode = mode;
  const lufs = val<number>(f, 'audio.loudnessLufs');
  if (lufs !== undefined) defaults.loudnorm = Math.abs(lufs - -14) <= 3;

  const hints: StyleHints = {};
  const put = (h: keyof StyleHints, k: keyof StyleFeatures) => {
    const v = val<number>(f, k);
    if (typeof v === 'number') hints[h] = v;
  };
  put('cutsPerMinute', 'rythme.cutsPerMinute');
  put('shotMedianMs', 'rythme.shotMedianMs');
  put('zoomsPerMinute', 'zooms.perMinute');
  put('effectsPerMinute', 'effets.visualPerMinute');
  put('soundEffectsPerMinute', 'effets.soundPerMinute');
  put('densityScore', 'densite.score');
  return { defaults, hints };
}
