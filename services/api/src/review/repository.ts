/**
 * Données de la revue (migration 6) : moments, décisions courantes, journal éditorial, demandes
 * (idempotence) et changements de regroupement. Toutes les écritures passent par des transactions
 * SQLite synchrones ; les journaux sont en ajout seul (garanti par la base).
 */
import type {
  DecisionEvent,
  DecisionState,
  EffectiveDecision,
  ExistingMoment,
  FeedbackEvent,
  FeedbackEventType,
  MomentRef,
  ProposalSnapshot,
  RejectReason,
  ReviewStatus,
} from '@acs/memory';
import { FEEDBACK_SCHEMA_VERSION, PENDING_STATE } from '@acs/memory';
import type { Db } from '../db';
import { NOW } from '../recordings/repository';

export type Source = 'ui' | 'cli' | 'api';

export interface MembershipDto {
  proposalId: string;
  momentId: string;
  matchKind: 'founder' | 'same_punchline' | 'overlap' | 'detached';
  score: number;
  ruleVersion: number;
  linkedAt: string;
}

export interface ReviewDto extends DecisionState {
  proposalId: string;
  decidedAt: string | null;
  lastEventId: string;
  lastEventSeq: number;
  version: number;
  updatedAt: string;
}

export interface StoredRequest {
  requestId: string;
  requestHash: string;
  proposalId: string;
  action: 'decision' | 'detach';
  outcome: 'applied' | 'noop';
  eventId: string | null;
  response: unknown;
}

interface EventRow {
  seq: number;
  id: string;
  request_id: string;
  schema_version: number;
  type: string;
  occurred_at: string;
  recording_id: string;
  game_id: string;
  proposal_id: string;
  run_id: string;
  moment_id_at_decision: string;
  previous_status: string;
  new_status: string;
  reasons_json: string;
  comment: string | null;
  reevaluates_event_id: string | null;
  snapshot_json: string;
  source: string;
}

const toEvent = (r: EventRow): FeedbackEvent => ({
  seq: r.seq,
  id: r.id,
  requestId: r.request_id,
  schemaVersion: r.schema_version as typeof FEEDBACK_SCHEMA_VERSION,
  type: r.type as FeedbackEventType,
  occurredAt: r.occurred_at,
  recordingId: r.recording_id,
  gameId: r.game_id,
  proposalId: r.proposal_id,
  runId: r.run_id,
  momentIdAtDecision: r.moment_id_at_decision,
  previousStatus: r.previous_status as ReviewStatus,
  newStatus: r.new_status as ReviewStatus,
  reasons: JSON.parse(r.reasons_json) as RejectReason[],
  comment: r.comment,
  reevaluatesEventId: r.reevaluates_event_id,
  snapshot: JSON.parse(r.snapshot_json) as ProposalSnapshot,
  source: r.source as Source,
});

interface ReviewRow {
  proposal_id: string;
  status: string;
  reasons_json: string;
  comment: string | null;
  decided_at: string | null;
  last_event_id: string;
  last_event_seq: number;
  version: number;
  updated_at: string;
}

const toReview = (r: ReviewRow): ReviewDto => ({
  proposalId: r.proposal_id,
  status: r.status as ReviewStatus,
  reasons: JSON.parse(r.reasons_json) as RejectReason[],
  comment: r.comment,
  decidedAt: r.decided_at,
  lastEventId: r.last_event_id,
  lastEventSeq: r.last_event_seq,
  version: r.version,
  updatedAt: r.updated_at,
});

export interface NewEvent {
  id: string;
  requestId: string;
  type: FeedbackEventType;
  recordingId: string;
  gameId: string;
  proposalId: string;
  runId: string;
  momentId: string;
  previousStatus: ReviewStatus;
  next: DecisionState;
  reevaluatesEventId: string | null;
  snapshot: ProposalSnapshot;
  source: Source;
}

export class ReviewRepository {
  constructor(private readonly db: Db) {}

  /* ------------------------------- Moments ------------------------------- */

  momentsOfRecording(recordingId: string): ExistingMoment[] {
    const rows = this.db
      .prepare(
        `SELECT id, ref_punchline_segment_id, ref_punchline_ms, ref_src_start_ms, ref_src_end_ms
         FROM review_moments WHERE recording_id = ? ORDER BY created_at, rowid`,
      )
      .all(recordingId) as {
      id: string;
      ref_punchline_segment_id: number;
      ref_punchline_ms: number;
      ref_src_start_ms: number;
      ref_src_end_ms: number;
    }[];
    return rows.map((r, i) => ({
      id: r.id,
      order: i,
      ref: {
        punchlineSegmentId: r.ref_punchline_segment_id,
        punchlineMs: r.ref_punchline_ms,
        srcStartMs: r.ref_src_start_ms,
        srcEndMs: r.ref_src_end_ms,
      },
    }));
  }

  insertMoment(m: {
    id: string;
    recordingId: string;
    ruleVersion: number;
    refProposalId: string;
    ref: MomentRef;
  }) {
    this.db
      .prepare(
        `INSERT INTO review_moments (id, recording_id, rule_version, ref_proposal_id,
           ref_punchline_segment_id, ref_punchline_ms, ref_src_start_ms, ref_src_end_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW})`,
      )
      .run(
        m.id,
        m.recordingId,
        m.ruleVersion,
        m.refProposalId,
        m.ref.punchlineSegmentId,
        m.ref.punchlineMs,
        m.ref.srcStartMs,
        m.ref.srcEndMs,
      );
  }

  /** Insertion seulement : une appartenance existante n'est jamais modifiée. */
  insertMember(m: Omit<MembershipDto, 'linkedAt'>) {
    this.db
      .prepare(
        `INSERT INTO moment_members (proposal_id, moment_id, match_kind, score, rule_version, linked_at)
         VALUES (?, ?, ?, ?, ?, ${NOW})`,
      )
      .run(m.proposalId, m.momentId, m.matchKind, m.score, m.ruleVersion);
  }

  deleteMember(proposalId: string) {
    this.db.prepare('DELETE FROM moment_members WHERE proposal_id = ?').run(proposalId);
  }

  membership(proposalId: string): MembershipDto | null {
    const r = this.db
      .prepare('SELECT * FROM moment_members WHERE proposal_id = ?')
      .get(proposalId) as Record<string, unknown> | undefined;
    return r ? toMembership(r) : null;
  }

  members(momentId: string): MembershipDto[] {
    return (
      this.db
        .prepare('SELECT * FROM moment_members WHERE moment_id = ? ORDER BY linked_at, rowid')
        .all(momentId) as Record<string, unknown>[]
    ).map(toMembership);
  }

  membershipsOfRecording(recordingId: string): MembershipDto[] {
    return (
      this.db
        .prepare(
          `SELECT mm.* FROM moment_members mm JOIN review_moments m ON m.id = mm.moment_id
           WHERE m.recording_id = ? ORDER BY mm.linked_at, mm.rowid`,
        )
        .all(recordingId) as Record<string, unknown>[]
    ).map(toMembership);
  }

  allMemberships(): MembershipDto[] {
    return (
      this.db.prepare('SELECT * FROM moment_members ORDER BY linked_at, rowid').all() as Record<
        string,
        unknown
      >[]
    ).map(toMembership);
  }

  insertMomentChange(c: {
    id: string;
    requestId: string;
    proposalId: string;
    fromMomentId: string;
    toMomentId: string;
    comment: string | null;
    source: Source;
  }) {
    this.db
      .prepare(
        `INSERT INTO moment_changes (id, request_id, kind, proposal_id, from_moment_id, to_moment_id,
           comment, source, occurred_at) VALUES (?, ?, 'detach', ?, ?, ?, ?, ?, ${NOW})`,
      )
      .run(c.id, c.requestId, c.proposalId, c.fromMomentId, c.toMomentId, c.comment, c.source);
  }

  momentChanges(): {
    seq: number;
    id: string;
    proposalId: string;
    fromMomentId: string;
    toMomentId: string;
    comment: string | null;
    source: string;
    occurredAt: string;
  }[] {
    return (
      this.db.prepare('SELECT * FROM moment_changes ORDER BY seq').all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      seq: r['seq'] as number,
      id: r['id'] as string,
      proposalId: r['proposal_id'] as string,
      fromMomentId: r['from_moment_id'] as string,
      toMomentId: r['to_moment_id'] as string,
      comment: r['comment'] as string | null,
      source: r['source'] as string,
      occurredAt: r['occurred_at'] as string,
    }));
  }

  /* ------------------------------ Décisions ------------------------------ */

  review(proposalId: string): ReviewDto | null {
    const r = this.db
      .prepare('SELECT * FROM proposal_reviews WHERE proposal_id = ?')
      .get(proposalId) as ReviewRow | undefined;
    return r ? toReview(r) : null;
  }

  /**
   * Décision effective d'un moment : celle de son membre dont le dernier événement est le plus
   * récent. Si c'est une réinitialisation, le moment est « à examiner » (jamais de retour à une
   * décision plus ancienne). Équivaut à effectiveDecisions(journal, appartenances).
   */
  effectiveForMoment(momentId: string): EffectiveDecision & { lastEventSeq: number | null } {
    const r = this.db
      .prepare(
        `SELECT pr.* FROM proposal_reviews pr JOIN moment_members mm ON mm.proposal_id = pr.proposal_id
         WHERE mm.moment_id = ? ORDER BY pr.last_event_seq DESC LIMIT 1`,
      )
      .get(momentId) as ReviewRow | undefined;
    if (!r)
      return {
        ...PENDING_STATE,
        reasons: [],
        sourceProposalId: null,
        eventId: null,
        lastEventSeq: null,
      };
    const rev = toReview(r);
    return rev.status === 'pending'
      ? {
          ...PENDING_STATE,
          reasons: [],
          sourceProposalId: null,
          eventId: rev.lastEventId,
          lastEventSeq: rev.lastEventSeq,
        }
      : {
          status: rev.status,
          reasons: rev.reasons,
          comment: rev.comment,
          sourceProposalId: rev.proposalId,
          eventId: rev.lastEventId,
          lastEventSeq: rev.lastEventSeq,
        };
  }

  /** Écrit l'événement puis met à jour la décision propre de la proposition (même transaction). */
  applyDecision(e: NewEvent): { event: FeedbackEvent; review: ReviewDto } {
    return this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO feedback_events (id, request_id, schema_version, type, occurred_at, recording_id,
             game_id, proposal_id, run_id, moment_id_at_decision, previous_status, new_status,
             reasons_json, comment, reevaluates_event_id, snapshot_json, source)
           VALUES (@id, @requestId, @schemaVersion, @type, ${NOW}, @recordingId, @gameId, @proposalId,
             @runId, @momentId, @previousStatus, @newStatus, @reasons, @comment, @reevaluatesEventId,
             @snapshot, @source)`,
        )
        .run({
          id: e.id,
          requestId: e.requestId,
          schemaVersion: FEEDBACK_SCHEMA_VERSION,
          type: e.type,
          recordingId: e.recordingId,
          gameId: e.gameId,
          proposalId: e.proposalId,
          runId: e.runId,
          momentId: e.momentId,
          previousStatus: e.previousStatus,
          newStatus: e.next.status,
          reasons: JSON.stringify(e.next.reasons),
          comment: e.next.comment,
          reevaluatesEventId: e.reevaluatesEventId,
          snapshot: JSON.stringify(e.snapshot),
          source: e.source,
        });
      const seq = Number(info.lastInsertRowid);
      const event = this.event(e.id)!;
      const decided = e.next.status !== 'pending';
      this.db
        .prepare(
          `INSERT INTO proposal_reviews (proposal_id, status, reasons_json, comment, decided_at,
             last_event_id, last_event_seq, version, updated_at)
           VALUES (@proposalId, @status, @reasons, @comment, @decidedAt, @eventId, @seq, 1, ${NOW})
           ON CONFLICT(proposal_id) DO UPDATE SET status = excluded.status,
             reasons_json = excluded.reasons_json, comment = excluded.comment,
             decided_at = excluded.decided_at, last_event_id = excluded.last_event_id,
             last_event_seq = excluded.last_event_seq, version = proposal_reviews.version + 1,
             updated_at = excluded.updated_at`,
        )
        .run({
          proposalId: e.proposalId,
          status: e.next.status,
          reasons: JSON.stringify(e.next.reasons),
          comment: decided ? e.next.comment : null,
          decidedAt: decided ? event.occurredAt : null,
          eventId: e.id,
          seq,
        });
      return { event, review: this.review(e.proposalId)! };
    })();
  }

  /* ------------------------------- Journal ------------------------------- */

  event(id: string): FeedbackEvent | null {
    const r = this.db.prepare('SELECT * FROM feedback_events WHERE id = ?').get(id) as
      EventRow | undefined;
    return r ? toEvent(r) : null;
  }

  eventsOfProposals(proposalIds: readonly string[]): FeedbackEvent[] {
    if (!proposalIds.length) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM feedback_events WHERE proposal_id IN (${proposalIds.map(() => '?').join(',')})
           ORDER BY seq`,
        )
        .all(...proposalIds) as EventRow[]
    ).map(toEvent);
  }

  events(f: {
    recordingId?: string;
    gameId?: string;
    proposalIds?: readonly string[];
    type?: string;
    afterSeq?: number;
    limit: number;
  }): FeedbackEvent[] {
    const where: string[] = ['seq > @afterSeq'];
    if (f.recordingId) where.push('recording_id = @recordingId');
    if (f.gameId) where.push('game_id = @gameId');
    if (f.type) where.push('type = @type');
    if (f.proposalIds) {
      if (!f.proposalIds.length) return [];
      where.push(`proposal_id IN (${f.proposalIds.map((_, i) => `@p${i}`).join(',')})`);
    }
    const params: Record<string, unknown> = {
      afterSeq: f.afterSeq ?? 0,
      recordingId: f.recordingId,
      gameId: f.gameId,
      type: f.type,
      limit: f.limit,
    };
    f.proposalIds?.forEach((id, i) => (params[`p${i}`] = id));
    return (
      this.db
        .prepare(
          `SELECT * FROM feedback_events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT @limit`,
        )
        .all(params) as EventRow[]
    ).map(toEvent);
  }

  decisionEvents(): DecisionEvent[] {
    return (
      this.db
        .prepare(
          'SELECT id, seq, proposal_id, type, reasons_json, comment FROM feedback_events ORDER BY seq',
        )
        .all() as Pick<
        EventRow,
        'id' | 'seq' | 'proposal_id' | 'type' | 'reasons_json' | 'comment'
      >[]
    ).map((r) => ({
      id: r.id,
      seq: r.seq,
      proposalId: r.proposal_id,
      type: r.type as FeedbackEventType,
      reasons: JSON.parse(r.reasons_json) as RejectReason[],
      comment: r.comment,
    }));
  }

  /* --------------------------- Demandes (idempotence) --------------------------- */

  findRequest(requestId: string): StoredRequest | null {
    const r = this.db
      .prepare('SELECT * FROM review_requests WHERE request_id = ?')
      .get(requestId) as Record<string, unknown> | undefined;
    return r
      ? {
          requestId: r['request_id'] as string,
          requestHash: r['request_hash'] as string,
          proposalId: r['proposal_id'] as string,
          action: r['action'] as StoredRequest['action'],
          outcome: r['outcome'] as StoredRequest['outcome'],
          eventId: r['event_id'] as string | null,
          response: JSON.parse(r['response_json'] as string) as unknown,
        }
      : null;
  }

  insertRequest(q: StoredRequest) {
    this.db
      .prepare(
        `INSERT INTO review_requests (request_id, request_hash, proposal_id, action, outcome, event_id,
           response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW})`,
      )
      .run(
        q.requestId,
        q.requestHash,
        q.proposalId,
        q.action,
        q.outcome,
        q.eventId,
        JSON.stringify(q.response),
      );
  }
}

function toMembership(r: Record<string, unknown>): MembershipDto {
  return {
    proposalId: r['proposal_id'] as string,
    momentId: r['moment_id'] as string,
    matchKind: r['match_kind'] as MembershipDto['matchKind'],
    score: r['score'] as number,
    ruleVersion: r['rule_version'] as number,
    linkedAt: r['linked_at'] as string,
  };
}
