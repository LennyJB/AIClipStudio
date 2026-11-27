/**
 * Types de contenu (étape 9) : détections automatiques et corrections du créateur, en ajout
 * seul. La segmentation EFFECTIVE (celle qu'utilise l'analyse) est calculée ici, en un seul
 * endroit : dernière correction si elle existe (et n'est pas un retour à l'automatique), sinon
 * dernière détection, sinon aucune.
 */
import type Database from 'better-sqlite3';
import type { ContentDetection, EffectiveContentSegment } from '@acs/editorial';

export interface ContentDetectionDto {
  id: number;
  recordingId: string;
  detectorVersion: string;
  inputKey: string;
  detection: ContentDetection;
  createdAt: string;
}

export interface ContentCorrectionDto {
  id: number;
  recordingId: string;
  basedOnDetectionId: number | null;
  /** null : retour à la détection automatique. */
  segments: EffectiveContentSegment[] | null;
  requestId: string;
  createdAt: string;
}

export interface EffectiveContent {
  source: 'manual' | 'auto';
  segments: EffectiveContentSegment[];
  detectionId: number | null;
  correctionId: number | null;
  /** Détection automatique : clé de ses entrées (null pour une correction). */
  detectionInputKey: string | null;
}

interface DetectionRow {
  id: number;
  recording_id: string;
  detector_version: string;
  input_key: string;
  detection_json: string;
  created_at: string;
}
interface CorrectionRow {
  id: number;
  recording_id: string;
  based_on_detection_id: number | null;
  segments_json: string | null;
  request_id: string;
  created_at: string;
}

const toDetection = (r: DetectionRow): ContentDetectionDto => ({
  id: r.id,
  recordingId: r.recording_id,
  detectorVersion: r.detector_version,
  inputKey: r.input_key,
  detection: JSON.parse(r.detection_json) as ContentDetection,
  createdAt: r.created_at,
});
const toCorrection = (r: CorrectionRow): ContentCorrectionDto => ({
  id: r.id,
  recordingId: r.recording_id,
  basedOnDetectionId: r.based_on_detection_id,
  segments: r.segments_json ? (JSON.parse(r.segments_json) as EffectiveContentSegment[]) : null,
  requestId: r.request_id,
  createdAt: r.created_at,
});

export class ContentRepository {
  constructor(private readonly db: Database.Database) {}

  latestDetection(recordingId: string): ContentDetectionDto | null {
    const r = this.db
      .prepare('SELECT * FROM content_detections WHERE recording_id = ? ORDER BY id DESC LIMIT 1')
      .get(recordingId) as DetectionRow | undefined;
    return r ? toDetection(r) : null;
  }

  insertDetection(recordingId: string, inputKey: string, d: ContentDetection): ContentDetectionDto {
    const info = this.db
      .prepare(
        `INSERT INTO content_detections (recording_id, detector_version, input_key, detection_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(recordingId, d.detectorVersion, inputKey, JSON.stringify(d));
    return toDetection(
      this.db
        .prepare('SELECT * FROM content_detections WHERE id = ?')
        .get(info.lastInsertRowid) as DetectionRow,
    );
  }

  latestCorrection(recordingId: string): ContentCorrectionDto | null {
    const r = this.db
      .prepare('SELECT * FROM content_corrections WHERE recording_id = ? ORDER BY id DESC LIMIT 1')
      .get(recordingId) as CorrectionRow | undefined;
    return r ? toCorrection(r) : null;
  }

  correctionByRequest(requestId: string): ContentCorrectionDto | null {
    const r = this.db
      .prepare('SELECT * FROM content_corrections WHERE request_id = ?')
      .get(requestId) as CorrectionRow | undefined;
    return r ? toCorrection(r) : null;
  }

  listCorrections(recordingId: string): ContentCorrectionDto[] {
    return (
      this.db
        .prepare('SELECT * FROM content_corrections WHERE recording_id = ? ORDER BY id')
        .all(recordingId) as CorrectionRow[]
    ).map(toCorrection);
  }

  insertCorrection(c: {
    recordingId: string;
    basedOnDetectionId: number | null;
    segments: EffectiveContentSegment[] | null;
    requestId: string;
  }): ContentCorrectionDto {
    const info = this.db
      .prepare(
        `INSERT INTO content_corrections (recording_id, based_on_detection_id, segments_json, request_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        c.recordingId,
        c.basedOnDetectionId,
        c.segments ? JSON.stringify(c.segments) : null,
        c.requestId,
      );
    return toCorrection(
      this.db
        .prepare('SELECT * FROM content_corrections WHERE id = ?')
        .get(info.lastInsertRowid) as CorrectionRow,
    );
  }

  /**
   * Segmentation effective BRUTE : la correction du créateur l'emporte toujours. La validité d'une
   * détection automatique (entrées inchangées) est vérifiée par `resolveContent` : ne jamais
   * utiliser ce résultat directement pour l'analyse.
   */
  effective(recordingId: string): EffectiveContent | null {
    const correction = this.latestCorrection(recordingId);
    if (correction?.segments) {
      return {
        source: 'manual',
        segments: correction.segments,
        detectionId: correction.basedOnDetectionId,
        correctionId: correction.id,
        detectionInputKey: null,
      };
    }
    const detection = this.latestDetection(recordingId);
    if (!detection) return null;
    return {
      source: 'auto',
      segments: detection.detection.segments.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        type: s.type,
        confidence: s.confidence,
        source: 'auto' as const,
      })),
      detectionId: detection.id,
      correctionId: correction?.id ?? null,
      detectionInputKey: detection.inputKey,
    };
  }
}
