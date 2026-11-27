/**
 * Sous-titres incrustés (ASS, rendus par libass) et fichier .srt livré avec l'export
 * (docs/plan-etape-6.md §7.3).
 *
 * Le texte vient de la transcription (donnée NON fiable) : caractères de contrôle supprimés,
 * `\`, `{` et `}` remplacés par des caractères visuellement proches qui ne sont pas interprétés
 * par libass (aucune injection de balises). Aucun mot n'est jamais retiré ni inventé : une ligne
 * trop longue est conservée en entier.
 */
import {
  CAPTION_MARGIN_H,
  CAPTION_POSITIONS,
  canonicalJson,
  TEXT_CANVAS,
  TEXT_OVERLAY_FONT,
  TEXT_OVERLAY_OUTLINE_PX,
  textOverlayFontPx,
  upperText,
  wrapWords,
  type CaptionStyle,
  type TextOverlayLine,
} from '@acs/timeline';

export { wrapWords };

export interface SubtitleWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleLine {
  /** Temps MONTAGE (ms). */
  startMs: number;
  endMs: number;
  /** Texte affiché (corrigé et pseudonymisé), jamais vide. */
  text: string;
  /** Mots en temps montage pour la mise en évidence du mot prononcé ; null si indisponible. */
  words: SubtitleWord[] | null;
  /** Ligne de la chute mise en évidence. */
  emphasize: boolean;
  /** Style propre à la ligne (réglage de l'item, sous-titre manuel) ; absent : style global. */
  style?: CaptionStyle | null;
  /** Centre du bloc (fraction de l'image 9:16) ; absent : position du style. */
  position?: { x: number; y: number } | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** Texte sûr pour libass : aucune séquence de balise ou d'échappement possible. */
export function escapeAssText(s: string): string {
  return s
    .replace(CONTROL, ' ')
    .replace(/\\/gu, '\uFF3C')
    .replace(/\{/gu, '\uFF5B')
    .replace(/\}/gu, '\uFF5D')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function cleanSrtText(s: string): string {
  return s.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

/** « #RRGGBB » → couleur ASS « &H00BBGGRR » (opaque). */
export function assColor(hex: string, alpha = 0): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!m) throw new RangeError(`couleur invalide : ${hex}`);
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${m[3]!.toUpperCase()}${m[2]!.toUpperCase()}${m[1]!.toUpperCase()}`;
}

export function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const r = t % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

const FONT: Record<CaptionStyle['font'], { name: string; bold: number }> = {
  'Montserrat ExtraBold': { name: 'Montserrat ExtraBold', bold: 0 },
  Inter: { name: 'Inter', bold: -1 },
};

const POSITION = CAPTION_POSITIONS;
const upper = upperText;

function lineText(l: SubtitleLine, style: CaptionStyle): string {
  const words = (l.words?.length ? l.words.map((w) => w.text) : l.text.split(' '))
    .map((w) => escapeAssText(upper(w, style.uppercase)))
    .filter(Boolean);
  const wrapped = wrapWords(words, style.maxCharsPerLine, style.maxLines);
  const prefix = l.emphasize ? `{\\1c${assColor(style.highlightColor)}\\fscx108\\fscy108}` : '';
  if (!style.karaoke || !l.words?.length || l.emphasize) {
    return prefix + wrapped.map((ln) => ln.join(' ')).join('\\N');
  }
  // Mot prononcé mis en évidence : avant son temps, couleur secondaire (texte normal) ; après,
  // couleur primaire (mise en évidence).
  const out: string[] = [];
  let cursor = l.startMs;
  let index = 0;
  wrapped.forEach((ln, li) => {
    const parts: string[] = [];
    for (const w of ln) {
      const src = l.words![index++]!;
      const gap = Math.max(0, Math.round((src.startMs - cursor) / 10));
      const dur = Math.max(1, Math.round((src.endMs - Math.max(cursor, src.startMs)) / 10));
      parts.push(`${gap ? `{\\k${gap}}` : ''}{\\k${dur}}${w}`);
      cursor = Math.max(cursor, src.endMs);
    }
    out.push(parts.join(' '));
    if (li < wrapped.length - 1) out.push('\\N');
  });
  return out.join('').replace(/ \\N/gu, '\\N');
}

/** Ligne de style ASS d'un style de sous-titre. */
function styleLine(name: string, style: CaptionStyle): string {
  const font = FONT[style.font];
  const pos = POSITION[style.position];
  const primary = assColor(style.karaoke ? style.highlightColor : style.color);
  const secondary = assColor(style.color);
  return `Style: ${name},${font.name},${style.sizePx},${primary},${secondary},${assColor(style.outlineColor)},&H80000000,${font.bold},0,0,0,100,100,0,0,1,${style.outlinePx},${style.shadow ? 2 : 0},${pos.alignment},${CAPTION_MARGIN_H},${CAPTION_MARGIN_H},${pos.marginV},1`;
}

const OVERLAY_STYLE = `Style: Overlay,${TEXT_OVERLAY_FONT},72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${TEXT_OVERLAY_OUTLINE_PX},0,5,0,0,0,1`;

const pos = (p: { x: number; y: number }) =>
  `\\pos(${Math.round(p.x * TEXT_CANVAS.width)},${Math.round(p.y * TEXT_CANVAS.height)})`;

/**
 * Fichier ASS : sous-titres (style global, styles propres aux lignes réglées, position éventuelle)
 * puis calques texte (couche 1 + ordre d'empilement, au-dessus des sous-titres). Sans réglage par
 * ligne ni calque texte, le fichier est EXACTEMENT celui de l'étape 6.
 */
export function buildAss(
  lines: readonly SubtitleLine[],
  style: CaptionStyle,
  overlays: readonly TextOverlayLine[] = [],
): string {
  const styles = new Map<string, { name: string; style: CaptionStyle }>();
  const styleOf = (l: SubtitleLine) => {
    if (!l.style) return { name: 'Default', style };
    const key = canonicalJson(l.style);
    let s = styles.get(key);
    if (!s) {
      s = { name: `S${styles.size + 1}`, style: l.style };
      styles.set(key, s);
    }
    return s;
  };
  const sorted = [...lines]
    .filter((l) => l.endMs > l.startMs && l.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  const events = sorted.map((l) => {
    const s = styleOf(l);
    const at = l.position ? `{\\an5${pos(l.position)}}` : '';
    return `Dialogue: 0,${assTime(l.startMs)},${assTime(l.endMs)},${s.name},,0,0,0,,${at}${lineText(l, s.style)}`;
  });
  for (const o of overlays) {
    if (o.endMs <= o.startMs) continue;
    const text = escapeAssText(o.text);
    if (!text) continue;
    const alpha = Math.round((1 - o.opacity) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
    const center = { x: o.frame.x + o.frame.w / 2, y: o.frame.y + o.frame.h / 2 };
    events.push(
      `Dialogue: ${1 + o.z},${assTime(o.startMs)},${assTime(o.endMs)},Overlay,,0,0,0,,{\\an5${pos(center)}\\fs${textOverlayFontPx(o.frame.h)}\\alpha&H${alpha}&}${text}`,
    );
  }
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${TEXT_CANVAS.width}`,
    `PlayResY: ${TEXT_CANVAS.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine('Default', style),
    ...[...styles.values()].map((s) => styleLine(s.name, s.style)),
    ...(overlays.length ? [OVERLAY_STYLE] : []),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  return `${[...header, ...events].join('\n')}\n`;
}

export function buildSrt(lines: readonly SubtitleLine[], style: CaptionStyle): string {
  return [...lines]
    .filter((l) => l.endMs > l.startMs && l.text.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map((l, i) => {
      const st = l.style ?? style;
      const words = cleanSrtText(upper(l.text, st.uppercase)).split(' ').filter(Boolean);
      const text = wrapWords(words, st.maxCharsPerLine, st.maxLines)
        .map((ln) => ln.join(' '))
        .join('\n');
      return `${i + 1}\n${srtTime(l.startMs)} --> ${srtTime(l.endMs)}\n${text}\n`;
    })
    .join('\n');
}
