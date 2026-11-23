import type { JobLane, JobStatus, JobType, TrackRole, TrackRoleSource } from '@acs/shared';
import type { MediaInfo, MediaWarning } from '@acs/media';
import type { Db } from '../db';

/* ---------------------------- Types exposés ---------------------------- */

export interface AudioTrackDto {
  audioIndex: number;
  streamIndex: number;
  role: TrackRole;
  roleSource: TrackRoleSource;
  title: string | null;
  codec: string | null;
  channels: number | null;
  sampleRate: number | null;
  startOffsetSec: number;
}

export interface RecordingDto {
  id: string;
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  container: MediaInfo['container'];
  durationSec: number | null;
  durationSource: MediaInfo['durationSource'] | 'audio';
  gameId: string;
  video: MediaInfo['video'];
  warnings: MediaWarning[];
  createdAt: string;
  audioTracks: AudioTrackDto[];
}

export interface JobFile {
  relPath: string;
  usage: 'input' | 'output';
}

export interface JobDto {
  id: string;
  type: JobType;
  lane: JobLane;
  targetKey: string;
  recordingId: string | null;
  params: Record<string, unknown>;
  status: JobStatus;
  progress: number;
  result: unknown;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/* ------------------------------ Lignes SQL ----------------------------- */

interface RecordingRow {
  id: string;
  source_path: string;
  file_name: string;
  size_bytes: number;
  fingerprint: string;
  container: string;
  duration_sec: number | null;
  duration_source: string | null;
  game_id: string;
  media_info_json: string;
  warnings_json: string;
  created_at: string;
}

interface TrackRow {
  audio_index: number;
  stream_index: number;
  role: string;
  role_source: string;
  title: string | null;
  codec: string | null;
  channels: number | null;
  sample_rate: number | null;
  start_offset_sec: number;
}

interface JobRow {
  id: string;
  type: string;
  lane: string;
  target_key: string;
  recording_id: string | null;
  params_json: string;
  status: string;
  progress: number;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function toTrack(r: TrackRow): AudioTrackDto {
  return {
    audioIndex: r.audio_index,
    streamIndex: r.stream_index,
    role: r.role as TrackRole,
    roleSource: r.role_source as TrackRoleSource,
    title: r.title,
    codec: r.codec,
    channels: r.channels,
    sampleRate: r.sample_rate,
    startOffsetSec: r.start_offset_sec,
  };
}

function toJob(r: JobRow): JobDto {
  return {
    id: r.id,
    type: r.type as JobType,
    lane: r.lane as JobLane,
    targetKey: r.target_key,
    recordingId: r.recording_id,
    params: JSON.parse(r.params_json) as Record<string, unknown>,
    status: r.status as JobStatus,
    progress: r.progress,
    result: r.result_json ? (JSON.parse(r.result_json) as unknown) : null,
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? '' } : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export interface NewRecording {
  id: string;
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  fingerprint: string;
  gameId: string;
  media: MediaInfo;
  tracks: { audioIndex: number; role: TrackRole; roleSource: TrackRoleSource }[];
}

/* ------------------------------ Enregistrements ------------------------ */

export class RecordingRepository {
  constructor(private readonly db: Db) {}

  insert(rec: NewRecording): void {
    const insertRec = this.db.prepare(`
      INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
        duration_sec, duration_source, game_id, media_info_json, warnings_json)
      VALUES (@id, @sourcePath, @fileName, @sizeBytes, @mtimeMs, @fingerprint, @container,
        @durationSec, @durationSource, @gameId, @mediaInfo, @warnings)`);
    const insertTrack = this.db.prepare(`
      INSERT INTO audio_tracks (recording_id, audio_index, stream_index, role, role_source, title,
        codec, channels, sample_rate, start_offset_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    this.db.transaction(() => {
      insertRec.run({
        id: rec.id,
        sourcePath: rec.sourcePath,
        fileName: rec.fileName,
        sizeBytes: rec.sizeBytes,
        mtimeMs: rec.mtimeMs,
        fingerprint: rec.fingerprint,
        container: rec.media.container,
        durationSec: rec.media.durationSec,
        durationSource: rec.media.durationSource,
        gameId: rec.gameId,
        mediaInfo: JSON.stringify(rec.media),
        warnings: JSON.stringify(rec.media.warnings),
      });
      for (const t of rec.media.audioTracks) {
        const resolved = rec.tracks.find((r) => r.audioIndex === t.audioIndex);
        insertTrack.run(
          rec.id,
          t.audioIndex,
          t.streamIndex,
          resolved?.role ?? 'unknown',
          resolved?.roleSource ?? 'default',
          t.title,
          t.codec,
          t.channels,
          t.sampleRate,
          t.startOffsetSec,
        );
      }
    })();
  }

  findIdByFingerprint(fingerprint: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM recordings WHERE fingerprint = ?')
      .get(fingerprint) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Données internes (empreinte) nécessaires au contrôle de l'original. */
  getSource(id: string): { sourcePath: string; fingerprint: string } | null {
    const row = this.db
      .prepare('SELECT source_path, fingerprint FROM recordings WHERE id = ?')
      .get(id) as { source_path: string; fingerprint: string } | undefined;
    return row ? { sourcePath: row.source_path, fingerprint: row.fingerprint } : null;
  }

  get(id: string): RecordingDto | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as
      RecordingRow | undefined;
    if (!row) return null;
    const tracks = this.db
      .prepare('SELECT * FROM audio_tracks WHERE recording_id = ? ORDER BY audio_index')
      .all(id) as TrackRow[];
    const media = JSON.parse(row.media_info_json) as MediaInfo;
    return {
      id: row.id,
      sourcePath: row.source_path,
      fileName: row.file_name,
      sizeBytes: row.size_bytes,
      container: row.container as MediaInfo['container'],
      durationSec: row.duration_sec,
      durationSource: row.duration_source as RecordingDto['durationSource'],
      gameId: row.game_id,
      video: media.video,
      warnings: JSON.parse(row.warnings_json) as MediaWarning[],
      createdAt: row.created_at,
      audioTracks: tracks.map(toTrack),
    };
  }

  list(): RecordingDto[] {
    const ids = this.db.prepare('SELECT id FROM recordings ORDER BY created_at DESC').all() as {
      id: string;
    }[];
    return ids.map((r) => this.get(r.id)).filter((r): r is RecordingDto => r !== null);
  }

  /**
   * Change les rôles des pistes. Les fichiers dérivés sont identifiés par l'index
   * de piste (pas par le rôle) : ils restent valides.
   */
  updateRoles(id: string, roles: readonly TrackRole[]): void {
    const stmt = this.db.prepare(
      `UPDATE audio_tracks SET role = ?, role_source = 'override' WHERE recording_id = ? AND audio_index = ?`,
    );
    this.db.transaction(() => {
      roles.forEach((role, i) => stmt.run(role, id, i));
      this.db.prepare(`UPDATE recordings SET updated_at = ${NOW} WHERE id = ?`).run(id);
    })();
  }

  /** Renseigne la durée déduite de l'audio quand le conteneur ne la fournit pas. */
  setDurationFromAudioIfUnknown(id: string, durationSec: number): void {
    this.db
      .prepare(
        `UPDATE recordings SET duration_sec = ?, duration_source = 'audio', updated_at = ${NOW}
         WHERE id = ? AND duration_sec IS NULL`,
      )
      .run(durationSec, id);
  }
}

/* ------------------------------ Traitements ---------------------------- */

export interface NewJob {
  id: string;
  type: JobType;
  lane: JobLane;
  targetKey: string;
  recordingId: string | null;
  params: Record<string, unknown>;
  files: readonly JobFile[];
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  /**
   * Crée un traitement, sauf si un traitement actif a déjà la même clé de cible :
   * il est alors renvoyé (déduplication). Atomique.
   */
  createOrGetActive(job: NewJob): { job: JobDto; created: boolean } {
    return this.db.transaction(() => {
      const active = this.findActiveByTarget(job.targetKey);
      if (active) return { job: active, created: false };
      this.db
        .prepare(
          `INSERT INTO jobs (id, type, lane, target_key, recording_id, params_json, status)
           VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
        )
        .run(
          job.id,
          job.type,
          job.lane,
          job.targetKey,
          job.recordingId,
          JSON.stringify(job.params),
        );
      const insertFile = this.db.prepare(
        'INSERT OR IGNORE INTO job_files (job_id, rel_path, usage) VALUES (?, ?, ?)',
      );
      for (const f of job.files) insertFile.run(job.id, f.relPath, f.usage);
      return { job: this.get(job.id)!, created: true };
    })();
  }

  get(id: string): JobDto | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  listForRecording(recordingId: string): JobDto[] {
    return (
      this.db
        .prepare('SELECT * FROM jobs WHERE recording_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(recordingId) as JobRow[]
    ).map(toJob);
  }

  findActiveByTarget(targetKey: string): JobDto | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE target_key = ? AND status IN ('queued','running')`)
      .get(targetKey) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  nextQueued(lane: JobLane): JobDto | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE lane = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(lane) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  markRunning(id: string): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'running', started_at = ${NOW}, progress = 0 WHERE id = ?`)
      .run(id);
  }

  setProgress(id: string, progress: number): void {
    this.db
      .prepare('UPDATE jobs SET progress = ? WHERE id = ?')
      .run(Math.max(0, Math.min(1, progress)), id);
  }

  finish(
    id: string,
    status: Exclude<JobStatus, 'queued' | 'running'>,
    opts: { error?: { code: string; message: string }; result?: unknown } = {},
  ) {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, finished_at = ${NOW}, error_code = ?, error_message = ?, result_json = ?,
           progress = CASE WHEN ? = 'succeeded' THEN 1 ELSE progress END
         WHERE id = ?`,
      )
      .run(
        status,
        opts.error?.code ?? null,
        opts.error?.message ?? null,
        opts.result === undefined ? null : JSON.stringify(opts.result),
        status,
        id,
      );
  }

  /** Au démarrage : tout travail « en cours » ou « en attente » a été interrompu. */
  markStaleAsInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'interrupted', finished_at = ${NOW},
           error_code = 'INTERRUPTED', error_message = 'Traitement interrompu (arrêt du serveur)'
         WHERE status IN ('queued','running')`,
      )
      .run().changes;
  }

  /** Fichiers déclarés par les traitements actifs : le nettoyage ne doit pas y toucher. */
  activeFilePaths(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT f.rel_path FROM job_files f JOIN jobs j ON j.id = f.job_id
         WHERE j.status IN ('queued','running')`,
      )
      .all() as { rel_path: string }[];
    return new Set(rows.map((r) => r.rel_path));
  }
}
