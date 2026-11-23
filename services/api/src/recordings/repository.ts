import type { JobStatus, JobType, TrackRole, TrackRoleSource } from '@acs/shared';
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
  extracted: { path: string; durationSec: number; at: string } | null;
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

export interface JobDto {
  id: string;
  recordingId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
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
  mtime_ms: number;
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
  extracted_path: string | null;
  extracted_duration_sec: number | null;
  extracted_at: string | null;
}

interface JobRow {
  id: string;
  recording_id: string;
  type: string;
  status: string;
  progress: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

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
    extracted:
      r.extracted_path && r.extracted_duration_sec !== null && r.extracted_at
        ? { path: r.extracted_path, durationSec: r.extracted_duration_sec, at: r.extracted_at }
        : null,
  };
}

function toJob(r: JobRow): JobDto {
  return {
    id: r.id,
    recordingId: r.recording_id,
    type: r.type as JobType,
    status: r.status as JobStatus,
    progress: r.progress,
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

/* ------------------------------ Repository ----------------------------- */

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

  /** Change les rôles ; l'extraction d'une piste dont le rôle change est invalidée. */
  updateRoles(id: string, roles: readonly TrackRole[]): void {
    const stmt = this.db.prepare(`
      UPDATE audio_tracks SET role = ?, role_source = 'override',
        extracted_path = CASE WHEN role = ? THEN extracted_path ELSE NULL END,
        extracted_duration_sec = CASE WHEN role = ? THEN extracted_duration_sec ELSE NULL END,
        extracted_at = CASE WHEN role = ? THEN extracted_at ELSE NULL END
      WHERE recording_id = ? AND audio_index = ?`);
    this.db.transaction(() => {
      roles.forEach((role, i) => stmt.run(role, role, role, role, id, i));
      this.db.prepare(`UPDATE recordings SET updated_at = ${NOW} WHERE id = ?`).run(id);
    })();
  }

  setTrackExtracted(id: string, audioIndex: number, filePath: string, durationSec: number): void {
    this.db
      .prepare(
        `UPDATE audio_tracks SET extracted_path = ?, extracted_duration_sec = ?, extracted_at = ${NOW}
         WHERE recording_id = ? AND audio_index = ?`,
      )
      .run(filePath, durationSec, id, audioIndex);
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

export class JobRepository {
  constructor(private readonly db: Db) {}

  create(id: string, recordingId: string, type: JobType): JobDto {
    this.db
      .prepare(`INSERT INTO jobs (id, recording_id, type, status) VALUES (?, ?, ?, 'queued')`)
      .run(id, recordingId, type);
    return this.get(id)!;
  }

  get(id: string): JobDto | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  listForRecording(recordingId: string): JobDto[] {
    return (
      this.db
        .prepare('SELECT * FROM jobs WHERE recording_id = ? ORDER BY created_at DESC')
        .all(recordingId) as JobRow[]
    ).map(toJob);
  }

  findActive(recordingId: string, type: JobType): JobDto | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE recording_id = ? AND type = ? AND status IN ('queued','running')
         ORDER BY created_at LIMIT 1`,
      )
      .get(recordingId, type) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  nextQueued(): JobDto | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`)
      .get() as JobRow | undefined;
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
    error?: { code: string; message: string },
  ) {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, finished_at = ${NOW}, error_code = ?, error_message = ?,
           progress = CASE WHEN ? = 'succeeded' THEN 1 ELSE progress END
         WHERE id = ?`,
      )
      .run(status, error?.code ?? null, error?.message ?? null, status, id);
  }

  /** Au démarrage : tout travail « en cours » a été interrompu (crash, arrêt). */
  markStaleAsInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'interrupted', finished_at = ${NOW},
           error_code = 'INTERRUPTED', error_message = 'Traitement interrompu (arrêt du serveur)'
         WHERE status IN ('queued','running')`,
      )
      .run().changes;
  }
}
