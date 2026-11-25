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
const H = 'a'.repeat(64);

function projectWithRevisions(db: Db, id: string, proposal: string, revisions: number) {
  db.prepare(PROPOSAL).run(proposal);
  db.prepare(
    `INSERT INTO clip_projects (id, proposal_id, recording_id, current_revision) VALUES (?, ?, 'r', ?)`,
  ).run(id, proposal, revisions);
  for (let r = 1; r <= revisions; r++) {
    db.prepare(
      `INSERT INTO clip_project_revisions (project_id, revision, schema_version, document_json, document_hash,
         request_id, source) VALUES (?, ?, 1, '{}', ?, ?, 'api')`,
    ).run(id, r, H, `q${r}`);
  }
}

const edit = (db: Db) =>
  db.prepare(
    `INSERT INTO clip_project_edits (project_id, seq, kind, target_seq, ops_json, inverse_json,
       preconditions_json, hash_after, base_revision, base_seq, request_id, request_hash, source)
     VALUES ('c1', ?, ?, ?, '[]', '[]', '{}', ?, 1, ?, ?, ?, 'ui')`,
  );

describe('migration 8 (journal d’édition)', () => {
  it('s’applique sur une base v7 avec des projets : tête = révision courante, rien d’autre ne change', () => {
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 7));
    db.prepare(REC).run();
    db.prepare(RUN).run();
    projectWithRevisions(db, 'c1', 'p1', 3);
    projectWithRevisions(db, 'c2', 'p2', 1);
    const before = {
      projects: db.prepare('SELECT * FROM clip_projects').all(),
      revisions: db.prepare('SELECT * FROM clip_project_revisions').all(),
    };
    expect(migrate(db, MIGRATIONS)).toEqual([8]);
    expect(db.prepare('SELECT * FROM clip_projects').all()).toEqual(before.projects);
    expect(db.prepare('SELECT * FROM clip_project_revisions').all()).toEqual(before.revisions);
    expect(
      db
        .prepare(
          'SELECT project_id, head_seq, checkpoint_revision FROM clip_project_heads ORDER BY project_id',
        )
        .all(),
    ).toEqual([
      { project_id: 'c1', head_seq: 3, checkpoint_revision: 3 },
      { project_id: 'c2', head_seq: 1, checkpoint_revision: 1 },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('journal en ajout seul : ni modification ni suppression ; suppression du projet en cascade', () => {
    const db = openDatabase(':memory:');
    db.prepare(REC).run();
    db.prepare(RUN).run();
    projectWithRevisions(db, 'c1', 'p1', 1);
    edit(db).run(2, 'do', null, H, 1, 'r2', H);
    expect(() => db.prepare(`UPDATE clip_project_edits SET summary = 'x'`).run()).toThrow(
      /ajout seul/,
    );
    expect(() => db.prepare(`DELETE FROM clip_project_edits`).run()).toThrow(/ajout seul/);
    // Le projet lui-même peut être supprimé (cascade), le journal part avec lui.
    db.prepare(`DELETE FROM clip_project_revisions`).run();
    db.prepare(`DELETE FROM clip_projects WHERE id = 'c1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip_project_edits').get()).toEqual({ n: 0 });
  });

  it('contraintes : cible des annulations, base antérieure, requête unique, empreinte', () => {
    const db = openDatabase(':memory:');
    db.prepare(REC).run();
    db.prepare(RUN).run();
    projectWithRevisions(db, 'c1', 'p1', 1);
    // Annuler sans cible, geste avec cible : refusés.
    expect(() => edit(db).run(2, 'undo', null, H, 1, 'a', H)).toThrow(/CHECK/);
    expect(() => edit(db).run(2, 'do', 1, H, 1, 'b', H)).toThrow(/CHECK/);
    // Base non antérieure, empreinte invalide : refusées.
    expect(() => edit(db).run(2, 'do', null, H, 2, 'c', H)).toThrow(/CHECK/);
    expect(() => edit(db).run(2, 'do', null, 'court', 1, 'd', H)).toThrow(/CHECK/);
    edit(db).run(2, 'do', null, H, 1, 'e', H);
    // Même requête deux fois, même numéro deux fois : refusés.
    expect(() => edit(db).run(3, 'do', null, H, 2, 'e', H)).toThrow(/UNIQUE/);
    expect(() => edit(db).run(2, 'do', null, H, 1, 'f', H)).toThrow(/UNIQUE|PRIMARY/);
    // Point de contrôle postérieur à la tête : refusé.
    db.prepare(
      `INSERT INTO clip_project_heads (project_id, head_seq, checkpoint_revision) VALUES ('c1', 2, 1)`,
    ).run();
    expect(() =>
      db
        .prepare(`UPDATE clip_project_heads SET checkpoint_revision = 5 WHERE project_id = 'c1'`)
        .run(),
    ).toThrow(/CHECK/);
  });
});
