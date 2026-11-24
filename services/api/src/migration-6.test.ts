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

function event(db: Db, id: string, status = 'accepted') {
  db.prepare(
    `INSERT INTO feedback_events (id, request_id, schema_version, type, recording_id, game_id,
       proposal_id, run_id, moment_id_at_decision, previous_status, new_status, snapshot_json, source)
     VALUES (?, ?, 1, 'proposal_accepted', 'r', 'generic', 'p1', 'run', 'm1', 'pending', ?, '{}', 'ui')`,
  ).run(id, `req-${id}`, status);
}

function seeded(): Db {
  const db = openDatabase(':memory:');
  db.prepare(REC).run();
  db.prepare(RUN).run();
  db.prepare(PROPOSAL).run('p1');
  return db;
}

describe('migration 6 (validation et mémoire éditoriale)', () => {
  it('s’applique sur une base v5 contenant des propositions, sans les modifier', () => {
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 5));
    db.prepare(REC).run();
    db.prepare(RUN).run();
    db.prepare(PROPOSAL).run('p1');
    const before = db.prepare('SELECT * FROM clip_proposals').all();
    expect(migrate(db, MIGRATIONS)).toEqual([6]);
    expect(db.prepare('SELECT * FROM clip_proposals').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposal_reviews').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('la référence figée d’un moment a exactement les types des colonnes d’origine', () => {
    const db = seeded();
    const types = (t: string) =>
      new Map(
        (db.pragma(`table_info(${t})`) as { name: string; type: string; notnull: number }[]).map(
          (c) => [c.name, `${c.type}/${c.notnull}`],
        ),
      );
    const src = types('clip_proposals');
    const ref = types('review_moments');
    for (const [refCol, srcCol] of [
      ['ref_punchline_segment_id', 'punchline_segment_id'],
      ['ref_punchline_ms', 'punchline_ms'],
      ['ref_src_start_ms', 'src_start_ms'],
      ['ref_src_end_ms', 'src_end_ms'],
    ] as const) {
      expect(ref.get(refCol), refCol).toBe(src.get(srcCol));
    }
  });

  it('journaux en ajout seul : ni modification ni suppression', () => {
    const db = seeded();
    event(db, 'e1');
    expect(() => db.prepare(`UPDATE feedback_events SET comment = 'x'`).run()).toThrow(
      /ajout seul/,
    );
    expect(() => db.prepare('DELETE FROM feedback_events').run()).toThrow(/ajout seul/);
    db.prepare(
      `INSERT INTO review_requests (request_id, request_hash, proposal_id, action, outcome, response_json)
       VALUES ('q', 'h', 'p1', 'decision', 'noop', '{}')`,
    ).run();
    expect(() => db.prepare(`UPDATE review_requests SET outcome = 'applied'`).run()).toThrow(
      /ajout seul/,
    );
    expect(() => db.prepare('DELETE FROM review_requests').run()).toThrow(/ajout seul/);
    db.prepare(
      `INSERT INTO moment_changes (id, request_id, kind, proposal_id, from_moment_id, to_moment_id, source)
       VALUES ('c', 'q2', 'detach', 'p1', 'm1', 'm2', 'cli')`,
    ).run();
    expect(() => db.prepare('DELETE FROM moment_changes').run()).toThrow(/ajout seul/);
    // Une demande « noop » ne peut pas porter d'événement.
    expect(() =>
      db
        .prepare(
          `INSERT INTO review_requests (request_id, request_hash, proposal_id, action, outcome, event_id, response_json)
           VALUES ('q3', 'h', 'p1', 'decision', 'noop', 'e1', '{}')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('moments : référence figée, appartenance jamais modifiée (seulement supprimée puis recréée)', () => {
    const db = seeded();
    db.prepare(
      `INSERT INTO review_moments (id, recording_id, rule_version, ref_proposal_id, ref_punchline_segment_id,
         ref_punchline_ms, ref_src_start_ms, ref_src_end_ms) VALUES ('m1', 'r', 1, 'p1', 2, 15000, 1000, 30000)`,
    ).run();
    db.prepare(
      `INSERT INTO moment_members (proposal_id, moment_id, match_kind, score, rule_version)
       VALUES ('p1', 'm1', 'founder', 1, 1)`,
    ).run();
    expect(() => db.prepare('UPDATE review_moments SET ref_punchline_ms = 1').run()).toThrow(
      /figée/,
    );
    expect(() => db.prepare(`UPDATE moment_members SET moment_id = 'm1'`).run()).toThrow(
      /jamais modifiée/,
    );
    expect(db.prepare('DELETE FROM moment_members').run().changes).toBe(1);
  });

  it('décision courante : une réinitialisation ne garde ni motif, ni commentaire, ni date', () => {
    const db = seeded();
    event(db, 'e1');
    const ins = db.prepare(
      `INSERT OR REPLACE INTO proposal_reviews (proposal_id, status, reasons_json, comment, decided_at,
         last_event_id, last_event_seq, version) VALUES ('p1', ?, ?, ?, ?, 'e1', 1, 1)`,
    );
    const d = '2026-11-24T10:00:00.000Z';
    expect(() => ins.run('pending', '["pas_drole"]', null, null)).toThrow(/CHECK/);
    expect(() => ins.run('pending', '[]', 'ancien commentaire', null)).toThrow(/CHECK/);
    expect(() => ins.run('pending', '[]', null, d)).toThrow(/CHECK/);
    expect(() => ins.run('accepted', '["pas_drole"]', null, d)).toThrow(/CHECK/);
    expect(() => ins.run('rejected', '[]', null, d)).toThrow(/CHECK/);
    expect(() => ins.run('accepted', '[]', null, null)).toThrow(/CHECK/);
    ins.run('rejected', '["pas_drole","autre"]', 'son saturé', d);
    ins.run('pending', '[]', null, null);
    ins.run('accepted', '[]', 'top', d);
  });

  it('le journal survit à la suppression de l’analyse et de ses propositions', () => {
    const db = seeded();
    event(db, 'e1');
    db.prepare('DELETE FROM analysis_runs').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM clip_proposals').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_events').get()).toEqual({ n: 1 });
  });
});
