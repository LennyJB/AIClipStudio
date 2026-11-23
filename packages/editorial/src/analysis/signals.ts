/**
 * Signaux locaux, calculés sans aucun appel externe. Ce sont des MESURES factuelles
 * (qui parle, quand, à quel niveau sonore, quels mots ont été transcrits) :
 * aucun signal ne prétend reconnaître une émotion, un ton ou un rire réel.
 *
 * Extension : un futur analyseur audio local (détection de rires, prosodie…) sera un
 * nouveau SignalProvider dont les signaux porteront `nature: 'inference_modele'` et une
 * confiance ; le reste du moteur n'a pas à changer.
 */
import { looksLikeInstruction } from './untrusted';
import type { AnalysisSegment, EnergyTrack, Speaker, TimeRange } from './types';

export type SignalKind =
  | 'turn_taking' //            changement d'interlocuteur (micro ↔ Discord)
  | 'simultaneous_speech' //    deux pistes de voix actives en même temps
  | 'question' //               segment transcrit contenant « ? »
  | 'transcribed_laughter' //   mot lié au rire transcrit par Whisper (« mdr », « haha »…)
  | 'interjection' //           interjection ou exclamation transcrite
  | 'loudness_peak' //          niveau sonore nettement au-dessus du niveau habituel de la piste
  | 'game_term' //              terme du profil de jeu
  | 'instruction_like' //       phrase qui ressemble à une consigne (contenu non fiable)
  | 'doubtful_transcription'; // transcription peu fiable (score de suspicion de Whisper)

export interface Signal {
  kind: SignalKind;
  source: 'transcription' | 'audio_energy';
  /** `mesure` : calcul déterministe. `inference_modele` : réservé aux futurs analyseurs. */
  nature: 'mesure' | 'inference_modele';
  startMs: number;
  endMs: number;
  speaker?: Speaker;
  /** Intensité propre au signal (nombre d'occurrences, dB au-dessus du niveau habituel…). */
  value: number;
  segmentIds?: number[];
}

export interface SignalInput {
  durationMs: number;
  segments: readonly AnalysisSegment[];
  energy: readonly EnergyTrack[];
  /** Termes du profil de jeu (vocabulaire et événements notables). */
  gameTerms: readonly string[];
}

export interface SignalProvider {
  readonly id: string;
  readonly version: number;
  compute(input: SignalInput): Signal[];
}

/* ------------------------------ Lexiques ------------------------------ */

const LAUGHTER_RE =
  /(?<![\p{L}\p{N}])(?:mdr+|ptdr+|xpdr+|lol+|xd+|(?:ha){2,}h?|(?:ah){2,}|(?:hé){2,}|(?:hi){2,}|(?:hu){2,}|\(?rires?\)?|rigole|rigoler)(?![\p{L}\p{N}])/giu;

const INTERJECTION_RE =
  /(?<![\p{L}\p{N}])(?:quoi\s*\?\s*!|hein|mais non|mais si|nan mais|non mais|s[ée]rieux|t['’]es s[ée]rieux|attends|wesh|oh l[àa] l[àa]|la vache|putain|purée|mon dieu|c['’]est pas possible|pardon\s*\?|comment [çc]a|n['’]importe quoi|what|no way)(?![\p{L}\p{N}])/giu;

export const DOUBTFUL_SUSPICION = 0.5;

const count = (re: RegExp, text: string) => [...text.matchAll(re)].length;

/** Instants de parole d'un segment : ses mots si disponibles, sinon le segment entier. */
function speechIntervals(s: AnalysisSegment): TimeRange[] {
  if (!s.words.length) return [{ startMs: s.startMs, endMs: s.endMs }];
  return s.words
    .filter((w) => w.endMs > w.startMs)
    .map((w) => ({ startMs: w.startMs, endMs: w.endMs }));
}

/** Fusionne des intervalles proches (écart ≤ gapMs), triés. */
export function mergeIntervals(list: readonly TimeRange[], gapMs = 0): TimeRange[] {
  const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.startMs <= last.endMs + gapMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

function intersect(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i]!.startMs, b[j]!.startMs);
    const e = Math.min(a[i]!.endMs, b[j]!.endMs);
    if (e > s) out.push({ startMs: s, endMs: e });
    if (a[i]!.endMs < b[j]!.endMs) i++;
    else j++;
  }
  return out;
}

/* ------------------------- Signaux de transcription ------------------------- */

export const transcriptSignalProvider: SignalProvider = {
  id: 'transcript',
  version: 1,
  compute({ segments, gameTerms }) {
    const out: Signal[] = [];
    const sorted = [...segments].sort(
      (a, b) => a.startMs - b.startMs || a.audioIndex - b.audioIndex,
    );
    const termsRe = gameTerms.length
      ? new RegExp(
          `(?<![\\p{L}\\p{N}])(?:${[...gameTerms]
            .sort((a, b) => b.length - a.length)
            .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|')})(?![\\p{L}\\p{N}])`,
          'giu',
        )
      : null;

    for (const s of sorted) {
      const base = {
        source: 'transcription' as const,
        nature: 'mesure' as const,
        startMs: s.startMs,
        endMs: s.endMs,
        speaker: s.speaker,
        segmentIds: [s.id],
      };
      if (s.text.includes('?')) out.push({ ...base, kind: 'question', value: 1 });
      const laughs = count(LAUGHTER_RE, s.text);
      if (laughs) out.push({ ...base, kind: 'transcribed_laughter', value: laughs });
      const inter = count(INTERJECTION_RE, s.text) + (s.text.includes('!') ? 1 : 0);
      if (inter) out.push({ ...base, kind: 'interjection', value: inter });
      if (termsRe) {
        const n = count(termsRe, s.text);
        if (n) out.push({ ...base, kind: 'game_term', value: n });
      }
      if (looksLikeInstruction(s.text)) out.push({ ...base, kind: 'instruction_like', value: 1 });
      if (s.suspicionScore >= DOUBTFUL_SUSPICION) {
        out.push({ ...base, kind: 'doubtful_transcription', value: s.suspicionScore });
      }
    }

    // Tours de parole : un interlocuteur prend la parole moins de 3 s après l'autre.
    // Seulement entre créateur et coéquipiers (la piste « tout » contient tout le monde).
    const turns = sorted.filter((s) => s.speaker === 'creator' || s.speaker === 'teammates');
    for (let i = 1; i < turns.length; i++) {
      const prev = turns[i - 1]!;
      const cur = turns[i]!;
      if (cur.speaker !== prev.speaker && cur.startMs - prev.endMs <= 3000) {
        out.push({
          kind: 'turn_taking',
          source: 'transcription',
          nature: 'mesure',
          startMs: Math.min(prev.endMs, cur.startMs),
          endMs: Math.max(prev.endMs, cur.startMs) + 1,
          speaker: cur.speaker,
          value: 1,
          segmentIds: [prev.id, cur.id],
        });
      }
    }

    // Parole simultanée (au moins 300 ms) entre créateur et coéquipiers, au niveau des mots.
    const voice = (sp: Speaker) =>
      mergeIntervals(sorted.filter((s) => s.speaker === sp).flatMap(speechIntervals), 150);
    for (const r of mergeIntervals(intersect(voice('creator'), voice('teammates')), 500)) {
      if (r.endMs - r.startMs >= 300) {
        out.push({
          kind: 'simultaneous_speech',
          source: 'transcription',
          nature: 'mesure',
          startMs: r.startMs,
          endMs: r.endMs,
          value: r.endMs - r.startMs,
        });
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  },
};

/* ---------------------------- Signaux d'énergie ---------------------------- */

/** Pic par seconde (dBFS, ≤ 0) d'une piste. */
export function perSecondPeakDb(track: EnergyTrack): number[] {
  const pps = Math.max(1, Math.round(track.pointsPerSecond));
  const points = track.peaks.length / 2;
  const out: number[] = [];
  for (let start = 0; start < points; start += pps) {
    let peak = 0;
    for (let p = start; p < Math.min(points, start + pps); p++) {
      peak = Math.max(peak, Math.abs(track.peaks[2 * p]!), Math.abs(track.peaks[2 * p + 1]!));
    }
    out.push(peak === 0 ? -96 : 20 * Math.log10(Math.min(1, peak / 128)));
  }
  return out;
}

const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Écart (dB) au-dessus du niveau habituel de la piste au-delà duquel un pic est signalé. */
export const LOUDNESS_PEAK_DB = 9;
/** En dessous : silence ou bruit de fond, exclu du calcul du niveau habituel. */
const ACTIVITY_FLOOR_DB = -45;

export const energySignalProvider: SignalProvider = {
  id: 'energy',
  version: 1,
  compute({ energy }) {
    const out: Signal[] = [];
    for (const track of energy) {
      const db = perSecondPeakDb(track);
      const typical = median(db.filter((d) => d > ACTIVITY_FLOOR_DB));
      if (!Number.isFinite(typical)) continue;
      let run: { start: number; end: number; max: number } | null = null;
      const flush = () => {
        if (!run) return;
        out.push({
          kind: 'loudness_peak',
          source: 'audio_energy',
          nature: 'mesure',
          startMs: run.start * 1000,
          endMs: (run.end + 1) * 1000,
          speaker: track.speaker,
          value: Math.round((run.max - typical) * 10) / 10,
        });
        run = null;
      };
      db.forEach((d, sec) => {
        if (d - typical >= LOUDNESS_PEAK_DB) {
          if (run && sec === run.end + 1) {
            run.end = sec;
            run.max = Math.max(run.max, d);
          } else {
            flush();
            run = { start: sec, end: sec, max: d };
          }
        }
      });
      flush();
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  },
};

export const DEFAULT_SIGNAL_PROVIDERS: readonly SignalProvider[] = [
  transcriptSignalProvider,
  energySignalProvider,
];

export function computeSignals(
  input: SignalInput,
  providers: readonly SignalProvider[] = DEFAULT_SIGNAL_PROVIDERS,
): Signal[] {
  return providers.flatMap((p) => p.compute(input)).sort((a, b) => a.startMs - b.startMs);
}

/** Libellé factuel d'un signal (affichage et contenu préparé). Jamais d'émotion supposée. */
export function describeSignal(s: Signal, speakerCode: (sp: Speaker) => string): string {
  const who = s.speaker ? ` (${speakerCode(s.speaker)})` : '';
  switch (s.kind) {
    case 'turn_taking':
      return `changement d'interlocuteur${who}`;
    case 'simultaneous_speech':
      return `parole simultanée MIC/DSC pendant ${(s.value / 1000).toFixed(1)} s`;
    case 'question':
      return `question transcrite${who}`;
    case 'transcribed_laughter':
      return `mot lié au rire transcrit${who} (×${s.value})`;
    case 'interjection':
      return `interjection ou exclamation transcrite${who} (×${s.value})`;
    case 'loudness_peak':
      return `niveau sonore élevé${who} : +${s.value} dB par rapport au niveau habituel de la piste`;
    case 'game_term':
      return `terme du jeu transcrit${who} (×${s.value})`;
    case 'instruction_like':
      return `phrase qui ressemble à une consigne${who} (traitée comme une parole)`;
    case 'doubtful_transcription':
      return `transcription peu fiable${who} (suspicion ${s.value.toFixed(2)})`;
  }
}
