/**
 * Profils de style (étape 10) : profils, versions (immuables), validations (ajout seul),
 * références (fichiers seulement référencés) et applications aux projets.
 */
import type Database from 'better-sqlite3';
import type { StyleFeatures } from '@acs/style';

export type StyleTargetType = 'gaming' | 'just_chatting' | 'reaction' | 'podcast' | 'irl' | 'mixed';

export interface StyleProfileRow {
  id: string;
  name: string;
  contentTypes: StyleTargetType[];
  builtin: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StyleVersionRow {
  profileId: string;
  version: number;
  features: StyleFeatures;
  featuresHash: string;
  origin: 'learned' | 'manual';
  basedOnVersion: number | null;
  evidence: Record<string, unknown>;
  requestId: string;
  createdAt: string;
}

export interface StyleValidationRow {
  id: number;
  profileId: string;
  version: number;
  featuresHash: string;
  requestId: string;
  createdAt: string;
}

export interface StyleReferenceRow {
  id: string;
  kind: 'edited' | 'pair';
  label: string;
  sourcePath: string;
  fileName: string;
  fingerprint: string;
  rawPath: string | null;
  rawFileName: string | null;
  rawFingerprint: string | null;
  contentType: StyleTargetType | null;
  profileId: string | null;
  status: 'pending' | 'analyzing' | 'analyzed' | 'failed';
  analyzerVersion: string | null;
  analysis: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const toProfile = (r: any): StyleProfileRow => ({
  id: r.id,
  name: r.name,
  contentTypes: JSON.parse(r.content_types_json),
  builtin: r.builtin === 1,
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toVersion = (r: any): StyleVersionRow => ({
  profileId: r.profile_id,
  version: r.version,
  features: JSON.parse(r.features_json),
  featuresHash: r.features_hash,
  origin: r.origin,
  basedOnVersion: r.based_on_version,
  evidence: JSON.parse(r.evidence_json),
  requestId: r.request_id,
  createdAt: r.created_at,
});
const toValidation = (r: any): StyleValidationRow => ({
  id: r.id,
  profileId: r.profile_id,
  version: r.version,
  featuresHash: r.features_hash,
  requestId: r.request_id,
  createdAt: r.created_at,
});
const toReference = (r: any): StyleReferenceRow => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  sourcePath: r.source_path,
  fileName: r.file_name,
  fingerprint: r.fingerprint,
  rawPath: r.raw_path,
  rawFileName: r.raw_file_name,
  rawFingerprint: r.raw_fingerprint,
  contentType: r.content_type,
  profileId: r.profile_id,
  status: r.status,
  analyzerVersion: r.analyzer_version,
  analysis: r.analysis_json ? JSON.parse(r.analysis_json) : null,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export class StyleRepository {
  constructor(private readonly db: Database.Database) {}

  /* Profils */

  listProfiles(): StyleProfileRow[] {
    return this.db
      .prepare(
        `SELECT * FROM style_profiles ORDER BY builtin DESC,
           CASE id WHEN 'gaming' THEN 1 WHEN 'just_chatting' THEN 2 WHEN 'reaction' THEN 3
                   WHEN 'podcast' THEN 4 WHEN 'irl' THEN 5 WHEN 'mixed' THEN 6 ELSE 7 END,
           created_at, id`,
      )
      .all()
      .map(toProfile);
  }
  profile(id: string): StyleProfileRow | null {
    const r = this.db.prepare('SELECT * FROM style_profiles WHERE id = ?').get(id);
    return r ? toProfile(r) : null;
  }
  insertProfile(p: { id: string; name: string; contentTypes: StyleTargetType[] }) {
    this.db
      .prepare('INSERT INTO style_profiles (id, name, content_types_json) VALUES (?, ?, ?)')
      .run(p.id, p.name, JSON.stringify(p.contentTypes));
  }
  updateProfile(
    id: string,
    p: { name: string; contentTypes: StyleTargetType[]; archived: boolean },
  ) {
    this.db
      .prepare(
        `UPDATE style_profiles SET name = ?, content_types_json = ?, archived = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(p.name, JSON.stringify(p.contentTypes), p.archived ? 1 : 0, id);
  }

  /* Versions et validations */

  versions(profileId: string): StyleVersionRow[] {
    return this.db
      .prepare('SELECT * FROM style_profile_versions WHERE profile_id = ? ORDER BY version')
      .all(profileId)
      .map(toVersion);
  }
  version(profileId: string, version: number): StyleVersionRow | null {
    const r = this.db
      .prepare('SELECT * FROM style_profile_versions WHERE profile_id = ? AND version = ?')
      .get(profileId, version);
    return r ? toVersion(r) : null;
  }
  latestVersion(profileId: string): StyleVersionRow | null {
    const r = this.db
      .prepare(
        'SELECT * FROM style_profile_versions WHERE profile_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(profileId);
    return r ? toVersion(r) : null;
  }
  versionByRequest(requestId: string): StyleVersionRow | null {
    const r = this.db
      .prepare('SELECT * FROM style_profile_versions WHERE request_id = ?')
      .get(requestId);
    return r ? toVersion(r) : null;
  }
  insertVersion(v: Omit<StyleVersionRow, 'createdAt'>) {
    this.db
      .prepare(
        `INSERT INTO style_profile_versions
           (profile_id, version, features_json, features_hash, origin, based_on_version, evidence_json, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.profileId,
        v.version,
        JSON.stringify(v.features),
        v.featuresHash,
        v.origin,
        v.basedOnVersion,
        JSON.stringify(v.evidence),
        v.requestId,
      );
  }
  latestValidation(profileId: string): StyleValidationRow | null {
    const r = this.db
      .prepare(
        'SELECT * FROM style_profile_validations WHERE profile_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(profileId);
    return r ? toValidation(r) : null;
  }
  validations(profileId: string): StyleValidationRow[] {
    return this.db
      .prepare('SELECT * FROM style_profile_validations WHERE profile_id = ? ORDER BY id')
      .all(profileId)
      .map(toValidation);
  }
  validationByRequest(requestId: string): StyleValidationRow | null {
    const r = this.db
      .prepare('SELECT * FROM style_profile_validations WHERE request_id = ?')
      .get(requestId);
    return r ? toValidation(r) : null;
  }
  insertValidation(v: {
    profileId: string;
    version: number;
    featuresHash: string;
    requestId: string;
  }) {
    this.db
      .prepare(
        'INSERT INTO style_profile_validations (profile_id, version, features_hash, request_id) VALUES (?, ?, ?, ?)',
      )
      .run(v.profileId, v.version, v.featuresHash, v.requestId);
  }

  /* Références */

  listReferences(): StyleReferenceRow[] {
    return this.db
      .prepare('SELECT * FROM style_references ORDER BY created_at DESC, id')
      .all()
      .map(toReference);
  }
  reference(id: string): StyleReferenceRow | null {
    const r = this.db.prepare('SELECT * FROM style_references WHERE id = ?').get(id);
    return r ? toReference(r) : null;
  }
  referenceByFiles(fingerprint: string, rawFingerprint: string | null): StyleReferenceRow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM style_references WHERE fingerprint = ? AND IFNULL(raw_fingerprint, '') = ?",
      )
      .get(fingerprint, rawFingerprint ?? '');
    return r ? toReference(r) : null;
  }
  referencesForProfile(profileId: string): StyleReferenceRow[] {
    return this.db
      .prepare(
        "SELECT * FROM style_references WHERE profile_id = ? AND status = 'analyzed' ORDER BY created_at, id",
      )
      .all(profileId)
      .map(toReference);
  }
  insertReference(
    r: Pick<
      StyleReferenceRow,
      | 'id'
      | 'kind'
      | 'label'
      | 'sourcePath'
      | 'fileName'
      | 'fingerprint'
      | 'rawPath'
      | 'rawFileName'
      | 'rawFingerprint'
      | 'contentType'
      | 'profileId'
    >,
  ) {
    this.db
      .prepare(
        `INSERT INTO style_references
           (id, kind, label, source_path, file_name, fingerprint, raw_path, raw_file_name, raw_fingerprint, content_type, profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.kind,
        r.label,
        r.sourcePath,
        r.fileName,
        r.fingerprint,
        r.rawPath,
        r.rawFileName,
        r.rawFingerprint,
        r.contentType,
        r.profileId,
      );
  }
  updateReference(
    id: string,
    p: { label: string; profileId: string | null; contentType: StyleTargetType | null },
  ) {
    this.db
      .prepare(
        `UPDATE style_references SET label = ?, profile_id = ?, content_type = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(p.label, p.profileId, p.contentType, id);
  }
  setReferenceStatus(
    id: string,
    s:
      | { status: 'analyzing' | 'pending' }
      | { status: 'analyzed'; analyzerVersion: string; analysis: Record<string, unknown> }
      | { status: 'failed'; code: string; message: string },
  ) {
    if (s.status === 'analyzed') {
      this.db
        .prepare(
          `UPDATE style_references SET status = 'analyzed', analyzer_version = ?, analysis_json = ?,
             error_code = NULL, error_message = NULL, updated_at = ${NOW} WHERE id = ?`,
        )
        .run(s.analyzerVersion, JSON.stringify(s.analysis), id);
    } else if (s.status === 'failed') {
      this.db
        .prepare(
          `UPDATE style_references SET status = 'failed', error_code = ?, error_message = ?, updated_at = ${NOW} WHERE id = ?`,
        )
        .run(s.code, s.message.slice(0, 500), id);
    } else {
      this.db
        .prepare(`UPDATE style_references SET status = ?, updated_at = ${NOW} WHERE id = ?`)
        .run(s.status, id);
    }
  }
  deleteReference(id: string) {
    this.db.prepare('DELETE FROM style_references WHERE id = ?').run(id);
  }
  /** Analyses « en cours » interrompues (redémarrage) : à relancer. */
  recoverStale(): number {
    return this.db
      .prepare(
        `UPDATE style_references SET status = 'pending', updated_at = ${NOW} WHERE status = 'analyzing'`,
      )
      .run().changes;
  }

  /* Applications */

  insertApplication(a: {
    projectId: string;
    profileId: string;
    version: number;
    contentType: string;
    applied: Record<string, unknown>;
  }) {
    this.db
      .prepare(
        'INSERT INTO style_applications (project_id, profile_id, version, content_type, applied_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(a.projectId, a.profileId, a.version, a.contentType, JSON.stringify(a.applied));
  }
  application(projectId: string) {
    const r = this.db
      .prepare('SELECT * FROM style_applications WHERE project_id = ?')
      .get(projectId) as
      | {
          profile_id: string;
          version: number;
          content_type: string;
          applied_json: string;
          created_at: string;
        }
      | undefined;
    return r
      ? {
          profileId: r.profile_id,
          version: r.version,
          contentType: r.content_type,
          applied: JSON.parse(r.applied_json) as Record<string, unknown>,
          createdAt: r.created_at,
        }
      : null;
  }
  applicationCount(profileId: string): number {
    return (
      this.db
        .prepare('SELECT count(*) AS n FROM style_applications WHERE profile_id = ?')
        .get(profileId) as {
        n: number;
      }
    ).n;
  }
  /** Projets modifiés par le créateur (au moins une entrée au journal d'édition). */
  editedProjects(): { projectId: string; recordingId: string; proposalId: string }[] {
    return this.db
      .prepare(
        `SELECT p.id AS projectId, p.recording_id AS recordingId, p.proposal_id AS proposalId
           FROM clip_projects p JOIN clip_project_heads h ON h.project_id = p.id
          WHERE h.head_seq > 1 ORDER BY p.created_at, p.id`,
      )
      .all() as { projectId: string; recordingId: string; proposalId: string }[];
  }
}
