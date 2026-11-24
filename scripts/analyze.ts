/**
 * Analyse éditoriale en ligne de commande — étape 4a : PRÉPARATION LOCALE UNIQUEMENT.
 * Aucun appel à Claude API : la commande repère les fenêtres candidates, prépare le contenu
 * qui serait transmis, l'écrit sur disque et estime le coût sous le plafond.
 *
 *   npm run analyze -- <id> --dry-run                 préparer et résumer
 *   npm run analyze -- <id> --dry-run --show-payload  afficher TOUT le contenu qui serait transmis
 *   npm run analyze -- <id> --dry-run --window 3      afficher le contenu de la fenêtre 3
 *   npm run analyze -- <id> --dry-run --force         refaire une préparation identique
 *   npm run analyze -- <id> --list                    analyses déjà préparées
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
    'show-payload': { type: 'boolean', default: false },
    window: { type: 'string' },
    force: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});

const usd = (n: number) => `${n.toFixed(n < 1 ? 4 : 2)} $`;

function printRun(run: AnalysisRunDto) {
  console.log(
    `  ${run.id}  ${run.status.padEnd(10)} ${run.mode}  ${String(run.windowCount).padStart(3)} fenêtre(s)  ${run.createdAt}`,
  );
}

async function main(): Promise<number> {
  const id = positionals[0];
  if (!id || (!values['dry-run'] && !values.list)) {
    console.error(
      'Usage : npm run analyze -- <id> --dry-run [--show-payload | --window N] [--force]\n' +
        '        npm run analyze -- <id> --list\n\n' +
        'Étape 4a : seule la préparation locale (--dry-run) existe. Les appels à Claude API\n' +
        'arriveront à l’étape 4b, après validation de cette préparation.',
    );
    return 2;
  }
  const { config, db, services, recordings } = await openCliContext();
  try {
    const rec = recordings.get(id);
    if (!rec) throw new Error(`Enregistrement introuvable : ${id}`);
    if (values.list) {
      const runs = services.analysis.listRuns(rec.id);
      if (!runs.length) console.log('Aucune analyse préparée.');
      runs.forEach(printRun);
      return 0;
    }

    process.once('SIGINT', () => {
      console.log('\nInterruption : relancez la commande pour recommencer la préparation.');
      void services.runner.stop();
    });
    const res = await services.analysis.request(rec.id, { force: values.force });
    if (res.reused && res.status === 'ready')
      console.log('Préparation identique déjà disponible (--force pour la refaire).');
    const jobs = new JobRepository(db);
    const timer = setInterval(() => {
      const j = res.job ? jobs.get(res.job.id) : null;
      if (j?.status === 'running')
        process.stdout.write(`\r  préparation… ${(j.progress * 100).toFixed(0)} %`);
    }, 500);
    await services.runner.idle();
    clearInterval(timer);
    const { run, windows } = services.analysis.getRun(res.run.id);
    if (run.status !== 'completed') {
      console.error(
        `\nPréparation ${run.status}${run.error ? ` — ${run.error.code} : ${run.error.message}` : ''}`,
      );
      return 1;
    }
    const dir = path.join(config.paths.storage, run.outputRelDir!);
    const manifest = (await services.analysis.manifest(run.id)) as {
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

    console.log(`\n${rec.fileName} — préparation locale terminée (AUCUN appel à Claude API)`);
    console.log(`Contenu préparé : ${dir}\n`);
    console.log('Pistes :');
    for (const t of manifest.tracks) {
      console.log(
        `  piste ${t.audioIndex + 1} (${t.role}) : ${t.textTransmitted ? 'texte transmis' : 'texte NON transmis'} — ${t.reason}`,
      );
    }
    const pf = manifest.privacy.pseudonymFile;
    console.log(
      `Pseudonymes : ${pf.present ? `${pf.entries} entrée(s), étiquettes utilisées : ${manifest.privacy.pseudonymLabelsUsed.join(', ') || 'aucune'}` : `aucun fichier (${config.analysis.privacyFile})`}`,
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

    console.log(`Fenêtres candidates : ${windows.length}`);
    for (const w of windows) {
      const kinds = (w.signals as Signal[]).filter((s) => s.kind !== 'doubtful_transcription');
      const top = [
        ...new Set(
          kinds.map((s) => describeSignal(s, (sp) => SPEAKER_CODES[sp]).replace(/ \(×\d+\)$/, '')),
        ),
      ].slice(0, 3);
      const e = w.estimate as { typicalUsd?: number; maxUsd?: number };
      console.log(
        `  #${String(w.rank).padEnd(3)} ${formatClock(w.coreStartMs, false)} → ${formatClock(w.coreEndMs, false)}  score ${w.localScore.toFixed(2)}  ${(w.frames as unknown[]).length} image(s)  ~${usd(e.typicalUsd ?? 0)} (max ${usd(e.maxUsd ?? 0)})  ${top.join(' ; ')}`,
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
    } else if (values['show-payload']) {
      for (let i = 1; i <= manifest.triage.chunks.length; i++)
        await show(`reperage/tranche-${String(i).padStart(2, '0')}.txt`);
      for (const w of windows)
        await show(`fenetres/fenetre-${String(w.rank).padStart(3, '0')}.txt`);
    } else {
      console.log(
        '\nPour relire le contenu qui serait transmis : --show-payload (tout) ou --window N.',
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

runMain(main);
