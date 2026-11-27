/**
 * Textes du montage (sous-titres et calques texte), PR 7e : lignes à afficher, en temps montage,
 * calculées UNE fois pour l'aperçu canvas et pour l'ASS de l'export (mêmes horaires, mêmes
 * coupures de lignes, même style, même position).
 *
 * Le texte affiché est TOUJOURS celui fourni par le serveur (correction puis pseudonymisation) :
 * ce module ne pseudonymise rien et refuse un sous-titre manuel ou un calque texte dont le texte
 * affiché manque (jamais d'affichage non pseudonymisé).
 *
 * Sémantique (§3.3) : un sous-titre ancré au contenu est affiché figé pendant un arrêt sur image
 * qui le contient, absent pendant un vide ; un calque ancré au montage continue.
 */
import type { CaptionRole, DisplayCaption } from '../captions';
import type { CaptionStyle } from '../project';
import {
  resolveTiming,
  sourceToEdit,
  totalEditDuration,
  type SourceMs,
  type Timing,
} from '../time';
import { segmentsV2, type ClipProjectV2, type TimingV2 } from './schema';

/** Repère des textes (ASS `PlayRes`) : l'image 9:16 de référence. */
export const TEXT_CANVAS = { width: 1080, height: 1920 } as const;

/** Positions prédéfinies : alignement ASS (pavé numérique) et marge verticale (repère 1080×1920). */
export const CAPTION_POSITIONS: Record<
  CaptionStyle['position'],
  { alignment: 2 | 5 | 8; marginV: number }
> = {
  bottom_safe: { alignment: 2, marginV: Math.round(TEXT_CANVAS.height * 0.22) },
  middle: { alignment: 5, marginV: 0 },
  top: { alignment: 8, marginV: Math.round(TEXT_CANVAS.height * 0.14) },
};
/** Marges horizontales des sous-titres (repère 1080×1920). */
export const CAPTION_MARGIN_H = 60;

/** Calque texte : hauteur de police = part de la hauteur du cadre ; contour fixe. */
export const TEXT_OVERLAY_FONT = 'Montserrat ExtraBold' as const;
export const TEXT_OVERLAY_FILL = 0.7;
export const TEXT_OVERLAY_OUTLINE_PX = 4;

/** Découpe en lignes (≤ maxChars) sans jamais perdre de mot ; l'excédent reste sur la dernière. */
export function wrapWords(
  words: readonly string[],
  maxChars: number,
  maxLines: number,
): string[][] {
  const lines: string[][] = [[]];
  for (const w of words) {
    const cur = lines.at(-1)!;
    const len = cur.join(' ').length + (cur.length ? 1 : 0) + w.length;
    if (cur.length && len > maxChars && lines.length < maxLines) lines.push([w]);
    else cur.push(w);
  }
  return lines;
}

export const upperText = (s: string, on: boolean) => (on ? s.toLocaleUpperCase('fr-FR') : s);

/** Sous-titre affiché fourni par le serveur (voir `displayCaptions`). */
export type DisplayCaptionLike = Pick<
  DisplayCaption,
  'itemId' | 'speakerRole' | 'text' | 'corrected' | 'replacements' | 'editRanges'
>;

/**
 * Items de transcription avec leurs horaires d'affichage EFFECTIFS (réglage de l'item, sinon
 * horaires d'origine). Source unique pour l'aperçu, la timeline, les textes du serveur et
 * l'export : un sous-titre ramené dans le montage par un réglage n'est jamais oublié.
 */
export function effectiveCaptionItems(d: ClipProjectV2): ClipProjectV2['captions']['items'] {
  const overrides = new Map(d.captions.overrides.map((o) => [o.id, o]));
  return d.captions.items.map((it) => {
    const ov = overrides.get(it.id);
    if (!ov || (ov.srcStartMs === null && ov.srcEndMs === null)) return it;
    return {
      ...it,
      srcStartMs: ov.srcStartMs ?? it.srcStartMs,
      srcEndMs: ov.srcEndMs ?? it.srcEndMs,
    };
  });
}

export interface CaptionLineWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionLine {
  /** Identifiant de l'item (transcription) ou du sous-titre manuel. */
  id: string;
  origin: 'transcript' | 'creator';
  /** Temps MONTAGE (ms). */
  startMs: number;
  endMs: number;
  text: string;
  /** Mots en temps montage (mise en évidence du mot prononcé) ; null si indisponible. */
  words: CaptionLineWord[] | null;
  emphasize: boolean;
  /** Style complet (global + réglage de l'item), null : style global inchangé. */
  style: CaptionStyle | null;
  /** Centre du bloc (fraction de l'image 9:16), null : position du style. */
  position: { x: number; y: number } | null;
}

export class TextLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextLayerError';
  }
}

const asTiming = (t: TimingV2): Timing => t as unknown as Timing;

/**
 * Lignes de sous-titres du document v2.
 *  - `display` : items de transcription affichés (corrigés, pseudonymisés) des sources CHOISIES ;
 *    l'appelant vérifie l'autorisation (moteur) ou ne fournit que les sources autorisées (aperçu) ;
 *  - `manual` : texte affiché (pseudonymisé) de chaque sous-titre manuel ;
 *  - `emphasis` : effet `caption_emphasis` actif.
 * Sans réglage par item ni sous-titre manuel, le résultat est EXACTEMENT celui du moteur de
 * l'étape 6 (empreintes de plan inchangées).
 */
export function captionLinesV2(
  d: ClipProjectV2,
  display: readonly DisplayCaptionLike[],
  manual: Readonly<Record<string, string>>,
  opts: { roles: readonly CaptionRole[]; emphasis: boolean },
): CaptionLine[] {
  if (!d.captions.enabled) return [];
  const segments = segmentsV2(d.segments);
  const total = totalEditDuration(segments);
  const items = new Map(d.captions.items.map((it) => [it.id, it]));
  const overrides = new Map(d.captions.overrides.map((o) => [o.id, o]));
  const punch = d.anchors.punchlineMs;
  const emphasis = opts.emphasis && d.captions.style.emphasizePunchline;
  // Réglage partiel : seules les propriétés présentes remplacent celles du style global.
  const styled = (s: { [K in keyof CaptionStyle]?: CaptionStyle[K] | undefined } | null) => {
    if (!s) return null;
    const own = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
    return Object.keys(own).length ? ({ ...d.captions.style, ...own } as CaptionStyle) : null;
  };
  const lines: CaptionLine[] = [];
  for (const c of display) {
    if (!opts.roles.includes(c.speakerRole)) continue;
    const item = items.get(c.itemId);
    if (!item) continue;
    const ov = overrides.get(item.id);
    const retimed = ov && (ov.srcStartMs !== null || ov.srcEndMs !== null);
    const ranges = retimed
      ? resolveTiming(segments, {
          anchor: 'source',
          srcStartMs: (ov.srcStartMs ?? item.srcStartMs) as SourceMs,
          srcEndMs: (ov.srcEndMs ?? item.srcEndMs) as SourceMs,
        }).ranges
      : c.editRanges;
    const exact = !retimed && !c.corrected && c.replacements === 0 && ranges.length === 1;
    for (const r of ranges) {
      const words = exact
        ? item.words
            .map((w) => {
              const pos = sourceToEdit(segments, w.srcStartMs as SourceMs)[0];
              if (!pos) return null;
              const startMs = Math.max(r.editStartMs, pos.editMs);
              const endMs = Math.min(r.editEndMs, startMs + (w.srcEndMs - w.srcStartMs));
              return { text: w.text, startMs, endMs: Math.max(endMs, startMs + 10) };
            })
            .filter((w): w is CaptionLineWord => w !== null)
        : null;
      lines.push({
        id: item.id,
        origin: 'transcript',
        startMs: r.editStartMs,
        endMs: Math.min(r.editEndMs, total),
        text: c.text,
        words: words && words.length === item.words.length ? words : null,
        emphasize: emphasis && item.srcStartMs <= punch && punch < item.srcEndMs,
        style: styled(ov?.style ?? null),
        position: ov?.position ?? null,
      });
    }
  }
  for (const m of d.captions.manual) {
    const text = manual[m.id];
    if (text === undefined || !text.trim()) {
      throw new TextLayerError(`Texte affiché (pseudonymisé) manquant pour le sous-titre ${m.id}`);
    }
    const { ranges } = resolveTiming(segments, {
      anchor: 'source',
      srcStartMs: m.srcStartMs as SourceMs,
      srcEndMs: m.srcEndMs as SourceMs,
    });
    for (const r of ranges) {
      lines.push({
        id: m.id,
        origin: 'creator',
        startMs: r.editStartMs,
        endMs: Math.min(r.editEndMs, total),
        text,
        words: null,
        emphasize: false,
        style: styled(m.style),
        position: m.position,
      });
    }
  }
  return lines;
}

export interface TextOverlayLine {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Cadre normalisé dans l'image 9:16 ; le texte y est centré. */
  frame: { x: number; y: number; w: number; h: number };
  opacity: number;
  z: number;
}

/**
 * Calques texte visibles (plages en temps montage). Les calques image et mème sont traités par la
 * bibliothèque de médias (`imageOverlayPlacements`, PR 7f) : ils ne sont pas produits ici.
 */
export function textOverlayLines(
  d: ClipProjectV2,
  texts: Readonly<Record<string, string>>,
): TextOverlayLine[] {
  const segments = segmentsV2(d.segments);
  const total = totalEditDuration(segments);
  const out: TextOverlayLine[] = [];
  for (const o of d.overlays) {
    if (o.kind !== 'text') continue;
    const text = texts[o.id];
    if (text === undefined || !text.trim()) {
      throw new TextLayerError(`Texte affiché (pseudonymisé) manquant pour le calque ${o.id}`);
    }
    for (const r of resolveTiming(segments, asTiming(o.timing)).ranges) {
      const start = Math.max(0, r.editStartMs);
      const end = Math.min(total, r.editEndMs);
      if (end <= start) continue;
      out.push({
        id: o.id,
        startMs: start,
        endMs: end,
        text,
        frame: o.frame,
        opacity: o.opacity,
        z: o.z,
      });
    }
  }
  return out.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1) || a.startMs - b.startMs);
}

/** Taille de police d'un calque texte (repère 1080×1920). */
export const textOverlayFontPx = (frameH: number) =>
  Math.max(8, Math.round(frameH * TEXT_CANVAS.height * TEXT_OVERLAY_FILL));
