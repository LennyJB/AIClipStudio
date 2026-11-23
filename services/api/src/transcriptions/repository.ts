import type { RawSegment, SuspicionReason } from '@acs/transcription';
import type { Db } from '../db';
import { NOW } from '../recordings/repository';

export type TranscriptionStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type Device = 'cuda' | 'cpu';

export interface TranscriptionDto {
  id: string;
  recordingId: string;
  audioIndex: number;
  cacheKey: string;
  comparisonKey: string;
  model: string;
  engine: string;
  engineVersion: string | null;
  computeTypeRequested: string;
  deviceRequested: 'auto' | Device;
  /** Périphériques RÉELLEMENT utilisés (d'après les blocs enregistrés). */
  devicesUsed: Device[];
  /** Erreur CUDA ayant entraîné un repli CPU (premier repli rencontré), sinon null. */
  fallbackError: string | null;
  params: Record<string, unknown>;
  status: TranscriptionStatus;
  language: string | null;
  languageProbability: number | null;
  languageSource: 'detected' | 'forced' | null;
  audioDurationMs: number | null;
  checkpointMs: number;
  segmentCount: number;
  processingMs: number;
  modelLoadMs: number | null;
  /** Durée audio traitée / durée de traitement (ex. 25 = 25× plus rapide que le temps réel). */
  realtimeFactor: number | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface SegmentDto {
  id: number;
  transcriptionId: string;
  recordingId: string;
  audioIndex: number;
  role: string | null;
  srcStartMs: number;
  srcEndMs: number;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
  suspicionScore: number;
  suspicionReasons: SuspicionReason[];
  words: RawSegment['words'];
}

interface Row {
  id: string;
  recording_id: string;
  audio_index: number;
  cache_key: string;
  comparison_key: string;
  engine: string;
  engine_version: string | null;
  model: string;
  compute_type_requested: string;
  device_requested: string;
  params_json: string;
  status: string;
  language: string | null;
  language_probability: number | null;
  language_source: string | null;
  audio_duration_ms: number | null;
  checkpoint_ms: number;
  segment_count: number;
  processing_ms: number;
  model_load_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  devices: string | null;
  fallback_error: string | null;
  processed_audio_ms: number | null;
}

const SELECT = `
  SELECT t.*,
    (SELECT group_concat(DISTINCT b.device) FROM transcription_blocks b WHERE b.transcription_id = t.id) AS devices,
    (SELECT b.fallback_error FROM transcription_blocks b WHERE b.transcription_id = t.id
       AND b.fallback_error IS NOT NULL ORDER BY b.core_start_ms LIMIT 1) AS fallback_error,
    (SELECT SUM(b.core_end_ms - b.core_start_ms) FROM transcription_blocks b WHERE b.transcription_id = t.id)
       AS processed_audio_ms
  FROM transcriptions t`;

function toDto(r: Row): TranscriptionDto {
  return {
    id: r.id,
    recordingId: r.recording_id,
    audioIndex: r.audio_index,
    cacheKey: r.cache_key,
    comparisonKey: r.comparison_key,
    model: r.model,
    engine: r.engine,
    engineVersion: r.engine_version,
    computeTypeRequested: r.compute_type_requested,
    deviceRequested: r.device_requested as TranscriptionDto['deviceRequested'],
    devicesUsed: r.devices ? (r.devices.split(',').sort() as Device[]) : [],
    fallbackError: r.fallback_error,
    params: JSON.parse(r.params_json) as Record<string, unknown>,
    status: r.status as TranscriptionStatus,
    language: r.language,
    languageProbability: r.language_probability,
    languageSource: r.language_source as TranscriptionDto['languageSource'],
    audioDurationMs: r.audio_duration_ms,
    checkpointMs: r.checkpoint_ms,
    segmentCount: r.segment_count,
    processingMs: r.processing_ms,
    modelLoadMs: r.model_load_ms,
    realtimeFactor:
      r.processing_ms > 0 && r.processed_audio_ms
        ? Math.round((r.processed_audio_ms / r.processing_ms) * 100) / 100
        : null,
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? '' } : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export interface NewTranscription {
  id: string;
  recordingId: string;
  audioIndex: number;
  cacheKey: string;
  comparisonKey: string;
  inputAudioKey: string;
  sourceFingerprint: string;
  model: string;
  computeTypeRequested: string;
  deviceRequested: 'auto' | Device;
  params: Record<string, unknown>;
}

export interface BlockCommit {
  transcriptionId: string;
  /** Checkpoint attendu en base : protège contre un double enregistrement du même bloc. */
  expectedCheckpointMs: number;
  coreStartMs: number;
  coreEndMs: number;
  device: Device;
  computeType: string;
  fallbackError: string | null;
  elapsedMs: number;
  audioMs: number;
  segments: (RawSegment & { suspicionScore: number; suspicionReasons: SuspicionReason[] })[];
  deduplicated: number;
  /** Langue à enregistrer si elle ne l'est pas encore. */
  language: { code: string; probability: number | null; source: 'detected' | 'forced' } | null;
}

export class TranscriptionRepository {
  constructor(private readonly db: Db) {}

  create(t: NewTranscription): TranscriptionDto {
    this.db
      .prepare(
        `INSERT INTO transcriptions (id, recording_id, audio_index, cache_key, comparison_key, input_audio_key,
           source_fingerprint, model, compute_type_requested, device_requested, params_json, status)
         VALUES (@id, @recordingId, @audioIndex, @cacheKey, @comparisonKey, @inputAudioKey, @sourceFingerprint,
           @model, @computeTypeRequested, @deviceRequested, @params, 'pending')`,
      )
      .run({ ...t, params: JSON.stringify(t.params) });
    return this.get(t.id)!;
  }

  get(id: string): TranscriptionDto | null {
    const r = this.db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    return r ? toDto(r) : null;
  }

  listForRecording(recordingId: string): TranscriptionDto[] {
    return (
      this.db
        .prepare(`${SELECT} WHERE t.recording_id = ? ORDER BY t.audio_index, t.created_at DESC`)
        .all(recordingId) as Row[]
    ).map(toDto);
  }

  /** Dernière transcription TERMINÉE pour cette clé (réutilisation sans retranscrire). */
  findCompleted(cacheKey: string): TranscriptionDto | null {
    const r = this.db
      .prepare(
        `${SELECT} WHERE t.cache_key = ? AND t.status = 'completed' ORDER BY t.completed_at DESC LIMIT 1`,
      )
      .get(cacheKey) as Row | undefined;
    return r ? toDto(r) : null;
  }

  /** Transcription inachevée (même clé) à reprendre depuis son checkpoint. */
  findResumable(cacheKey: string): TranscriptionDto | null {
    const r = this.db
      .prepare(
        `${SELECT} WHERE t.cache_key = ? AND t.status IN ('pending','running','interrupted','failed','cancelled')
         ORDER BY t.checkpoint_ms DESC, t.created_at DESC LIMIT 1`,
      )
      .get(cacheKey) as Row | undefined;
    return r ? toDto(r) : null;
  }

  markRunning(
    id: string,
    info: {
      engineVersion: string;
      ctranslate2Version: string;
      audioDurationMs: number;
      modelLoadMs: number;
    },
  ) {
    this.db
      .prepare(
        `UPDATE transcriptions SET status = 'running', engine_version = ?, ctranslate2_version = ?,
           audio_duration_ms = ?, model_load_ms = ?, error_code = NULL, error_message = NULL,
           started_at = COALESCE(started_at, ${NOW}), updated_at = ${NOW}
         WHERE id = ?`,
      )
      .run(info.engineVersion, info.ctranslate2Version, info.audioDurationMs, info.modelLoadMs, id);
  }

  /**
   * Enregistre UN bloc : segments, bloc et nouveau checkpoint dans une transaction unique.
   * Si quoi que ce soit échoue (y compris un checkpoint inattendu), rien n'est écrit et le
   * checkpoint n'avance pas. Renvoie le nombre de segments réellement insérés.
   */
  commitBlock(c: BlockCommit): number {
    return this.db.transaction(() => {
      // Pas de « INSERT OR IGNORE » : il ignorerait aussi les violations de CHECK (segment
      // invalide écarté en silence). Les doublons exacts sont écartés explicitement ; toute
      // autre violation fait échouer la transaction entière.
      const exists = this.db.prepare(
        `SELECT 1 FROM transcript_segments WHERE transcription_id = ? AND src_start_ms = ? AND src_end_ms = ?`,
      );
      const insert = this.db.prepare(
        `INSERT INTO transcript_segments (transcription_id, recording_id, audio_index, src_start_ms,
           src_end_ms, text, avg_logprob, no_speech_prob, compression_ratio, suspicion_score,
           suspicion_reasons_json, words_json)
         SELECT ?, recording_id, audio_index, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM transcriptions WHERE id = ?`,
      );
      let inserted = 0;
      for (const s of c.segments) {
        if (exists.get(c.transcriptionId, s.startMs, s.endMs)) continue;
        inserted += insert.run(
          c.transcriptionId,
          s.startMs,
          s.endMs,
          s.text,
          s.avgLogprob,
          s.noSpeechProb,
          s.compressionRatio,
          s.suspicionScore,
          JSON.stringify(s.suspicionReasons),
          JSON.stringify(s.words),
          c.transcriptionId,
        ).changes;
      }
      this.db
        .prepare(
          `INSERT INTO transcription_blocks (transcription_id, core_start_ms, core_end_ms, device, compute_type,
             fallback_error, elapsed_ms, audio_ms, segments_kept, segments_deduplicated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.transcriptionId,
          c.coreStartMs,
          c.coreEndMs,
          c.device,
          c.computeType,
          c.fallbackError,
          c.elapsedMs,
          c.audioMs,
          inserted,
          c.deduplicated + (c.segments.length - inserted),
        );
      const updated = this.db
        .prepare(
          `UPDATE transcriptions SET checkpoint_ms = ?, segment_count = segment_count + ?,
             processing_ms = processing_ms + ?, updated_at = ${NOW},
             language = COALESCE(language, ?), language_probability = COALESCE(language_probability, ?),
             language_source = COALESCE(language_source, ?)
           WHERE id = ? AND checkpoint_ms = ?`,
        )
        .run(
          c.coreEndMs,
          inserted,
          c.elapsedMs,
          c.language?.code ?? null,
          c.language?.probability ?? null,
          c.language?.source ?? null,
          c.transcriptionId,
          c.expectedCheckpointMs,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `Checkpoint inattendu pour ${c.transcriptionId} (attendu ${c.expectedCheckpointMs}) : bloc non enregistré`,
        );
      }
      return inserted;
    })();
  }

  /** Segments enregistrés qui chevauchent [fromMs, toMs[ (déduplication aux frontières). */
  segmentsBetween(transcriptionId: string, fromMs: number, toMs: number) {
    return this.db
      .prepare(
        `SELECT src_start_ms AS startMs, src_end_ms AS endMs, text FROM transcript_segments
           WHERE transcription_id = ? AND src_end_ms > ? AND src_start_ms < ? ORDER BY src_start_ms`,
      )
      .all(transcriptionId, fromMs, toMs) as { startMs: number; endMs: number; text: string }[];
  }

  setLanguageIfUnknown(
    id: string,
    code: string,
    source: 'detected' | 'forced',
    probability: number | null,
  ) {
    this.db
      .prepare(
        `UPDATE transcriptions SET language = ?, language_source = ?, language_probability = ?
         WHERE id = ? AND language IS NULL`,
      )
      .run(code, source, probability, id);
  }

  complete(id: string) {
    this.db
      .prepare(
        `UPDATE transcriptions SET status = 'completed', completed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(id);
  }

  finish(
    id: string,
    status: 'failed' | 'interrupted' | 'cancelled',
    error: { code: string; message: string },
  ) {
    this.db
      .prepare(
        `UPDATE transcriptions SET status = ?, error_code = ?, error_message = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(status, error.code, error.message, id);
  }

  /** Au démarrage : toute transcription « en cours » a été interrompue (son checkpoint est conservé). */
  markStaleAsInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE transcriptions SET status = 'interrupted', error_code = 'INTERRUPTED',
           error_message = 'Interrompue (arrêt du serveur)', updated_at = ${NOW}
         WHERE status IN ('running','pending')`,
      )
      .run().changes;
  }

  /**
   * Segments d'un enregistrement, par ordre chronologique (toutes pistes confondues),
   * pour un ensemble de transcriptions. Filtres facultatifs : pistes, plage source.
   */
  segments(q: {
    recordingId: string;
    transcriptionIds: readonly string[];
    audioIndexes?: readonly number[] | undefined;
    fromMs?: number | undefined;
    toMs?: number | undefined;
    limit?: number | undefined;
  }): SegmentDto[] {
    if (!q.transcriptionIds.length) return [];
    const where = [
      `s.recording_id = ?`,
      `s.transcription_id IN (${q.transcriptionIds.map(() => '?').join(',')})`,
    ];
    const args: unknown[] = [q.recordingId, ...q.transcriptionIds];
    if (q.audioIndexes?.length) {
      where.push(`s.audio_index IN (${q.audioIndexes.map(() => '?').join(',')})`);
      args.push(...q.audioIndexes);
    }
    if (q.fromMs !== undefined) {
      where.push('s.src_end_ms > ?');
      args.push(q.fromMs);
    }
    if (q.toMs !== undefined) {
      where.push('s.src_start_ms < ?');
      args.push(q.toMs);
    }
    const rows = this.db
      .prepare(
        `SELECT s.*, a.role FROM transcript_segments s
         LEFT JOIN audio_tracks a ON a.recording_id = s.recording_id AND a.audio_index = s.audio_index
         WHERE ${where.join(' AND ')}
         ORDER BY s.src_start_ms, s.audio_index, s.src_end_ms LIMIT ?`,
      )
      .all(...args, q.limit ?? 5000) as {
      id: number;
      transcription_id: string;
      recording_id: string;
      audio_index: number;
      role: string | null;
      src_start_ms: number;
      src_end_ms: number;
      text: string;
      avg_logprob: number;
      no_speech_prob: number;
      compression_ratio: number;
      suspicion_score: number;
      suspicion_reasons_json: string;
      words_json: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      transcriptionId: r.transcription_id,
      recordingId: r.recording_id,
      audioIndex: r.audio_index,
      role: r.role,
      srcStartMs: r.src_start_ms,
      srcEndMs: r.src_end_ms,
      text: r.text,
      avgLogprob: r.avg_logprob,
      noSpeechProb: r.no_speech_prob,
      compressionRatio: r.compression_ratio,
      suspicionScore: r.suspicion_score,
      suspicionReasons: JSON.parse(r.suspicion_reasons_json) as SuspicionReason[],
      words: JSON.parse(r.words_json) as RawSegment['words'],
    }));
  }
}
