/**
 * Revue des propositions (étape 5) : liste, détail, contexte, décision, réévaluation,
 * détachement d'un moment, historique et journal.
 *
 * Garanties :
 *  - proposal_reviews est la source de vérité de la décision propre à une proposition ;
 *  - une décision vaut pour tout son moment ; une proposition qui en hérite ne crée rien ;
 *  - chaque demande porte un `requestId` : rejouée, elle renvoie la réponse d'origine, même si
 *    l'état a changé depuis (y compris pour une demande sans effet) ;
 *  - tout ce qui est lu et écrit pour une demande l'est dans UNE transaction SQLite ;
 *  - rien n'est envoyé à Claude et aucune préférence n'est déduite ni activée.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  assignMoments,
  buildSnapshot,
  DecisionInputSchema,
  effectiveDecisions,
  MOMENT_RULE_VERSION,
  normalizeDecision,
  planDecision,
  summarizeDecisions,
  type DecisionState,
  type EffectiveDecision,
  type FeedbackEvent,
} from '@acs/memory';
import { AppError } from '@acs/shared';
import type { AppContext } from '../context';
import { ProposalRepository, type ProposalDto } from '../analysis/proposals';
import { AnalysisRepository, type AnalysisRunDto } from '../analysis/repository';
import { RecordingRepository } from '../recordings/repository';
import { parse } from '../routes/validation';
import type { TranscriptionService } from '../transcriptions/service';
import { ReviewRepository, type MembershipDto, type ReviewDto, type Source } from './repository';

const FINAL_STATUSES = new Set(['completed', 'budget_exhausted']);

export const DecisionBodySchema = z
  .object({
    requestId: z.uuid(),
    decision: z.enum(['pending', 'accepted', 'rejected']),
    reasons: DecisionInputSchema.shape.reasons,
    comment: DecisionInputSchema.shape.comment,
    expectedVersion: z.number().int().min(0).optional(),
    reevaluate: z.boolean().optional(),
  })
  .strict();
export type DecisionBody = z.infer<typeof DecisionBodySchema>;

export const DetachBodySchema = z
  .object({
    requestId: z.uuid(),
    comment: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type DetachBody = z.infer<typeof DetachBodySchema>;

export const ListQuerySchema = z
  .object({
    runId: z.uuid().optional(),
    tier: z.enum(['clip', 'secondary']).optional(),
    status: z.enum(['to_review', 'accepted', 'rejected', 'already_reviewed', 'all']).default('all'),
    includeMerged: z.coerce.boolean().default(false),
  })
  .strict();

export type ReviewState = 'to_review' | 'accepted' | 'rejected' | 'already_reviewed' | 'merged';

/** Décision effective d'un moment, vue depuis une proposition donnée. */
export interface EffectiveView extends EffectiveDecision {
  /** Vrai si la décision a été prise sur une AUTRE proposition du moment. */
  inherited: boolean;
  source: { proposalId: string; runId: string; title: string; decidedAt: string | null } | null;
}

export interface ReviewItem {
  proposal: ProposalDto;
  momentId: string | null;
  /** Décision PROPRE de la proposition, si elle en a une et qu'elle est la décision actuelle. */
  review: ReviewDto | null;
  /** Décision propre existante mais remplacée (réévaluation ailleurs ou réinitialisation). */
  supersededReview: ReviewDto | null;
  effective: EffectiveView;
  state: ReviewState;
  /** Version de la décision propre (0 si aucune) : à renvoyer dans `expectedVersion`. */
  version: number;
}

/** Réponse d'une décision (aussi renvoyée telle quelle lors d'un rejeu). */
export interface DecisionResult {
  outcome: 'applied' | 'noop';
  event: FeedbackEvent | null;
  review: ReviewDto | null;
  supersededReview: ReviewDto | null;
  effective: EffectiveView;
  state: ReviewState;
  version: number;
  replayed: boolean;
}

/** Réponse d'un détachement (aussi renvoyée telle quelle lors d'un rejeu). */
export interface DetachResult extends Omit<DecisionResult, 'event'> {
  change: {
    id: string;
    proposalId: string;
    fromMomentId: string;
    toMomentId: string;
    comment: string | null;
  } | null;
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class ReviewService {
  readonly repo: ReviewRepository;
  private readonly proposals: ProposalRepository;
  private readonly runs: AnalysisRepository;
  private readonly recordings: RecordingRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly transcriptions: TranscriptionService,
  ) {
    this.repo = new ReviewRepository(ctx.db);
    this.proposals = new ProposalRepository(ctx.db);
    this.runs = new AnalysisRepository(ctx.db);
    this.recordings = new RecordingRepository(ctx.db);
  }

  /* ------------------------------- Moments ------------------------------- */

  /**
   * Affecte les propositions encore SANS moment (analyses terminées, non fusionnées), dans
   * l'ordre (création, identifiant). Les appartenances existantes ne sont jamais recalculées.
   */
  ensureMoments(recordingId: string): number {
    return this.ctx.db.transaction(() => {
      const fresh = this.ctx.db
        .prepare(
          `SELECT p.id, p.punchline_segment_id, p.punchline_ms, p.src_start_ms, p.src_end_ms, p.created_at
           FROM clip_proposals p
           JOIN analysis_runs r ON r.id = p.run_id
           LEFT JOIN moment_members mm ON mm.proposal_id = p.id
           WHERE p.recording_id = ? AND p.merged_into_id IS NULL AND mm.proposal_id IS NULL
             AND r.status IN ('completed','budget_exhausted')`,
        )
        .all(recordingId) as {
        id: string;
        punchline_segment_id: number;
        punchline_ms: number;
        src_start_ms: number;
        src_end_ms: number;
        created_at: string;
      }[];
      if (!fresh.length) return 0;
      const assignments = assignMoments(
        this.repo.momentsOfRecording(recordingId),
        fresh.map((p) => ({
          id: p.id,
          createdAt: p.created_at,
          ref: {
            punchlineSegmentId: p.punchline_segment_id,
            punchlineMs: p.punchline_ms,
            srcStartMs: p.src_start_ms,
            srcEndMs: p.src_end_ms,
          },
        })),
        () => randomUUID(),
      );
      for (const a of assignments) {
        if (a.newMoment) {
          this.repo.insertMoment({
            id: a.newMoment.id,
            recordingId,
            ruleVersion: MOMENT_RULE_VERSION,
            refProposalId: a.proposalId,
            ref: a.newMoment.ref,
          });
        }
        this.repo.insertMember({
          proposalId: a.proposalId,
          momentId: a.momentId,
          matchKind: a.kind,
          score: a.score,
          ruleVersion: MOMENT_RULE_VERSION,
        });
      }
      return assignments.length;
    })();
  }

  /* -------------------------------- Lecture -------------------------------- */

  private recording(recordingId: string) {
    const rec = this.recordings.get(recordingId);
    if (!rec) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return rec;
  }

  private proposal(id: string): ProposalDto {
    const p = this.proposals.getProposal(id);
    if (!p) throw new AppError('NOT_FOUND', 'Proposition introuvable');
    return p;
  }

  /** Dernière analyse avec Claude terminée (ou arrêtée par le budget) d'un enregistrement. */
  latestFinalRun(recordingId: string): AnalysisRunDto | null {
    return (
      this.runs
        .listRuns(recordingId)
        .find((r) => r.mode === 'claude' && FINAL_STATUSES.has(r.status)) ?? null
    );
  }

  private effectiveView(proposalId: string, momentId: string | null): EffectiveView {
    if (!momentId) {
      return {
        status: 'pending',
        reasons: [],
        comment: null,
        sourceProposalId: null,
        eventId: null,
        inherited: false,
        source: null,
      };
    }
    const e = this.repo.effectiveForMoment(momentId);
    let source: EffectiveView['source'] = null;
    if (e.sourceProposalId) {
      const sp = this.proposals.getProposal(e.sourceProposalId);
      const sr = this.repo.review(e.sourceProposalId);
      source = {
        proposalId: e.sourceProposalId,
        runId: sp?.runId ?? '',
        title: sp?.title ?? '',
        decidedAt: sr?.decidedAt ?? null,
      };
    }
    return {
      status: e.status,
      reasons: e.reasons,
      comment: e.comment,
      sourceProposalId: e.sourceProposalId,
      eventId: e.eventId,
      inherited: e.sourceProposalId !== null && e.sourceProposalId !== proposalId,
      source,
    };
  }

  item(p: ProposalDto): ReviewItem {
    const membership = this.repo.membership(p.id);
    const effective = this.effectiveView(p.id, membership?.momentId ?? null);
    const own = this.repo.review(p.id);
    // La décision propre n'est « actuelle » que si elle est la décision effective du moment.
    const ownIsCurrent =
      own !== null && own.status !== 'pending' && effective.sourceProposalId === p.id;
    const state: ReviewState =
      p.mergedIntoId !== null
        ? 'merged'
        : effective.status === 'pending'
          ? 'to_review'
          : effective.inherited
            ? 'already_reviewed'
            : effective.status;
    return {
      proposal: p,
      momentId: membership?.momentId ?? null,
      review: ownIsCurrent ? own : null,
      supersededReview: own && !ownIsCurrent && own.status !== 'pending' ? own : null,
      effective,
      state,
      version: own?.version ?? 0,
    };
  }

  list(recordingId: string, query: z.input<typeof ListQuerySchema> = {}) {
    const q = parse(ListQuerySchema, query);
    this.recording(recordingId);
    this.ensureMoments(recordingId);
    const run = q.runId ? this.runs.getRun(q.runId) : this.latestFinalRun(recordingId);
    if (q.runId && (!run || run.recordingId !== recordingId)) {
      throw new AppError('NOT_FOUND', 'Analyse introuvable pour cet enregistrement');
    }
    const runs = this.runs
      .listRuns(recordingId)
      .filter((r) => r.mode === 'claude' && FINAL_STATUSES.has(r.status))
      .map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt }));
    if (!run) return { run: null, runs, items: [], counts: emptyCounts(), summary: null };

    const all = this.proposals
      .listProposals(run.id, { includeMerged: q.includeMerged })
      .map((p) => this.item(p));
    const counts = emptyCounts();
    for (const i of all) {
      counts.all += 1;
      counts[i.state] += 1;
    }
    const items = all.filter(
      (i) =>
        (!q.tier || i.proposal.tier === q.tier) && (q.status === 'all' || i.state === q.status),
    );
    const momentIds = all.map((i) => i.momentId).filter((m): m is string => m !== null);
    const summary = summarizeDecisions(
      momentIds,
      new Map(momentIds.map((m) => [m, this.repo.effectiveForMoment(m)])),
    );
    return {
      run: { id: run.id, status: run.status, createdAt: run.createdAt },
      runs,
      items,
      counts,
      summary,
    };
  }

  detail(proposalId: string) {
    const p = this.proposal(proposalId);
    this.ensureMoments(p.recordingId);
    const item = this.item(p);
    const run = this.runs.getRun(p.runId);
    const members: (MembershipDto & { runId: string; title: string; isSource: boolean })[] =
      item.momentId
        ? this.repo.members(item.momentId).map((m) => {
            const mp = this.proposals.getProposal(m.proposalId);
            return {
              ...m,
              runId: mp?.runId ?? '',
              title: mp?.title ?? '',
              isSource: item.effective.sourceProposalId === m.proposalId,
            };
          })
        : [];
    return {
      ...item,
      moment: item.momentId ? { id: item.momentId, members } : null,
      run: run
        ? {
            id: run.id,
            status: run.status,
            createdAt: run.createdAt,
            promptVersion: run.promptVersion,
            models: this.models(run.id, p.callId),
          }
        : null,
    };
  }

  /** Segments autour du passage, toutes pistes, avec ce qui a été transmis à Claude. */
  context(proposalId: string, opts: { beforeMs?: number; afterMs?: number } = {}) {
    const p = this.proposal(proposalId);
    const run = this.runs.getRun(p.runId);
    const before = Math.min(Math.max(opts.beforeMs ?? 30_000, 0), 120_000);
    const after = Math.min(Math.max(opts.afterMs ?? 15_000, 0), 120_000);
    const fromMs = Math.max(0, p.srcStartMs - before);
    const toMs = p.srcEndMs + after;
    const discordAllowed =
      (run?.privacy as { discordTextAllowed?: boolean } | undefined)?.discordTextAllowed === true;
    const t = this.transcriptions.transcript(p.recordingId, {
      ...(run?.transcriptionIds.length ? { transcriptionIds: run.transcriptionIds } : {}),
      fromMs,
      toMs,
    });
    const marks = new Map<number, 'setup' | 'punchline' | 'reaction_end'>([
      [p.setupSegmentId, 'setup'],
      [p.reactionEndSegmentId, 'reaction_end'],
      [p.punchlineSegmentId, 'punchline'],
    ]);
    return {
      proposalId: p.id,
      fromMs,
      toMs,
      clip: { srcStartMs: p.srcStartMs, srcEndMs: p.srcEndMs },
      segments: t.segments.map((s) => ({
        id: s.id,
        audioIndex: s.audioIndex,
        role: s.role,
        srcStartMs: s.srcStartMs,
        srcEndMs: s.srcEndMs,
        text: s.text,
        inClip: s.srcEndMs > p.srcStartMs && s.srcStartMs < p.srcEndMs,
        marker: marks.get(s.id) ?? null,
        // Ce qui a été transmis à Claude pour cette analyse (piste par piste).
        sentToClaude:
          s.role === 'mic' || (discordAllowed && (s.role === 'discord' || s.role === 'mix')),
      })),
    };
  }

  private models(runId: string, callId: string | null) {
    const deep = callId
      ? (this.ctx.db.prepare('SELECT model FROM llm_calls WHERE id = ?').get(callId) as
          { model: string } | undefined)
      : undefined;
    const triage = this.ctx.db
      .prepare(`SELECT model FROM llm_calls WHERE run_id = ? AND stage = 'triage' LIMIT 1`)
      .get(runId) as { model: string } | undefined;
    return { triage: triage?.model ?? null, deep: deep?.model ?? null };
  }

  /* ------------------------------- Décision ------------------------------- */

  decide(
    proposalId: string,
    body: z.input<typeof DecisionBodySchema>,
    source: Source,
  ): DecisionResult {
    const b = parse(DecisionBodySchema, body);
    // Règles métier (motifs, « autre » + commentaire…) : erreur 400 lisible, jamais une 500.
    const input = parse(DecisionInputSchema, {
      decision: b.decision,
      ...(b.reasons ? { reasons: b.reasons } : {}),
      ...(b.comment !== undefined ? { comment: b.comment } : {}),
    });
    const target = normalizeDecision(input);
    const hash = sha({
      action: 'decision',
      proposalId,
      target,
      reevaluate: b.reevaluate === true,
      expectedVersion: b.expectedVersion ?? null,
    });

    return this.ctx.db.transaction(() => {
      const replay = this.replay<DecisionResult>(b.requestId, hash);
      if (replay) return replay;

      const p = this.reviewable(proposalId);
      this.ensureMoments(p.recordingId);
      const membership = this.repo.membership(p.id)!;
      const own = this.repo.review(p.id);
      if (b.expectedVersion !== undefined && b.expectedVersion !== (own?.version ?? 0)) {
        throw new AppError(
          'VERSION_CONFLICT',
          'La décision a été modifiée entre-temps : rechargez la proposition',
          { details: { current: this.item(p) } },
        );
      }
      const before = this.effectiveView(p.id, membership.momentId);
      const plan = planDecision({
        proposalId: p.id,
        target,
        effective: before,
        reevaluate: b.reevaluate === true,
      });
      if (plan.kind === 'refused') {
        const where = before.source
          ? `la proposition « ${before.source.title} »`
          : 'une autre proposition';
        throw new AppError(
          plan.code,
          plan.code === 'DECISION_ELSEWHERE'
            ? `La décision actuelle a été prise sur ${where} : seule cette proposition peut l’annuler`
            : `Ce passage a déjà été examiné sur ${where} : réévaluez-le explicitement pour changer d’avis`,
          { details: { effective: before } },
        );
      }
      if (plan.kind === 'noop') {
        const response = {
          outcome: 'noop' as const,
          event: null,
          ...this.stateOf(p),
        };
        this.repo.insertRequest({
          requestId: b.requestId,
          requestHash: hash,
          proposalId: p.id,
          action: 'decision',
          outcome: 'noop',
          eventId: null,
          response,
        });
        return { ...response, replayed: false };
      }
      const run = this.runs.getRun(p.runId)!;
      const rec = this.recordings.get(p.recordingId)!;
      const { event } = this.repo.applyDecision({
        id: randomUUID(),
        requestId: b.requestId,
        type: plan.eventType,
        recordingId: p.recordingId,
        gameId: rec.gameId,
        proposalId: p.id,
        runId: p.runId,
        momentId: membership.momentId,
        previousStatus: plan.previousStatus,
        next: plan.next,
        reevaluatesEventId: plan.reevaluatesEventId,
        snapshot: buildSnapshot({
          tier: p.tier,
          title: p.title,
          categories: p.categories,
          relevance: p.relevance,
          reliability: p.reliability,
          flags: p.flags,
          srcStartMs: p.srcStartMs,
          srcEndMs: p.srcEndMs,
          punchlineMs: p.punchlineMs,
          standalone: p.standalone,
          promptVersion: run.promptVersion,
          models: this.models(run.id, p.callId),
          pipelineVersion: run.pipelineVersion,
          memoryVersion: run.memoryVersion,
        }),
        source,
      });
      const response = { outcome: 'applied' as const, event, ...this.stateOf(p) };
      this.repo.insertRequest({
        requestId: b.requestId,
        requestHash: hash,
        proposalId: p.id,
        action: 'decision',
        outcome: 'applied',
        eventId: event.id,
        response,
      });
      return { ...response, replayed: false };
    })();
  }

  /** Détache explicitement une proposition de son moment : elle fonde un nouveau moment. */
  detach(proposalId: string, body: z.input<typeof DetachBodySchema>, source: Source): DetachResult {
    const b = parse(DetachBodySchema, body);
    const comment = b.comment?.trim() ? b.comment.trim() : null;
    const hash = sha({ action: 'detach', proposalId, comment });
    return this.ctx.db.transaction(() => {
      const replay = this.replay<DetachResult>(b.requestId, hash);
      if (replay) return replay;
      const p = this.reviewable(proposalId);
      this.ensureMoments(p.recordingId);
      const membership = this.repo.membership(p.id)!;
      if (this.repo.members(membership.momentId).length === 1) {
        const response = { outcome: 'noop' as const, change: null, ...this.stateOf(p) };
        this.repo.insertRequest({
          requestId: b.requestId,
          requestHash: hash,
          proposalId: p.id,
          action: 'detach',
          outcome: 'noop',
          eventId: null,
          response,
        });
        return { ...response, replayed: false };
      }
      const momentId = randomUUID();
      this.repo.deleteMember(p.id);
      this.repo.insertMoment({
        id: momentId,
        recordingId: p.recordingId,
        ruleVersion: MOMENT_RULE_VERSION,
        refProposalId: p.id,
        ref: {
          punchlineSegmentId: p.punchlineSegmentId,
          punchlineMs: p.punchlineMs,
          srcStartMs: p.srcStartMs,
          srcEndMs: p.srcEndMs,
        },
      });
      this.repo.insertMember({
        proposalId: p.id,
        momentId,
        matchKind: 'detached',
        score: 1,
        ruleVersion: MOMENT_RULE_VERSION,
      });
      const change = {
        id: randomUUID(),
        requestId: b.requestId,
        proposalId: p.id,
        fromMomentId: membership.momentId,
        toMomentId: momentId,
        comment,
        source,
      };
      this.repo.insertMomentChange(change);
      const response = { outcome: 'applied' as const, change, ...this.stateOf(p) };
      this.repo.insertRequest({
        requestId: b.requestId,
        requestHash: hash,
        proposalId: p.id,
        action: 'detach',
        outcome: 'applied',
        eventId: null,
        response,
      });
      return { ...response, replayed: false };
    })();
  }

  private stateOf(p: ProposalDto) {
    const i = this.item(p);
    return {
      review: i.review,
      supersededReview: i.supersededReview,
      effective: i.effective,
      state: i.state,
      version: this.repo.review(p.id)?.version ?? 0,
    };
  }

  /** Demande déjà traitée : réponse d'origine telle quelle, quel que soit l'état actuel. */
  private replay<T extends { replayed: boolean }>(requestId: string, hash: string): T | null {
    const prior = this.repo.findRequest(requestId);
    if (!prior) return null;
    if (prior.requestHash !== hash) {
      throw new AppError(
        'IDEMPOTENCY_MISMATCH',
        'Cet identifiant de demande a déjà servi pour une autre demande',
      );
    }
    return { ...(prior.response as Omit<T, 'replayed'>), replayed: true } as T;
  }

  private reviewable(proposalId: string): ProposalDto {
    const p = this.proposal(proposalId);
    if (p.mergedIntoId) {
      throw new AppError(
        'PROPOSAL_NOT_REVIEWABLE',
        'Proposition fusionnée dans une autre : jugez la proposition retenue',
        { details: { mergedIntoId: p.mergedIntoId } },
      );
    }
    const run = this.runs.getRun(p.runId);
    if (!run || !FINAL_STATUSES.has(run.status)) {
      throw new AppError(
        'PROPOSAL_NOT_REVIEWABLE',
        'L’analyse de cette proposition n’est pas terminée',
        { details: { runStatus: run?.status ?? null } },
      );
    }
    return p;
  }

  /* ------------------------------ Historique ------------------------------ */

  /** Historique du moment de la proposition ; `current` marque l'événement qui fait foi. */
  history(proposalId: string) {
    const p = this.proposal(proposalId);
    this.ensureMoments(p.recordingId);
    const membership = this.repo.membership(p.id);
    const ids = membership
      ? this.repo.members(membership.momentId).map((m) => m.proposalId)
      : [p.id];
    const effective = membership ? this.repo.effectiveForMoment(membership.momentId) : null;
    return {
      momentId: membership?.momentId ?? null,
      events: this.repo
        .eventsOfProposals(ids)
        .map((e) => ({ ...e, current: effective?.eventId === e.id })),
    };
  }

  journal(q: {
    recordingId?: string;
    gameId?: string;
    momentId?: string;
    type?: string;
    afterSeq?: number;
    limit?: number;
  }): { events: FeedbackEvent[]; nextAfterSeq: number | null } {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const proposalIds = q.momentId
      ? this.repo.members(q.momentId).map((m) => m.proposalId)
      : undefined;
    const events = this.repo.events({
      ...(q.recordingId ? { recordingId: q.recordingId } : {}),
      ...(q.gameId ? { gameId: q.gameId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(proposalIds ? { proposalIds } : {}),
      afterSeq: q.afterSeq ?? 0,
      limit,
    });
    return {
      events,
      nextAfterSeq: events.length === limit ? events[events.length - 1]!.seq : null,
    };
  }

  /**
   * Export complet (JSON Lines) : journal éditorial, appartenances, changements de regroupement,
   * et une synthèse par moment calculée par effectiveDecisions (une décision par moment).
   */
  exportLines(filter: { gameId?: string } = {}): string[] {
    const memberships = this.repo.allMemberships();
    const byProposal = new Map(memberships.map((m) => [m.proposalId, m.momentId]));
    const events = this.repo.events({
      ...(filter.gameId ? { gameId: filter.gameId } : {}),
      afterSeq: 0,
      limit: 1e9,
    });
    const kept = new Set(events.map((e) => e.id));
    const decisions = [...effectiveDecisions(this.repo.decisionEvents(), byProposal)].filter(
      ([, d]) => d.eventId !== null && kept.has(d.eventId),
    );
    const lines: string[] = [];
    for (const e of events) lines.push(JSON.stringify({ kind: 'event', ...e }));
    for (const m of memberships) lines.push(JSON.stringify({ kind: 'membership', ...m }));
    for (const c of this.repo.momentChanges())
      lines.push(JSON.stringify({ kind: 'moment_change', ...c }));
    for (const [momentId, d] of decisions) {
      lines.push(JSON.stringify({ kind: 'moment_decision', momentId, ...d }));
    }
    return lines;
  }
}

function emptyCounts(): Record<ReviewState | 'all', number> {
  return { all: 0, to_review: 0, accepted: 0, rejected: 0, already_reviewed: 0, merged: 0 };
}

export type { DecisionState };
