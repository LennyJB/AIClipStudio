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

/** Étape d'une analyse avec Claude en pause, en attente de la relecture des requêtes Opus. */
export const AWAITING_REVIEW = 'awaiting_review';
/** Code d'une analyse en pause remplacée par une nouvelle (jamais reprise). */
export const SUPERSEDED = 'SUPERSEDED';

/** Ce qui est montré au créateur pendant la pause de relecture. */
export interface ReviewInfo {
  pausedAt: string;
  /** Requêtes Opus prêtes (une par fenêtre restant à analyser), dans requetes/. */
  deepRequests: number;
  /** Pire cas estimé localement (sans comptage par l'API) de ces requêtes. */
  deepMaxUsd: number;
  /** Plafond restant (plafond − déjà dépensé). */
  remainingUsd: number;
}

/** Pause de relecture : en attente (pas encore approuvée) ? */
export function isAwaitingReview(run: AnalysisRunDto): boolean {
  return (
    run.mode === 'claude' &&
    run.status === 'pending' &&
    run.stage === AWAITING_REVIEW &&
    !(run.config as { reviewApprovedAt?: string }).reviewApprovedAt
  );
}

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
  /** Plafond de RÉSERVATION : dépensé (compté) + réservé ne le dépasse jamais (contrainte en base). */
  budgetUsd: number;
  estimate: unknown;
  /** Part du coût comptée dans le plafond (≤ budget). */
  spentUsd: number;
  reservedUsd: number;
  outputRelDir: string | null;
  windowCount: number;
  preparedFromRunId: string | null;
  streamSummary: string | null;
  forceRecall: boolean;
  /** Coût réel calculé au-delà du plafond (0 normalement). */
  overrunUsd: number;
  /** Coût réel calculé total = dépensé + dépassement ; peut excéder `budgetUsd` si overrunUsd > 0. */
  totalCostUsd: number;
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
  prepared_from_run_id: string | null;
  stream_summary: string | null;
  force_recall: number;
  overrun_usd: number;
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
  preparedFromRunId: r.prepared_from_run_id,
  streamSummary: r.stream_summary,
  forceRecall: r.force_recall === 1,
  overrunUsd: r.overrun_usd,
  totalCostUsd: Math.round((r.spent_usd + r.overrun_usd) * 1e9) / 1e9,
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
  promptVersion?: string | null;
  forceRecall?: boolean;
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
           transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd, prompt_version,
           force_recall)
         VALUES (@id, @recordingId, @mode, 'pending', @pipelineVersion, @pricingVersion, @inputKey,
           @transcriptionIds, @config, @privacy, @profiles, @budgetUsd, @promptVersion, @forceRecall)`,
      )
      .run({
        ...r,
        promptVersion: r.promptVersion ?? null,
        forceRecall: r.forceRecall ? 1 : 0,
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

  /**
   * Analyse identique (mêmes entrées) déjà terminée ou en cours. Une analyse arrêtée par le
   * budget compte comme terminée : la relancer sans `force` ne dépense rien de plus.
   */
  findReusable(inputKey: string, mode: 'dry_run' | 'claude'): AnalysisRunDto | null {
    const r = this.db
      .prepare(
        `SELECT * FROM analysis_runs WHERE input_key = ? AND mode = ?
           AND status IN ('pending','running','completed','budget_exhausted')
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(inputKey, mode) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  /**
   * Analyse interrompue ou en échec avec les mêmes entrées : reprise (même budget).
   * `forceRecall` (mode claude) : seule une analyse lancée avec la même option est reprise,
   * pour qu'une reprise ne redemande jamais à Claude ce que le créateur n'a pas demandé.
   */
  findResumable(
    inputKey: string,
    mode: 'dry_run' | 'claude',
    forceRecall = false,
  ): AnalysisRunDto | null {
    const r = this.db
      .prepare(
        `SELECT * FROM analysis_runs WHERE input_key = ? AND mode = ? AND force_recall = ?
           AND status IN ('interrupted','failed','cancelled')
           AND COALESCE(error_code, '') <> '${SUPERSEDED}'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(inputKey, mode, forceRecall ? 1 : 0) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  setPreparedFrom(id: string, preparedRunId: string, outputRelDir: string) {
    this.db
      .prepare(
        `UPDATE analysis_runs SET prepared_from_run_id = ?, output_rel_dir = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(preparedRunId, outputRelDir, id);
  }

  setStreamSummary(id: string, summary: string | null) {
    this.db
      .prepare(`UPDATE analysis_runs SET stream_summary = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(summary, id);
  }

  /** Fenêtres d'une analyse avec Claude (remplacées en bloc, statut « pending »). */
  insertWindows(runId: string, windows: readonly NewWindow[]) {
    const ins = this.db.prepare(
      `INSERT INTO analysis_windows (id, run_id, rank, origin, far_start_ms, src_start_ms, core_start_ms,
         core_end_ms, src_end_ms, local_score, signals_json, frames_json, payload_rel_path, estimate_json,
         status, cache_key)
       VALUES (@id, @runId, @rank, @origin, @farStartMs, @startMs, @coreStartMs, @coreEndMs, @endMs,
         @localScore, @signals, @frames, @payloadRelPath, @estimate, @status, @cacheKey)`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM analysis_windows WHERE run_id = ?').run(runId);
      for (const w of windows) {
        ins.run({
          ...w,
          runId,
          signals: JSON.stringify(w.signals),
          frames: JSON.stringify(w.frames),
          estimate: w.estimate === null ? null : JSON.stringify(w.estimate),
        });
      }
      this.db
        .prepare(`UPDATE analysis_runs SET window_count = ?, updated_at = ${NOW} WHERE id = ?`)
        .run(windows.length, runId);
    })();
  }

  /** Fenêtres non encore traitées sont marquées « sautées » (plafond atteint). */
  skipPendingWindows(runId: string) {
    this.db
      .prepare(
        `UPDATE analysis_windows SET status = 'skipped', updated_at = ${NOW}
         WHERE run_id = ? AND status IN ('pending','prepared')`,
      )
      .run(runId);
  }

  completeClaudeRun(
    id: string,
    status: 'completed' | 'budget_exhausted',
    error?: { code: string; message: string },
  ) {
    this.db
      .prepare(
        `UPDATE analysis_runs SET status = ?, stage = 'done', error_code = ?, error_message = ?,
           completed_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(status, error?.code ?? null, error?.message ?? null, id);
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
    // Une analyse en pause de relecture n'a aucun traitement en cours : elle reste en pause.
    return this.db
      .prepare(
        `UPDATE analysis_runs SET status = 'interrupted', error_code = 'INTERRUPTED',
           error_message = 'Interrompue (arrêt du serveur)', updated_at = ${NOW}
         WHERE status = 'running'
            OR (status = 'pending' AND COALESCE(stage, '') <> '${AWAITING_REVIEW}')`,
      )
      .run().changes;
  }

  /**
   * Pause après le repérage : toutes les requêtes Opus sont écrites, aucune n'est envoyée.
   * L'état tient dans les colonnes existantes : statut `pending`, étape `awaiting_review`,
   * détail dans `config_json.review` (aucune migration).
   */
  pauseForReview(id: string, info: ReviewInfo) {
    this.db
      .prepare(
        `UPDATE analysis_runs SET status = 'pending', stage = '${AWAITING_REVIEW}',
           config_json = json_set(config_json, '$.review', json(?)), updated_at = ${NOW} WHERE id = ?`,
      )
      .run(JSON.stringify(info), id);
  }

  /**
   * Analyse en pause de relecture remplacée par une nouvelle (`--force`) : fermée, elle ne peut
   * plus être approuvée ni reprise. Rien n'était en vol ni réservé pendant la pause.
   */
  supersede(id: string, byRunId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE analysis_runs SET status = 'cancelled', error_code = '${SUPERSEDED}',
             error_message = ?, completed_at = ${NOW}, updated_at = ${NOW}
           WHERE id = ? AND status = 'pending' AND stage = '${AWAITING_REVIEW}'`,
        )
        .run(`Remplacée par une nouvelle analyse (${byRunId}) avant toute requête Opus`, id)
        .changes === 1
    );
  }

  /** Relecture faite : l'analyse approfondie est autorisée (une seule fois, sur une pause). */
  approveReview(id: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE analysis_runs SET config_json = json_set(config_json, '$.reviewApprovedAt', ${NOW}),
             updated_at = ${NOW}
           WHERE id = ? AND status = 'pending' AND stage = '${AWAITING_REVIEW}'
             AND json_extract(config_json, '$.reviewApprovedAt') IS NULL`,
        )
        .run(id).changes === 1
    );
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
