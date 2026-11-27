/**
 * Observations (fonctions PURES) : ce que chaque source permet de mesurer, rien de plus.
 * Aucune observation ne contient de texte, de dialogue, d'image ni d'horodatage d'événement de la
 * vidéo : seulement des grandeurs agrégées (comptes par minute, durées, réglages).
 */
import type { ClipProjectV2 } from '@acs/timeline';
import type { FeatureKey } from './catalog';
import { densityScore, type FeatureScalar, type StyleObservation } from './features';

type Values = Partial<Record<FeatureKey, FeatureScalar>>;

const perMinute = (n: number, durMs: number) =>
  durMs > 0 ? Math.round((n / (durMs / 60_000)) * 1000) / 1000 : 0;

const quantile = (xs: readonly number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};

function shotValues(shotsMs: readonly number[], durationMs: number): Values {
  const v: Values = {};
  if (!shotsMs.length || durationMs <= 0) return v;
  v['rythme.cutsPerMinute'] = perMinute(Math.max(0, shotsMs.length - 1), durationMs);
  v['rythme.shotMedianMs'] = Math.max(100, Math.round(quantile(shotsMs, 0.5)));
  v['rythme.shotShortMs'] = Math.max(50, Math.round(quantile(shotsMs, 0.1)));
  v['rythme.shotLongMs'] = Math.max(100, Math.round(quantile(shotsMs, 0.9)));
  return v;
}

const withDensity = (v: Values): Values => {
  const d = densityScore(v);
  return d === null ? v : { ...v, 'densite.score': d };
};

/* ------------------------------------------------------------------ */
/* Éditeur : décisions exactes du créateur                             */
/* ------------------------------------------------------------------ */

const segDur = (s: ClipProjectV2['segments'][number]) =>
  s.kind === 'source' ? s.srcEndMs - s.srcStartMs : s.editDurMs;

/**
 * Observation d'un projet de l'éditeur. `initial` (document de création) sert à savoir ce que le
 * créateur a réellement changé (`changed`) : utile pour l'affichage, jamais pour inventer.
 */
export function editorObservation(
  projectId: string,
  current: ClipProjectV2,
  initial: ClipProjectV2 | null,
): StyleObservation & { changed: FeatureKey[] } {
  const durationMs = current.segments.reduce((a, s) => a + segDur(s), 0);
  const v: Values = {};
  v['format.durationMs'] = Math.max(1000, durationMs);
  Object.assign(v, shotValues(current.segments.map(segDur), durationMs));
  // Coupe éditoriale : saut entre deux segments source non contigus (ou insertion d'un arrêt/vide).
  let editorial = 0;
  for (let i = 1; i < current.segments.length; i++) {
    const a = current.segments[i - 1]!;
    const b = current.segments[i]!;
    if (a.kind !== 'source' || b.kind !== 'source' || a.srcEndMs !== b.srcStartMs) editorial++;
  }
  v['rythme.editorialCutsPerMinute'] = perMinute(editorial, durationMs);
  const bounds = current.origin.proposalBounds;
  const span = bounds.srcEndMs - bounds.srcStartMs;
  const kept = current.segments.reduce((a, s) => a + (s.kind === 'source' ? segDur(s) : 0), 0);
  if (span > 0) v['rythme.keptRatio'] = Math.min(1, Math.round((kept / span) * 1000) / 1000);
  v['transitions.freezesPerMinute'] = perMinute(
    current.segments.filter((s) => s.kind === 'freeze').length,
    durationMs,
  );

  const c = current.captions;
  v['sous_titres.enabled'] = c.enabled;
  if (c.enabled) {
    v['sous_titres.font'] = c.style.font;
    v['sous_titres.sizePx'] = c.style.sizePx;
    v['sous_titres.color'] = c.style.color;
    v['sous_titres.highlightColor'] = c.style.highlightColor;
    v['sous_titres.outlinePx'] = c.style.outlinePx;
    v['sous_titres.position'] = c.style.position;
    v['sous_titres.uppercase'] = c.style.uppercase;
    v['sous_titres.maxCharsPerLine'] = c.style.maxCharsPerLine;
    v['sous_titres.maxLines'] = c.style.maxLines;
    v['sous_titres.karaoke'] = c.style.karaoke;
    v['sous_titres.emphasizePunchline'] = c.style.emphasizePunchline;
  }

  const l = current.layout;
  const facecam = l.preset === 'facecam_top' || l.layers.some((x) => x.role === 'facecam');
  if (l.preset !== 'custom') v['cadrage.layoutPreset'] = l.preset;
  v['cadrage.facecamUsage'] = facecam ? 1 : 0;
  if (l.preset === 'facecam_top') v['cadrage.facecamShare'] = l.facecamShare;

  const on = current.effects.filter((e) => e.enabled);
  const zooms = on.filter((e) => ['zoom', 'punch_zoom', 'reaction_hold'].includes(e.type));
  v['zooms.perMinute'] = perMinute(zooms.length, durationMs);
  const factors = zooms
    .map((e) => e.params['factor'])
    .filter((x): x is number => typeof x === 'number');
  if (factors.length) v['zooms.factorMedian'] = Math.round(quantile(factors, 0.5) * 1000) / 1000;
  v['effets.visualPerMinute'] = perMinute(
    on.filter((e) => ['flash', 'shake', 'caption_emphasis', 'blur_region'].includes(e.type)).length,
    durationMs,
  );
  v['effets.soundPerMinute'] = perMinute(
    current.audio.sfx.length + on.filter((e) => e.type === 'bleep').length,
    durationMs,
  );
  v['effets.overlaysPerMinute'] = perMinute(current.overlays.length, durationMs);
  if (current.audio.loudnorm.enabled) v['audio.loudnessLufs'] = current.audio.loudnorm.targetLufs;
  v['densite.mode'] = current.mode;

  const values = withDensity(v);
  const changed: FeatureKey[] = [];
  if (initial) {
    const before = editorObservation(projectId, initial, null).values;
    for (const k of Object.keys(values) as FeatureKey[]) {
      if (JSON.stringify(before[k]) !== JSON.stringify(values[k])) changed.push(k);
    }
  }
  return { source: 'editor', sourceId: projectId, values, changed };
}

/* ------------------------------------------------------------------ */
/* Référence : mesures FFmpeg d'une vidéo montée                       */
/* ------------------------------------------------------------------ */

export interface ReferenceMeasures {
  durationMs: number;
  width: number | null;
  height: number | null;
  /** Instants des changements de plan détectés (ms). */
  cutsMs: readonly number[];
  /** Passages par le noir [début, fin] (ms). */
  blacks: readonly (readonly [number, number])[];
  /** Images figées [début, fin] (ms). */
  freezes: readonly (readonly [number, number])[];
  /** Sonie intégrée et plage (null : pas de son). */
  loudness: { integratedLufs: number; rangeLu: number } | null;
  /** Silences [début, fin] (ms). */
  silences: readonly (readonly [number, number])[];
}

/** Durées des plans : les passages par le noir sont des transitions, pas des plans. */
export function shotsFromCuts(m: ReferenceMeasures): number[] {
  const bounds = [0, ...m.cutsMs.filter((t) => t > 0 && t < m.durationMs), m.durationMs].sort(
    (a, b) => a - b,
  );
  const shots: number[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const s = bounds[i - 1]!;
    const e = bounds[i]!;
    const inBlack = m.blacks.some(([bs, be]) => s >= bs - 40 && e <= be + 40);
    if (e - s >= 100 && !inBlack) shots.push(e - s);
  }
  return shots;
}

const coverMs = (ranges: readonly (readonly [number, number])[], durationMs: number) =>
  ranges.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, durationMs) - Math.max(0, s)), 0);

export function referenceObservation(
  referenceId: string,
  m: ReferenceMeasures,
  source: 'reference' | 'pair' = 'reference',
): StyleObservation {
  const v: Values = {};
  if (m.durationMs >= 1000) v['format.durationMs'] = Math.round(m.durationMs);
  if (m.width && m.height) v['format.vertical'] = m.height > m.width;
  Object.assign(v, shotValues(shotsFromCuts(m), m.durationMs));
  // Un fondu au noir ne compte que s'il est bref et entouré d'image (pas un écran noir final).
  const fades = m.blacks.filter(([s, e]) => e - s <= 2000 && s > 200 && e < m.durationMs - 200);
  v['transitions.fadesToBlackPerMinute'] = perMinute(fades.length, m.durationMs);
  v['transitions.freezesPerMinute'] = perMinute(
    m.freezes.filter(([s, e]) => e - s >= 400).length,
    m.durationMs,
  );
  if (m.loudness) {
    v['audio.loudnessLufs'] = Math.max(
      -60,
      Math.min(0, Math.round(m.loudness.integratedLufs * 10) / 10),
    );
    v['audio.loudnessRangeLu'] = Math.max(
      0,
      Math.min(40, Math.round(m.loudness.rangeLu * 10) / 10),
    );
    v['audio.silenceShare'] =
      Math.round((coverMs(m.silences, m.durationMs) / Math.max(1, m.durationMs)) * 1000) / 1000;
  }
  return { source, sourceId: referenceId, values: withDensity(v) };
}

/* ------------------------------------------------------------------ */
/* Paire brut + montage : alignement sonore des plans                   */
/* ------------------------------------------------------------------ */

/** Enveloppe sonore : niveau RMS (dBFS, borné à −60) échantillonné à `rateHz`. */
export interface Envelope {
  rateHz: number;
  db: Float32Array;
}

export interface ShotMatch {
  /** Plan dans le montage (ms). */
  editStartMs: number;
  editEndMs: number;
  /** Position retrouvée dans le brut (ms), ou null si l'alignement n'est pas fiable. */
  rawStartMs: number | null;
  /** Corrélation normalisée (−1..1) du meilleur alignement. */
  score: number;
}

/** Corrélation minimale pour accepter un alignement. */
export const ALIGN_MIN_SCORE = 0.85;
/** Variation sonore minimale (écart-type, dB) d'un plan alignable : un plan muet ne prouve rien. */
export const ALIGN_MIN_STD_DB = 2;

function stats(x: Float32Array, from: number, len: number) {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const v = x[from + i]!;
    s += v;
    s2 += v * v;
  }
  const mean = s / len;
  return { mean, std: Math.sqrt(Math.max(0, s2 / len - mean * mean)) };
}

/**
 * Cherche chaque plan du montage dans le brut par corrélation normalisée de l'enveloppe sonore.
 * Recherche d'abord après le plan précédent (montage chronologique), puis dans tout le brut.
 * Un plan trop court, trop calme ou sans correspondance nette n'est PAS aligné (null).
 */
export function alignShots(
  edited: Envelope,
  raw: Envelope,
  shots: readonly { startMs: number; endMs: number }[],
): ShotMatch[] {
  if (edited.rateHz !== raw.rateHz) throw new Error('enveloppes à des fréquences différentes');
  const r = edited.rateHz;
  const toIdx = (ms: number) => Math.round((ms / 1000) * r);
  const out: ShotMatch[] = [];
  let cursor = 0;
  for (const shot of shots) {
    const a = toIdx(shot.startMs);
    const len = Math.min(toIdx(shot.endMs) - a, edited.db.length - a);
    const base = { editStartMs: shot.startMs, editEndMs: shot.endMs };
    if (len < r || len > raw.db.length) {
      out.push({ ...base, rawStartMs: null, score: 0 });
      continue;
    }
    const q = stats(edited.db, a, len);
    if (q.std < ALIGN_MIN_STD_DB) {
      out.push({ ...base, rawStartMs: null, score: 0 });
      continue;
    }
    const scoreAt = (o: number) => {
      const w = stats(raw.db, o, len);
      if (w.std < 1e-6) return -1;
      let acc = 0;
      for (let i = 0; i < len; i++) acc += (edited.db[a + i]! - q.mean) * (raw.db[o + i]! - w.mean);
      return acc / (len * q.std * w.std);
    };
    const search = (from: number, to: number) => {
      let best = { o: -1, s: -2 };
      for (let o = Math.max(0, from); o <= Math.min(raw.db.length - len, to); o++) {
        const s = scoreAt(o);
        if (s > best.s) best = { o, s };
      }
      return best;
    };
    let best = search(cursor, cursor + 120 * r);
    if (best.s < ALIGN_MIN_SCORE) {
      const global = search(0, raw.db.length - len);
      if (global.s > best.s) best = global;
    }
    if (best.s >= ALIGN_MIN_SCORE) {
      cursor = best.o + len;
      out.push({
        ...base,
        rawStartMs: Math.round((best.o / r) * 1000),
        score: Math.round(best.s * 1000) / 1000,
      });
    } else {
      out.push({ ...base, rawStartMs: null, score: Math.round(Math.max(0, best.s) * 1000) / 1000 });
    }
  }
  return out;
}

/** Tolérance d'un raccord continu (pas de saut dans le brut). */
const CONTINUITY_MS = 250;

export interface PairStructure {
  alignedShots: number;
  totalShots: number;
  /** Coupes avec saut dans le brut (ou retour en arrière). */
  editorialCuts: number;
  /** Changements de plan sans saut dans le brut (scène filmée qui change). */
  continuousCuts: number;
  /** Plans montés dans un autre ordre que le brut. */
  reordered: number;
  keptMs: number;
  spanMs: number;
}

export function pairStructure(matches: readonly ShotMatch[]): PairStructure {
  const aligned = matches.filter((m) => m.rawStartMs !== null);
  let editorialCuts = 0;
  let continuousCuts = 0;
  let reordered = 0;
  for (let i = 1; i < matches.length; i++) {
    const a = matches[i - 1]!;
    const b = matches[i]!;
    if (a.rawStartMs === null || b.rawStartMs === null) continue;
    const expected = a.rawStartMs + (a.editEndMs - a.editStartMs);
    if (Math.abs(b.rawStartMs - expected) <= CONTINUITY_MS) continuousCuts++;
    else {
      editorialCuts++;
      if (b.rawStartMs < a.rawStartMs) reordered++;
    }
  }
  const keptMs = aligned.reduce((x, m) => x + (m.editEndMs - m.editStartMs), 0);
  const starts = aligned.map((m) => m.rawStartMs!);
  const ends = aligned.map((m) => m.rawStartMs! + (m.editEndMs - m.editStartMs));
  const spanMs = aligned.length ? Math.max(...ends) - Math.min(...starts) : 0;
  return {
    alignedShots: aligned.length,
    totalShots: matches.length,
    editorialCuts,
    continuousCuts,
    reordered,
    keptMs,
    spanMs,
  };
}

/** Part minimale de plans alignés pour tirer des conclusions de la paire. */
export const PAIR_MIN_ALIGNED = 0.5;

/**
 * Observation d'une paire : mesures de la version montée + structure retrouvée dans le brut.
 * Si trop peu de plans sont alignés, la structure n'est PAS déduite (seules les mesures de la
 * vidéo montée restent).
 */
export function pairObservation(
  referenceId: string,
  edited: ReferenceMeasures,
  structure: PairStructure,
): StyleObservation & { structureReliable: boolean } {
  const base = referenceObservation(referenceId, edited, 'pair');
  const reliable =
    structure.totalShots > 0 && structure.alignedShots / structure.totalShots >= PAIR_MIN_ALIGNED;
  if (!reliable) return { ...base, structureReliable: false };
  const values = { ...base.values };
  const alignedDur = Math.max(1, structure.keptMs);
  values['rythme.editorialCutsPerMinute'] = perMinute(structure.editorialCuts, alignedDur);
  if (structure.spanMs > 0) {
    values['rythme.keptRatio'] = Math.min(
      1,
      Math.round((structure.keptMs / structure.spanMs) * 1000) / 1000,
    );
  }
  return { ...base, values, structureReliable: true };
}
