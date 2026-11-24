/**
 * Sous-titres : regroupement des mots de la transcription en lignes, et texte AFFICHÉ.
 *
 *  - Les mots et les lignes sont ancrés en temps SOURCE ; le passage en temps montage se fait
 *    uniquement via les segments (`resolveTiming`).
 *  - Le texte d'origine n'est jamais modifié : une correction du créateur est une donnée à part,
 *    et la pseudonymisation s'applique au texte affiché (corrigé ou non), jamais à la source.
 */
import { resolveTiming, type Segment, type SourceMs } from './time';

export const CAPTION_ROLES = ['mic', 'discord', 'mix'] as const;
export type CaptionRole = (typeof CAPTION_ROLES)[number];

export interface CaptionWord {
  text: string;
  srcStartMs: number;
  srcEndMs: number;
}

export interface CaptionItem {
  id: string;
  speakerRole: CaptionRole;
  srcStartMs: number;
  srcEndMs: number;
  words: CaptionWord[];
}

export interface RoleWords {
  role: CaptionRole;
  words: readonly CaptionWord[];
}

export interface GroupOptions {
  maxCharsPerLine: number;
  maxLines: number;
  /** Une pause plus longue que ce seuil commence une nouvelle ligne. */
  pauseMs: number;
  minDisplayMs: number;
  maxDisplayMs: number;
}

export const DEFAULT_GROUP_OPTIONS: GroupOptions = {
  maxCharsPerLine: 32,
  maxLines: 2,
  pauseMs: 350,
  minDisplayMs: 700,
  maxDisplayMs: 3500,
};

const SENTENCE_END = /[.!?…]$/u;
/** Caractères de contrôle (dont retours à la ligne) : jamais affichés. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Nettoie un mot de transcription (texte non fiable) : contrôles retirés, espaces normalisés. */
export function cleanWord(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

export function joinWords(words: readonly CaptionWord[]): string {
  return words.map((w) => w.text).join(' ');
}

/**
 * Regroupe les mots d'UN locuteur en lignes de sous-titres, dans la plage [fromMs, toMs[.
 * Un mot est retenu si son milieu est dans la plage. Garanties (testées) :
 *  - aucune ligne ne dépasse maxCharsPerLine × maxLines caractères (sauf mot isolé plus long) ;
 *  - les lignes d'un même locuteur ne se chevauchent pas et sont dans l'ordre ;
 *  - durée d'affichage ≥ minDisplayMs quand l'espace le permet, ≤ maxDisplayMs sauf mot plus long.
 */
export function groupWords(
  input: RoleWords,
  fromMs: number,
  toMs: number,
  makeId: (role: CaptionRole, index: number) => string,
  opts: GroupOptions = DEFAULT_GROUP_OPTIONS,
): CaptionItem[] {
  const words = input.words
    .map((w) => ({ ...w, text: cleanWord(w.text) }))
    .filter((w) => w.text && w.srcEndMs > w.srcStartMs)
    .filter((w) => {
      const mid = (w.srcStartMs + w.srcEndMs) / 2;
      return mid >= fromMs && mid < toMs;
    })
    .sort((a, b) => a.srcStartMs - b.srcStartMs || a.srcEndMs - b.srcEndMs);
  const maxChars = opts.maxCharsPerLine * opts.maxLines;
  const groups: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev) {
      const len = joinWords(cur).length + 1 + w.text.length;
      const breakHere =
        w.srcStartMs - prev.srcEndMs > opts.pauseMs ||
        len > maxChars ||
        w.srcEndMs - cur[0]!.srcStartMs > opts.maxDisplayMs ||
        SENTENCE_END.test(prev.text);
      if (breakHere) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  const items: CaptionItem[] = groups.map((g, i) => ({
    id: makeId(input.role, i),
    speakerRole: input.role,
    srcStartMs: g[0]!.srcStartMs,
    // Bornée à la plage : un mot retenu par son milieu peut déborder légèrement.
    srcEndMs: Math.min(toMs, Math.max(...g.map((w) => w.srcEndMs))),
    words: g,
  }));
  // Durée minimale d'affichage, sans empiéter sur la ligne suivante ni sortir de la plage.
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const limit = Math.min(items[i + 1]?.srcStartMs ?? toMs, toMs);
    if (it.srcEndMs - it.srcStartMs < opts.minDisplayMs) {
      it.srcEndMs = Math.max(it.srcEndMs, Math.min(it.srcStartMs + opts.minDisplayMs, limit));
    }
    // Mots qui débordent (chevauchement dans la transcription) : la ligne s'arrête avant la suivante.
    if (items[i + 1] && it.srcEndMs > items[i + 1]!.srcStartMs) {
      it.srcEndMs = Math.max(it.srcStartMs + 1, items[i + 1]!.srcStartMs);
    }
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Texte affiché                                                       */
/* ------------------------------------------------------------------ */

export interface CaptionCorrection {
  itemId: string;
  originalText: string;
  correctedText: string;
  revision: number;
  at: string;
}

/** Fonction de pseudonymisation injectée (ex. createPseudonymizer de @acs/editorial). */
export type CaptionPseudonymizer = (text: string) => { text: string; replacements: number };

export interface DisplayCaption {
  itemId: string;
  speakerRole: CaptionRole;
  /** Texte de la transcription, intact. */
  originalText: string;
  /** Texte affiché : correction éventuelle puis pseudonymisation. */
  text: string;
  corrected: boolean;
  replacements: number;
  /** Positions dans le clip monté (temps montage). Vide si la ligne est coupée. */
  editRanges: { editStartMs: number; editEndMs: number }[];
}

export interface DisplayOptions {
  roles: readonly CaptionRole[];
  pseudonymize: CaptionPseudonymizer;
}

/**
 * Calcule les sous-titres tels qu'ils seront affichés. Seules les lignes des rôles demandés
 * (et donc autorisés par l'appelant) sont produites ; le texte source n'est jamais modifié.
 */
export function displayCaptions(
  segments: readonly Segment[],
  items: readonly CaptionItem[],
  corrections: readonly CaptionCorrection[],
  opts: DisplayOptions,
): DisplayCaption[] {
  const byItem = new Map(corrections.map((c) => [c.itemId, c]));
  const out: DisplayCaption[] = [];
  for (const it of items) {
    if (!opts.roles.includes(it.speakerRole)) continue;
    const { ranges } = resolveTiming(segments, {
      anchor: 'source',
      srcStartMs: it.srcStartMs as SourceMs,
      srcEndMs: it.srcEndMs as SourceMs,
    });
    if (!ranges.length) continue;
    const originalText = joinWords(it.words);
    const correction = byItem.get(it.id);
    const shown = opts.pseudonymize(correction ? correction.correctedText : originalText);
    out.push({
      itemId: it.id,
      speakerRole: it.speakerRole,
      originalText,
      text: shown.text,
      corrected: Boolean(correction),
      replacements: shown.replacements,
      editRanges: ranges.map((r) => ({ editStartMs: r.editStartMs, editEndMs: r.editEndMs })),
    });
  }
  return out.sort(
    (a, b) =>
      a.editRanges[0]!.editStartMs - b.editRanges[0]!.editStartMs || (a.itemId < b.itemId ? -1 : 1),
  );
}
