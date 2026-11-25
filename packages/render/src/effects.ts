/**
 * Effets contextuels, catalogue v1 (docs/plan-etape-6.md §7.4).
 *
 *  - Un effet n'est proposé que si un ANCRAGE ÉDITORIAL (repère de la proposition acceptée) et,
 *    pour les zooms, un INDICE TECHNIQUE (hausse d'énergie de la voix) sont réunis ; jamais sur
 *    l'indice seul. L'indice n'est pas une preuve de rire ou de réaction : la raison le dit.
 *  - Mode fidèle : seule la mise en évidence de la ligne de la chute. Mode enrichi : au plus
 *    2 effets automatiques, jamais deux zooms qui se chevauchent, aucun dans les 2 premières
 *    secondes du clip.
 *  - Les idées libres de Claude ne sont jamais converties en effets.
 *  - Déterministe : mêmes entrées ⇒ mêmes effets.
 */
import type { ClipProject } from '@acs/timeline';

type Effect = ClipProject['effects'][number];

export const EFFECT_PARAMS = {
  punch_zoom: { factor: 1.12, durationMs: 1500 },
  reaction_hold: { factor: 1.08, durationMs: 2000 },
} as const;

/** Seuil de l'indice : énergie maximale ≥ 2 × médiane du clip (≈ +6 dB). */
export const ENERGY_RATIO_THRESHOLD = 2;
export const NO_EFFECT_LEAD_MS = 2000;
export const MAX_AUTO_EFFECTS = 2;

/** Enveloppe d'énergie (RMS) d'une piste, en temps SOURCE. */
export interface EnergyEnvelope {
  startMs: number;
  stepMs: number;
  values: number[];
}

/** RMS par fenêtres de `windowMs` sur des échantillons 16 bits mono. Pur. */
export function rmsEnvelope(
  samples: Int16Array,
  sampleRate: number,
  startMs: number,
  windowMs = 50,
): EnergyEnvelope {
  const n = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const values: number[] = [];
  for (let i = 0; i < samples.length; i += n) {
    let sum = 0;
    const end = Math.min(samples.length, i + n);
    for (let j = i; j < end; j++) sum += (samples[j]! / 32768) ** 2;
    values.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  return { startMs, stepMs: windowMs, values };
}

function slice(env: EnergyEnvelope, fromMs: number, toMs: number) {
  const out: { t: number; v: number }[] = [];
  env.values.forEach((v, i) => {
    const t = env.startMs + i * env.stepMs;
    if (t >= fromMs && t < toMs) out.push({ t, v });
  });
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export interface SuggestInput {
  project: ClipProject;
  /** Enveloppe de la piste micro (calcul local, rien n'est exporté), ou null si indisponible. */
  energy: EnergyEnvelope | null;
}

/** Effets proposés automatiquement (origine « auto »), avec raison et valeurs mesurées. */
export function suggestEffects({ project: p, energy }: SuggestInput): Effect[] {
  const seg = p.segments.find((s) => s.kind === 'source');
  if (!seg || seg.kind !== 'source') return [];
  const start = seg.srcStartMs;
  const end = seg.srcEndMs;
  const { punchlineMs, reactionEndMs } = p.anchors;
  const out: Effect[] = [];
  if (punchlineMs >= start && punchlineMs < end) {
    out.push({
      id: 'auto-caption_emphasis',
      type: 'caption_emphasis',
      params: {},
      timing: { anchor: 'source', srcStartMs: punchlineMs, srcEndMs: punchlineMs + 1 },
      enabled: true,
      origin: 'auto',
      reason: `Ligne de la chute (${clock(punchlineMs - start)}) mise en évidence : repère de la proposition acceptée`,
      signals: {},
    });
  }
  if (p.mode !== 'enrichi' || !energy || out.length >= MAX_AUTO_EFFECTS) return out;

  const all = slice(energy, start, end).map((x) => x.v);
  const baseline = median(all);
  const windowEnd = Math.min(
    end,
    Math.max(punchlineMs + 1000, Math.min(reactionEndMs, punchlineMs + 4000)),
  );
  const reaction = slice(energy, punchlineMs, windowEnd);
  if (!reaction.length || baseline <= 0) return out;
  const peak = reaction.reduce((a, b) => (b.v > a.v ? b : a));
  const ratio = peak.v / baseline;
  if (ratio < ENERGY_RATIO_THRESHOLD) return out;
  const signals = {
    baselineRms: Number(baseline.toFixed(5)),
    peakRms: Number(peak.v.toFixed(5)),
    ratio: Number(ratio.toFixed(2)),
    threshold: ENERGY_RATIO_THRESHOLD,
    peakMs: peak.t,
  };
  const why = `le volume de ta voix est ${ratio.toFixed(1)} fois plus élevé que d’habitude à ${clock(peak.t - start)} — indice technique, pas une preuve de réaction : à vérifier`;

  // Zoom sur la chute, s'il tient dans le clip et après les 2 premières secondes.
  const zStart = Math.max(punchlineMs - 200, start + NO_EFFECT_LEAD_MS);
  const zEnd = Math.min(zStart + EFFECT_PARAMS.punch_zoom.durationMs, end);
  if (zEnd - zStart >= 600) {
    out.push({
      id: 'auto-punch_zoom',
      type: 'punch_zoom',
      params: { factor: EFFECT_PARAMS.punch_zoom.factor },
      timing: { anchor: 'source', srcStartMs: zStart, srcEndMs: zEnd },
      enabled: true,
      origin: 'auto',
      reason: `Zoom sur la chute : ${why}`,
      signals,
    });
    return out;
  }
  // Sinon, léger zoom maintenu sur la facecam au moment du pic (disposition facecam en haut).
  if (p.layout.preset === 'facecam_top' && p.layout.facecamRect) {
    const hStart = Math.max(peak.t, start + NO_EFFECT_LEAD_MS);
    const hEnd = Math.min(hStart + EFFECT_PARAMS.reaction_hold.durationMs, end);
    if (hEnd - hStart >= 600) {
      out.push({
        id: 'auto-reaction_hold',
        type: 'reaction_hold',
        params: { factor: EFFECT_PARAMS.reaction_hold.factor },
        timing: { anchor: 'source', srcStartMs: hStart, srcEndMs: hEnd },
        enabled: true,
        origin: 'auto',
        reason: `Zoom léger sur la facecam : ${why}`,
        signals,
      });
    }
  }
  return out;
}

/**
 * Fusionne les effets proposés avec ceux du document, SANS jamais changer un choix existant :
 *  - un effet du créateur est conservé tel quel ;
 *  - un effet automatique déjà présent garde son état (activé ou désactivé) ; s'il est proposé de
 *    nouveau, seuls ses instants, paramètres, raison et mesures sont mis à jour ;
 *  - un effet automatique déjà présent mais plus proposé est conservé tel quel (hors du clip, il
 *    est ignoré au rendu) ;
 *  - un NOUVEAU type d'effet arrive DÉSACTIVÉ : seul le créateur l'active.
 */
export function mergeSuggestedEffects(
  current: readonly Effect[],
  suggested: readonly Effect[],
): Effect[] {
  const fresh = new Map(suggested.map((e) => [e.type, e]));
  const out: Effect[] = current.map((e) => {
    if (e.origin !== 'auto') return e;
    const s = fresh.get(e.type);
    if (!s) return e;
    fresh.delete(e.type);
    return { ...s, id: e.id, enabled: e.enabled };
  });
  for (const s of fresh.values()) out.push({ ...s, enabled: false });
  return out;
}

/** Effets effectivement appliqués : activés, et autorisés par le mode du projet. */
export function activeEffects(p: ClipProject): Effect[] {
  return p.effects.filter(
    (e) => e.enabled && (p.mode === 'enrichi' || e.type === 'caption_emphasis'),
  );
}
