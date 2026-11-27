import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase } from './db';

const H = 'h'.repeat(64);

describe('migration 12 : profils de style', () => {
  it('est la douzième migration ; appliquée sur une base v11 ; six profils fournis', () => {
    expect(MIGRATIONS[11]).toMatchObject({ version: 12, name: 'style_profiles' });
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 11));
    expect(migrate(db, MIGRATIONS.slice(0, 12))).toEqual([12]);
    const rows = db.prepare('SELECT id, builtin FROM style_profiles ORDER BY id').all();
    expect(rows).toEqual(
      ['gaming', 'irl', 'just_chatting', 'mixed', 'podcast', 'reaction'].map((id) => ({
        id,
        builtin: 1,
      })),
    );
  });

  it('versions et validations en ajout seul ; profils fournis non supprimables ; fichiers d’une référence figés', () => {
    const db = openDatabase(':memory:');
    const v = db.prepare(
      `INSERT INTO style_profile_versions (profile_id, version, features_json, features_hash, origin, based_on_version, evidence_json, request_id)
       VALUES ('gaming', ?, '{}', ?, 'manual', ?, '{}', ?)`,
    );
    v.run(1, H, null, 'requete-0001');
    expect(() => v.run(2, H, 3, 'requete-0002')).toThrow(/CHECK/u);
    expect(() => v.run(2, H, 1, 'requete-0001')).toThrow(/UNIQUE/u);
    expect(() =>
      db.prepare(`UPDATE style_profile_versions SET features_json = '{"x":1}'`).run(),
    ).toThrow(/immuable/u);
    const val = db.prepare(
      `INSERT INTO style_profile_validations (profile_id, version, features_hash, request_id) VALUES ('gaming', ?, ?, ?)`,
    );
    val.run(1, H, 'valide-0001');
    expect(() => val.run(9, H, 'valide-0002')).toThrow(/FOREIGN KEY/u);
    expect(() => db.prepare(`UPDATE style_profile_validations SET version = 1`).run()).toThrow(
      /ajout seul/u,
    );
    expect(() => db.prepare(`DELETE FROM style_profiles WHERE id = 'gaming'`).run()).toThrow(
      /non supprimable/u,
    );

    const ref = db.prepare(
      `INSERT INTO style_references (id, kind, label, source_path, file_name, fingerprint, raw_path, raw_file_name, raw_fingerprint)
       VALUES (?, ?, 'Réf', '/v/a.mp4', 'a.mp4', ?, ?, ?, ?)`,
    );
    expect(() => ref.run('r0', 'pair', 'fp0', null, null, null)).toThrow(/CHECK/u);
    ref.run('r1', 'edited', 'fp1', null, null, null);
    ref.run('r2', 'pair', 'fp1', '/v/brut.mkv', 'brut.mkv', 'fpraw');
    expect(() => ref.run('r3', 'edited', 'fp1', null, null, null)).toThrow(/UNIQUE/u);
    expect(() =>
      db.prepare(`UPDATE style_references SET source_path = '/autre.mp4' WHERE id = 'r1'`).run(),
    ).toThrow(/immuables/u);
    db.prepare(
      `UPDATE style_references SET label = 'Nouveau', profile_id = 'irl' WHERE id = 'r1'`,
    ).run();
    expect(() =>
      db.prepare(`UPDATE style_references SET status = 'analyzed' WHERE id = 'r1'`).run(),
    ).toThrow(/CHECK/u);
  });
});
