/**
 * Persistance des projets de clip (migration 7) : projets, révisions immuables, manifestes
 * d'intégrité. Aucune décision de revue n'est stockée ici.
 */
import type { IntegrityManifest } from '@acs/media';
import type { Db } from '../db';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export type RevisionSource = 'ui' | 'cli' | 'api' | 'system';

export interface ProjectRow {
  id: string;
  proposalId: string;
  recordingId: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionRow {
  projectId: string;
  revision: number;
  schemaVersion: number;
  document: unknown;
  documentHash: string;
  changeSummary: string | null;
  requestId: string;
  source: RevisionSource;
  createdAt: string;
}

export interface StoredManifest extends IntegrityManifest {
  id: string;
  recordingId: string;
  createdAt: string;
}

const project = (r: Record<string, unknown>): ProjectRow => ({
  id: r.id as string,
  proposalId: r.proposal_id as string,
  recordingId: r.recording_id as string,
  currentRevision: r.current_revision as number,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const revision = (r: Record<string, unknown>): RevisionRow => ({
  projectId: r.project_id as string,
  revision: r.revision as number,
  schemaVersion: r.schema_version as number,
  document: JSON.parse(r.document_json as string) as unknown,
  documentHash: r.document_hash as string,
  changeSummary: (r.change_summary as string | null) ?? null,
  requestId: r.request_id as string,
  source: r.source as RevisionSource,
  createdAt: r.created_at as string,
});

export class ClipRepository {
  constructor(private readonly db: Db) {}

  getProject(id: string): ProjectRow | null {
    const r = this.db.prepare('SELECT * FROM clip_projects WHERE id = ?').get(id);
    return r ? project(r as Record<string, unknown>) : null;
  }

  projectForProposal(proposalId: string): ProjectRow | null {
    const r = this.db.prepare('SELECT * FROM clip_projects WHERE proposal_id = ?').get(proposalId);
    return r ? project(r as Record<string, unknown>) : null;
  }

  projectsOfRecording(recordingId: string): ProjectRow[] {
    return (
      this.db
        .prepare('SELECT * FROM clip_projects WHERE recording_id = ? ORDER BY created_at, id')
        .all(recordingId) as Record<string, unknown>[]
    ).map(project);
  }

  revision(projectId: string, rev: number): RevisionRow | null {
    const r = this.db
      .prepare('SELECT * FROM clip_project_revisions WHERE project_id = ? AND revision = ?')
      .get(projectId, rev);
    return r ? revision(r as Record<string, unknown>) : null;
  }

  revisionByRequest(projectId: string, requestId: string): RevisionRow | null {
    const r = this.db
      .prepare('SELECT * FROM clip_project_revisions WHERE project_id = ? AND request_id = ?')
      .get(projectId, requestId);
    return r ? revision(r as Record<string, unknown>) : null;
  }

  revisions(projectId: string): RevisionRow[] {
    return (
      this.db
        .prepare('SELECT * FROM clip_project_revisions WHERE project_id = ? ORDER BY revision')
        .all(projectId) as Record<string, unknown>[]
    ).map(revision);
  }

  insertProject(p: { id: string; proposalId: string; recordingId: string }) {
    this.db
      .prepare(
        `INSERT INTO clip_projects (id, proposal_id, recording_id, current_revision) VALUES (?, ?, ?, 1)`,
      )
      .run(p.id, p.proposalId, p.recordingId);
  }

  insertRevision(r: Omit<RevisionRow, 'createdAt' | 'document'> & { documentJson: string }) {
    this.db
      .prepare(
        `INSERT INTO clip_project_revisions (project_id, revision, schema_version, document_json,
           document_hash, change_summary, request_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.projectId,
        r.revision,
        r.schemaVersion,
        r.documentJson,
        r.documentHash,
        r.changeSummary,
        r.requestId,
        r.source,
      );
  }

  setCurrentRevision(projectId: string, rev: number) {
    this.db
      .prepare(
        `UPDATE clip_projects SET current_revision = ?, updated_at = ${NOW} WHERE id = ? AND current_revision = ?`,
      )
      .run(rev, projectId, rev - 1);
  }

  insertManifest(id: string, recordingId: string, m: IntegrityManifest) {
    this.db
      .prepare(
        `INSERT INTO source_integrity_manifests (id, recording_id, method, container, file_size,
           window_start_ms, window_end_ms, probe_bytes, ranges_json, protected_bytes, sha256, algo_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        recordingId,
        m.method,
        m.container,
        m.fileSize,
        m.windowStartMs,
        m.windowEndMs,
        m.probeBytes,
        JSON.stringify(m.ranges),
        m.protectedBytes,
        m.sha256,
        m.algoVersion,
      );
  }

  manifest(id: string): StoredManifest | null {
    const r = this.db.prepare('SELECT * FROM source_integrity_manifests WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      recordingId: r.recording_id as string,
      method: r.method as IntegrityManifest['method'],
      container: r.container as string,
      fileSize: r.file_size as number,
      windowStartMs: r.window_start_ms as number,
      windowEndMs: r.window_end_ms as number,
      probeBytes: r.probe_bytes as number,
      ranges: JSON.parse(r.ranges_json as string) as IntegrityManifest['ranges'],
      protectedBytes: r.protected_bytes as number,
      sha256: r.sha256 as string,
      algoVersion: r.algo_version as number,
      createdAt: r.created_at as string,
    };
  }

  segmentBounds(segmentId: number): { srcStartMs: number; srcEndMs: number } | null {
    const r = this.db
      .prepare('SELECT src_start_ms, src_end_ms FROM transcript_segments WHERE id = ?')
      .get(segmentId) as { src_start_ms: number; src_end_ms: number } | undefined;
    return r ? { srcStartMs: r.src_start_ms, srcEndMs: r.src_end_ms } : null;
  }
}
