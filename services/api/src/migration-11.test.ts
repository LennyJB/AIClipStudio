import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase } from './db';

const KEY = 'k'.repeat(64);
const addRecording = (db: ReturnType<typeof openDatabase>, id = 'rec1') =>
  db
    .prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         duration_sec, duration_source, game_id, media_info_json) VALUES
       (?, '/videos/a.mkv', 'a.mkv', 10, 1, ?, 'mkv', 60, 'format', 'generic', '{}')`,
    )
    .run(id, `fp-${id}`);

describe('migration 11 : types de contenu', () => {
  it('est la onzième migration ; appliquée sur une base v10 sans toucher aux données existantes', () => {
    expect(MIGRATIONS[10]).toMatchObject({ version: 11, name: 'content_types' });
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 10));
    addRecording(db);
    expect(migrate(db, MIGRATIONS.slice(0, 11))).toEqual([11]);
    expect(db.prepare('SELECT count(*) AS n FROM recordings').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM content_detections').get()).toEqual({ n: 0 });
  });

  it('journaux en ajout seul ; JSON valide ; identifiant de requête unique ; suppression en cascade', () => {
    const db = openDatabase(':memory:');
    addRecording(db);
    const det = db.prepare(
      `INSERT INTO content_detections (recording_id, detector_version, input_key, detection_json)
       VALUES ('rec1', 'content-v1', ?, ?)`,
    );
    expect(() => det.run(KEY, 'pas du json')).toThrow();
    expect(() => det.run('court', '{}')).toThrow();
    const id = det.run(KEY, '{"segments":[]}').lastInsertRowid;
    expect(() =>
      db.prepare(`UPDATE content_detections SET detection_json = '{}' WHERE id = ?`).run(id),
    ).toThrow(/ajout seul/u);

    const cor = db.prepare(
      `INSERT INTO content_corrections (recording_id, based_on_detection_id, segments_json, request_id)
       VALUES ('rec1', ?, ?, ?)`,
    );
    cor.run(id, '[]', 'requete-0001');
    cor.run(id, null, 'requete-0002'); // retour à la détection automatique
    expect(() => cor.run(id, '[]', 'requete-0001')).toThrow(/UNIQUE/u);
    expect(() => cor.run(id, '[]', 'court')).toThrow(/CHECK/u);
    expect(() => cor.run(9999, '[]', 'requete-0003')).toThrow(/FOREIGN KEY/u);
    expect(() => db.prepare(`UPDATE content_corrections SET segments_json = NULL`).run()).toThrow(
      /ajout seul/u,
    );

    db.prepare(`DELETE FROM recordings WHERE id = 'rec1'`).run();
    expect(db.prepare('SELECT count(*) AS n FROM content_corrections').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM content_detections').get()).toEqual({ n: 0 });
  });
});
