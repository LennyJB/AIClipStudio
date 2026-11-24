/**
 * Estimation des coûts AVANT tout appel, et nombre de fenêtres analysables sous le plafond.
 *
 *  - coût typique : hypothèses de sortie selon l'effort, prompt système mis en cache ;
 *  - coût maximal : entrée estimée + 20 %, prompt système écrit en cache à CHAQUE appel
 *    (tarif d'écriture ≥ tarif d'entrée), sortie = limite `max_tokens` (réflexion comprise).
 *    C'est ce montant que l'étape 4b réservera avant chaque appel : le plafond est strict.
 *
 * Les tailles du prompt système sont des HYPOTHÈSES tant que les prompts n'existent pas (4b).
 */
import { costUsd, PRICING_VERSION, pricingFor } from './pricing';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const ESTIMATE_ASSUMPTIONS = {
  deepSystemPromptTokens: 3_000,
  triageSystemPromptTokens: 1_500,
  /** Sortie typique (réflexion + réponse) d'une analyse approfondie, selon l'effort. */
  deepTypicalOutputTokens: {
    low: 1_500,
    medium: 3_000,
    high: 5_000,
    xhigh: 7_000,
    max: 9_000,
  } as Record<Effort, number>,
  triageTypicalOutputTokens: 1_500,
  /** Marge appliquée à l'estimation locale des jetons d'entrée pour le pire cas. */
  inputMargin: 1.2,
} as const;

export interface CallEstimate {
  inputTokens: number;
  imageTokens: number;
  typicalUsd: number;
  maxUsd: number;
}

export interface AnalysisEstimate {
  pricingVersion: string;
  models: { triage: string; deep: string };
  effort: Effort;
  budgetUsd: number;
  assumptions: string[];
  triage: { chunks: CallEstimate[]; typicalUsd: number; maxUsd: number };
  windows: (CallEstimate & { rank: number })[];
  totals: { typicalUsd: number; maxUsd: number };
  /** Fenêtres (par rang) qui tiennent dans le budget, au coût typique et dans le pire cas. */
  fit: {
    windowCount: number;
    typicalWindows: number;
    worstCaseWindows: number;
    triageFits: boolean;
  };
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

export function estimateCall(input: {
  model: string;
  systemTokens: number;
  dataTokens: number;
  imageTokens: number;
  typicalOutputTokens: number;
  maxOutputTokens: number;
  /** Prompt système déjà en cache (appels suivants) dans le cas typique. */
  cachedSystem: boolean;
}): CallEstimate {
  pricingFor(input.model);
  const data = input.dataTokens + input.imageTokens;
  const typical = costUsd(input.model, {
    inputTokens: data,
    cacheWriteTokens: input.cachedSystem ? 0 : input.systemTokens,
    cacheReadTokens: input.cachedSystem ? input.systemTokens : 0,
    outputTokens: Math.min(input.typicalOutputTokens, input.maxOutputTokens),
  });
  const max = costUsd(input.model, {
    inputTokens: Math.ceil(data * ESTIMATE_ASSUMPTIONS.inputMargin),
    cacheWriteTokens: Math.ceil(input.systemTokens * ESTIMATE_ASSUMPTIONS.inputMargin),
    cacheReadTokens: 0,
    outputTokens: input.maxOutputTokens,
  });
  return {
    inputTokens: input.dataTokens + input.systemTokens,
    imageTokens: input.imageTokens,
    typicalUsd: round(typical),
    maxUsd: round(max),
  };
}

export function estimateAnalysis(input: {
  triageModel: string;
  deepModel: string;
  effort: Effort;
  budgetUsd: number;
  maxOutputTokens: number;
  triageMaxOutputTokens: number;
  triageChunkTokens: readonly number[];
  windows: readonly { rank: number; textTokens: number; imageTokens: number }[];
  /** Taille estimée des prompts système (et schémas), quand ils sont connus (étape 4b). */
  systemTokens?: { triage: number; deep: number };
}): AnalysisEstimate {
  const A = ESTIMATE_ASSUMPTIONS;
  const sys = input.systemTokens ?? {
    triage: A.triageSystemPromptTokens,
    deep: A.deepSystemPromptTokens,
  };
  const chunks = input.triageChunkTokens.map((t, i) =>
    estimateCall({
      model: input.triageModel,
      systemTokens: sys.triage,
      dataTokens: t,
      imageTokens: 0,
      typicalOutputTokens: A.triageTypicalOutputTokens,
      maxOutputTokens: input.triageMaxOutputTokens,
      cachedSystem: i > 0,
    }),
  );
  const windows = [...input.windows]
    .sort((a, b) => a.rank - b.rank)
    .map((w, i) => ({
      rank: w.rank,
      ...estimateCall({
        model: input.deepModel,
        systemTokens: sys.deep,
        dataTokens: w.textTokens,
        imageTokens: w.imageTokens,
        typicalOutputTokens: A.deepTypicalOutputTokens[input.effort],
        maxOutputTokens: input.maxOutputTokens,
        cachedSystem: i > 0,
      }),
    }));
  const sum = (l: readonly CallEstimate[], k: 'typicalUsd' | 'maxUsd') =>
    l.reduce((a, c) => a + c[k], 0);
  const triage = {
    chunks,
    typicalUsd: round(sum(chunks, 'typicalUsd')),
    maxUsd: round(sum(chunks, 'maxUsd')),
  };

  // Fenêtres traitées par rang, après le repérage : combien tiennent sous le plafond ?
  const fitCount = (k: 'typicalUsd' | 'maxUsd') => {
    let spent = triage[k];
    let n = 0;
    for (const w of windows) {
      if (spent + w[k] > input.budgetUsd) break;
      spent += w[k];
      n++;
    }
    return n;
  };
  return {
    pricingVersion: PRICING_VERSION,
    models: { triage: input.triageModel, deep: input.deepModel },
    effort: input.effort,
    budgetUsd: input.budgetUsd,
    assumptions: [
      'Jetons de texte estimés localement (1 jeton pour 3 octets) ; les comptes réels seront mesurés à l’étape 4b.',
      input.systemTokens
        ? `Prompt système et schéma de réponse : ${sys.deep} jetons estimés (analyse), ${sys.triage} (repérage).`
        : `Prompt système supposé : ${sys.deep} jetons (analyse), ${sys.triage} (repérage).`,
      `Sortie typique (réflexion comprise) : ${A.deepTypicalOutputTokens[input.effort]} jetons par fenêtre (effort ${input.effort}), ${A.triageTypicalOutputTokens} par tranche de repérage.`,
      `Pire cas : entrée +${Math.round((A.inputMargin - 1) * 100)} %, prompt système réécrit en cache à chaque appel, sortie = limite (${input.maxOutputTokens} / ${input.triageMaxOutputTokens} jetons).`,
      'Images : ⌈largeur/28⌉ × ⌈hauteur/28⌉ jetons chacune.',
    ],
    triage,
    windows,
    totals: {
      typicalUsd: round(triage.typicalUsd + sum(windows, 'typicalUsd')),
      maxUsd: round(triage.maxUsd + sum(windows, 'maxUsd')),
    },
    fit: {
      windowCount: windows.length,
      typicalWindows: fitCount('typicalUsd'),
      worstCaseWindows: fitCount('maxUsd'),
      triageFits: triage.maxUsd <= input.budgetUsd,
    },
  };
}
