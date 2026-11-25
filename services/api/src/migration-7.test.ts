import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase, type Db } from './db';

const REC = `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
  game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`;
const RUN = `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version,
  input_key, transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd)
  VALUES ('run', 'r', 'claude', 'completed', 2, 'p', 'k', '[]', '{}', '{}', '{}', 5)`;
const PROPOSAL = `INSERT INTO clip_proposals (id, run_id, recording_id, tier, title, explanation,
  categories_json, relevance, reliability, reliability_json, src_start_ms, src_end_ms, setup_segment_id,
  punchline_segment_id, reaction_end_segment_id, punchline_ms, standalone)
  VALUES (?, 'run', 'r', 'clip', 't', 'e', '[]', 80, 70, '{}', 1000, 30000, 1, 2, 3, 15000, 1)`;
const HASH = 'a'.repeat(64);

function seeded(): Db {
  const db = openDatabase(':memory:');
  db.prepare(REC).run();
  db.prepare(RUN).run();
  db.prepare(PROPOSAL).run('p1');
  return db;
}

function project(db: Db) {
  db.prepare(
    `INSERT INTO clip_projects (id, proposal_id, recording_id, current_revision) VALUES ('c1', 'p1', 'r', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO clip_project_revisions (project_id, revision, schema_version, document_json, document_hash,
       request_id, source) VALUES ('c1', 1, 1, '{}', ?, 'q1', 'api')`,
  ).run(HASH);
}

const audioEvent = (db: Db) =>
  db.prepare(
    `INSERT INTO export_audio_events (id, recording_id, kind, subject, action, payload_json, request_id, source)
     VALUES (?, 'r', ?, ?, ?, ?, ?, 'cli')`,
  );

const render = (db: Db) =>
  db.prepare(
    `INSERT INTO clip_renders (id, project_id, revision, kind, status, plan_hash, staging_rel_path,
       output_rel_path, output_sha256) VALUES (?, 'c1', 1, ?, ?, ?, ?, ?, ?)`,
  );

describe('migration 7 (projets de clip)', () => {
  it('s’applique sur une base v6 contenant des propositions, sans les modifier', () => {
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 6));
    db.prepare(REC).run();
    db.prepare(RUN).run();
    db.prepare(PROPOSAL).run('p1');
    const before = db.prepare('SELECT * FROM clip_proposals').all();
    expect(migrate(db, MIGRATIONS.slice(0, 7))).toEqual([7]);
    expect(db.prepare('SELECT * FROM clip_proposals').all()).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('événements audio : consentement sans contenu, déclaration avec contenu, ajout seul', () => {
    const db = seeded();
    const ins = audioEvent(db);
    ins.run('e1', 'consent', 'discord_voices', 'granted', null, 'q1');
    ins.run('e2', 'declaration', 'mix_composition', 'declared', '{"discord":"present"}', 'q2');
    ins.run('e2m', 'declaration', 'mic_composition', 'declared', '{"otherVoices":"absent"}', 'q2m');
    expect(() => ins.run('e3m', 'consent', 'mic_composition', 'granted', null, 'q3m')).toThrow(
      /CHECK/,
    );
    expect(() => ins.run('e4m', 'declaration', 'mic_composition', 'declared', null, 'q4m')).toThrow(
      /CHECK/,
    );
    // Incohérences refusées par la base.
    expect(() => ins.run('e3', 'consent', 'mix_composition', 'granted', null, 'q3')).toThrow(
      /CHECK/,
    );
    expect(() => ins.run('e4', 'consent', 'discord_voices', 'declared', null, 'q4')).toThrow(
      /CHECK/,
    );
    expect(() => ins.run('e5', 'consent', 'discord_voices', 'granted', '{}', 'q5')).toThrow(
      /CHECK/,
    );
    expect(() => ins.run('e6', 'declaration', 'game_composition', 'declared', null, 'q6')).toThrow(
      /CHECK/,
    );
    expect(() => ins.run('e7', 'consent', 'discord_voices', 'granted', null, 'q1')).toThrow(
      /UNIQUE/,
    );
    expect(() => db.prepare(`UPDATE export_audio_events SET note = 'x'`).run()).toThrow(
      /ajout seul/,
    );
    expect(() => db.prepare('DELETE FROM export_audio_events').run()).toThrow(/ajout seul/);
  });

  it('révisions immuables, une seule par numéro et par identifiant de demande', () => {
    const db = seeded();
    project(db);
    expect(() =>
      db.prepare(`UPDATE clip_project_revisions SET change_summary = 'x'`).run(),
    ).toThrow(/immuable/);
    const ins = db.prepare(
      `INSERT INTO clip_project_revisions (project_id, revision, schema_version, document_json,
         document_hash, request_id, source) VALUES ('c1', ?, 1, '{}', ?, ?, 'api')`,
    );
    expect(() => ins.run(1, HASH, 'q2')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => ins.run(2, HASH, 'q1')).toThrow(/UNIQUE/);
    expect(() => ins.run(2, 'court', 'q3')).toThrow(/CHECK/);
    // Un seul projet par proposition.
    expect(() =>
      db
        .prepare(
          `INSERT INTO clip_projects (id, proposal_id, recording_id, current_revision) VALUES ('c2', 'p1', 'r', 1)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('une proposition liée à un projet ne peut pas disparaître silencieusement', () => {
    const db = seeded();
    project(db);
    expect(() => db.prepare(`DELETE FROM clip_proposals WHERE id = 'p1'`).run()).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('manifeste d’intégrité figé', () => {
    const db = seeded();
    db.prepare(
      `INSERT INTO source_integrity_manifests (id, recording_id, method, container, file_size,
         window_start_ms, window_end_ms, probe_bytes, ranges_json, protected_bytes, sha256, algo_version)
       VALUES ('m', 'r', 'byte_ranges', 'matroska', 10, 0, 1000, 5, '[]', 0, ?, 1)`,
    ).run(HASH);
    expect(() => db.prepare('UPDATE source_integrity_manifests SET sha256 = sha256').run()).toThrow(
      /figé/,
    );
  });

  it('rendus : un final n’est jamais évincé ; publication et succès toujours complets', () => {
    const db = seeded();
    project(db);
    const ins = render(db);
    expect(() => ins.run('x1', 'final', 'evicted', 'h1', null, null, null)).toThrow(/CHECK/);
    ins.run('x2', 'preview', 'evicted', 'h2', null, null, null);
    expect(() => ins.run('x3', 'final', 'finalizing', 'h3', null, 'o', HASH)).toThrow(/CHECK/);
    expect(() => ins.run('x4', 'final', 'succeeded', 'h4', null, 'o', null)).toThrow(/CHECK/);
    ins.run('x5', 'final', 'succeeded', 'h5', null, 'o', HASH);
    // Pas deux rendus actifs ou réussis pour le même plan.
    expect(() => ins.run('x6', 'final', 'queued', 'h5', null, null, null)).toThrow(/UNIQUE/);
    ins.run('x7', 'final', 'failed', 'h5', null, null, null);
    // La révision rendue doit exister.
    expect(() =>
      db
        .prepare(
          `INSERT INTO clip_renders (id, project_id, revision, kind, status, plan_hash)
           VALUES ('x8', 'c1', 9, 'preview', 'queued', 'h8')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
