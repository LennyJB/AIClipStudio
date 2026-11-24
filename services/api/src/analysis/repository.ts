import type { Db } from '../db';
import { NOW } from '../recordings/repository';

/* ------------------------------ Réglages ------------------------------ */

export interface AnalysisSettingsDto {
  recordingId: string;
  /** Accord explicite pour transmettre le texte de Discord et de la piste « tout ». */
  discordTextAllowed: boolean;
  discordConsentNote: string | null;
  discordConsentAt: string | null;
  facecamAllowed: boolean;
  framingProfileId: string | null;
  framingProfileHash: string | null;
  framingValidatedAt: string | null;
  updatedAt: string | null;
}

interface SettingsRow {
  recording_id: string;
  discord_text_allowed: number;
  discord_consent_note: string | null;
  discord_consent_at: string | null;
  facecam_allowed: number;
  framing_profile_id: string | null;
  framing_profile_hash: string | null;
  framing_validated_at: string | null;
  updated_at: string;
}

/** Réglages par défaut : RIEN d'autre que le micro n'est transmissible. */
export const defaultSettings = (recordingId: string): AnalysisSettingsDto => ({
  recordingId,
  discordTextAllowed: false,
  discordConsentNote: null,
  discordConsentAt: null,
  facecamAllowed: false,
  framingProfileId: null,
  framingProfileHash: null,
  framingValidatedAt: null,
  updatedAt: null,
});

/* ------------------------------ Analyses ------------------------------ */

export type AnalysisRunStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'budget_exhausted';

export interface AnalysisRunDto {
  id: string;
  recordingId: string;
  mode: 'dry_run' | 'claude';
  status: AnalysisRunStatus;
  stage: string | null;
  pipelineVersion: number;
  promptVersion: string | null;
  pricingVersion: string;
  memoryVersion: string | null;
  inputKey: string;
  transcriptionIds: string[];
  config: Record<string, unknown>;
  privacy: Record<string, unknown>;
  profiles: Record<string, unknown>;
  budgetUsd: number;
  estimate: unknown;
  spentUsd: number;
  reservedUsd: number;
  outputRelDir: string | null;
  windowCount: number;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface RunRow {
  id: string;
  recording_id: string;
  mode: string;
  status: string;
  stage: string | null;
  pipeline_version: number;
  prompt_version: string | null;
  pricing_version: string;
  memory_version: string | null;
  input_key: string;
  transcription_ids_json: string;
  config_json: string;
  privacy_json: string;
  profiles_json: string;
  budget_usd: number;
  estimate_json: string | null;
  spent_usd: number;
  reserved_usd: number;
  output_rel_dir: string | null;
  window_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const toRun = (r: RunRow): AnalysisRunDto => ({
  id: r.id,
  recordingId: r.recording_id,
  mode: r.mode as AnalysisRunDto['mode'],
  status: r.status as AnalysisRunStatus,
  stage: r.stage,
  pipelineVersion: r.pipeline_version,
  promptVersion: r.prompt_version,
  pricingVersion: r.pricing_version,
  memoryVersion: r.memory_version,
  inputKey: r.input_key,
  transcriptionIds: JSON.parse(r.transcription_ids_json) as string[],
  config: JSON.parse(r.config_json) as Record<string, unknown>,
  privacy: JSON.parse(r.privacy_json) as Record<string, unknown>,
  profiles: JSON.parse(r.profiles_json) as Record<string, unknown>,
  budgetUsd: r.budget_usd,
  estimate: r.estimate_json ? (JSON.parse(r.estimate_json) as unknown) : null,
  spentUsd: r.spent_usd,
  reservedUsd: r.reserved_usd,
  outputRelDir: r.output_rel_dir,
  windowCount: r.window_count,
  error: r.error_code ? { code: r.error_code, message: r.error_message ?? '' } : null,
  createdAt: r.created_at,
  startedAt: r.started_at,
  completedAt: r.completed_at,
});

export interface NewRun {
  id: string;
  recordingId: string;
  mode: 'dry_run' | 'claude';
  pipelineVersion: number;
  pricingVersion: string;
  inputKey: string;
  transcriptionIds: string[];
  config: Record<string, unknown>;
  privacy: Record<string, unknown>;
  profiles: Record<string, unknown>;
  budgetUsd: number;
}

/* ------------------------------ Fenêtres ------------------------------ */

export interface AnalysisWindowDto {
  id: string;
  runId: string;
  rank: number;
  origin: 'signals' | 'triage' | 'both';
  farStartMs: number;
  startMs: number;
  coreStartMs: number;
  coreEndMs: number;
  endMs: number;
  localScore: number;
  signals: unknown[];
  frames: unknown[];
  payloadRelPath: string | null;
  estimate: unknown;
  status: string;
  cacheKey: string;
  costUsd: number;
}

interface WindowRow {
  id: string;
  run_id: string;
  rank: number;
  origin: string;
  far_start_ms: number;
  src_start_ms: number;
  core_start_ms: number;
  core_end_ms: number;
  src_end_ms: number;
  local_score: number;
  signals_json: string;
  frames_json: string;
  payload_rel_path: string | null;
  estimate_json: string | null;
  status: string;
  cache_key: string;
  cost_usd: number;
}

const toWindow = (r: WindowRow): AnalysisWindowDto => ({
  id: r.id,
  runId: r.run_id,
  rank: r.rank,
  origin: r.origin as AnalysisWindowDto['origin'],
  farStartMs: r.far_start_ms,
  startMs: r.src_start_ms,
  coreStartMs: r.core_start_ms,
  coreEndMs: r.core_end_ms,
  endMs: r.src_end_ms,
  localScore: r.local_score,
  signals: JSON.parse(r.signals_json) as unknown[],
  frames: JSON.parse(r.frames_json) as unknown[],
  payloadRelPath: r.payload_rel_path,
  estimate: r.estimate_json ? (JSON.parse(r.estimate_json) as unknown) : null,
  status: r.status,
  cacheKey: r.cache_key,
  costUsd: r.cost_usd,
});

export type NewWindow = Omit<AnalysisWindowDto, 'runId' | 'costUsd'>;

export class AnalysisRepository {
  constructor(private readonly db: Db) {}

  /* Réglages */

  getSettings(recordingId: string): AnalysisSettingsDto {
    const r = this.db
      .prepare('SELECT * FROM recording_analysis_settings WHERE recording_id = ?')
      .get(recordingId) as SettingsRow | undefined;
    if (!r) return defaultSettings(recordingId);
    return {
      recordingId: r.recording_id,
      discordTextAllowed: r.discord_text_allowed === 1,
      discordConsentNote: r.discord_consent_note,
      discordConsentAt: r.discord_consent_at,
      facecamAllowed: r.facecam_allowed === 1,
      framingProfileId: r.framing_profile_id,
      framingProfileHash: r.framing_profile_hash,
      framingValidatedAt: r.framing_validated_at,
      updatedAt: r.updated_at,
    };
  }

  saveSettings(s: AnalysisSettingsDto): AnalysisSettingsDto {
    this.db
      .prepare(
        `INSERT INTO recording_analysis_settings (recording_id, discord_text_allowed, discord_consent_note,
           discord_consent_at, facecam_allowed, framing_profile_id, framing_profile_hash, framing_validated_at)
         VALUES (@recordingId, @discord, @note, @consentAt, @facecam, @framingId, @framingHash, @validatedAt)
         ON CONFLICT(recording_id) DO UPDATE SET discord_text_allowed = excluded.discord_text_allowed,
           discord_consent_note = excluded.discord_consent_note, discord_consent_at = excluded.discord_consent_at,
           facecam_allowed = excluded.facecam_allowed, framing_profile_id = excluded.framing_profile_id,
           framing_profile_hash = excluded.framing_profile_hash,
           framing_validated_at = excluded.framing_validated_at, updated_at = ${NOW}`,
      )
      .run({
        recordingId: s.recordingId,
        discord: s.discordTextAllowed ? 1 : 0,
        note: s.discordConsentNote,
        consentAt: s.discordConsentAt,
        facecam: s.facecamAllowed ? 1 : 0,
        framingId: s.framingProfileId,
        framingHash: s.framingProfileHash,
        validatedAt: s.framingValidatedAt,
      });
    return this.getSettings(s.recordingId);
  }

  /* Analyses */

  createRun(r: NewRun): AnalysisRunDto {
    this.db
      .prepare(
        `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
           transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd)
         VALUES (@id, @recordingId, @mode, 'pending', @pipelineVersion, @pricingVersion, @inputKey,
           @transcriptionIds, @config, @privacy, @profiles, @budgetUsd)`,
      )
      .run({
        ...r,
        transcriptionIds: JSON.stringify(r.transcriptionIds),
        config: JSON.stringify(r.config),
        privacy: JSON.stringify(r.privacy),
        profiles: JSON.stringify(r.profiles),
      });
    return this.getRun(r.id)!;
  }

  getRun(id: string): AnalysisRunDto | null {
    const r = this.db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(id) as
      RunRow | undefined;
    return r ? toRun(r) : null;
  }

  listRuns(recordingId: string): AnalysisRunDto[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM analysis_runs WHERE recording_id = ? ORDER BY created_at DESC, rowid DESC',
        )
        .all(recordingId) as RunRow[]
    ).map(toRun);
  }

  /** Analyse identique (mêmes entrées) déjà terminée ou en cours. */
  findReusable(inputKey: string, mode: 'dry_run' | 'claude'): AnalysisRunDto | null {
    const r = this.db
      .prepare(
        `SELECT * FROM analysis_runs WHERE input_key = ? AND mode = ?
           AND status IN ('pending','running','completed') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(inputKey, mode) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  markRunning(id: string) {
    this.db
      .prepare(
        `UPDATE analysis_runs SET status = 'running', started_at = COALESCE(started_at, ${NOW}),
           error_code = NULL, error_message = NULL, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(id);
  }

  setStage(id: string, stage: string) {
    this.db
      .prepare(`UPDATE analysis_runs SET stage = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(stage, id);
  }

  /** Fenêtres et résultat de la préparation, en une seule transaction. */
  completePreparation(
    id: string,
    data: { windows: readonly NewWindow[]; estimate: unknown; outputRelDir: string },
  ) {
    const del = this.db.prepare('DELETE FROM analysis_windows WHERE run_id = ?');
    const ins = this.db.prepare(
      `INSERT INTO analysis_windows (id, run_id, rank, origin, far_start_ms, src_start_ms, core_start_ms,
         core_end_ms, src_end_ms, local_score, signals_json, frames_json, payload_rel_path, estimate_json,
         status, cache_key)
       VALUES (@id, @runId, @rank, @origin, @farStartMs, @startMs, @coreStartMs, @coreEndMs, @endMs,
         @localScore, @signals, @frames, @payloadRelPath, @estimate, @status, @cacheKey)`,
    );
    this.db.transaction(() => {
      del.run(id);
      for (const w of data.windows) {
        ins.run({
          ...w,
          runId: id,
          signals: JSON.stringify(w.signals),
          frames: JSON.stringify(w.frames),
          estimate: w.estimate === null ? null : JSON.stringify(w.estimate),
        });
      }
      this.db
        .prepare(
          `UPDATE analysis_runs SET status = 'completed', stage = 'prepared', estimate_json = ?,
             output_rel_dir = ?, window_count = ?, completed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`,
        )
        .run(JSON.stringify(data.estimate), data.outputRelDir, data.windows.length, id);
    })();
  }

  finish(
    id: string,
    status: 'failed' | 'interrupted' | 'cancelled',
    error: { code: string; message: string },
  ) {
    this.db
      .prepare(
        `UPDATE analysis_runs SET status = ?, error_code = ?, error_message = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(status, error.code, error.message, id);
  }

  markStaleAsInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE analysis_runs SET status = 'interrupted', error_code = 'INTERRUPTED',
           error_message = 'Interrompue (arrêt du serveur)', updated_at = ${NOW}
         WHERE status IN ('pending','running')`,
      )
      .run().changes;
  }

  listWindows(runId: string): AnalysisWindowDto[] {
    return (
      this.db
        .prepare('SELECT * FROM analysis_windows WHERE run_id = ? ORDER BY rank')
        .all(runId) as WindowRow[]
    ).map(toWindow);
  }

  getWindow(runId: string, rank: number): AnalysisWindowDto | null {
    const r = this.db
      .prepare('SELECT * FROM analysis_windows WHERE run_id = ? AND rank = ?')
      .get(runId, rank) as WindowRow | undefined;
    return r ? toWindow(r) : null;
  }
}
