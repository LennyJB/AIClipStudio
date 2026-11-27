import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, openDatabase } from './db';

const ID = 'a'.repeat(64);
const insert = (over: Record<string, unknown> = {}) => {
  const row = {
    id: ID,
    kind: 'image',
    source_format: 'png',
    format: 'png',
    rel_path: `assets/aa/${ID}.png`,
    preview_rel_path: `assets/aa/${ID}.preview.png`,
    file_sha256: 'b'.repeat(64),
    size_bytes: 10,
    width: 4,
    height: 2,
    duration_ms: null,
    peaks_json: null,
    display_name: 'logo.png',
    rights: 'own',
    rights_note: null,
    normalizer_version: 1,
    ...over,
  };
  const cols = Object.keys(row);
  return [
    `INSERT INTO media_assets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    Object.values(row),
  ] as const;
};

describe('migration 10 : bibliothèque de médias', () => {
  it('est la dixième migration ; appliquée sur une base v9 sans toucher aux données existantes', () => {
    expect(MIGRATIONS[9]).toMatchObject({ version: 10, name: 'media_assets' });
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 9));
    expect(migrate(db, MIGRATIONS.slice(0, 10))).toEqual([10]);
    expect(db.prepare('SELECT count(*) AS n FROM media_assets').get()).toEqual({ n: 0 });
  });

  it('contraintes : identifiant sha256, chemin relatif sous assets/, cohérence image/son, droits déclarés', () => {
    const db = openDatabase(':memory:');
    const run = (over: Record<string, unknown>) => {
      const [sql, args] = insert(over);
      return () => db.prepare(sql).run(...args);
    };
    for (const bad of [
      { id: 'A'.repeat(64) },
      { id: 'a'.repeat(63) },
      { rel_path: '/etc/passwd' },
      { rel_path: `assets/../../${ID}.png` },
      { rel_path: `processing/${ID}.png` },
      { kind: 'audio' }, // un son doit être un WAV avec durée et forme d'onde
      { format: 'wav' },
      { rights: 'unknown' },
      { width: null },
      { preview_rel_path: null },
      { display_name: '' },
      { source_format: 'svg' },
    ]) {
      expect(run(bad), JSON.stringify(bad)).toThrow();
    }
    run({})();
    // Son valide.
    const SND = 'c'.repeat(64);
    run({
      id: SND,
      kind: 'audio',
      source_format: 'mp3',
      format: 'wav',
      rel_path: `assets/cc/${SND}.wav`,
      preview_rel_path: null,
      width: null,
      height: null,
      duration_ms: 500,
      peaks_json: '[0.1,0.2]',
    })();
    expect(db.prepare('SELECT count(*) AS n FROM media_assets').get()).toEqual({ n: 2 });
  });

  it('le fichier d’un média est immuable (seuls le nom affiché et la note peuvent changer)', () => {
    const db = openDatabase(':memory:');
    const [sql, args] = insert();
    db.prepare(sql).run(...args);
    for (const col of ['rel_path', 'file_sha256', 'size_bytes', 'kind', 'width']) {
      expect(() =>
        db.prepare(`UPDATE media_assets SET ${col} = ${col} WHERE id = ?`).run(ID),
      ).toThrow(/immuable/u);
    }
    db.prepare(`UPDATE media_assets SET display_name = 'nouveau.png' WHERE id = ?`).run(ID);
  });
});
