/**
 * Clés d'état du document v2 : la granularité des lectures, écritures et préconditions des
 * opérations (docs/plan-etape-7.md §6.3). Chaque clé désigne une partie du document que l'on peut
 * lire et remplacer de façon indépendante.
 *
 *  segments              structure du montage (ordre, bornes, durées) ; toute position en temps
 *                        montage en dépend
 *  window                fenêtre éditable (+ manifeste d'intégrité)
 *  layout                disposition globale (hors surcharges par segment)
 *  layoutOverride:<id>   surcharge de disposition d'un segment
 *  mask:<id>             masque de confidentialité
 *  caption:<id>          item de transcription + sa correction + son réglage d'affichage
 *  manual:<id>           sous-titre écrit par le créateur
 *  captions.config       activation, sources, style global
 *  effect:<id> overlay:<id> sfx:<id>
 *  track:<audioIndex>    piste audio de l'enregistrement
 *  audio.config          export sans son, normalisation
 *  mode                  fidèle / enrichi
 */
import { canonicalJson } from '../project';
import type { ClipProjectV2 } from './schema';

export type StateKey = string;

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Ordre canonique des items de transcription : début, puis identifiant. */
export const byStartThenId = (
  a: { id: string; srcStartMs: number },
  b: { id: string; srcStartMs: number },
) => a.srcStartMs - b.srcStartMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type Doc = ClipProjectV2;
type Item = Doc['captions']['items'][number];
type Correction = Doc['captions']['corrections'][number];
type CaptionOverride = Doc['captions']['overrides'][number];

export interface CaptionState {
  item: Item;
  correction: Correction | null;
  override: CaptionOverride | null;
}

const ENTITY_PREFIXES = {
  layoutOverride: (d: Doc) => d.layout.overrides,
  mask: (d: Doc) => d.masks,
  manual: (d: Doc) => d.captions.manual,
  effect: (d: Doc) => d.effects,
  overlay: (d: Doc) => d.overlays,
  sfx: (d: Doc) => d.audio.sfx,
} as const;
type EntityPrefix = keyof typeof ENTITY_PREFIXES;

function splitKey(key: StateKey): [string, string | null] {
  const i = key.indexOf(':');
  return i < 0 ? [key, null] : [key.slice(0, i), key.slice(i + 1)];
}

/** Valeur d'une clé (undefined si l'entité n'existe pas). */
export function getKey(d: Doc, key: StateKey): unknown {
  const [k, arg] = splitKey(key);
  if (arg === null) {
    switch (k) {
      case 'segments':
        return d.segments;
      case 'window':
        return d.source.editWindow;
      case 'layout': {
        const rest: Partial<Doc['layout']> = { ...d.layout };
        delete rest.overrides;
        return rest;
      }
      case 'captions.config':
        return {
          enabled: d.captions.enabled,
          sources: d.captions.sources,
          style: d.captions.style,
        };
      case 'audio.config':
        return { silent: d.audio.silent, loudnorm: d.audio.loudnorm };
      case 'mode':
        return d.mode;
    }
  } else if (k in ENTITY_PREFIXES) {
    return ENTITY_PREFIXES[k as EntityPrefix](d).find((e) => e.id === arg);
  } else if (k === 'caption') {
    const item = d.captions.items.find((i) => i.id === arg);
    if (!item) return undefined;
    return {
      item,
      correction: d.captions.corrections.find((c) => c.itemId === arg) ?? null,
      override: d.captions.overrides.find((o) => o.id === arg) ?? null,
    } satisfies CaptionState;
  } else if (k === 'track') {
    return d.audio.tracks.find((t) => t.audioIndex === Number(arg));
  }
  throw new RangeError(`clé d'état inconnue : ${key}`);
}

function upsert<T extends { id: string }>(list: T[], id: string, value: T | undefined): T[] {
  const rest = list.filter((e) => e.id !== id);
  return value === undefined ? rest : [...rest, value].sort(byId);
}

/** Remplace la valeur d'une clé dans un brouillon (mutation du brouillon uniquement). */
export function setKey(d: Doc, key: StateKey, value: unknown): void {
  const [k, arg] = splitKey(key);
  if (arg === null) {
    switch (k) {
      case 'segments':
        d.segments = value as Doc['segments'];
        return;
      case 'window':
        d.source.editWindow = value as Doc['source']['editWindow'];
        return;
      case 'layout':
        d.layout = {
          ...(value as Omit<Doc['layout'], 'overrides'>),
          overrides: d.layout.overrides,
        };
        return;
      case 'captions.config': {
        const v = value as Pick<Doc['captions'], 'enabled' | 'sources' | 'style'>;
        d.captions.enabled = v.enabled;
        d.captions.sources = v.sources;
        d.captions.style = v.style;
        return;
      }
      case 'audio.config': {
        const v = value as Pick<Doc['audio'], 'silent' | 'loudnorm'>;
        d.audio.silent = v.silent;
        d.audio.loudnorm = v.loudnorm;
        return;
      }
      case 'mode':
        d.mode = value as Doc['mode'];
        return;
    }
  } else if (k === 'layoutOverride') {
    d.layout.overrides = upsert(d.layout.overrides, arg, value as never);
    return;
  } else if (k === 'mask') {
    d.masks = upsert(d.masks, arg, value as never);
    return;
  } else if (k === 'manual') {
    d.captions.manual = upsert(d.captions.manual, arg, value as never);
    return;
  } else if (k === 'effect') {
    d.effects = upsert(d.effects, arg, value as never);
    return;
  } else if (k === 'overlay') {
    d.overlays = upsert(d.overlays, arg, value as never);
    return;
  } else if (k === 'sfx') {
    d.audio.sfx = upsert(d.audio.sfx, arg, value as never);
    return;
  } else if (k === 'caption') {
    const v = value as CaptionState | undefined;
    d.captions.items = d.captions.items.filter((i) => i.id !== arg);
    d.captions.corrections = d.captions.corrections.filter((c) => c.itemId !== arg);
    d.captions.overrides = d.captions.overrides.filter((o) => o.id !== arg);
    if (v) {
      d.captions.items = [...d.captions.items, v.item].sort(byStartThenId);
      if (v.correction) {
        d.captions.corrections = [...d.captions.corrections, v.correction].sort((a, b) =>
          a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
        );
      }
      if (v.override) d.captions.overrides = [...d.captions.overrides, v.override].sort(byId);
    }
    return;
  } else if (k === 'track') {
    const idx = Number(arg);
    const rest = d.audio.tracks.filter((t) => t.audioIndex !== idx);
    d.audio.tracks =
      value === undefined
        ? rest
        : [...rest, value as Doc['audio']['tracks'][number]].sort(
            (a, b) => a.audioIndex - b.audioIndex,
          );
    return;
  }
  throw new RangeError(`clé d'état inconnue : ${key}`);
}

/** Empreinte comparable d'une valeur de clé (absence = null). */
export function keyFingerprint(d: Doc, key: StateKey): string | null {
  const v = getKey(d, key);
  return v === undefined ? null : canonicalJson(v);
}

/** Clés qui touchent aux masques ou à l'audio : jamais réappliquées automatiquement (§6.3). */
export function isSensitiveKey(key: StateKey): boolean {
  return (
    key.startsWith('mask:') ||
    key.startsWith('track:') ||
    key.startsWith('sfx:') ||
    key === 'audio.config' ||
    key === 'captions.config'
  );
}

/** Forme canonique d'un document (ordres des collections) : utilisée à la migration. */
export function canonicalizeOrder(d: Doc): void {
  d.captions.items = [...d.captions.items].sort(byStartThenId);
}
