import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIO_GENERATOR_VERSION, AUDIO_PROFILES } from '@acs/media';
import { migrate, MIGRATIONS, openDatabase } from './db';
import { derivativeCacheKey } from './derivatives/cache-key';

describe('migration 2', () => {
  it('reprend les WAV de la v1 et convertit les traitements', () => {
    const storage = mkdtempSync(path.join(tmpdir(), 'acs-mig-'));
    const wav = path.join(storage, 'processing', 'rec1', 'audio', 'track-2-mic.wav');
    mkdirSync(path.dirname(wav), { recursive: true });
    writeFileSync(wav, Buffer.alloc(1234));

    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 1));
    db.prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         duration_sec, duration_source, game_id, media_info_json) VALUES
       ('rec1', '/videos/a.mkv', 'a.mkv', 10, 1, 'fp1', 'mkv', 60, 'format', 'generic', '{}')`,
    ).run();
    const track = db.prepare(
      `INSERT INTO audio_tracks (recording_id, audio_index, stream_index, role, role_source,
         extracted_path, extracted_duration_sec, extracted_at) VALUES ('rec1', ?, ?, ?, 'title', ?, ?, ?)`,
    );
    track.run(0, 1, 'mix', null, null, null);
    track.run(1, 2, 'mic', wav, 60.5, '2026-11-23T10:00:00Z');
    track.run(
      2,
      3,
      'discord',
      path.join(storage, 'processing', 'absent.wav'),
      60,
      '2026-11-23T10:00:00Z',
    );
    track.run(3, 4, 'game', '/ailleurs/hors-stockage.wav', 60, '2026-11-23T10:00:00Z');
    db.prepare(
      `INSERT INTO jobs (id, recording_id, type, status, progress) VALUES ('j1', 'rec1', 'extract_audio', 'succeeded', 1)`,
    ).run();

    expect(migrate(db, MIGRATIONS, { storageDir: storage })).toEqual(
      MIGRATIONS.slice(1).map((m) => m.version),
    );

    const ders = db.prepare('SELECT * FROM media_derivatives').all() as Record<string, unknown>[];
    expect(ders).toHaveLength(1); // seul le WAV présent et dans le stockage est repris
    expect(ders[0]).toMatchObject({
      kind: 'audio_transcription',
      audio_index: 1,
      rel_path: 'processing/rec1/audio/track-2-mic.wav',
      size_bytes: 1234,
      duration_ms: 60_500,
      src_start_ms: null,
      cache_key: derivativeCacheKey({
        sourceFingerprint: 'fp1',
        kind: 'audio_transcription',
        audioIndex: 1,
        range: null,
        params: { ...AUDIO_PROFILES.transcription },
        generatorVersion: AUDIO_GENERATOR_VERSION,
      }),
    });

    const cols = (db.prepare('PRAGMA table_info(audio_tracks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols.some((c) => c.startsWith('extracted'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audio_tracks').get()).toEqual({ n: 4 });

    expect(db.prepare('SELECT type, lane, target_key, status FROM jobs').get()).toEqual({
      type: 'extract_transcription_audio',
      lane: 'heavy',
      target_key: 'recording:rec1:transcription_audio',
      status: 'succeeded',
    });
    db.close();
  });

  it('garantit un seul traitement actif par clé de cible', () => {
    const db = openDatabase(':memory:');
    const ins = db.prepare(
      `INSERT INTO jobs (id, type, lane, target_key, status) VALUES (?, 'x', 'heavy', 'k1', ?)`,
    );
    ins.run('a', 'succeeded');
    ins.run('b', 'queued');
    expect(() => ins.run('c', 'running')).toThrow(/UNIQUE/);
    ins.run('d', 'failed'); // les traitements terminés ne comptent pas
    db.close();
  });

  it('refuse une plage de dérivé incohérente', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO media_derivatives (id, cache_key, recording_id, source_fingerprint, kind, src_start_ms,
         src_end_ms, params_json, generator_version, rel_path, size_bytes)
       VALUES (?, ?, 'r', 'fp', 'audio_stem', ?, ?, '{}', 1, ?, 1)`,
    );
    expect(() => ins.run('1', 'k1', 5000, 5000, 'p1')).toThrow(/CHECK/);
    expect(() => ins.run('2', 'k2', 5000, null, 'p2')).toThrow(/CHECK/);
    ins.run('3', 'k3', 0, 30_000, 'p3');
    db.close();
  });
});
