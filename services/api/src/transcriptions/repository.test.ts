import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db';
import { TranscriptionRepository, type BlockCommit } from './repository';

let db: Db;
let repo: TranscriptionRepository;

const seg = (startMs: number, endMs: number, text = `s${startMs}`) => ({
  startMs,
  endMs,
  text,
  avgLogprob: -0.3,
  noSpeechProb: 0.02,
  compressionRatio: 1.3,
  words: [{ word: text, startMs, endMs, probability: 0.9 }],
  suspicionScore: 0,
  suspicionReasons: [],
});

function newRun(id: string, audioIndex: number, cacheKey = `key-${id}`) {
  return repo.create({
    id,
    recordingId: 'rec',
    audioIndex,
    cacheKey,
    comparisonKey: 'cmp',
    inputAudioKey: 'wav',
    sourceFingerprint: 'fp',
    model: 'large-v3-turbo',
    computeTypeRequested: 'auto',
    deviceRequested: 'auto',
    params: { beamSize: 5 },
  });
}

const block = (over: Partial<BlockCommit> = {}): BlockCommit => ({
  transcriptionId: 't1',
  expectedCheckpointMs: 0,
  coreStartMs: 0,
  coreEndMs: 1_200_000,
  device: 'cuda',
  computeType: 'float16',
  fallbackError: null,
  elapsedMs: 40_000,
  audioMs: 1_230_000,
  segments: [seg(1_000, 3_000), seg(5_000, 6_500)],
  deduplicated: 0,
  language: { code: 'fr', probability: 0.98, source: 'detected' },
  ...over,
});

beforeEach(() => {
  db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
       game_id, media_info_json) VALUES ('rec', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'valorant', '{}')`,
  ).run();
  const t = db.prepare(
    `INSERT INTO audio_tracks (recording_id, audio_index, stream_index, role, role_source) VALUES ('rec', ?, ?, ?, 'title')`,
  );
  t.run(1, 2, 'mic');
  t.run(2, 3, 'discord');
  repo = new TranscriptionRepository(db);
  newRun('t1', 1);
});

describe('commitBlock', () => {
  it('enregistre segments, bloc, checkpoint et langue ensemble', () => {
    expect(repo.commitBlock(block())).toBe(2);
    const t = repo.get('t1')!;
    expect(t).toMatchObject({
      checkpointMs: 1_200_000,
      segmentCount: 2,
      processingMs: 40_000,
      language: 'fr',
      languageSource: 'detected',
      devicesUsed: ['cuda'],
      fallbackError: null,
    });
    expect(t.realtimeFactor).toBe(30); // 20 min d'audio en 40 s
  });

  it('échec au milieu de l’écriture : RIEN n’est enregistré et le checkpoint n’avance pas', () => {
    const bad = block({ segments: [seg(1_000, 3_000), seg(9_000, 9_000)] }); // durée nulle : refusée par CHECK
    expect(() => repo.commitBlock(bad)).toThrow();
    expect(repo.get('t1')).toMatchObject({
      checkpointMs: 0,
      segmentCount: 0,
      processingMs: 0,
      language: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcription_blocks').get()).toEqual({ n: 0 });
  });

  it('refuse un bloc dont le checkpoint attendu ne correspond pas (double enregistrement)', () => {
    repo.commitBlock(block());
    expect(() =>
      repo.commitBlock(
        block({ expectedCheckpointMs: 0, coreStartMs: 1_200_000, coreEndMs: 2_400_000 }),
      ),
    ).toThrow(/Checkpoint inattendu/);
    expect(repo.get('t1')).toMatchObject({ checkpointMs: 1_200_000, segmentCount: 2 });
  });

  it('la contrainte SQL écarte un segment strictement identique déjà enregistré', () => {
    repo.commitBlock(block());
    const n = repo.commitBlock(
      block({
        expectedCheckpointMs: 1_200_000,
        coreStartMs: 1_200_000,
        coreEndMs: 2_400_000,
        segments: [seg(5_000, 6_500), seg(1_300_000, 1_302_000)],
        language: null,
      }),
    );
    expect(n).toBe(1);
    const b = db
      .prepare(
        'SELECT segments_kept, segments_deduplicated FROM transcription_blocks WHERE core_start_ms = 1200000',
      )
      .get();
    expect(b).toEqual({ segments_kept: 1, segments_deduplicated: 1 });
  });

  it('un repli CPU est visible : périphériques mixtes et erreur CUDA conservée', () => {
    repo.commitBlock(block());
    repo.commitBlock(
      block({
        expectedCheckpointMs: 1_200_000,
        coreStartMs: 1_200_000,
        coreEndMs: 2_400_000,
        device: 'cpu',
        computeType: 'int8',
        fallbackError: 'RuntimeError: Could not load library cudnn_ops64_9.dll',
        segments: [],
        language: null,
      }),
    );
    expect(repo.get('t1')).toMatchObject({
      devicesUsed: ['cpu', 'cuda'],
      fallbackError: expect.stringContaining('cudnn'),
    });
  });

  it('la langue détectée au premier bloc n’est pas écrasée ensuite', () => {
    repo.commitBlock(block());
    repo.commitBlock(
      block({
        expectedCheckpointMs: 1_200_000,
        coreStartMs: 1_200_000,
        coreEndMs: 2_400_000,
        segments: [],
        language: { code: 'en', probability: 0.5, source: 'detected' },
      }),
    );
    expect(repo.get('t1')?.language).toBe('fr');
  });
});

describe('lecture', () => {
  it('segments de plusieurs pistes par ordre chronologique, avec leur rôle', () => {
    newRun('t2', 2);
    repo.commitBlock(
      block({ segments: [seg(1_000, 3_000, 'micro A'), seg(8_000, 9_000, 'micro B')] }),
    );
    repo.commitBlock(block({ transcriptionId: 't2', segments: [seg(2_000, 4_000, 'discord A')] }));
    const s = repo.segments({ recordingId: 'rec', transcriptionIds: ['t1', 't2'] });
    expect(s.map((x) => [x.text, x.role])).toEqual([
      ['micro A', 'mic'],
      ['discord A', 'discord'],
      ['micro B', 'mic'],
    ]);
    expect(s[0]!.words[0]).toMatchObject({ startMs: 1_000, probability: 0.9 });
    expect(
      repo.segments({ recordingId: 'rec', transcriptionIds: ['t1', 't2'], audioIndexes: [2] }),
    ).toHaveLength(1);
    expect(
      repo
        .segments({
          recordingId: 'rec',
          transcriptionIds: ['t1', 't2'],
          fromMs: 3_500,
          toMs: 8_500,
        })
        .map((x) => x.text),
    ).toEqual(['discord A', 'micro B']);
  });

  it('réutilisation et reprise par clé de cache', () => {
    expect(repo.findCompleted('key-t1')).toBeNull();
    expect(repo.findResumable('key-t1')?.id).toBe('t1');
    repo.complete('t1');
    expect(repo.findCompleted('key-t1')?.id).toBe('t1');
    expect(repo.findResumable('key-t1')).toBeNull();
  });

  it('au démarrage, une transcription en cours devient interrompue en gardant son checkpoint', () => {
    repo.markRunning('t1', {
      engineVersion: '1.2.1',
      ctranslate2Version: '4.9.1',
      audioDurationMs: 3_600_000,
      modelLoadMs: 900,
    });
    repo.commitBlock(block());
    expect(repo.markStaleAsInterrupted()).toBe(1);
    expect(repo.get('t1')).toMatchObject({
      status: 'interrupted',
      checkpointMs: 1_200_000,
      error: { code: 'INTERRUPTED' },
    });
  });
});
