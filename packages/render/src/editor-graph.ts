/**
 * Graphe FFmpeg des fonctions de l'éditeur (PR 7e) : disposition personnalisée et surcharges par
 * segment, masques temporels, flou créatif, zooms localisés, secousse, éclair, automatisation du
 * gain et effets audio. Code PUR : uniquement des nombres validés et des énumérations ; aucun
 * texte du document n'entre dans le graphe (les textes passent par l'ASS échappé).
 *
 * Chaque enveloppe est celle de `@acs/timeline` (`effects.ts`), avec les mêmes constantes :
 * l'aperçu (canvas, Web Audio) et l'export appliquent la même fonction du temps.
 *
 * Ordre de l'image (§3.4, §5.4) :
 *   image source → aplats OPAQUES (permanents, puis temporels avec marge) → images du segment →
 *   flou créatif (`blur_region`, APRÈS les aplats) → disposition → concaténation → zooms →
 *   secousse → éclair → textes (ASS) → format final.
 */
import { toPixelRect } from '@acs/media';
import {
  BLEEP_LEVEL,
  BLEEP_RAMP_S,
  DUCK_RAMP_S,
  MASK_TIME_MARGIN_MS,
  SHAKE_FX_HZ,
  SHAKE_FY_HZ,
  ZOOM_RAMP_S,
  type Mask,
  type PixelRect,
  type PlacedLayer,
  type ResolvedEffect,
} from '@acs/timeline';
import { num, zoompan, type ZoomWindow } from './layout';

const crop = (r: PixelRect) => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
const scale = (w: number, h: number) => `scale=${w}:${h}:flags=lanczos,setsar=1`;
export const ffColor = (hex: string) => `0x${hex.slice(1).toUpperCase()}`;

/** Rampe trapézoïdale (expression FFmpeg) : même formule que `trapezoid` de @acs/timeline. */
export const trapezoidExpr = (v: string, s: number, e: number, ramp: number) =>
  `clip(min((${v}-${num(s)})/${num(ramp)},(${num(e)}-${v})/${num(ramp)}),0,1)`;

/* ------------------------------------------------------------------ */
/* Masques temporels                                                   */
/* ------------------------------------------------------------------ */

/**
 * Aplats d'une branche (image source) : masques permanents, puis masques temporels dont la plage
 * (+ marge de sécurité) recoupe la branche. `local(srcMs)` convertit un instant source en temps de
 * la branche (s) ; `frozenAt` : arrêt sur image (un seul instant source, aplats statiques).
 */
export function maskFilters(
  masks: readonly Mask[],
  src: { width: number; height: number },
  branch: { srcStartMs: number; srcEndMs: number; frozenAtMs: number | null },
): string[] {
  const out: string[] = [];
  for (const m of masks) {
    if (m.mode !== 'opaque') continue;
    const p = toPixelRect(m.rect, src.width, src.height);
    const box = `drawbox=x=${p.x}:y=${p.y}:w=${p.w}:h=${p.h}:color=black@1:t=fill`;
    if (!m.srcRange) {
      out.push(box);
      continue;
    }
    const a = m.srcRange.srcStartMs - MASK_TIME_MARGIN_MS;
    const b = m.srcRange.srcEndMs + MASK_TIME_MARGIN_MS;
    if (branch.frozenAtMs !== null) {
      if (a <= branch.frozenAtMs && branch.frozenAtMs < b) out.push(box);
      continue;
    }
    if (b <= branch.srcStartMs || a >= branch.srcEndMs) continue;
    if (a <= branch.srcStartMs && b >= branch.srcEndMs) {
      out.push(box); // couvre toute la branche
      continue;
    }
    const s = (a - branch.srcStartMs) / 1000;
    const e = (b - branch.srcStartMs) / 1000;
    out.push(`${box}:enable='between(t,${num(s)},${num(e)})'`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Flou créatif (après les aplats, avant la disposition)               */
/* ------------------------------------------------------------------ */

export interface BlurWindow {
  region: PixelRect;
  sigma: number;
  /** Fenêtre en temps de la branche (s) ; null : toute la branche. */
  local: { s: number; e: number } | null;
}

export function blurParts(
  input: string,
  blurs: readonly BlurWindow[],
  sfx: string,
): { parts: string[]; output: string } {
  const parts: string[] = [];
  let cur = input;
  blurs.forEach((b, i) => {
    const m = `[bm${sfx}_${i}]`;
    const r = `[br${sfx}_${i}]`;
    const bb = `[bb${sfx}_${i}]`;
    const next = `[bo${sfx}_${i}]`;
    const enable = b.local ? `:enable='between(t,${num(b.local.s)},${num(b.local.e)})'` : '';
    parts.push(`${cur}split=2${m}${r}`);
    parts.push(`${r}${crop(b.region)},gblur=sigma=${num(b.sigma)}${bb}`);
    parts.push(`${m}${bb}overlay=${b.region.x}:${b.region.y}${enable}${next}`);
    cur = next;
  });
  return { parts, output: cur };
}

/* ------------------------------------------------------------------ */
/* Disposition personnalisée                                           */
/* ------------------------------------------------------------------ */

/**
 * Calques placés (géométrie partagée `segmentLayers`) sur un fond uni : chaque calque est un
 * recadrage de l'image source (aplats déjà posés) redimensionné dans son cadre de sortie.
 */
export function customLayoutParts(
  layers: readonly PlacedLayer[],
  o: {
    input: string;
    output: string;
    sfx: string;
    width: number;
    height: number;
    background: string;
    fps: number;
    /** Zooms du calque facecam (`reaction_hold`), temps de la branche. */
    facecamZooms: readonly ZoomWindow[];
  },
): string[] {
  const n = layers.length;
  const l = (name: string, i?: number) => `[${name}${o.sfx}${i === undefined ? '' : `_${i}`}]`;
  const parts = [
    `${o.input}split=${n + 1}${l('cbase')}${layers.map((_, i) => l('cl', i)).join('')}`,
    `${l('cbase')}crop=2:2:0:0,${scale(o.width, o.height)},drawbox=x=0:y=0:w=iw:h=ih:color=${ffColor(o.background)}@1:t=fill${l('cc', 0)}`,
  ];
  layers.forEach((layer, i) => {
    const zoom =
      layer.role === 'facecam' && o.facecamZooms.length
        ? `,${zoompan(o.facecamZooms, layer.frame.w, layer.frame.h, o.fps)}`
        : '';
    parts.push(
      `${l('cl', i)}${crop(layer.crop)},${scale(layer.frame.w, layer.frame.h)}${zoom}${l('cs', i)}`,
    );
    const target = i === n - 1 ? o.output : l('cc', i + 1);
    parts.push(`${l('cc', i)}${l('cs', i)}overlay=${layer.frame.x}:${layer.frame.y}${target}`);
  });
  return parts;
}

/* ------------------------------------------------------------------ */
/* Image composée : zooms, secousse, éclair                            */
/* ------------------------------------------------------------------ */

export interface ZoomPiece {
  startS: number;
  endS: number;
  cx: number;
  cy: number;
}

/** Expression du centre (fraction) : la dernière fenêtre qui contient `it`, sinon 0,5. */
function centerExpr(pieces: readonly ZoomPiece[], key: 'cx' | 'cy'): string {
  let e = '0.5';
  for (const p of pieces) {
    e = `if(between(it,${num(p.startS)},${num(p.endS)}),${num(p[key])},${e})`;
  }
  return e;
}

/** `zoompan` avec centre variable (zooms localisés) ; centre fixe si aucun zoom localisé. */
export function zoompanCentered(
  windows: readonly ZoomWindow[],
  pieces: readonly ZoomPiece[],
  w: number,
  h: number,
  fps: number,
): string {
  if (!pieces.length) return zoompan(windows, w, h, fps);
  const base = zoompan(windows, w, h, fps);
  const x = `clip(${centerExpr(pieces, 'cx')}*iw-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip(${centerExpr(pieces, 'cy')}*ih-ih/zoom/2,0,ih-ih/zoom)`;
  return base
    .replace(`x='iw/2-(iw/zoom/2)'`, `x='${x}'`)
    .replace(`y='ih/2-(ih/zoom/2)'`, `y='${y}'`);
}

export interface CompositeEffects {
  zooms: readonly ZoomWindow[];
  zoomPieces: readonly ZoomPiece[];
  shakes: readonly { startS: number; endS: number; amplitude: number }[];
  flashes: readonly { startS: number; endS: number; intensity: number }[];
}

/**
 * Effets de l'image composée, en temps montage (`t` = temps du flux concaténé). Retourne les
 * parties du graphe et l'étiquette de sortie.
 */
export function compositeEffectParts(
  input: string,
  fx: CompositeEffects,
  o: { width: number; height: number; fps: number; retime?: string },
): { parts: string[]; output: string } {
  const parts: string[] = [];
  let cur = input;
  if (fx.zooms.length) {
    // Image exacte : l'horodatage de l'image est remis à l'instant demandé après le zoom.
    const retime = o.retime ? `,${o.retime}` : '';
    parts.push(
      `${cur}${zoompanCentered(fx.zooms, fx.zoomPieces, o.width, o.height, o.fps)}${retime}[fxz]`,
    );
    cur = '[fxz]';
  }
  if (fx.shakes.length) {
    const term = (k: 'x' | 'y') =>
      fx.shakes
        .map((s) => {
          const a = s.amplitude * o.width;
          const f = k === 'x' ? SHAKE_FX_HZ : SHAKE_FY_HZ;
          const phase = k === 'x' ? '' : '+1';
          return `if(between(t,${num(s.startS)},${num(s.endS)})*lt(t,${num(s.endS)}),round(${num(a)}*sin(2*PI*${f}*(t-${num(s.startS)})${phase})),0)`;
        })
        .join('+');
    parts.push(`${cur}split=2[fxsa][fxsb]`);
    parts.push(`[fxsa][fxsb]overlay=x='${term('x')}':y='${term('y')}':eval=frame[fxs]`);
    cur = '[fxs]';
  }
  fx.flashes.forEach((f, i) => {
    const dur = Math.max(0.001, f.endS - f.startS);
    parts.push(
      `color=c=white:s=${o.width}x${o.height}:r=${num(o.fps)}:d=${num(f.endS + 0.1)},format=rgba,colorchannelmixer=aa=${num(f.intensity)},fade=t=out:st=${num(f.startS)}:d=${num(dur)}:alpha=1[fxfl${i}]`,
    );
    parts.push(
      `${cur}[fxfl${i}]overlay=eof_action=pass:enable='between(t,${num(f.startS)},${num(f.endS)})'[fxf${i}]`,
    );
    cur = `[fxf${i}]`;
  });
  return { parts, output: cur };
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

/** Taille des trames audio avant une expression de gain (≈ 1,3 ms à 48 kHz). */
export const AUDIO_EXPR_SAMPLES = 64;
const exprVolume = (expr: string) =>
  `asetnsamples=n=${AUDIO_EXPR_SAMPLES}:p=0,volume='${expr}':eval=frame`;

/**
 * Automatisation (points en temps SOURCE, dB, interpolation linéaire, constante aux bords) d'une
 * branche source : `t` = temps de la branche, instant source = `srcStartMs` + t.
 */
export function automationFilter(
  points: readonly { srcMs: number; gainDb: number }[],
  srcStartMs: number,
  srcEndMs: number,
): string | null {
  if (!points.length) return null;
  // Points utiles : ceux de la branche et leurs voisins immédiats.
  const first = Math.max(0, points.findIndex((p) => p.srcMs >= srcStartMs) - 1);
  const lastIdx = points.findIndex((p) => p.srcMs > srcEndMs);
  const pts = points.slice(first, lastIdx < 0 ? points.length : lastIdx + 1);
  const S = `(${num(srcStartMs / 1000)}+t)`;
  let e = num(pts.at(-1)!.gainDb);
  for (let i = pts.length - 1; i >= 1; i--) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const as = a.srcMs / 1000;
    const bs = b.srcMs / 1000;
    e = `if(lt(${S},${num(bs)}),${num(a.gainDb)}+(${num(b.gainDb - a.gainDb)})*(${S}-${num(as)})/${num(bs - as)},${e})`;
  }
  e = `if(lt(${S},${num(pts[0]!.srcMs / 1000)}),${num(pts[0]!.gainDb)},${e})`;
  return exprVolume(`pow(10,(${e})/20)`);
}

type AudioFx = Pick<ResolvedEffect, 'type' | 'params' | 'startS' | 'endS'>;

/** Atténuation et bips sur une piste de l'enregistrement (temps montage). */
export function sourceEffectsFilter(fx: readonly AudioFx[]): string | null {
  const terms = fx.flatMap((e) => {
    if (e.type === 'duck') {
      const g = e.params['gainDb'] ?? -12;
      return [`pow(10,${num(g)}*${trapezoidExpr('t', e.startS, e.endS, DUCK_RAMP_S)}/20)`];
    }
    if (e.type === 'bleep') return [`(1-${trapezoidExpr('t', e.startS, e.endS, BLEEP_RAMP_S)})`];
    return [];
  });
  return terms.length ? exprVolume(terms.join('*')) : null;
}

/** Fondus d'entrée et de sortie du mixage complet (temps montage). */
export function masterFadeFilter(fx: readonly AudioFx[]): string | null {
  const terms = fx.flatMap((e) => {
    const d = Math.max(0.001, e.endS - e.startS);
    const inside = `between(t,${num(e.startS)},${num(e.endS)})`;
    if (e.type === 'fade_in') return [`if(${inside},clip((t-${num(e.startS)})/${num(d)},0,1),1)`];
    if (e.type === 'fade_out') return [`if(${inside},clip((${num(e.endS)}-t)/${num(d)},0,1),1)`];
    return [];
  });
  return terms.length ? exprVolume(terms.join('*')) : null;
}

/** Le filtre `sine` de FFmpeg produit une amplitude de 1/8 : compensée pour atteindre BLEEP_LEVEL. */
export const SINE_SOURCE_AMPLITUDE = 1 / 8;

/** Ton de chaque bip (même rampe que la coupure des pistes). */
export function bleepToneParts(
  fx: readonly AudioFx[],
  totalS: number,
  audioFormat: string,
): { parts: string[]; labels: string[] } {
  const parts: string[] = [];
  const labels: string[] = [];
  fx.filter((e) => e.type === 'bleep').forEach((e, i) => {
    const f = Math.round(e.params['frequencyHz'] ?? 1000);
    parts.push(
      `sine=frequency=${f}:sample_rate=48000:duration=${num(totalS)},${audioFormat},${exprVolume(`${num(BLEEP_LEVEL / SINE_SOURCE_AMPLITUDE)}*${trapezoidExpr('t', e.startS, e.endS, BLEEP_RAMP_S)}`)}[tone${i}]`,
    );
    labels.push(`[tone${i}]`);
  });
  return { parts, labels };
}

export { ZOOM_RAMP_S };
