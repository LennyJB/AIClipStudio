/**
 * Analyse éditoriale en ligne de commande.
 *
 * Préparation locale (AUCUN appel, gratuite) :
 *   npm run analyze -- <id> --dry-run                 préparer, résumer, estimer
 *   npm run analyze -- <id> --dry-run --window 3      requête/contenu de la fenêtre 3
 *   npm run analyze -- <id> --dry-run --show-payload  TOUT le contenu qui serait transmis
 *
 * Analyse avec Claude (PAYANTE, plafond strict, confirmation obligatoire) :
 *   npm run analyze -- <id> --run                     prépare, affiche l'estimation, demande « oui »
 *   npm run analyze -- <id> --run --yes               confirmation explicite sans question
 *   npm run analyze -- <id> --run --force             nouvelle analyse (réponses identiques réutilisées)
 *   npm run analyze -- <id> --run --force-recall      redemander à Claude même ce qui est déjà obtenu
 *
 * Résultats :
 *   npm run analyze -- <id> --proposals | --calls | --costs | --list
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  describeSignal,
  formatClock,
  SPEAKER_CODES,
  type AnalysisEstimate,
  type Signal,
} from '@acs/editorial';
import type { AnalysisRunDto } from '../services/api/src/analysis/repository';
import { JobRepository } from '../services/api/src/recordings/repository';
import { openCliContext, runMain } from './lib/context';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    run: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'show-payload': { type: 'boolean', default: false },
    window: { type: 'string' },
    force: { type: 'boolean', default: false },
    'force-recall': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    proposals: { type: 'boolean', default: false },
    calls: { type: 'boolean', default: false },
    costs: { type: 'boolean', default: false },
  },
});

const usd = (n: number) => `${n.toFixed(n < 1 ? 4 : 2)} $`;
const clock = (ms: number) => formatClock(ms, false);

type Ctx = Awaited<ReturnType<typeof openCliContext>>;

async function waitJobs(ctx: Ctx, jobId: string | undefined, label: string) {
  const jobs = new JobRepository(ctx.db);
  const timer = setInterval(() => {
    const j = jobId ? jobs.get(jobId) : null;
    if (j?.status === 'running')
      process.stdout.write(`\r  ${label}… ${(j.progress * 100).toFixed(0)} %`);
  }, 500);
  await ctx.services.runner.idle();
  clearInterval(timer);
  process.stdout.write('\n');
}

async function prepare(ctx: Ctx, recId: string): Promise<AnalysisRunDto | null> {
  const res = await ctx.services.analysis.request(recId, {
    mode: 'dry_run',
    force: values.force && !values.run,
  });
  if (res.reused && res.status === 'ready') console.log('Préparation identique déjà disponible.');
  await waitJobs(ctx, res.job?.id, 'préparation locale');
  const { run } = ctx.services.analysis.getRun(res.run.id);
  if (run.status !== 'completed') {
    console.error(
      `Préparation ${run.status}${run.error ? ` — ${run.error.code} : ${run.error.message}` : ''}`,
    );
    return null;
  }
  return run;
}

async function printPreparation(ctx: Ctx, run: AnalysisRunDto, fileName: string) {
  const { windows } = ctx.services.analysis.getRun(run.id);
  const dir = path.join(ctx.config.paths.storage, run.outputRelDir!);
  const manifest = (await ctx.services.analysis.manifest(run.id)) as {
    tracks: { audioIndex: number; role: string; textTransmitted: boolean; reason: string }[];
    privacy: {
      imagesSent: boolean;
      noImagesReason: string | null;
      pseudonymLabelsUsed: string[];
      pseudonymFile: { present: boolean; entries: number };
      masked: Record<string, number>;
    };
    triage: { scope: string; chunks: unknown[] };
  };
  const est = run.estimate as AnalysisEstimate;
  console.log(`\n${fileName} — préparation locale (AUCUN appel à Claude API)`);
  console.log(`Contenu préparé et requêtes exactes : ${dir}\n`);
  console.log('Pistes :');
  for (const t of manifest.tracks) {
    console.log(
      `  piste ${t.audioIndex + 1} (${t.role}) : ${t.textTransmitted ? 'texte transmis' : 'texte NON transmis'} — ${t.reason}`,
    );
  }
  const pf = manifest.privacy.pseudonymFile;
  console.log(
    `Pseudonymes : ${pf.present ? `${pf.entries} entrée(s), étiquettes utilisées : ${manifest.privacy.pseudonymLabelsUsed.join(', ') || 'aucune'}` : `aucun fichier (${ctx.config.analysis.privacyFile})`}`,
  );
  console.log(
    `Masqués : ${Object.entries(manifest.privacy.masked)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
  console.log(
    `Images : ${manifest.privacy.imagesSent ? 'oui (gameplay recadré, zones sensibles masquées)' : `aucune — ${manifest.privacy.noImagesReason}`}`,
  );
  console.log(
    `Repérage global : ${manifest.triage.scope}, ${manifest.triage.chunks.length} tranche(s)\n`,
  );
  console.log(`Fenêtres à signaux locaux : ${windows.length} (le repérage pourra en ajouter)`);
  for (const w of windows) {
    const kinds = (w.signals as Signal[]).filter((s) => s.kind !== 'doubtful_transcription');
    const top = [
      ...new Set(
        kinds.map((s) => describeSignal(s, (sp) => SPEAKER_CODES[sp]).replace(/ \(×\d+\)$/, '')),
      ),
    ].slice(0, 3);
    const e = w.estimate as { typicalUsd?: number; maxUsd?: number };
    console.log(
      `  #${String(w.rank).padEnd(3)} ${clock(w.coreStartMs)} → ${clock(w.coreEndMs)}  score ${w.localScore.toFixed(2)}  ${(w.frames as unknown[]).length} image(s)  ~${usd(e.typicalUsd ?? 0)} (max ${usd(e.maxUsd ?? 0)})  ${top.join(' ; ')}`,
    );
  }
  console.log(
    `\nEstimation (tarifs du ${est.pricingVersion}, ${est.models.triage} + ${est.models.deep}, effort ${est.effort}) :`,
  );
  console.log(`  repérage : ~${usd(est.triage.typicalUsd)} (max ${usd(est.triage.maxUsd)})`);
  console.log(
    `  total    : ~${usd(est.totals.typicalUsd)} (pire cas ${usd(est.totals.maxUsd)}) — plafond ${usd(est.budgetUsd)}`,
  );
  console.log(
    `  sous le plafond : ${est.fit.typicalWindows}/${est.fit.windowCount} fenêtre(s) au coût typique, ${est.fit.worstCaseWindows}/${est.fit.windowCount} dans le pire cas`,
  );
  for (const a of est.assumptions) console.log(`  · ${a}`);
  const show = async (rel: string) => {
    console.log(`\n────────── ${rel} ──────────\n${await readFile(path.join(dir, rel), 'utf8')}`);
  };
  if (values.window) {
    await show(`fenetres/fenetre-${values.window.padStart(3, '0')}.txt`);
    await show(`requetes/fenetre-${values.window.padStart(3, '0')}.json`);
  } else if (values['show-payload']) {
    for (let i = 1; i <= manifest.triage.chunks.length; i++)
      await show(`requetes/reperage-${String(i).padStart(2, '0')}.json`);
    for (const w of windows) await show(`requetes/fenetre-${String(w.rank).padStart(3, '0')}.json`);
  } else {
    console.log('\nRequêtes exactes : --show-payload (toutes) ou --window N.');
  }
}

function latestClaudeRun(ctx: Ctx, recId: string): AnalysisRunDto | null {
  return ctx.services.analysis.listRuns(recId).find((r) => r.mode === 'claude') ?? null;
}

function printProposals(ctx: Ctx, run: AnalysisRunDto) {
  const list = ctx.services.analysis.proposals(run.id);
  const clips = list.filter((p) => p.tier === 'clip');
  const second = list.filter((p) => p.tier === 'secondary');
  console.log(`\nAnalyse ${run.id} — ${run.status}${run.error ? ` (${run.error.message})` : ''}`);
  if (!list.length)
    console.log(
      'Aucun moment retenu : c’est un résultat normal pour un stream sans moment marquant.',
    );
  const show = (title: string, items: typeof list) => {
    if (!items.length) return;
    console.log(`\n${title}`);
    for (const p of items) {
      const reasons = (p.reliabilityDetail as { reasons?: string[] }).reasons ?? [];
      console.log(
        `  ${clock(p.srcStartMs)} → ${clock(p.srcEndMs)} (${Math.round((p.srcEndMs - p.srcStartMs) / 1000)} s)  « ${p.title} »  pertinence ${p.relevance}  fiabilité ${p.reliability}  [${p.categories.join(', ')}]`,
      );
      console.log(`      ${p.explanation}`);
      for (const e of p.evidence.filter((x) => x.kind === 'quote'))
        console.log(`      ✓ #${e.segmentId} « ${e.quote} »`);
      if (p.flags.length) console.log(`      alertes : ${p.flags.join(', ')}`);
      if (reasons.length) console.log(`      fiabilité : ${reasons.join(' ; ')}`);
    }
  };
  show(`Clips (${clips.length}) :`, clips);
  show(`Moments secondaires (${second.length}) — limites ou peu fiables, à vérifier :`, second);
}

function printCalls(ctx: Ctx, run: AnalysisRunDto) {
  const { calls, costs } = ctx.services.analysis.calls(run.id);
  console.log(`\nAppels de l’analyse ${run.id} :`);
  for (const c of calls) {
    console.log(
      `  ${c.stage.padEnd(6)} ${c.model.padEnd(17)} ${c.status.padEnd(14)} réservé ${usd(c.reservedUsd)}  coût ${usd(c.costUsd)}  entrée ${c.inputTokens ?? '—'} (cache ${c.cacheReadTokens ?? 0}/${c.cacheWriteTokens ?? 0})  sortie ${c.outputTokens ?? '—'}${c.refusalCategory ? `  refus : ${c.refusalCategory}` : ''}${c.errorCode ? `  ${c.errorCode}` : ''}`,
    );
  }
  console.log(
    `Coût réel : ${usd(costs.realCostUsd)} (${costs.calls} appel(s), ${costs.reusedCalls} réutilisé(s), ${costs.unknownCostCalls} à coût inconnu compté au pire cas) — plafond ${usd(run.budgetUsd)}, dépensé ${usd(run.spentUsd)}`,
  );
}

async function confirm(question: string): Promise<boolean> {
  if (values.yes) return true;
  if (!process.stdin.isTTY) {
    console.error(
      'Confirmation impossible sans terminal interactif : relancez avec --yes pour confirmer explicitement.',
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase() === 'oui';
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const id = positionals[0];
  const modes = ['dry-run', 'run', 'list', 'proposals', 'calls', 'costs'] as const;
  if (!id || !modes.some((m) => values[m])) {
    console.error(
      'Usage : npm run analyze -- <id> --dry-run [--show-payload | --window N] [--force]\n' +
        '        npm run analyze -- <id> --run [--yes] [--force] [--force-recall]\n' +
        '        npm run analyze -- <id> --proposals | --calls | --costs | --list',
    );
    return 2;
  }
  const ctx = await openCliContext();
  try {
    const rec = ctx.recordings.get(id);
    if (!rec) throw new Error(`Enregistrement introuvable : ${id}`);
    const a = ctx.services.analysis;
    if (values.list) {
      const runs = a.listRuns(rec.id);
      if (!runs.length) console.log('Aucune analyse.');
      for (const r of runs) {
        console.log(
          `  ${r.id}  ${r.mode.padEnd(8)} ${r.status.padEnd(16)} ${String(r.windowCount).padStart(3)} fenêtre(s)  dépensé ${usd(r.spentUsd)}  ${r.createdAt}`,
        );
      }
      return 0;
    }
    if (values.costs) {
      const c = a.recordingCosts(rec.id);
      console.log(
        `${rec.fileName} : coût réel cumulé ${usd(c.realCostUsd)} (${c.calls} appel(s), ${c.runs} analyse(s))`,
      );
      return 0;
    }
    if (values.proposals || values.calls) {
      const run = latestClaudeRun(ctx, rec.id);
      if (!run) {
        console.log('Aucune analyse avec Claude pour cet enregistrement (voir --run).');
        return 0;
      }
      if (values.proposals) printProposals(ctx, run);
      if (values.calls) printCalls(ctx, run);
      return 0;
    }

    process.once('SIGINT', () => {
      console.log(
        '\nInterruption : relancer la même commande reprend l’analyse sans repayer les appels réussis.',
      );
      void ctx.services.runner.stop();
    });
    const prepared = await prepare(ctx, rec.id);
    if (!prepared) return 1;
    await printPreparation(ctx, prepared, rec.fileName);
    if (!values.run) return 0;

    // Analyse PAYANTE : confirmation explicite du plafond.
    const budget = ctx.config.analysis.maxCostUsd;
    if (!ctx.config.claude.apiKey) {
      console.error(
        '\nANTHROPIC_API_KEY absente (.env) : seule la préparation locale est possible.',
      );
      return 1;
    }
    const est = prepared.estimate as AnalysisEstimate;
    console.log(
      `\nAnalyse avec Claude : estimation ~${usd(est.totals.typicalUsd)} (pire cas ${usd(est.totals.maxUsd)}), PLAFOND STRICT ${usd(budget)}.`,
    );
    if (values['force-recall'])
      console.log('--force-recall : les réponses déjà obtenues seront redemandées (payant).');
    if (!(await confirm(`Lancer l’analyse payante ? Tapez « oui » pour confirmer : `))) {
      console.log('Analyse non lancée.');
      return 1;
    }
    const res = await a.request(rec.id, {
      mode: 'claude',
      acceptBudgetUsd: budget,
      force: values.force,
      forceRecall: values['force-recall'],
    });
    if (res.reused && res.status === 'ready')
      console.log('Analyse identique déjà terminée (--force pour en refaire une, sans repayer).');
    await waitJobs(ctx, res.job?.id, 'analyse avec Claude');
    const { run } = a.getRun(res.run.id);
    printProposals(ctx, run);
    printCalls(ctx, run);
    return run.status === 'completed' || run.status === 'budget_exhausted' ? 0 : 1;
  } finally {
    ctx.db.close();
  }
}

runMain(main);
