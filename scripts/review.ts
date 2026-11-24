/**
 * Revue des propositions de clips (étape 5), en ligne de commande. Aucun appel à Claude.
 *
 *   npm run review -- <recordingId> [--run <id>] [--tier clip|secondary]
 *                      [--status to_review|accepted|rejected|already_reviewed|all]
 *   npm run review -- --show <proposalId>
 *   npm run review -- --accept <proposalId> [--comment "…"] [--reevaluate]
 *   npm run review -- --reject <proposalId> --reason chute_coupee [--reason trop_long]
 *                      [--comment "…"] [--reevaluate]
 *   npm run review -- --reset <proposalId>
 *   npm run review -- --detach <proposalId> [--comment "…"]
 *   npm run review -- --export [--game valorant]        journal en JSON Lines (sortie standard)
 *
 * Chaque action porte un identifiant de demande unique : relancer la même commande après une
 * réussite ne crée pas de doublon (l'état identique ne produit aucun événement).
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { REJECT_REASON_LABELS, REJECT_REASONS, type RejectReason } from '@acs/memory';
import { formatClock } from '@acs/editorial';
import type { ReviewItem } from '../services/api/src/review/service';
import { openCliContext, runMain } from './lib/context';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: 'string' },
    tier: { type: 'string' },
    status: { type: 'string' },
    show: { type: 'string' },
    accept: { type: 'string' },
    reject: { type: 'string' },
    reset: { type: 'string' },
    detach: { type: 'string' },
    reason: { type: 'string', multiple: true },
    comment: { type: 'string' },
    reevaluate: { type: 'boolean', default: false },
    export: { type: 'boolean', default: false },
    game: { type: 'string' },
  },
});

const STATE: Record<string, string> = {
  to_review: 'à examiner',
  accepted: 'acceptée',
  rejected: 'refusée',
  already_reviewed: 'déjà examinée',
  merged: 'fusionnée',
};
const clock = (ms: number) => formatClock(ms, false);
const reasonsText = (r: readonly RejectReason[]) =>
  r.map((x) => REJECT_REASON_LABELS[x]).join(', ');

function line(i: ReviewItem) {
  const p = i.proposal;
  const eff = i.effective;
  const decided =
    eff.status === 'pending'
      ? ''
      : ` — ${eff.status === 'accepted' ? 'acceptée' : `refusée (${reasonsText(eff.reasons)})`}${
          eff.inherited && eff.source ? ` sur « ${eff.source.title} »` : ''
        }`;
  return `  ${p.id}  ${p.tier === 'clip' ? 'clip      ' : 'secondaire'} ${clock(p.srcStartMs)} → ${clock(p.srcEndMs)}  « ${p.title} »  pertinence ${p.relevance}  fiabilité ${p.reliability}  [${STATE[i.state]}]${decided}`;
}

async function main(): Promise<number> {
  const ctx = await openCliContext();
  try {
    const review = ctx.services.review;

    if (values.export) {
      for (const l of review.exportLines(values.game ? { gameId: values.game } : {}))
        process.stdout.write(`${l}\n`);
      return 0;
    }

    const action = values.accept ?? values.reject ?? values.reset ?? values.detach ?? values.show;
    if (action) {
      if (values.show) {
        const d = review.detail(values.show);
        console.log(line(d));
        console.log(`  ${d.proposal.explanation}`);
        for (const e of d.proposal.evidence.filter((x) => x.kind === 'quote'))
          console.log(`    ${e.verified ? '✓' : '✗'} « ${e.quote} »`);
        for (const e of review.history(values.show).events)
          console.log(
            `    ${e.occurredAt}  ${e.type}${e.reasons.length ? ` (${reasonsText(e.reasons)})` : ''}${e.comment ? ` « ${e.comment} »` : ''}${e.current ? '  [actuelle]' : ''}`,
          );
        return 0;
      }
      if (values.detach) {
        const r = review.detach(
          values.detach,
          { requestId: randomUUID(), ...(values.comment ? { comment: values.comment } : {}) },
          'cli',
        );
        console.log(
          r.outcome === 'noop'
            ? 'Déjà seule dans son moment : rien à faire.'
            : 'Détachée : nouveau moment créé.',
        );
        return 0;
      }
      const reasons = (values.reason ?? []) as string[];
      const unknown = reasons.filter((r) => !(REJECT_REASONS as readonly string[]).includes(r));
      if (unknown.length) {
        console.error(
          `Motif inconnu : ${unknown.join(', ')}. Motifs : ${REJECT_REASONS.join(', ')}`,
        );
        return 2;
      }
      const id = (values.accept ?? values.reject ?? values.reset)!;
      const r = review.decide(
        id,
        {
          requestId: randomUUID(),
          decision: values.accept ? 'accepted' : values.reject ? 'rejected' : 'pending',
          ...(values.reject ? { reasons: reasons as RejectReason[] } : {}),
          ...(values.comment ? { comment: values.comment } : {}),
          ...(values.reevaluate ? { reevaluate: true } : {}),
        },
        'cli',
      );
      console.log(
        r.outcome === 'noop'
          ? 'Aucun changement : la décision était déjà celle-ci.'
          : `Décision enregistrée : ${STATE[r.state]}.`,
      );
      return 0;
    }

    const recId = positionals[0];
    if (!recId) {
      console.error(
        'Usage : npm run review -- <recordingId> [--run <id>] [--tier clip|secondary] [--status …]\n' +
          '        npm run review -- --show | --accept | --reject | --reset | --detach <proposalId>\n' +
          '        npm run review -- --export [--game <jeu>]',
      );
      return 2;
    }
    const l = review.list(recId, {
      ...(values.run ? { runId: values.run } : {}),
      ...(values.tier ? { tier: values.tier as 'clip' | 'secondary' } : {}),
      ...(values.status ? { status: values.status as 'all' } : {}),
    });
    if (!l.run) {
      console.log('Aucune analyse avec Claude terminée pour cet enregistrement.');
      return 0;
    }
    console.log(
      `Analyse ${l.run.id} — ${l.counts.to_review} à examiner, ${l.counts.accepted} acceptée(s), ${l.counts.rejected} refusée(s), ${l.counts.already_reviewed} déjà examinée(s)`,
    );
    if (!l.items.length) console.log('  Aucune proposition pour ce filtre.');
    for (const i of l.items) console.log(line(i));
    return 0;
  } finally {
    ctx.db.close();
  }
}

runMain(main);
