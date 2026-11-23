import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface Migration {
  version: number;
  name: string;
  sql: string;
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
];

export function openDatabase(filePath: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL'); // lectures concurrentes + robustesse en cas d'interruption
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations);
  return db;
}

export function migrate(db: Db, migrations: readonly Migration[]): number[] {
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
      db.exec(m.sql);
      insert.run(m.version, m.name);
    })();
  }
  return pending.map((m) => m.version);
}
