import type { Db } from '../db';
import { NOW } from '../recordings/repository';
import type { DerivativeKind } from './cache-key';

export interface DerivativeDto {
  id: string;
  cacheKey: string;
  recordingId: string;
  sourceFingerprint: string;
  kind: DerivativeKind;
  audioIndex: number | null;
  /** Plage source couverte (SourceMs) ; null = tout l'enregistrement. */
  srcStartMs: number | null;
  srcEndMs: number | null;
  params: Record<string, unknown>;
  generatorVersion: number;
  inputDerivativeId: string | null;
  relPath: string;
  sizeBytes: number;
  durationMs: number | null;
  retention: 'cache' | 'keep';
  createdAt: string;
  lastUsedAt: string;
}

interface Row {
  id: string;
  cache_key: string;
  recording_id: string;
  source_fingerprint: string;
  kind: string;
  audio_index: number | null;
  src_start_ms: number | null;
  src_end_ms: number | null;
  params_json: string;
  generator_version: number;
  input_derivative_id: string | null;
  rel_path: string;
  size_bytes: number;
  duration_ms: number | null;
  retention: string;
  created_at: string;
  last_used_at: string;
}

const toDto = (r: Row): DerivativeDto => ({
  id: r.id,
  cacheKey: r.cache_key,
  recordingId: r.recording_id,
  sourceFingerprint: r.source_fingerprint,
  kind: r.kind as DerivativeKind,
  audioIndex: r.audio_index,
  srcStartMs: r.src_start_ms,
  srcEndMs: r.src_end_ms,
  params: JSON.parse(r.params_json) as Record<string, unknown>,
  generatorVersion: r.generator_version,
  inputDerivativeId: r.input_derivative_id,
  relPath: r.rel_path,
  sizeBytes: r.size_bytes,
  durationMs: r.duration_ms,
  retention: r.retention as 'cache' | 'keep',
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export interface NewDerivative {
  id: string;
  cacheKey: string;
  recordingId: string;
  sourceFingerprint: string;
  kind: DerivativeKind;
  audioIndex: number | null;
  range: { startMs: number; endMs: number } | null;
  paramsJson: string;
  generatorVersion: number;
  inputDerivativeId: string | null;
  relPath: string;
  sizeBytes: number;
  durationMs: number | null;
}

export interface CoveringQuery {
  recordingId: string;
  sourceFingerprint: string;
  kind: DerivativeKind;
  audioIndex: number | null;
  paramsJson: string;
  generatorVersion: number;
  range: { startMs: number; endMs: number } | null;
}

export class DerivativeRepository {
  constructor(private readonly db: Db) {}

  get(id: string): DerivativeDto | null {
    const r = this.db.prepare('SELECT * FROM media_derivatives WHERE id = ?').get(id) as
      Row | undefined;
    return r ? toDto(r) : null;
  }

  findByKey(cacheKey: string): DerivativeDto | null {
    const r = this.db
      .prepare('SELECT * FROM media_derivatives WHERE cache_key = ?')
      .get(cacheKey) as Row | undefined;
    return r ? toDto(r) : null;
  }

  /**
   * Dérivé réutilisable : même original, usage, piste, paramètres et version,
   * dont la plage CONTIENT la plage demandée (le plus petit d'abord).
   * Un dérivé « tout l'enregistrement » couvre toute plage.
   */
  findCovering(q: CoveringQuery): DerivativeDto[] {
    const base = `SELECT * FROM media_derivatives WHERE recording_id = ? AND source_fingerprint = ? AND kind = ?
      AND audio_index IS ? AND params_json = ? AND generator_version = ?`;
    const args = [
      q.recordingId,
      q.sourceFingerprint,
      q.kind,
      q.audioIndex,
      q.paramsJson,
      q.generatorVersion,
    ];
    const rows = q.range
      ? (this.db
          .prepare(
            `${base} AND (src_start_ms IS NULL OR (src_start_ms <= ? AND src_end_ms >= ?))
             ORDER BY src_start_ms IS NULL, (src_end_ms - src_start_ms)`,
          )
          .all(...args, q.range.startMs, q.range.endMs) as Row[])
      : (this.db.prepare(`${base} AND src_start_ms IS NULL`).all(...args) as Row[]);
    return rows.map(toDto);
  }

  /** Enregistre un dérivé dont le fichier final est écrit (remplace une ligne obsolète de même clé). */
  upsert(d: NewDerivative): DerivativeDto {
    this.db
      .prepare(
        `INSERT INTO media_derivatives (id, cache_key, recording_id, source_fingerprint, kind, audio_index,
           src_start_ms, src_end_ms, params_json, generator_version, input_derivative_id, rel_path,
           size_bytes, duration_ms)
         VALUES (@id, @cacheKey, @recordingId, @sourceFingerprint, @kind, @audioIndex, @start, @end,
           @paramsJson, @generatorVersion, @inputDerivativeId, @relPath, @sizeBytes, @durationMs)
         ON CONFLICT(cache_key) DO UPDATE SET rel_path = excluded.rel_path, size_bytes = excluded.size_bytes,
           duration_ms = excluded.duration_ms, input_derivative_id = excluded.input_derivative_id,
           last_used_at = ${NOW}`,
      )
      .run({ ...d, start: d.range?.startMs ?? null, end: d.range?.endMs ?? null });
    return this.findByKey(d.cacheKey)!;
  }

  touch(id: string): void {
    this.db.prepare(`UPDATE media_derivatives SET last_used_at = ${NOW} WHERE id = ?`).run(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM media_derivatives WHERE id = ?').run(id);
  }

  setRetention(id: string, retention: 'cache' | 'keep'): void {
    this.db.prepare('UPDATE media_derivatives SET retention = ? WHERE id = ?').run(retention, id);
  }

  listForRecording(recordingId: string): DerivativeDto[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM media_derivatives WHERE recording_id = ? ORDER BY kind, audio_index, src_start_ms',
        )
        .all(recordingId) as Row[]
    ).map(toDto);
  }

  /** Tous les dérivés, du moins récemment utilisé au plus récent (pour l'éviction LRU). */
  listByLeastRecentlyUsed(): DerivativeDto[] {
    return (
      this.db
        .prepare('SELECT * FROM media_derivatives ORDER BY last_used_at, created_at')
        .all() as Row[]
    ).map(toDto);
  }
}
