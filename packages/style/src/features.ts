/**
 * Valeurs d'un profil stylistique, observations et apprentissage (fonctions PURES).
 *
 *  - une OBSERVATION est ce qu'une source a mesuré (une référence analysée, une paire, un projet
 *    de l'éditeur) : uniquement des nombres, booléens et énumérations — jamais de texte, de
 *    dialogue, d'image ni d'événement de la vidéo ;
 *  - l'APPRENTISSAGE agrège des observations (médiane, majorité, mode) ;
 *  - une SUGGESTION est un nouveau brouillon : une valeur réglée à la main par le créateur n'est
 *    jamais remplacée ; un profil validé n'est jamais modifié (le brouillon doit être validé).
 */
import { z } from 'zod';
import { FEATURE_KEYS, STYLE_FEATURES, type FeatureKey, type StyleSource } from './catalog';

export type FeatureScalar = number | boolean | string;

export interface FeatureValue {
  value: FeatureScalar;
  /** `learned` : agrégé depuis des observations ; `manual` : réglé par le créateur. */
  origin: 'learned' | 'manual';
  /** Nombre d'observations (0 pour une valeur manuelle). */
  samples: number;
  sources: StyleSource[];
  /** Dispersion des nombres appris (écart interquartile), ou part de la majorité (0..1). */
  spread?: number;
}

export type StyleFeatures = Partial<Record<FeatureKey, FeatureValue>>;

export interface StyleObservation {
  source: StyleSource;
  /** Référence ou projet d'où vient l'observation (traçabilité). */
  sourceId: string;
  values: Partial<Record<FeatureKey, FeatureScalar>>;
}

/** Valide une valeur selon le catalogue ; renvoie un message d'erreur ou null. */
export function featureValueError(key: FeatureKey, v: unknown): string | null {
  const def = STYLE_FEATURES[key];
  const t = def.type;
  switch (t.kind) {
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'nombre attendu';
      if (v < t.min || v > t.max) return `entre ${t.min} et ${t.max} ${t.unit}`;
      if ('integer' in t && t.integer && !Number.isInteger(v)) return 'entier attendu';
      return null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? null : 'oui / non attendu';
    case 'enum':
      return typeof v === 'string' && (t.options as readonly string[]).includes(v)
        ? null
        : `une valeur parmi : ${t.options.join(', ')}`;
    case 'color':
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/u.test(v) ? null : 'couleur #RRGGBB';
  }
}

const FeatureValueSchema = z
  .object({
    value: z.union([z.number(), z.boolean(), z.string().max(40)]),
    origin: z.enum(['learned', 'manual']),
    samples: z.number().int().min(0),
    sources: z.array(z.enum(['reference', 'pair', 'editor'])).max(3),
    spread: z.number().min(0).optional(),
  })
  .strict();

/** Schéma strict d'un ensemble de caractéristiques (clés du catalogue, valeurs bornées). */
export const StyleFeaturesSchema = z
  .record(z.string(), FeatureValueSchema)
  .superRefine((rec, ctx) => {
    for (const [k, fv] of Object.entries(rec)) {
      if (!(FEATURE_KEYS as string[]).includes(k)) {
        ctx.addIssue({ code: 'custom', path: [k], message: 'caractéristique inconnue' });
        continue;
      }
      const err = featureValueError(k as FeatureKey, fv.value);
      if (err) ctx.addIssue({ code: 'custom', path: [k], message: err });
      if (fv.origin === 'learned' && fv.sources.length === 0) {
        ctx.addIssue({ code: 'custom', path: [k], message: 'valeur apprise sans source' });
      }
      const measured = STYLE_FEATURES[k as FeatureKey].measuredBy as readonly string[];
      if (fv.origin === 'learned' && fv.sources.some((s) => !measured.includes(s))) {
        // Jamais de valeur « apprise » d'une source qui ne peut pas la mesurer.
        ctx.addIssue({ code: 'custom', path: [k], message: 'source incapable de la mesurer' });
      }
    }
  });

const quantile = (sorted: number[], q: number) => {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};
const roundFor = (key: FeatureKey, v: number) => {
  const t = STYLE_FEATURES[key].type;
  if (t.kind === 'number' && 'integer' in t && t.integer) return Math.round(v);
  return Math.round(v * 1000) / 1000;
};

/**
 * Agrège des observations. Une valeur observée par une source incapable de la mesurer (selon le
 * catalogue) est ignorée : on ne prétend jamais avoir appris ce qui n'est pas mesurable.
 */
export function learnFeatures(observations: readonly StyleObservation[]): StyleFeatures {
  const out: StyleFeatures = {};
  for (const key of FEATURE_KEYS) {
    const def = STYLE_FEATURES[key];
    const measuredBy = def.measuredBy as readonly StyleSource[];
    const vals: { v: FeatureScalar; s: StyleSource }[] = [];
    for (const o of observations) {
      const v = o.values[key];
      if (v === undefined || !measuredBy.includes(o.source)) continue;
      if (featureValueError(key, v) !== null) continue;
      vals.push({ v, s: o.source });
    }
    if (!vals.length) continue;
    const sources = [...new Set(vals.map((x) => x.s))].sort();
    if (def.type.kind === 'number') {
      const sorted = vals.map((x) => x.v as number).sort((a, b) => a - b);
      out[key] = {
        value: roundFor(key, quantile(sorted, 0.5)),
        origin: 'learned',
        samples: vals.length,
        sources,
        spread: roundFor(key, quantile(sorted, 0.75) - quantile(sorted, 0.25)),
      };
    } else {
      // Mode (égalité : valeur la plus récente parmi les ex æquo… ordre déterministe : tri).
      const counts = new Map<string, { v: FeatureScalar; n: number }>();
      for (const { v } of vals) {
        const k = JSON.stringify(v);
        counts.set(k, { v, n: (counts.get(k)?.n ?? 0) + 1 });
      }
      const best = [...counts.entries()].sort(
        (a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1),
      )[0]![1];
      out[key] = {
        value: best.v,
        origin: 'learned',
        samples: vals.length,
        sources,
        spread: Math.round((best.n / vals.length) * 1000) / 1000,
      };
    }
  }
  return out;
}

export interface FeatureChange {
  key: FeatureKey;
  before: FeatureValue | null;
  after: FeatureValue | null;
}

/**
 * Brouillon suggéré à partir d'un profil (validé ou brouillon) et de ce qui vient d'être appris :
 *  - valeur MANUELLE du profil : conservée telle quelle (le créateur l'a choisie) ;
 *  - valeur apprise : remplacée par la nouvelle valeur apprise si elle existe, sinon conservée ;
 *  - caractéristique nouvellement observée : ajoutée.
 * Le profil de départ n'est jamais modifié : la fonction renvoie un nouvel objet.
 */
export function suggestFeatures(
  base: StyleFeatures | null,
  learned: StyleFeatures,
): { features: StyleFeatures; changes: FeatureChange[] } {
  const features: StyleFeatures = {};
  const changes: FeatureChange[] = [];
  for (const key of FEATURE_KEYS) {
    const before = base?.[key] ?? null;
    const next = before?.origin === 'manual' ? before : (learned[key] ?? before);
    if (next) features[key] = next;
    if (JSON.stringify(before) !== JSON.stringify(next ?? null)) {
      changes.push({ key, before, after: next ?? null });
    }
  }
  return { features, changes };
}

/**
 * Édition manuelle d'un brouillon : `set` fixe des valeurs (origine manuelle), `clear` retire des
 * caractéristiques (elles redeviennent « non réglées »). Valeurs validées par le catalogue.
 */
export function editFeatures(
  base: StyleFeatures,
  edit: { set?: Partial<Record<string, FeatureScalar>>; clear?: readonly string[] },
): StyleFeatures {
  const out: StyleFeatures = { ...base };
  for (const k of edit.clear ?? []) {
    if (!(FEATURE_KEYS as string[]).includes(k)) throw new Error(`caractéristique inconnue : ${k}`);
    delete out[k as FeatureKey];
  }
  for (const [k, v] of Object.entries(edit.set ?? {})) {
    if (!(FEATURE_KEYS as string[]).includes(k)) throw new Error(`caractéristique inconnue : ${k}`);
    const err = featureValueError(k as FeatureKey, v);
    if (err) throw new Error(`${STYLE_FEATURES[k as FeatureKey].label} : ${err}`);
    out[k as FeatureKey] = { value: v!, origin: 'manual', samples: 0, sources: [] };
  }
  return out;
}

/**
 * Indice de densité (0..1) d'une observation, à partir de ce que la source mesure réellement.
 * Moyenne des composantes disponibles, chacune ramenée à 0..1 par une échelle prudente.
 */
export function densityScore(v: Partial<Record<FeatureKey, FeatureScalar>>): number | null {
  const parts: number[] = [];
  const add = (key: FeatureKey, full: number) => {
    const x = v[key];
    if (typeof x === 'number') parts.push(Math.min(1, x / full));
  };
  add('rythme.cutsPerMinute', 30);
  add('zooms.perMinute', 12);
  add('effets.visualPerMinute', 12);
  add('effets.soundPerMinute', 12);
  add('transitions.freezesPerMinute', 6);
  if (!parts.length) return null;
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 1000) / 1000;
}
