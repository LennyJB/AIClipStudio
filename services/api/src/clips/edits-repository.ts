/**
 * Persistance du journal d'édition (migration 8, docs/plan-etape-7.md §6) : tête de chaque
 * projet, entrées en ajout seul. Les écritures sont faites par `EditService`, dans une
 * transaction `BEGIN IMMEDIATE`.
 */
import type { Db } from '../db';
import type { RevisionSource } from './repository';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export type EditKind = 'do' | 'undo' | 'redo' | 'system';

export interface ProjectHead {
  projectId: string;
  /** Version courante : numéro de la dernière entrée (ou de la révision d'origine). */
  headSeq: number;
  /** Dernier point de contrôle (révision immuable complète). */
  checkpointRevision: number;
}

export interface EditEntry {
  projectId: string;
  seq: number;
  kind: EditKind;
  targetSeq: number | null;
  ops: unknown[];
  inverse: unknown[];
  preconditions: Record<string, string | null>;
  hashAfter: string;
  baseRevision: number;
  baseSeq: number;
  clientId: string | null;
  requestId: string;
  requestHash: string;
  summary: string | null;
  source: RevisionSource;
  createdAt: string;
}

const entry = (r: Record<string, unknown>): EditEntry => ({
  projectId: r.project_id as string,
  seq: r.seq as number,
  kind: r.kind as EditKind,
  targetSeq: (r.target_seq as number | null) ?? null,
  ops: JSON.parse(r.ops_json as string) as unknown[],
  inverse: JSON.parse(r.inverse_json as string) as unknown[],
  preconditions: JSON.parse(r.preconditions_json as string) as Record<string, string | null>,
  hashAfter: r.hash_after as string,
  baseRevision: r.base_revision as number,
  baseSeq: r.base_seq as number,
  clientId: (r.client_id as string | null) ?? null,
  requestId: r.request_id as string,
  requestHash: r.request_hash as string,
  summary: (r.summary as string | null) ?? null,
  source: r.source as RevisionSource,
  createdAt: r.created_at as string,
});

export class EditRepository {
  constructor(private readonly db: Db) {}

  head(projectId: string): ProjectHead | null {
    const r = this.db
      .prepare('SELECT * FROM clip_project_heads WHERE project_id = ?')
      .get(projectId) as Record<string, unknown> | undefined;
    return r
      ? {
          projectId,
          headSeq: r.head_seq as number,
          checkpointRevision: r.checkpoint_revision as number,
        }
      : null;
  }

  insertHead(projectId: string, seq: number) {
    this.db
      .prepare(
        `INSERT INTO clip_project_heads (project_id, head_seq, checkpoint_revision) VALUES (?, ?, ?)`,
      )
      .run(projectId, seq, seq);
  }

  /** Avance la tête de `from` à `to` (refus si elle a bougé entre-temps). */
  advanceHead(projectId: string, from: number, to: number) {
    const r = this.db
      .prepare(
        `UPDATE clip_project_heads SET head_seq = ?, updated_at = ${NOW}
         WHERE project_id = ? AND head_seq = ?`,
      )
      .run(to, projectId, from);
    if (r.changes !== 1) throw new Error('tête du journal modifiée pendant l’écriture');
  }

  setCheckpoint(projectId: string, revision: number) {
    this.db
      .prepare(
        `UPDATE clip_project_heads SET checkpoint_revision = ?, updated_at = ${NOW}
         WHERE project_id = ? AND checkpoint_revision < ?`,
      )
      .run(revision, projectId, revision);
    this.db
      .prepare(
        `UPDATE clip_projects SET current_revision = ?, updated_at = ${NOW}
         WHERE id = ? AND current_revision < ?`,
      )
      .run(revision, projectId, revision);
  }

  insert(e: Omit<EditEntry, 'createdAt'>) {
    this.db
      .prepare(
        `INSERT INTO clip_project_edits (project_id, seq, kind, target_seq, ops_json, inverse_json,
           preconditions_json, hash_after, base_revision, base_seq, client_id, request_id,
           request_hash, summary, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.projectId,
        e.seq,
        e.kind,
        e.targetSeq,
        JSON.stringify(e.ops),
        JSON.stringify(e.inverse),
        JSON.stringify(e.preconditions),
        e.hashAfter,
        e.baseRevision,
        e.baseSeq,
        e.clientId,
        e.requestId,
        e.requestHash,
        e.summary,
        e.source,
      );
  }

  byRequest(projectId: string, requestId: string): EditEntry | null {
    const r = this.db
      .prepare('SELECT * FROM clip_project_edits WHERE project_id = ? AND request_id = ?')
      .get(projectId, requestId) as Record<string, unknown> | undefined;
    return r ? entry(r) : null;
  }

  get(projectId: string, seq: number): EditEntry | null {
    const r = this.db
      .prepare('SELECT * FROM clip_project_edits WHERE project_id = ? AND seq = ?')
      .get(projectId, seq) as Record<string, unknown> | undefined;
    return r ? entry(r) : null;
  }

  /** Entrées de numéro ∈ ]after, upTo], dans l'ordre. */
  range(projectId: string, after: number, upTo = Number.MAX_SAFE_INTEGER): EditEntry[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM clip_project_edits WHERE project_id = ? AND seq > ? AND seq <= ? ORDER BY seq',
        )
        .all(projectId, after, upTo) as Record<string, unknown>[]
    ).map(entry);
  }

  /** Dernier point de contrôle de numéro ≤ `version`. */
  checkpointAtOrBefore(projectId: string, version: number): number | null {
    const r = this.db
      .prepare(
        'SELECT MAX(revision) AS r FROM clip_project_revisions WHERE project_id = ? AND revision <= ?',
      )
      .get(projectId, version) as { r: number | null };
    return r.r;
  }
}
