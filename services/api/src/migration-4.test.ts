import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase } from './db';

/** Base au schéma v3 avec des données réalistes (dérivés liés, traitements et fichiers protégés). */
function v3WithData() {
  const db = openDatabase(':memory:', MIGRATIONS.slice(0, 3));
  db.prepare(
    `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
       duration_sec, duration_source, game_id, media_info_json) VALUES
     ('rec1', '/videos/a.mkv', 'a.mkv', 10, 1, 'fp1', 'mkv', 60, 'format', 'generic', '{}')`,
  ).run();
  const der = db.prepare(
    `INSERT INTO media_derivatives (id, cache_key, recording_id, source_fingerprint, kind, audio_index,
       params_json, generator_version, input_derivative_id, rel_path, size_bytes, retention)
     VALUES (?, ?, 'rec1', 'fp1', ?, 1, '{}', 1, ?, ?, 100, ?)`,
  );
  der.run('d-audio', 'k1', 'audio_transcription', null, 'processing/rec1/a.wav', 'keep');
  der.run('d-wave', 'k2', 'waveform', 'd-audio', 'processing/rec1/a.dat', 'cache');
  db.prepare(
    `INSERT INTO jobs (id, type, lane, target_key, recording_id, params_json, status, progress, result_json)
     VALUES ('j1', 'compute_waveform', 'interactive', 't1', 'rec1', '{"a":1}', 'succeeded', 1, '{"ok":true}')`,
  ).run();
  db.prepare(
    `INSERT INTO job_files (job_id, rel_path, usage) VALUES ('j1', 'processing/rec1/a.dat', 'output')`,
  ).run();
  return db;
}

describe('migration 4 (analyse locale)', () => {
  it('conserve dérivés, liens, traitements et fichiers protégés', () => {
    const db = v3WithData();
    expect(migrate(db, MIGRATIONS.slice(0, 4))).toEqual([4]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(
      db
        .prepare('SELECT id, input_derivative_id, retention FROM media_derivatives ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'd-audio', input_derivative_id: null, retention: 'keep' },
      { id: 'd-wave', input_derivative_id: 'd-audio', retention: 'cache' },
    ]);
    expect(db.prepare('SELECT * FROM jobs').get()).toMatchObject({
      id: 'j1',
      lane: 'interactive',
      params_json: '{"a":1}',
      result_json: '{"ok":true}',
    });
    expect(db.prepare('SELECT * FROM job_files').all()).toHaveLength(1);
    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'media_derivatives_lookup',
        'media_derivatives_lru',
        'jobs_active_target',
        'jobs_queue_idx',
        'jobs_recording_idx',
        'job_files_path_idx',
      ]),
    );
  });

  it('les clés étrangères pointent vers les tables reconstruites (cascades intactes)', () => {
    const db = v3WithData();
    migrate(db, MIGRATIONS);
    const fks = db.prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('job_files')`).all();
    expect(fks).toEqual([{ t: 'jobs' }]);
    const self = db
      .prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('media_derivatives')`)
      .all();
    expect(self).toEqual(expect.arrayContaining([{ t: 'media_derivatives' }]));
    db.prepare(`DELETE FROM jobs WHERE id = 'j1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_files').get()).toEqual({ n: 0 });
    db.prepare(`DELETE FROM media_derivatives WHERE id = 'd-audio'`).run();
    expect(
      db.prepare(`SELECT input_derivative_id FROM media_derivatives WHERE id = 'd-wave'`).get(),
    ).toEqual({ input_derivative_id: null });
  });

  it('accepte le type de dérivé « frame » et la file « analysis »', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO media_derivatives (id, cache_key, recording_id, source_fingerprint, kind, src_start_ms,
         src_end_ms, params_json, generator_version, rel_path, size_bytes)
       VALUES ('f', 'kf', 'r', 'fp', 'frame', 1000, 1001, '{}', 1, 'processing/r/frames/x.jpg', 10)`,
    ).run();
    db.prepare(
      `INSERT INTO jobs (id, type, lane, target_key, status) VALUES ('j', 'prepare_analysis', 'analysis', 't', 'queued')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, type, lane, target_key, status) VALUES ('j2', 'x', 'inconnue', 't2', 'queued')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('la base refuse tout dépassement du budget d’une analyse (dépensé + réservé)', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
         transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd)
       VALUES ('a', 'r', 'dry_run', 'pending', 1, 'p', 'k', '[]', '{}', '{}', '{}', 5)`,
    ).run();
    db.prepare(`UPDATE analysis_runs SET spent_usd = 4, reserved_usd = 1 WHERE id = 'a'`).run();
    expect(() =>
      db.prepare(`UPDATE analysis_runs SET reserved_usd = 1.01 WHERE id = 'a'`).run(),
    ).toThrow(/CHECK/);
  });

  it('refuse l’accord Discord sans date et une validation de cadrage sans profil', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recording_analysis_settings (recording_id, discord_text_allowed) VALUES ('r', 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO recording_analysis_settings (recording_id, framing_validated_at) VALUES ('r', 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('refuse une fenêtre dont le cœur sort du contexte', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
         transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd)
       VALUES ('a', 'r', 'dry_run', 'pending', 1, 'p', 'k', '[]', '{}', '{}', '{}', 5)`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO analysis_windows (id, run_id, rank, origin, far_start_ms, src_start_ms, core_start_ms,
         core_end_ms, src_end_ms, local_score, signals_json, status, cache_key)
       VALUES (?, 'a', ?, 'signals', ?, ?, ?, ?, ?, 0.5, '[]', 'prepared', 'k')`,
    );
    ins.run('w1', 1, 0, 1000, 2000, 3000, 4000);
    expect(() => ins.run('w2', 2, 0, 1000, 500, 3000, 4000)).toThrow(/CHECK/);
  });
});
