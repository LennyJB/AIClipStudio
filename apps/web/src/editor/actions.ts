/**
 * Gestes de l'éditeur → opérations typées (docs/plan-etape-7.md §4). Fonctions PURES : chaque
 * geste produit un lot d'opérations et un libellé ; la validation complète (schéma, invariants,
 * autorisations) est faite par le réducteur partagé, côté interface puis côté serveur.
 */
import {
  CAPTION_RETIME_MARGIN_MS,
  EFFECT_CATALOG,
  editToSource,
  presetLayers,
  segmentsV2,
  totalEditDuration,
  type ClipProjectV2,
  type EditMs,
  type EffectTypeV2,
  type EffectV2,
  type Layer,
  type Mask,
  type Operation,
  type Overlay,
  type Sfx,
  type TimingV2,
} from '@acs/timeline';
import { MIN_SEGMENT_MS, segmentAt } from './timeline-math';

export interface Gesture {
  ops: Operation[];
  summary: string;
}

export class GestureError extends Error {}

export const shortId = (prefix: string, uuid: () => string) => `${prefix}-${uuid().slice(0, 8)}`;

const sourceAt = (d: ClipProjectV2, t: number) => {
  const p = editToSource(segmentsV2(d.segments), t as EditMs);
  return p?.kind === 'source' ? p : null;
};

/* ------------------------------ Segments ------------------------------ */

export function splitAt(d: ClipProjectV2, t: number, uuid: () => string): Gesture {
  const placed = segmentAt(d, t);
  const s = placed?.segment;
  if (!placed || !s || s.kind !== 'source') {
    throw new GestureError('Placez la tête de lecture dans un segment vidéo pour couper.');
  }
  const at = s.srcStartMs + Math.round(t - placed.editStartMs);
  if (at - s.srcStartMs < MIN_SEGMENT_MS || s.srcEndMs - at < MIN_SEGMENT_MS) {
    throw new GestureError('Trop près d’un bord du segment pour couper.');
  }
  return {
    ops: [{ type: 'splitSegment', segmentId: s.id, atSrcMs: at, newId: shortId('seg', uuid) }],
    summary: `coupe à ${(t / 1000).toFixed(2)} s`,
  };
}

export function deleteSegment(
  d: ClipProjectV2,
  id: string,
  ripple: boolean,
  uuid: () => string,
): Gesture {
  const i = d.segments.findIndex((s) => s.id === id);
  if (i < 0) throw new GestureError('Segment introuvable.');
  return ripple
    ? {
        ops: [{ type: 'rippleDelete', segmentId: id }],
        summary: `suppression du segment ${i + 1} (avec décalage)`,
      }
    : {
        ops: [{ type: 'liftDelete', segmentId: id, gapId: shortId('vide', uuid) }],
        summary: `suppression du segment ${i + 1} (sans décalage)`,
      };
}

export function freezeAt(d: ClipProjectV2, t: number, durMs: number, uuid: () => string): Gesture {
  const placed = segmentAt(d, t);
  const s = placed?.segment;
  if (!placed || !s || s.kind !== 'source') {
    throw new GestureError('Placez la tête de lecture dans un segment vidéo pour figer l’image.');
  }
  const at = s.srcStartMs + Math.round(t - placed.editStartMs);
  if (at <= s.srcStartMs || at >= s.srcEndMs) throw new GestureError('Instant hors du segment.');
  return {
    ops: [
      {
        type: 'insertFreeze',
        segmentId: s.id,
        atSrcMs: at,
        freezeId: shortId('arret', uuid),
        newId: shortId('seg', uuid),
        editDurMs: Math.max(MIN_SEGMENT_MS, Math.round(durMs)),
      },
    ],
    summary: `arrêt sur image à ${(t / 1000).toFixed(2)} s`,
  };
}

export function trimGesture(
  d: ClipProjectV2,
  id: string,
  fields: { srcStartMs?: number; srcEndMs?: number; editDurMs?: number },
): Gesture {
  const i = d.segments.findIndex((s) => s.id === id);
  return {
    ops: [{ type: 'trimSegment', segmentId: id, ...fields }],
    summary: `rognage du segment ${i + 1}`,
  };
}

export function moveGesture(d: ClipProjectV2, id: string, toIndex: number): Gesture {
  const i = d.segments.findIndex((s) => s.id === id);
  return {
    ops: [{ type: 'moveSegment', segmentId: id, toIndex }],
    summary: `déplacement du segment ${i + 1}`,
  };
}

/* ------------------------------ Sous-titres ------------------------------ */

export function retimeCaption(
  d: ClipProjectV2,
  itemId: string,
  srcStartMs: number,
  srcEndMs: number,
): Gesture {
  const it = d.captions.items.find((x) => x.id === itemId);
  if (!it) throw new GestureError('Sous-titre introuvable.');
  const lo = it.srcStartMs - CAPTION_RETIME_MARGIN_MS;
  const hi = it.srcEndMs + CAPTION_RETIME_MARGIN_MS;
  const a = Math.round(Math.min(Math.max(lo, srcStartMs), hi - MIN_SEGMENT_MS));
  const b = Math.round(Math.max(Math.min(hi, srcEndMs), a + MIN_SEGMENT_MS));
  return {
    ops: [
      {
        type: 'retimeCaption',
        itemId,
        srcStartMs: a === it.srcStartMs ? null : a,
        srcEndMs: b === it.srcEndMs ? null : b,
      },
    ],
    summary: 'horaires d’un sous-titre',
  };
}

export function addManualCaption(
  d: ClipProjectV2,
  t: number,
  text: string,
  uuid: () => string,
): Gesture {
  const p = sourceAt(d, t);
  if (!p || p.frozen) throw new GestureError('Placez la tête de lecture sur une image source.');
  return {
    ops: [
      {
        type: 'setEntity',
        collection: 'manual',
        entity: {
          id: shortId('man', uuid),
          origin: 'creator',
          text,
          srcStartMs: p.srcMs,
          srcEndMs: p.srcMs + 2000,
          style: null,
          position: null,
        },
      },
    ],
    summary: 'sous-titre ajouté',
  };
}

/* ------------------------------ Effets ------------------------------ */

const EDIT_ANCHORED: readonly EffectTypeV2[] = ['fade_in', 'fade_out', 'flash', 'shake'];

export function addEffect(
  d: ClipProjectV2,
  type: EffectTypeV2,
  t: number,
  uuid: () => string,
): Gesture {
  const def = EFFECT_CATALOG[type];
  const total = totalEditDuration(segmentsV2(d.segments));
  let timing: TimingV2;
  if (type === 'fade_in') timing = { anchor: 'edit', from: 'start', offsetMs: 0, durMs: 1000 };
  else if (type === 'fade_out') timing = { anchor: 'edit', from: 'end', offsetMs: 0, durMs: 1000 };
  else if (EDIT_ANCHORED.includes(type)) {
    const start = Math.max(0, Math.min(Math.round(t), total - 500));
    timing = {
      anchor: 'edit',
      from: 'start',
      offsetMs: start,
      durMs: type === 'flash' ? 400 : 800,
    };
  } else {
    const p = sourceAt(d, t);
    if (!p) throw new GestureError('Placez la tête de lecture sur une image source.');
    timing = { anchor: 'source', srcStartMs: p.srcMs, srcEndMs: p.srcMs + 1500 };
  }
  const effect: EffectV2 = {
    id: shortId('fx', uuid),
    type,
    params: { ...def.defaults },
    region: def.region ? { x: 0.35, y: 0.35, w: 0.3, h: 0.3 } : null,
    timing,
    enabled: true,
    origin: 'creator',
    reason: '',
    signals: {},
  };
  return {
    ops: [
      {
        type: 'setEntity',
        collection: 'effect',
        entity: effect as unknown as Record<string, unknown>,
      },
    ],
    summary: `effet ajouté : ${def.label}`,
  };
}

export function setEffect(e: EffectV2, summary: string): Gesture {
  return {
    ops: [
      { type: 'setEntity', collection: 'effect', entity: e as unknown as Record<string, unknown> },
    ],
    summary,
  };
}

/* ------------------------------ Calques texte ------------------------------ */

export function addTextOverlay(
  d: ClipProjectV2,
  t: number,
  text: string,
  uuid: () => string,
): Gesture {
  const total = totalEditDuration(segmentsV2(d.segments));
  const start = Math.max(0, Math.min(Math.round(t), total - 1000));
  const o: Overlay = {
    id: shortId('txt', uuid),
    kind: 'text',
    assetId: null,
    text,
    timing: {
      anchor: 'edit',
      from: 'start',
      offsetMs: start,
      durMs: Math.min(2000, total - start),
    },
    frame: { x: 0.1, y: 0.12, w: 0.8, h: 0.08 },
    opacity: 1,
    z: 0,
  };
  return {
    ops: [
      { type: 'setEntity', collection: 'overlay', entity: o as unknown as Record<string, unknown> },
    ],
    summary: 'calque texte ajouté',
  };
}

/* -------------------- Calques image et effets sonores (7f) -------------------- */

/** Média de la bibliothèque choisi par le créateur (identifiant et caractéristiques utiles). */
export interface PickedAsset {
  id: string;
  kind: 'image' | 'audio';
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/**
 * Cadre initial d'une image : 40 % de la largeur de l'image 9:16, rapport de l'image conservé
 * (le cadre étire l'image : il est donc initialisé avec son rapport), centré, borné à l'image.
 */
export function imageFrame(width: number, height: number) {
  const W = 1080;
  const H = 1920;
  let w = 0.4;
  let h = (w * W * (height / width)) / H;
  if (h > 0.5) {
    w = (w * 0.5) / h;
    h = 0.5;
  }
  const r = (v: number) => Math.round(v * 10_000) / 10_000;
  return { x: r((1 - w) / 2), y: r(Math.max(0, 0.35 - h / 2)), w: r(w), h: r(h) };
}

export function addImageOverlay(
  d: ClipProjectV2,
  t: number,
  asset: PickedAsset,
  kind: 'image' | 'meme',
  uuid: () => string,
): Gesture {
  if (asset.kind !== 'image' || !asset.width || !asset.height) {
    throw new GestureError('Choisissez une image de la bibliothèque.');
  }
  const total = totalEditDuration(segmentsV2(d.segments));
  const start = Math.max(0, Math.min(Math.round(t), total - 1000));
  const o: Overlay = {
    id: shortId(kind === 'meme' ? 'meme' : 'img', uuid),
    kind,
    assetId: asset.id,
    text: null,
    timing: {
      anchor: 'edit',
      from: 'start',
      offsetMs: start,
      durMs: Math.min(2000, total - start),
    },
    frame: imageFrame(asset.width, asset.height),
    opacity: 1,
    z: Math.min(
      20,
      d.overlays.reduce((m, x) => Math.max(m, x.z + 1), 0),
    ),
  };
  return {
    ops: [
      { type: 'setEntity', collection: 'overlay', entity: o as unknown as Record<string, unknown> },
    ],
    summary: kind === 'meme' ? 'mème ajouté' : 'image ajoutée',
  };
}

export function addSfx(
  d: ClipProjectV2,
  t: number,
  asset: PickedAsset,
  uuid: () => string,
): Gesture {
  if (asset.kind !== 'audio' || !asset.durationMs) {
    throw new GestureError('Choisissez un son de la bibliothèque.');
  }
  const total = totalEditDuration(segmentsV2(d.segments));
  const start = Math.max(0, Math.min(Math.round(t), total - 100));
  const s: Sfx = {
    id: shortId('sfx', uuid),
    assetId: asset.id,
    timing: {
      anchor: 'edit',
      from: 'start',
      offsetMs: start,
      durMs: Math.max(1, Math.min(asset.durationMs, total - start)),
    },
    gainDb: 0,
  };
  return {
    ops: [
      { type: 'setEntity', collection: 'sfx', entity: s as unknown as Record<string, unknown> },
    ],
    summary: 'effet sonore ajouté',
  };
}

/* ------------------------------ Masques ------------------------------ */

export function addTimedMask(d: ClipProjectV2, t: number, uuid: () => string): Gesture {
  const p = sourceAt(d, t);
  if (!p) throw new GestureError('Placez la tête de lecture sur une image source.');
  const w = d.source.editWindow;
  const mask: Mask = {
    id: shortId('masque', uuid),
    rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    label: 'Zone masquée',
    mode: 'opaque',
    srcRange: {
      srcStartMs: Math.max(w.srcStartMs, p.srcMs - 1000),
      srcEndMs: Math.min(w.srcEndMs, p.srcMs + 1000),
    },
  };
  return {
    ops: [
      { type: 'setEntity', collection: 'mask', entity: mask as unknown as Record<string, unknown> },
    ],
    summary: 'zone masquée temporelle ajoutée',
  };
}

/** Modification d'un masque ; désactivation : confirmation explicite exigée par l'appelant. */
export function setMask(m: Mask, acknowledgeMaskRisk: boolean, summary: string): Gesture {
  return {
    ops: [
      {
        type: 'setEntity',
        collection: 'mask',
        entity: m as unknown as Record<string, unknown>,
        ...(acknowledgeMaskRisk ? { acknowledgeMaskRisk: true } : {}),
      },
    ],
    summary,
  };
}

/* ------------------------------ Cadrage ------------------------------ */

/** Calques normalisés de la disposition courante (point de départ d'une disposition libre). */
export function layersFromPreset(
  d: ClipProjectV2,
  src: { width: number; height: number },
): Layer[] {
  if (d.layout.preset === 'custom') return structuredClone(d.layout.layers);
  const out = { width: 1080, height: 1920 };
  return presetLayers({ ...d.layout, preset: d.layout.preset }, src, out)
    .filter((l) => l.role !== 'background')
    .map((l, i) => ({
      id: `calque-${i + 1}`,
      role: l.role === 'facecam' ? ('facecam' as const) : ('gameplay' as const),
      crop: {
        x: l.crop.x / src.width,
        y: l.crop.y / src.height,
        w: l.crop.w / src.width,
        h: l.crop.h / src.height,
      },
      frame: {
        x: l.frame.x / out.width,
        y: l.frame.y / out.height,
        w: l.frame.w / out.width,
        h: l.frame.h / out.height,
      },
      z: l.z,
    }));
}

const clampRect = (r: { x: number; y: number; w: number; h: number }) => {
  const w = Math.min(1, Math.max(0.02, r.w));
  const h = Math.min(1, Math.max(0.02, r.h));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
};
export { clampRect };

/** Remplace un calque de la disposition libre (globale, ou surcharge du segment). */
export function setLayers(
  d: ClipProjectV2,
  layers: Layer[],
  segmentId: string | null,
  summary: string,
): Gesture {
  const clean = layers.map((l) => ({ ...l, crop: clampRect(l.crop), frame: clampRect(l.frame) }));
  if (segmentId) {
    return {
      ops: [
        {
          type: 'setEntity',
          collection: 'layoutOverride',
          entity: { id: segmentId, layers: clean },
        },
      ],
      summary,
    };
  }
  return { ops: [{ type: 'setLayout', preset: 'custom', layers: clean }], summary };
}
