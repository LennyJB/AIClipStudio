/**
 * Pseudonymisation locale, appliquée AVANT tout envoi :
 *  - noms et pseudos listés dans le fichier de confidentialité → étiquette stable ;
 *  - adresses e-mail, liens, numéros de téléphone et mentions « @… » → masqués.
 * Limite assumée : sans modèle de reconnaissance des noms, un nom absent de la liste
 * n'est pas détecté. La correspondance nom ↔ étiquette ne quitte jamais la machine.
 */
import type { PrivacyFile } from '@acs/shared';

export interface PseudonymizeResult {
  text: string;
  /** Remplacements par étiquette (ex. { "Coéquipier 1": 2 }). */
  pseudonyms: Record<string, number>;
  masked: { email: number; url: number; phone: number; mention: number };
}

export interface Pseudonymizer {
  /** Étiquettes configurées, dans l'ordre du fichier. */
  readonly labels: readonly string[];
  apply(text: string): PseudonymizeResult;
}

/** Repliement pour la comparaison : minuscules, sans accents. */
function fold(c: string): string {
  return c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Texte replié + correspondance de chaque caractère replié vers sa position d'origine. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function autoLabel(i: number): string {
  let n = i;
  let suffix = '';
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Personne ${suffix}`;
}

const MASKS = [
  {
    kind: 'email',
    re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
    label: '[e-mail masqué]',
  },
  {
    kind: 'url',
    re: /(?:\bhttps?:\/\/|\bwww\.)\S+|\b[\p{L}\p{N}-]+\.(?:com|fr|net|org|gg|tv|io|be|ch|ca|me|ly|link)(?:\/\S*)?(?![\p{L}\p{N}])/giu,
    label: '[lien masqué]',
  },
  {
    kind: 'phone',
    re: /(?:(?:\+|00)\d{1,3}[\s.-]?\d(?:[\s.-]?\d{2}){4}|(?<!\d)0\d(?:[\s.-]?\d{2}){4})(?!\d)/g,
    label: '[numéro masqué]',
  },
  {
    kind: 'mention',
    re: /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.]{2,32}/gu,
    label: '[mention masquée]',
  },
] as const;

export function createPseudonymizer(file: PrivacyFile | null): Pseudonymizer {
  const entries = (file?.pseudonyms ?? []).map((p, i) => ({
    label: p.label ?? autoLabel(i),
    names: p.names,
  }));
  const byFolded = new Map<string, string>();
  for (const e of entries) {
    for (const n of e.names) {
      const key = fold(n.trim().replace(/\s+/g, ' '));
      if (key && !byFolded.has(key)) byFolded.set(key, e.label);
    }
  }
  // Les noms les plus longs d'abord (« Jean Paul » avant « Jean »).
  const keys = [...byFolded.keys()].sort((a, b) => b.length - a.length);
  const nameRe = keys.length
    ? new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${keys.map((k) => escapeRe(k).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}_])`,
        'gu',
      )
    : null;

  return {
    labels: entries.map((e) => e.label),
    apply(input: string): PseudonymizeResult {
      const masked = { email: 0, url: 0, phone: 0, mention: 0 };
      let text = input;
      for (const m of MASKS) {
        text = text.replace(m.re, () => {
          masked[m.kind] += 1;
          return m.label;
        });
      }
      const pseudonyms: Record<string, number> = {};
      if (nameRe) {
        const { folded, map } = foldWithMap(text);
        const hits: { start: number; end: number; label: string }[] = [];
        for (const m of folded.matchAll(nameRe)) {
          const label = byFolded.get(m[0].replace(/\s+/g, ' '));
          if (!label) continue;
          hits.push({ start: map[m.index]!, end: map[m.index + m[0].length]!, label });
        }
        for (const h of hits.reverse()) {
          text = `${text.slice(0, h.start)}[${h.label}]${text.slice(h.end)}`;
          pseudonyms[h.label] = (pseudonyms[h.label] ?? 0) + 1;
        }
      }
      return { text, pseudonyms, masked };
    },
  };
}
