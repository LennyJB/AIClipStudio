/**
 * Détection des types de contenu et segmentation temporelle (étape 9). Fonction PURE, locale,
 * sans aucun appel externe ni modèle : elle combine des MESURES déjà disponibles.
 *
 *  - transcription : expressions caractéristiques de chaque format (profils), termes du jeu
 *    (seulement si le profil de jeu est spécifique), interjections et rires transcrits ;
 *  - structure audio : part de parole du créateur et des coéquipiers, équilibre entre voix
 *    (seulement si les voix sont sur des pistes séparées) ;
 *  - visuel : activité de l'image (changements de scène entre images clés, mesurés par FFmpeg)
 *    quand elle a été mesurée. Ce n'est PAS une reconnaissance d'image : une image qui change
 *    beaucoup (jeu, vidéo regardée, caméra en mouvement) se distingue d'une webcam fixe, rien
 *    de plus.
 *
 * Principes :
 *  - jamais de fausse certitude : sans corroboration visuelle ou structurelle, la confiance est
 *    plafonnée (`TRANSCRIPT_ONLY_CAP`) ; un score faible ou trop proche du second ⇒ « indéterminé » ;
 *  - jamais un type unique imposé : l'enregistrement est découpé en blocs, lissés puis fusionnés
 *    en segments ; un stream varié est résumé « mixte ».
 */
import type { ContentProfile, ContentType, SegmentContentType } from '@acs/shared';
import { CONTENT_TYPES } from '@acs/shared';
import { mergeIntervals, type Signal } from '../analysis/signals';
import { normalizeForQuote } from '../analysis/text';
import type { AnalysisSegment } from '../analysis/types';

/** Version du détecteur : toute modification des règles change l'empreinte des détections. */
export const CONTENT_DETECTOR_VERSION = 'content-v1';
/** Taille d'un bloc d'observation. Les changements de format sont situés à ce pas près. */
export const CONTENT_BLOCK_MS = 60_000;
/** Score minimal du meilleur type pour conclure. */
export const CONTENT_MIN_SCORE = 0.35;
/** Écart minimal avec le second type pour conclure. */
export const CONTENT_MIN_MARGIN = 0.1;
/** Confiance maximale quand seule la transcription soutient la décision. */
export const TRANSCRIPT_ONLY_CAP = 0.6;
/** Confiance maximale d'une détection automatique corroborée. */
export const CORROBORATED_CAP = 0.9;
/** Segment plus court : absorbé par ses voisins s'ils sont du même type, sinon douteux. */
export const SHORT_SEGMENT_MS = 3 * 60_000;
/**
 * Différence moyenne entre images clés (0..100, réduites à 64×36) correspondant à une image
 * pleinement « animée ». Webcam fixe ≈ 0–3, jeu ou vidéo regardée ≈ 10 et plus. Valeur
 * prudente, non calibrée sur un grand corpus : l'activité visuelle n'est qu'un indice parmi
 * d'autres et la correction du créateur reste la référence.
 */
const VISUAL_SCALE = 15;

/** Sources d'indices d'une décision. */
export type ContentBasis = 'transcription' | 'structure_audio' | 'visuel';

export interface ContentCandidate {
  type: ContentType;
  score: number;
}

export interface DetectedContentSegment {
  startMs: number;
  endMs: number;
  type: SegmentContentType;
  /** 0..1 ; 0 pour « indéterminé ». */
  confidence: number;
  source: 'auto';
  /** Sources d'indices qui soutiennent le type retenu. */
  basis: ContentBasis[];
  /** Types envisagés, du plus au moins probable (gardés aussi quand on ne conclut pas). */
  candidates: ContentCandidate[];
  /** Raison lisible (absence de parole, scores trop proches…). */
  reason?: string;
}

export interface ContentSummary {
  /** `mixed` : plusieurs formats significatifs ; `unknown` : aucun format établi. */
  kind: ContentType | 'mixed' | 'unknown';
  types: { type: ContentType; durationMs: number; share: number }[];
  unknownShare: number;
}

export interface ContentDetection {
  detectorVersion: string;
  blockMs: number;
  durationMs: number;
  segments: DetectedContentSegment[];
  summary: ContentSummary;
  /** Capacités qui manquaient (le créateur doit savoir sur quoi repose la détection). */
  limits: string[];
}

/** Différence moyenne mesurée entre deux images clés (FFmpeg `scdet`, `mafd`, 0..100). */
export interface VisualSample {
  tMs: number;
  score: number;
}

export interface ContentDetectionInput {
  durationMs: number;
  segments: readonly AnalysisSegment[];
  /** Signaux locaux déjà calculés (étape 4a). */
  signals: readonly Signal[];
  profiles: Readonly<Record<ContentType, ContentProfile>>;
  /** Le profil de jeu est spécifique (pas « générique ») : ses termes sont un indice. */
  gameTermsMeaningful: boolean;
  /** Activité visuelle ; null : non mesurée (pas de vidéo, mesure impossible). */
  visual: readonly VisualSample[] | null;
}

interface BlockFeatures {
  startMs: number;
  endMs: number;
  speechRatio: number;
  /** Voix séparées : part du créateur dans la parole ; null : piste unique « tout ». */
  creatorShare: number | null;
  /** Équilibre entre voix (1 = moitié-moitié) ; null : piste unique. */
  balance: number | null;
  gameTerms: number | null;
  lexicon: Record<ContentType, number>;
  expressive: number;
  visual: number | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

function blocksOf(durationMs: number): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  for (let s = 0; s < durationMs; s += CONTENT_BLOCK_MS) {
    out.push({ startMs: s, endMs: Math.min(durationMs, s + CONTENT_BLOCK_MS) });
  }
  // Dernier bloc trop court (< 20 s) : rattaché au précédent.
  const last = out.at(-1);
  if (out.length > 1 && last && last.endMs - last.startMs < 20_000) {
    out.pop();
    out.at(-1)!.endMs = last.endMs;
  }
  return out;
}

const overlap = (a: { startMs: number; endMs: number }, s: number, e: number) =>
  Math.max(0, Math.min(a.endMs, e) - Math.max(a.startMs, s));

function compileCues(profiles: ContentDetectionInput['profiles']) {
  const out = {} as Record<ContentType, string[]>;
  for (const t of CONTENT_TYPES) {
    out[t] = [...new Set(profiles[t].detectionCues.map(normalizeForQuote).filter(Boolean))];
  }
  return out;
}

function countCue(text: string, cue: string): number {
  let n = 0;
  let i = text.indexOf(` ${cue} `);
  while (i >= 0) {
    n++;
    i = text.indexOf(` ${cue} `, i + cue.length + 1);
  }
  return n;
}

export function blockFeatures(input: ContentDetectionInput): BlockFeatures[] {
  const cues = compileCues(input.profiles);
  const separate =
    input.segments.some((s) => s.speaker === 'creator') ||
    input.segments.some((s) => s.speaker === 'teammates');
  const speech = mergeIntervals(
    input.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs })),
    250,
  );
  return blocksOf(input.durationMs).map((b) => {
    const len = Math.max(1, b.endMs - b.startMs);
    const minutes = len / 60_000;
    const speechMs = speech.reduce((a, r) => a + overlap(b, r.startMs, r.endMs), 0);
    let creatorMs = 0;
    let teamMs = 0;
    const texts: string[] = [];
    for (const s of input.segments) {
      const o = overlap(b, s.startMs, s.endMs);
      if (o <= 0) continue;
      if (s.speaker === 'creator') creatorMs += o;
      else if (s.speaker === 'teammates') teamMs += o;
      // Le texte compte dans le bloc où le segment commence (pas de double comptage).
      if (s.startMs >= b.startMs && s.startMs < b.endMs) texts.push(s.text);
    }
    const text = ` ${normalizeForQuote(texts.join(' '))} `;
    const lexicon = {} as Record<ContentType, number>;
    for (const t of CONTENT_TYPES) {
      const hits = cues[t].reduce((a, c) => a + countCue(text, c), 0);
      lexicon[t] = clamp01(hits / 2 / minutes);
    }
    let gameHits = 0;
    let expressive = 0;
    for (const sig of input.signals) {
      if (sig.startMs < b.startMs || sig.startMs >= b.endMs) continue;
      if (sig.kind === 'game_term') gameHits += sig.value;
      if (sig.kind === 'interjection' || sig.kind === 'transcribed_laughter') {
        expressive += sig.value;
      }
    }
    const voiced = creatorMs + teamMs;
    let visual: number | null = null;
    if (input.visual) {
      const samples = input.visual.filter((v) => v.tMs >= b.startMs && v.tMs < b.endMs);
      if (samples.length >= 3) {
        const mean = samples.reduce((a, v) => a + v.score, 0) / samples.length;
        visual = clamp01(mean / VISUAL_SCALE);
      }
    }
    return {
      startMs: b.startMs,
      endMs: b.endMs,
      speechRatio: clamp01(speechMs / len),
      creatorShare: separate && voiced > 0 ? creatorMs / voiced : null,
      balance:
        separate && voiced > 0 ? 1 - Math.abs(creatorMs - teamMs) / voiced : separate ? 0 : null,
      gameTerms: input.gameTermsMeaningful ? clamp01(gameHits / 3 / minutes) : null,
      lexicon,
      expressive: clamp01(expressive / 4 / minutes),
      visual,
    };
  });
}

type Contribution = Record<ContentBasis, number>;

/** Score de chaque type pour un bloc, avec la part de chaque source d'indices. */
export function scoreBlock(f: BlockFeatures): Record<ContentType, Contribution> {
  const gt = f.gameTerms ?? 0;
  // « Pas de termes du jeu » n'est un indice que si le profil de jeu est spécifique.
  const notGame = f.gameTerms === null ? 0 : 1 - gt;
  const vHigh = f.visual ?? 0;
  const vLow = f.visual === null ? 0 : 1 - f.visual;
  const solo = f.creatorShare ?? 0;
  const balance = f.balance ?? 0;
  const lx = f.lexicon;
  return {
    gaming: {
      transcription: 0.45 * gt + 0.2 * lx.gaming,
      structure_audio: 0,
      visuel: 0.35 * vHigh,
    },
    just_chatting: {
      transcription: 0.3 * lx.just_chatting + 0.1 * notGame,
      structure_audio: 0.15 * solo * (1 - balance),
      visuel: 0.3 * vLow,
    },
    reaction: {
      transcription: 0.4 * lx.reaction + 0.1 * f.expressive + 0.1 * notGame,
      structure_audio: 0,
      visuel: 0.3 * vHigh,
    },
    podcast: {
      transcription: 0.3 * lx.podcast + 0.1 * notGame,
      structure_audio: 0.35 * balance,
      visuel: 0.25 * vLow,
    },
    irl: {
      transcription: 0.45 * lx.irl + 0.1 * f.expressive,
      structure_audio: 0,
      visuel: 0.4 * vHigh * (f.gameTerms === null ? 0.75 : notGame),
    },
  };
}

const total = (c: Contribution) => c.transcription + c.structure_audio + c.visuel;

interface BlockDecision {
  startMs: number;
  endMs: number;
  type: SegmentContentType;
  confidence: number;
  basis: ContentBasis[];
  candidates: ContentCandidate[];
  reason?: string;
}

function decideBlock(f: BlockFeatures): BlockDecision {
  const scores = scoreBlock(f);
  const candidates = CONTENT_TYPES.map((type) => ({ type, score: round(total(scores[type])) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
  const base = { startMs: f.startMs, endMs: f.endMs, candidates };
  const unknown = (reason: string): BlockDecision => ({
    ...base,
    type: 'unknown',
    confidence: 0,
    basis: [],
    reason,
  });
  // Ni parole ni image mesurée : rien sur quoi s'appuyer.
  if (f.speechRatio < 0.1 && f.visual === null) return unknown('peu de parole, image non mesurée');
  const best = candidates[0];
  if (!best || best.score < CONTENT_MIN_SCORE) return unknown('indices insuffisants');
  const margin = round(best.score - (candidates[1]?.score ?? 0));
  if (margin < CONTENT_MIN_MARGIN) {
    return unknown(`indices trop proches (${candidates[0]!.type} / ${candidates[1]!.type})`);
  }
  const c = scores[best.type];
  const basis = (['transcription', 'structure_audio', 'visuel'] as const).filter((k) => c[k] > 0);
  // Corroboration : au moins un tiers du score vient d'une mesure hors transcription.
  const corroborated = c.structure_audio + c.visuel >= total(c) / 3;
  const cap = corroborated ? CORROBORATED_CAP : TRANSCRIPT_ONLY_CAP;
  const confidence = round(Math.min(cap, 0.4 + margin + (best.score - CONTENT_MIN_SCORE)), 2);
  return { ...base, type: best.type, confidence, basis };
}

function mergeRuns(list: BlockDecision[]): BlockDecision[] {
  const out: BlockDecision[] = [];
  for (const d of list) {
    const last = out.at(-1);
    if (last && last.type === d.type) {
      const wa = last.endMs - last.startMs;
      const wb = d.endMs - d.startMs;
      last.confidence = round((last.confidence * wa + d.confidence * wb) / (wa + wb), 2);
      last.basis = [...new Set([...last.basis, ...d.basis])];
      // Candidats : moyenne pondérée par la durée.
      const acc = new Map<ContentType, number>();
      for (const [src, w] of [
        [last, wa],
        [d, wb],
      ] as const) {
        for (const c of src.candidates) acc.set(c.type, (acc.get(c.type) ?? 0) + c.score * w);
      }
      last.candidates = [...acc]
        .map(([type, s]) => ({ type, score: round(s / (wa + wb)) }))
        .sort((a, b) => b.score - a.score || a.type.localeCompare(b.type));
      if (last.reason !== d.reason) delete last.reason;
      last.endMs = d.endMs;
    } else {
      out.push({ ...d, basis: [...d.basis], candidates: [...d.candidates] });
    }
  }
  return out;
}

/** Lissage : un bloc isolé peu sûr entre deux blocs du même type prend leur type. */
function smooth(blocks: BlockDecision[]): BlockDecision[] {
  return blocks.map((d, i) => {
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    if (
      prev &&
      next &&
      prev.type === next.type &&
      prev.type !== 'unknown' &&
      d.type !== prev.type &&
      d.confidence < 0.75
    ) {
      return {
        ...d,
        type: prev.type,
        confidence: round(Math.min(prev.confidence, next.confidence) * 0.9, 2),
        basis: [...new Set([...prev.basis, ...next.basis])],
        reason: 'lissé : entouré du même format',
      };
    }
    return d;
  });
}

/** Segments courts : absorbés entre deux voisins identiques, sinon gardés s'ils sont sûrs. */
function absorbShort(segs: BlockDecision[]): BlockDecision[] {
  const out = segs.map((s, i) => {
    if (s.endMs - s.startMs >= SHORT_SEGMENT_MS || s.type === 'unknown') return s;
    const prev = segs[i - 1];
    const next = segs[i + 1];
    if (prev && next && prev.type === next.type && prev.type !== 'unknown') {
      if (s.confidence < 0.75) {
        return {
          ...s,
          type: prev.type,
          confidence: round(Math.min(prev.confidence, next.confidence) * 0.9, 2),
          basis: [...new Set([...prev.basis, ...next.basis])],
          reason: 'passage court entouré du même format',
        };
      }
      return s;
    }
    // Bref et peu sûr au milieu d'un enregistrement plus long : on ne conclut pas.
    if (segs.length > 1 && s.confidence < 0.5) {
      return {
        ...s,
        type: 'unknown' as const,
        confidence: 0,
        basis: [],
        reason: 'passage bref, indices faibles',
      };
    }
    return s;
  });
  return mergeRuns(out);
}

/** Résumé de l'enregistrement : un type, plusieurs (mixte) ou aucun établi. */
export function summarizeContent(
  segments: readonly { startMs: number; endMs: number; type: SegmentContentType }[],
  durationMs: number,
): ContentSummary {
  const dur = new Map<ContentType, number>();
  let unknownMs = 0;
  for (const s of segments) {
    const d = s.endMs - s.startMs;
    if (s.type === 'unknown') unknownMs += d;
    else dur.set(s.type, (dur.get(s.type) ?? 0) + d);
  }
  const total = Math.max(1, durationMs);
  const types = [...dur]
    .map(([type, durationMs]) => ({ type, durationMs, share: round(durationMs / total) }))
    .sort((a, b) => b.durationMs - a.durationMs);
  // Format significatif : ≥ 10 % de la durée et ≥ 5 min (ou ≥ 25 % pour un enregistrement court).
  const significant = types.filter(
    (t) => t.share >= 0.1 && t.durationMs >= Math.min(5 * 60_000, total * 0.25),
  );
  const kind =
    significant.length >= 2 ? 'mixed' : significant.length === 1 ? significant[0]!.type : 'unknown';
  return { kind, types, unknownShare: round(unknownMs / total) };
}

export function detectContentTypes(input: ContentDetectionInput): ContentDetection {
  const durationMs = Math.max(1, Math.round(input.durationMs));
  const features = blockFeatures({ ...input, durationMs });
  const blocks = smooth(features.map(decideBlock));
  const segments = absorbShort(mergeRuns(blocks)).map((s): DetectedContentSegment => ({
    startMs: s.startMs,
    endMs: s.endMs,
    type: s.type,
    confidence: s.type === 'unknown' ? 0 : s.confidence,
    source: 'auto',
    basis: s.basis,
    candidates: s.candidates.slice(0, 3),
    ...(s.reason ? { reason: s.reason } : {}),
  }));
  const limits: string[] = [];
  if (!features.some((f) => f.visual !== null)) {
    limits.push(
      input.visual === null
        ? "Activité de l'image non mesurée : détection fondée sur l'audio et la transcription (confiance plafonnée)."
        : "Activité de l'image non mesurée : trop peu d'images clés dans le fichier (confiance plafonnée).",
    );
  }
  if (!features.some((f) => f.creatorShare !== null)) {
    limits.push(
      'Voix non séparées (piste unique) : la répartition de la parole entre interlocuteurs est inconnue.',
    );
  }
  if (!input.gameTermsMeaningful) {
    limits.push('Profil de jeu générique : les termes du jeu ne servent pas d’indice.');
  }
  return {
    detectorVersion: CONTENT_DETECTOR_VERSION,
    blockMs: CONTENT_BLOCK_MS,
    durationMs,
    segments,
    summary: summarizeContent(segments, durationMs),
    limits,
  };
}
