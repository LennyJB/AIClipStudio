/**
 * Catalogue d'effets v2 (docs/plan-etape-7.md §3.2, PR 7e) : `defineEffect` décrit chaque type
 * d'effet UNE fois — paramètres validés, valeurs par défaut, catégorie, espace d'application et
 * ENVELOPPE temporelle pure. L'aperçu (canvas, Web Audio) évalue l'enveloppe ; le moteur FFmpeg
 * (`@acs/render`, table `EFFECT_FFMPEG`) produit l'expression de la MÊME enveloppe, avec les
 * mêmes constantes. Aucun texte n'entre jamais dans un effet : uniquement des nombres bornés et,
 * pour les effets localisés, une zone normalisée.
 *
 * Confidentialité (§3.4) : `blur_region` est un effet CRÉATIF, rangé dans les effets visuels,
 * appliqué APRÈS les aplats opaques. Il n'est jamais compté ni proposé comme un masque.
 */
import type { z } from 'zod';
import { resolveTiming, type Timing } from '../time';
import {
  EFFECT_PARAMS_SCHEMAS,
  segmentsV2,
  type ClipProjectV2,
  type EffectTypeV2,
  type EffectV2,
} from './schema';

/** Montée et descente des zooms (s) : constante commune à l'aperçu et à l'export. */
export const ZOOM_RAMP_S = 0.25;
/** Montée et descente de l'atténuation (`duck`) et du bip (`bleep`) (s). */
export const DUCK_RAMP_S = 0.02;
export const BLEEP_RAMP_S = 0.005;
/** Niveau du bip (facteur linéaire, ≈ −12 dBFS). */
export const BLEEP_LEVEL = 0.25;
/** Fréquences de la secousse (Hz) : déterministes, identiques dans l'aperçu et l'export. */
export const SHAKE_FX_HZ = 9;
export const SHAKE_FY_HZ = 7;

export type EffectCategory = 'visual' | 'audio';
/**
 * Espace d'application :
 *  - `source` : image source, après les aplats opaques et avant la disposition (`blur_region`) ;
 *  - `composite` : image 9:16 composée (zooms, secousse, éclair) ;
 *  - `facecam` : calque facecam seul (`reaction_hold`) ;
 *  - `captions` : mise en évidence d'un sous-titre ;
 *  - `audio` : mixage.
 */
export type EffectSpace = 'source' | 'composite' | 'facecam' | 'captions' | 'audio';

export interface EffectDefinition<T extends EffectTypeV2 = EffectTypeV2> {
  type: T;
  label: string;
  category: EffectCategory;
  space: EffectSpace;
  /** Absent en mode fidèle (règle de l'étape 6). */
  motion: boolean;
  /** Exige une zone de l'image source (normalisée). */
  region: boolean;
  params: z.ZodType;
  defaults: Record<string, number>;
  /** Aide affichée dans l'interface (le flou n'est pas une protection). */
  hint?: string;
}

export function defineEffect<T extends EffectTypeV2>(
  d: Omit<EffectDefinition<T>, 'params'>,
): EffectDefinition<T> {
  return { ...d, params: EFFECT_PARAMS_SCHEMAS[d.type] };
}

export const EFFECT_CATALOG = {
  caption_emphasis: defineEffect({
    type: 'caption_emphasis',
    label: 'Mise en évidence de la chute',
    category: 'visual',
    space: 'captions',
    motion: false,
    region: false,
    defaults: {},
  }),
  punch_zoom: defineEffect({
    type: 'punch_zoom',
    label: 'Zoom sur la chute',
    category: 'visual',
    space: 'composite',
    motion: true,
    region: false,
    defaults: { factor: 1.12 },
  }),
  reaction_hold: defineEffect({
    type: 'reaction_hold',
    label: 'Zoom sur la facecam',
    category: 'visual',
    space: 'facecam',
    motion: true,
    region: false,
    defaults: { factor: 1.08 },
  }),
  zoom: defineEffect({
    type: 'zoom',
    label: 'Zoom sur une zone',
    category: 'visual',
    space: 'composite',
    motion: true,
    region: true,
    defaults: { factor: 1.5 },
  }),
  flash: defineEffect({
    type: 'flash',
    label: 'Éclair blanc',
    category: 'visual',
    space: 'composite',
    motion: true,
    region: false,
    defaults: { intensity: 0.8 },
  }),
  shake: defineEffect({
    type: 'shake',
    label: 'Secousse',
    category: 'visual',
    space: 'composite',
    motion: true,
    region: false,
    defaults: { amplitude: 0.01 },
  }),
  blur_region: defineEffect({
    type: 'blur_region',
    label: 'Flou créatif d’une zone',
    category: 'visual',
    space: 'source',
    motion: false,
    region: true,
    defaults: { sigma: 20 },
    hint: 'Le flou n’est pas une protection : utilisez une zone masquée.',
  }),
  fade_in: defineEffect({
    type: 'fade_in',
    label: 'Fondu d’entrée (son)',
    category: 'audio',
    space: 'audio',
    motion: false,
    region: false,
    defaults: {},
  }),
  fade_out: defineEffect({
    type: 'fade_out',
    label: 'Fondu de sortie (son)',
    category: 'audio',
    space: 'audio',
    motion: false,
    region: false,
    defaults: {},
  }),
  duck: defineEffect({
    type: 'duck',
    label: 'Atténuation des pistes',
    category: 'audio',
    space: 'audio',
    motion: false,
    region: false,
    defaults: { gainDb: -12 },
  }),
  bleep: defineEffect({
    type: 'bleep',
    label: 'Bip (censure)',
    category: 'audio',
    space: 'audio',
    motion: false,
    region: false,
    defaults: { frequencyHz: 1000 },
  }),
} satisfies { [T in EffectTypeV2]: EffectDefinition<T> };

/* ------------------------------------------------------------------ */
/* Enveloppes (temps MONTAGE, en secondes)                             */
/* ------------------------------------------------------------------ */

/** Fenêtre active d'un effet (temps montage, secondes). */
export interface EffectWindow {
  startS: number;
  endS: number;
}

const clip01 = (x: number) => Math.min(1, Math.max(0, x));

/** Rampe trapézoïdale : 0 hors de la fenêtre, 1 au plateau, montée et descente de `ramp` s. */
export function trapezoid(w: EffectWindow, t: number, ramp: number): number {
  return clip01(Math.min((t - w.startS) / ramp, (w.endS - t) / ramp));
}

/** Facteur de zoom : 1 + Σ (facteur − 1) × rampe (même formule que l'expression FFmpeg). */
export function zoomFactorAt(windows: readonly (EffectWindow & { factor: number })[], t: number) {
  return windows.reduce((z, w) => z + (w.factor - 1) * trapezoid(w, t, ZOOM_RAMP_S), 1);
}

/**
 * Centre du zoom (fraction de l'image composée) : le centre de la DERNIÈRE fenêtre de zoom
 * localisé qui contient `t` (ordre de la liste), sinon le centre de l'image.
 */
export function zoomCenterAt(
  windows: readonly (EffectWindow & { cx: number; cy: number })[],
  t: number,
): { cx: number; cy: number } {
  let c = { cx: 0.5, cy: 0.5 };
  for (const w of windows) if (w.startS <= t && t <= w.endS) c = { cx: w.cx, cy: w.cy };
  return c;
}

/** Décalage de la secousse en pixels de sortie (arrondi), 0 hors de la fenêtre. */
export function shakeOffsetAt(
  w: EffectWindow & { amplitude: number },
  t: number,
  outWidth: number,
): { dx: number; dy: number } {
  if (t < w.startS || t >= w.endS) return { dx: 0, dy: 0 };
  const a = w.amplitude * outWidth;
  const u = t - w.startS;
  // Arrondi « demi vers l'extérieur », comme round() de FFmpeg.
  const round = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
  return {
    dx: round(a * Math.sin(2 * Math.PI * SHAKE_FX_HZ * u)),
    dy: round(a * Math.sin(2 * Math.PI * SHAKE_FY_HZ * u + 1)),
  };
}

/** Opacité de l'éclair : intensité × décroissance linéaire sur la fenêtre, 0 hors de celle-ci. */
export function flashAlphaAt(w: EffectWindow & { intensity: number }, t: number): number {
  if (t < w.startS || t > w.endS || w.endS <= w.startS) return 0;
  return w.intensity * clip01(1 - (t - w.startS) / (w.endS - w.startS));
}

/** Gains audio des effets à l'instant `t` (facteurs linéaires). */
export interface AudioEffectGains {
  /** Pistes de l'enregistrement (atténuation, bip). */
  source: number;
  /** Mixage complet (fondus). */
  master: number;
  /** Bips : amplitude et fréquence de chaque bip actif. */
  tones: { amplitude: number; frequencyHz: number }[];
}

export interface AudioEffectWindow extends EffectWindow {
  type: 'fade_in' | 'fade_out' | 'duck' | 'bleep';
  params: Record<string, number>;
}

export const dbToGain = (db: number) => 10 ** (db / 20);

/**
 * Fondu d'entrée : 0 → 1 sur la fenêtre ; fondu de sortie : 1 → 0 ; 1 hors de la fenêtre.
 * Atténuation : gain (dB) × rampe, sur les pistes de l'enregistrement. Bip : pistes coupées
 * (1 − rampe) et ton sinusoïdal (rampe × BLEEP_LEVEL).
 */
export function audioEffectGainsAt(
  windows: readonly AudioEffectWindow[],
  t: number,
): AudioEffectGains {
  let source = 1;
  let master = 1;
  const tones: AudioEffectGains['tones'] = [];
  for (const w of windows) {
    const inside = t >= w.startS && t < w.endS;
    const dur = Math.max(1e-6, w.endS - w.startS);
    switch (w.type) {
      case 'fade_in':
        if (inside) master *= clip01((t - w.startS) / dur);
        break;
      case 'fade_out':
        if (inside) master *= clip01((w.endS - t) / dur);
        break;
      case 'duck':
        source *= dbToGain((w.params['gainDb'] ?? -12) * trapezoid(w, t, DUCK_RAMP_S));
        break;
      case 'bleep': {
        const r = trapezoid(w, t, BLEEP_RAMP_S);
        source *= 1 - r;
        if (r > 0)
          tones.push({ amplitude: r * BLEEP_LEVEL, frequencyHz: w.params['frequencyHz'] ?? 1000 });
        break;
      }
    }
  }
  return { source, master, tones };
}

/* ------------------------------------------------------------------ */
/* Fenêtres actives d'un document                                      */
/* ------------------------------------------------------------------ */

export interface ResolvedEffect extends EffectWindow {
  id: string;
  type: EffectTypeV2;
  params: Record<string, number>;
  /** Zone normalisée de l'image source (effets localisés), null sinon. */
  region: { x: number; y: number; w: number; h: number } | null;
}

/** Effet appliqué : activé, et autorisé par le mode du projet (fidèle : aucun mouvement). */
export const effectApplies = (
  d: Pick<ClipProjectV2, 'mode'>,
  e: Pick<EffectV2, 'enabled' | 'type'>,
) => e.enabled && (d.mode === 'enrichi' || !EFFECT_CATALOG[e.type].motion);

/**
 * Fenêtres actives des effets, en temps montage (s), plages contiguës fusionnées (pas de creux au
 * raccord). Un effet ancré au contenu suit les coupes ; pendant un arrêt sur image qui contient
 * sa plage, il reste actif (figé avec l'image). Même calcul pour l'aperçu et l'export.
 */
export function resolvedEffects(d: ClipProjectV2): ResolvedEffect[] {
  const segments = segmentsV2(d.segments);
  const out: ResolvedEffect[] = [];
  for (const e of d.effects) {
    if (!effectApplies(d, e)) continue;
    const ranges = resolveTiming(segments, e.timing as unknown as Timing).ranges;
    const merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && last.end === r.editStartMs) last.end = r.editEndMs;
      else merged.push({ start: r.editStartMs, end: r.editEndMs });
    }
    const params = { ...EFFECT_CATALOG[e.type].defaults, ...e.params };
    for (const r of merged) {
      out.push({
        id: e.id,
        type: e.type,
        params,
        region: e.region,
        startS: r.start / 1000,
        endS: r.end / 1000,
      });
    }
  }
  return out;
}
