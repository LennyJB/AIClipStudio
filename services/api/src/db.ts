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
 * Vide à l'étape 1 : la table des sessions d'import arrivera à l'étape 2.
 */
export const MIGRATIONS: readonly Migration[] = [];

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
