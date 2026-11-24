/** Moments repérés et propositions de clips, côté base. */
import type { Db } from '../db';
import { NOW } from '../recordings/repository';

export interface TriageMomentRow {
  id: string;
  chunkIndex: number;
  callId: string | null;
  startSegmentId: number;
  endSegmentId: number;
  srcStartMs: number | null;
  srcEndMs: number | null;
  kind: string;
  strength: 'fort' | 'moyen';
  why: string;
  valid: boolean;
  rejectReason: string | null;
}

export interface ProposalEvidence {
  kind: 'quote' | 'frame' | 'signal';
  segmentId: number | null;
  quote: string | null;
  verified: boolean;
  role: string | null;
  srcMs: number | null;
  frameDerivativeId: string | null;
  note: string | null;
}

export interface NewProposal {
  id: string;
  runId: string;
  recordingId: string;
  windowId: string;
  callId: string;
  tier: 'clip' | 'secondary';
  title: string;
  explanation: string;
  categories: string[];
  relevance: number;
  reliability: number;
  reliabilityDetail: unknown;
  flags: string[];
  srcStartMs: number;
  srcEndMs: number;
  setupSegmentId: number;
  punchlineSegmentId: number;
  reactionEndSegmentId: number;
  punchlineMs: number;
  standalone: boolean;
  tracksUsed: string[];
  visual: unknown[];
  editingHint: unknown;
  uncertainty: string | null;
  evidence: ProposalEvidence[];
}

export type ProposalDto = Omit<NewProposal, 'evidence'> & {
  mergedIntoId: string | null;
  reviewStatus: string;
  createdAt: string;
  evidence: ProposalEvidence[];
};

interface ProposalRow {
  id: string;
  run_id: string;
  recording_id: string;
  window_id: string;
  call_id: string;
  tier: string;
  title: string;
  explanation: string;
  categories_json: string;
  relevance: number;
  reliability: number;
  reliability_json: string;
  flags_json: string;
  src_start_ms: number;
  src_end_ms: number;
  setup_segment_id: number;
  punchline_segment_id: number;
  reaction_end_segment_id: number;
  punchline_ms: number;
  standalone: number;
  tracks_used_json: string;
  visual_json: string;
  editing_hint_json: string | null;
  uncertainty: string | null;
  merged_into_id: string | null;
  review_status: string;
  created_at: string;
}

export class ProposalRepository {
  constructor(private readonly db: Db) {}

  /** Remplace les moments repérés d'une tranche (idempotent en cas de reprise). */
  replaceTriageMoments(
    runId: string,
    chunkIndex: number,
    rows: readonly Omit<TriageMomentRow, 'chunkIndex'>[],
  ) {
    const ins = this.db.prepare(
      `INSERT INTO analysis_triage_moments (id, run_id, chunk_index, call_id, start_segment_id, end_segment_id,
         src_start_ms, src_end_ms, kind, strength, why, valid, reject_reason)
       VALUES (@id, @runId, @chunkIndex, @callId, @startSegmentId, @endSegmentId, @srcStartMs, @srcEndMs,
         @kind, @strength, @why, @valid, @rejectReason)`,
    );
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM analysis_triage_moments WHERE run_id = ? AND chunk_index = ?')
        .run(runId, chunkIndex);
      for (const r of rows) ins.run({ ...r, runId, chunkIndex, valid: r.valid ? 1 : 0 });
    })();
  }

  listTriageMoments(runId: string): TriageMomentRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM analysis_triage_moments WHERE run_id = ? ORDER BY chunk_index, src_start_ms',
        )
        .all(runId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r['id'] as string,
      chunkIndex: r['chunk_index'] as number,
      callId: r['call_id'] as string | null,
      startSegmentId: r['start_segment_id'] as number,
      endSegmentId: r['end_segment_id'] as number,
      srcStartMs: r['src_start_ms'] as number | null,
      srcEndMs: r['src_end_ms'] as number | null,
      kind: r['kind'] as string,
      strength: r['strength'] as 'fort' | 'moyen',
      why: r['why'] as string,
      valid: r['valid'] === 1,
      rejectReason: r['reject_reason'] as string | null,
    }));
  }

  /**
   * Résultat d'une fenêtre, en une transaction : propositions, preuves, statut et coût.
   * Une reprise qui retraite la fenêtre remplace ses propositions (jamais de doublon).
   */
  saveWindowResult(
    windowId: string,
    status: 'analyzed' | 'refused' | 'truncated' | 'failed' | 'skipped',
    proposals: readonly NewProposal[],
  ) {
    const insP = this.db.prepare(
      `INSERT INTO clip_proposals (id, run_id, recording_id, window_id, call_id, tier, title, explanation,
         categories_json, relevance, reliability, reliability_json, flags_json, src_start_ms, src_end_ms,
         setup_segment_id, punchline_segment_id, reaction_end_segment_id, punchline_ms, standalone,
         tracks_used_json, visual_json, editing_hint_json, uncertainty)
       VALUES (@id, @runId, @recordingId, @windowId, @callId, @tier, @title, @explanation, @categories,
         @relevance, @reliability, @reliabilityJson, @flags, @srcStartMs, @srcEndMs, @setupSegmentId,
         @punchlineSegmentId, @reactionEndSegmentId, @punchlineMs, @standalone, @tracks, @visual, @hint,
         @uncertainty)`,
    );
    const insE = this.db.prepare(
      `INSERT INTO proposal_evidence (proposal_id, kind, segment_id, quote, verified, role, src_ms,
         frame_derivative_id, note)
       VALUES (@proposalId, @kind, @segmentId, @quote, @verified, @role, @srcMs, @frameDerivativeId, @note)`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM clip_proposals WHERE window_id = ?').run(windowId);
      for (const p of proposals) {
        insP.run({
          ...p,
          categories: JSON.stringify(p.categories),
          reliabilityJson: JSON.stringify(p.reliabilityDetail),
          flags: JSON.stringify(p.flags),
          standalone: p.standalone ? 1 : 0,
          tracks: JSON.stringify(p.tracksUsed),
          visual: JSON.stringify(p.visual),
          hint: p.editingHint === null ? null : JSON.stringify(p.editingHint),
        });
        for (const e of p.evidence)
          insE.run({ ...e, proposalId: p.id, verified: e.verified ? 1 : 0 });
      }
      this.db
        .prepare(
          `UPDATE analysis_windows SET status = ?, updated_at = ${NOW},
             cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_calls WHERE window_id = ?)
           WHERE id = ?`,
        )
        .run(status, windowId, windowId);
    })();
  }

  listProposals(runId: string, opts: { includeMerged?: boolean } = {}): ProposalDto[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM clip_proposals WHERE run_id = ? ${opts.includeMerged ? '' : 'AND merged_into_id IS NULL'}
         ORDER BY tier = 'clip' DESC, relevance DESC, reliability DESC, src_start_ms`,
      )
      .all(runId) as ProposalRow[];
    const ev = this.db.prepare('SELECT * FROM proposal_evidence WHERE proposal_id = ? ORDER BY id');
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      recordingId: r.recording_id,
      windowId: r.window_id,
      callId: r.call_id,
      tier: r.tier as 'clip' | 'secondary',
      title: r.title,
      explanation: r.explanation,
      categories: JSON.parse(r.categories_json) as string[],
      relevance: r.relevance,
      reliability: r.reliability,
      reliabilityDetail: JSON.parse(r.reliability_json) as unknown,
      flags: JSON.parse(r.flags_json) as string[],
      srcStartMs: r.src_start_ms,
      srcEndMs: r.src_end_ms,
      setupSegmentId: r.setup_segment_id,
      punchlineSegmentId: r.punchline_segment_id,
      reactionEndSegmentId: r.reaction_end_segment_id,
      punchlineMs: r.punchline_ms,
      standalone: r.standalone === 1,
      tracksUsed: JSON.parse(r.tracks_used_json) as string[],
      visual: JSON.parse(r.visual_json) as unknown[],
      editingHint: r.editing_hint_json ? (JSON.parse(r.editing_hint_json) as unknown) : null,
      uncertainty: r.uncertainty,
      mergedIntoId: r.merged_into_id,
      reviewStatus: r.review_status,
      createdAt: r.created_at,
      evidence: (ev.all(r.id) as Record<string, unknown>[]).map((e) => ({
        kind: e['kind'] as ProposalEvidence['kind'],
        segmentId: e['segment_id'] as number | null,
        quote: e['quote'] as string | null,
        verified: e['verified'] === 1,
        role: e['role'] as string | null,
        srcMs: e['src_ms'] as number | null,
        frameDerivativeId: e['frame_derivative_id'] as string | null,
        note: e['note'] as string | null,
      })),
    }));
  }

  /** Applique la consolidation (une proposition fusionnée pointe vers celle qui la remplace). */
  applyConsolidation(runId: string, mergedInto: ReadonlyMap<string, string>) {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE clip_proposals SET merged_into_id = NULL WHERE run_id = ?')
        .run(runId);
      const upd = this.db.prepare(
        'UPDATE clip_proposals SET merged_into_id = ? WHERE id = ? AND run_id = ?',
      );
      for (const [id, target] of mergedInto) upd.run(target, id, runId);
    })();
  }
}
