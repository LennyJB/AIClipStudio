import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase } from './db';

const rec = `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
  game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`;
const run = (id: string, mode = 'claude') =>
  `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
     transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd)
   VALUES ('${id}', 'r', '${mode}', 'pending', 1, 'p', 'k', '[]', '{}', '{}', '{}', 5)`;

describe('migration 5 (analyse avec Claude)', () => {
  it('s’applique sur une base v4 contenant des analyses, sans les modifier', () => {
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 4));
    db.prepare(rec).run();
    db.prepare(run('a', 'dry_run')).run();
    expect(migrate(db, MIGRATIONS)).toEqual([5]);
    expect(
      db.prepare('SELECT id, mode, prepared_from_run_id, force_recall FROM analysis_runs').get(),
    ).toEqual({
      id: 'a',
      mode: 'dry_run',
      prepared_from_run_id: null,
      force_recall: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('contraintes des propositions : bornes, niveaux, scores', () => {
    const db = openDatabase(':memory:');
    db.prepare(rec).run();
    db.prepare(run('a')).run();
    const ins = db.prepare(
      `INSERT INTO clip_proposals (id, run_id, recording_id, tier, title, explanation, categories_json,
         relevance, reliability, reliability_json, src_start_ms, src_end_ms, setup_segment_id,
         punchline_segment_id, reaction_end_segment_id, punchline_ms, standalone)
       VALUES (?, 'a', 'r', ?, 't', 'e', '[]', ?, ?, '{}', ?, ?, 1, 2, 3, 1500, 1)`,
    );
    ins.run('p1', 'clip', 80, 70, 1000, 30000);
    expect(() => ins.run('p2', 'rejet', 80, 70, 1000, 30000)).toThrow(/CHECK/);
    expect(() => ins.run('p3', 'clip', 101, 70, 1000, 30000)).toThrow(/CHECK/);
    expect(() => ins.run('p4', 'clip', 80, -1, 1000, 30000)).toThrow(/CHECK/);
    expect(() => ins.run('p5', 'clip', 80, 70, 30000, 1000)).toThrow(/CHECK/);
    expect(db.prepare(`SELECT review_status FROM clip_proposals WHERE id = 'p1'`).get()).toEqual({
      review_status: 'pending',
    });
  });

  it('statuts d’appel contrôlés ; suppression d’une analyse en cascade', () => {
    const db = openDatabase(':memory:');
    db.prepare(rec).run();
    db.prepare(run('a')).run();
    const ins = db.prepare(
      `INSERT INTO llm_calls (id, run_id, stage, model, prompt_version, request_hash, effort, max_tokens, status)
       VALUES (?, 'a', 'deep', 'claude-opus-5-5', 'deep-v1', 'h', 'high', 12000, ?)`,
    );
    ins.run('c1', 'reserved');
    expect(() => ins.run('c2', 'inconnu')).toThrow(/CHECK/);
    db.prepare(`DELETE FROM analysis_runs WHERE id = 'a'`).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get()).toEqual({ n: 0 });
  });
});
