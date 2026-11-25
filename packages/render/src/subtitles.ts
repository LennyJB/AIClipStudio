/**
 * Sous-titres incrustés (ASS, rendus par libass) et fichier .srt livré avec l'export
 * (docs/plan-etape-6.md §7.3).
 *
 * Le texte vient de la transcription (donnée NON fiable) : caractères de contrôle supprimés,
 * `\`, `{` et `}` remplacés par des caractères visuellement proches qui ne sont pas interprétés
 * par libass (aucune injection de balises). Aucun mot n'est jamais retiré ni inventé : une ligne
 * trop longue est conservée en entier.
 */
import type { CaptionStyle } from '@acs/timeline';
import { CANVAS } from './presets';

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

/** Position dans la zone sûre des applications (bandeau bas réservé à leur interface). */
const POSITION: Record<CaptionStyle['position'], { alignment: number; marginV: number }> = {
  bottom_safe: { alignment: 2, marginV: Math.round(CANVAS.height * 0.22) },
  middle: { alignment: 5, marginV: 0 },
  top: { alignment: 8, marginV: Math.round(CANVAS.height * 0.14) },
};

const upper = (s: string, on: boolean) => (on ? s.toLocaleUpperCase('fr-FR') : s);

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

export function buildAss(lines: readonly SubtitleLine[], style: CaptionStyle): string {
  const font = FONT[style.font];
  const pos = POSITION[style.position];
  const karaoke = style.karaoke;
  const primary = assColor(karaoke ? style.highlightColor : style.color);
  const secondary = assColor(style.color);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${CANVAS.width}`,
    `PlayResY: ${CANVAS.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font.name},${style.sizePx},${primary},${secondary},${assColor(style.outlineColor)},&H80000000,${font.bold},0,0,0,100,100,0,0,1,${style.outlinePx},${style.shadow ? 2 : 0},${pos.alignment},60,60,${pos.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = [...lines]
    .filter((l) => l.endMs > l.startMs && l.text.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map(
      (l) =>
        `Dialogue: 0,${assTime(l.startMs)},${assTime(l.endMs)},Default,,0,0,0,,${lineText(l, style)}`,
    );
  return `${[...header, ...events].join('\n')}\n`;
}

export function buildSrt(lines: readonly SubtitleLine[], style: CaptionStyle): string {
  return [...lines]
    .filter((l) => l.endMs > l.startMs && l.text.trim())
    .sort((a, b) => a.startMs - b.startMs)
    .map((l, i) => {
      const words = cleanSrtText(upper(l.text, style.uppercase)).split(' ').filter(Boolean);
      const text = wrapWords(words, style.maxCharsPerLine, style.maxLines)
        .map((ln) => ln.join(' '))
        .join('\n');
      return `${i + 1}\n${srtTime(l.startMs)} --> ${srtTime(l.endMs)}\n${text}\n`;
    })
    .join('\n');
}
