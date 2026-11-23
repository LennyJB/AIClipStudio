import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AUDIO_GENERATOR_VERSION, AUDIO_PROFILES, isInside } from '@acs/media';
import { canonicalJson, derivativeCacheKey } from './derivatives/cache-key';

export type Db = Database.Database;

export interface MigrationContext {
  /** Dossier de stockage (pour convertir les chemins absolus en chemins relatifs). */
  storageDir?: string | undefined;
}

export interface Migration {
  version: number;
  name: string;
  /** SQL exécuté avant `up`. */
  sql?: string;
  /** Étape en code (reprise de données), dans la même transaction. */
  up?: (db: Db, ctx: MigrationContext) => void;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Migration 2 : reprise des WAV de transcription de la v1 (colonnes extracted_*)
 * en lignes media_derivatives. Un fichier absent ou hors du stockage est ignoré.
 */
function migrateExtractedTracks(db: Db, ctx: MigrationContext) {
  const rows = db
    .prepare(
      `SELECT t.recording_id, t.audio_index, t.extracted_path, t.extracted_duration_sec, r.fingerprint
       FROM audio_tracks t JOIN recordings r ON r.id = t.recording_id
       WHERE t.extracted_path IS NOT NULL`,
    )
    .all() as {
    recording_id: string;
    audio_index: number;
    extracted_path: string;
    extracted_duration_sec: number | null;
    fingerprint: string;
  }[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO media_derivatives (id, cache_key, recording_id, source_fingerprint, kind,
      audio_index, params_json, generator_version, rel_path, size_bytes, duration_ms)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'audio_transcription', ?, ?, ?, ?, ?, ?)`);
  const params = { ...AUDIO_PROFILES.transcription };
  for (const r of rows) {
    if (
      !ctx.storageDir ||
      !isInside(ctx.storageDir, r.extracted_path) ||
      !existsSync(r.extracted_path)
    ) {
      continue;
    }
    const key = derivativeCacheKey({
      sourceFingerprint: r.fingerprint,
      kind: 'audio_transcription',
      audioIndex: r.audio_index,
      range: null,
      params,
      generatorVersion: AUDIO_GENERATOR_VERSION,
    });
    insert.run(
      key,
      r.recording_id,
      r.fingerprint,
      r.audio_index,
      canonicalJson(params),
      AUDIO_GENERATOR_VERSION,
      path.relative(ctx.storageDir, r.extracted_path).split(path.sep).join('/'),
      statSync(r.extracted_path).size,
      r.extracted_duration_sec === null ? null : Math.round(r.extracted_duration_sec * 1000),
    );
  }
}

/**
 * Migrations du schéma, appliquées dans l'ordre et une seule fois.
 * Ne jamais modifier une migration publiée : en ajouter une nouvelle.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'recordings_tracks_jobs',
    sql: `
      CREATE TABLE recordings (
        id               TEXT PRIMARY KEY,
        source_path      TEXT NOT NULL,
        file_name        TEXT NOT NULL,
        size_bytes       INTEGER NOT NULL,
        mtime_ms         INTEGER NOT NULL,
        fingerprint      TEXT NOT NULL UNIQUE,
        container        TEXT NOT NULL,
        duration_sec     REAL,
        duration_source  TEXT,
        game_id          TEXT NOT NULL,
        media_info_json  TEXT NOT NULL,
        warnings_json    TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE audio_tracks (
        recording_id            TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        audio_index             INTEGER NOT NULL,
        stream_index            INTEGER NOT NULL,
        role                    TEXT NOT NULL,
        role_source             TEXT NOT NULL,
        title                   TEXT,
        codec                   TEXT,
        channels                INTEGER,
        sample_rate             INTEGER,
        start_offset_sec        REAL NOT NULL DEFAULT 0,
        extracted_path          TEXT,
        extracted_duration_sec  REAL,
        extracted_at            TEXT,
        PRIMARY KEY (recording_id, audio_index)
      );

      CREATE TABLE jobs (
        id             TEXT PRIMARY KEY,
        recording_id   TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        type           TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN
                         ('queued','running','succeeded','failed','interrupted','cancelled')),
        progress       REAL NOT NULL DEFAULT 0,
        error_code     TEXT,
        error_message  TEXT,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        started_at     TEXT,
        finished_at    TEXT
      );
      CREATE INDEX jobs_recording_idx ON jobs(recording_id, created_at);
      CREATE INDEX jobs_status_idx ON jobs(status, created_at);
    `,
  },
  {
    version: 2,
    name: 'derivatives_cache_job_targets',
    sql: `
      CREATE TABLE media_derivatives (
        id                   TEXT PRIMARY KEY,
        cache_key            TEXT NOT NULL UNIQUE,
        recording_id         TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        source_fingerprint   TEXT NOT NULL,
        kind                 TEXT NOT NULL CHECK (kind IN
                               ('audio_transcription','audio_stem','waveform','video_proxy','thumbnail')),
        audio_index          INTEGER,
        src_start_ms         INTEGER,
        src_end_ms           INTEGER,
        params_json          TEXT NOT NULL,
        generator_version    INTEGER NOT NULL,
        input_derivative_id  TEXT REFERENCES media_derivatives(id) ON DELETE SET NULL,
        rel_path             TEXT NOT NULL UNIQUE,
        size_bytes           INTEGER NOT NULL,
        duration_ms          INTEGER,
        retention            TEXT NOT NULL DEFAULT 'cache' CHECK (retention IN ('cache','keep')),
        created_at           TEXT NOT NULL DEFAULT (${NOW}),
        last_used_at         TEXT NOT NULL DEFAULT (${NOW}),
        CHECK ((src_start_ms IS NULL) = (src_end_ms IS NULL)),
        CHECK (src_start_ms IS NULL OR (src_start_ms >= 0 AND src_start_ms < src_end_ms))
      );
      CREATE INDEX media_derivatives_lookup
        ON media_derivatives(recording_id, kind, audio_index, generator_version);
      CREATE INDEX media_derivatives_lru ON media_derivatives(retention, last_used_at);

      CREATE TABLE jobs_v2 (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        lane           TEXT NOT NULL CHECK (lane IN ('heavy','interactive')),
        target_key     TEXT NOT NULL,
        recording_id   TEXT REFERENCES recordings(id) ON DELETE CASCADE,
        params_json    TEXT NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL CHECK (status IN
                         ('queued','running','succeeded','failed','interrupted','cancelled')),
        progress       REAL NOT NULL DEFAULT 0,
        result_json    TEXT,
        error_code     TEXT,
        error_message  TEXT,
        created_at     TEXT NOT NULL DEFAULT (${NOW}),
        started_at     TEXT,
        finished_at    TEXT
      );
      INSERT INTO jobs_v2 (id, type, lane, target_key, recording_id, params_json, status, progress,
                           error_code, error_message, created_at, started_at, finished_at)
        SELECT id,
               CASE type WHEN 'extract_audio' THEN 'extract_transcription_audio' ELSE type END,
               'heavy',
               'recording:' || recording_id || ':transcription_audio',
               recording_id, '{}', status, progress, error_code, error_message,
               created_at, started_at, finished_at
        FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_v2 RENAME TO jobs;
      CREATE UNIQUE INDEX jobs_active_target ON jobs(target_key) WHERE status IN ('queued','running');
      CREATE INDEX jobs_queue_idx ON jobs(lane, status, created_at);
      CREATE INDEX jobs_recording_idx ON jobs(recording_id, created_at);

      CREATE TABLE job_files (
        job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        rel_path  TEXT NOT NULL,
        usage     TEXT NOT NULL CHECK (usage IN ('input','output')),
        PRIMARY KEY (job_id, rel_path)
      );
      CREATE INDEX job_files_path_idx ON job_files(rel_path);
    `,
    up: (db, ctx) => {
      migrateExtractedTracks(db, ctx);
      db.exec(`
        ALTER TABLE audio_tracks DROP COLUMN extracted_path;
        ALTER TABLE audio_tracks DROP COLUMN extracted_duration_sec;
        ALTER TABLE audio_tracks DROP COLUMN extracted_at;
      `);
    },
  },
];

export function openDatabase(
  filePath: string,
  migrations: readonly Migration[] = MIGRATIONS,
  ctx: MigrationContext = {},
): Db {
  if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL'); // lectures concurrentes + robustesse en cas d'interruption
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations, ctx);
  return db;
}

export function migrate(
  db: Db,
  migrations: readonly Migration[],
  ctx: MigrationContext = {},
): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => !applied.has(m.version));

  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  for (const m of pending) {
    // Chaque migration est atomique : en cas d'erreur, rien n'est appliqué.
    db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      m.up?.(db, ctx);
      insert.run(m.version, m.name);
    })();
  }
  return pending.map((m) => m.version);
}
