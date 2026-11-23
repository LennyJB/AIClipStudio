import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, type Migration } from './db';

const m1: Migration = {
  version: 1,
  name: 'create_t',
  sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)',
};
const m2: Migration = { version: 2, name: 'add_col', sql: 'ALTER TABLE t ADD COLUMN name TEXT' };

describe('base SQLite', () => {
  it('ouvre une base avec les clés étrangères actives', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('applique les migrations dans l’ordre et une seule fois', () => {
    const db = openDatabase(':memory:', []);
    expect(migrate(db, [m2, m1])).toEqual([1, 2]);
    expect(migrate(db, [m1, m2])).toEqual([]);
    db.prepare('INSERT INTO t (id, name) VALUES (1, ?)').run('ok');
    db.close();
  });

  it('annule entièrement une migration en échec', () => {
    const db = openDatabase(':memory:', [m1]);
    const broken: Migration = {
      version: 2,
      name: 'broken',
      sql: 'ALTER TABLE t ADD COLUMN a TEXT; SELECT * FROM table_inexistante;',
    };
    expect(() => migrate(db, [m1, broken])).toThrow();
    const cols = db.prepare('PRAGMA table_info(t)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(['id']);
    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([{ version: 1 }]);
    db.close();
  });
});
