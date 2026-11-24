/**
 * Appels à Claude et budget, côté base. Toutes les opérations d'argent sont des
 * transactions SQLite (synchrones).
 *
 * Ce que l'application GARANTIT (plafond de réservation) : aucun appel n'est envoyé si son
 * pire cas estimé ne tient pas dans le plafond ; « dépensé + réservé ≤ plafond », même avec
 * des appels simultanés (contrainte CHECK de analysis_runs en dernier recours).
 *
 * Ce qu'elle NE PEUT PAS garantir (facture réelle) : le pire cas repose sur un comptage
 * d'entrée estimé (count_tokens, ou estimation locale) et sur la table de tarifs versionnée.
 * Si le coût réel calculé d'un appel dépasse ce qui restait sous le plafond, l'excédent est
 * consigné dans `overrun_usd`, l'analyse s'arrête (BUDGET_OVERRUN) et le coût réel reste
 * affiché en entier. La facture d'Anthropic fait foi.
 */
import type { Db } from '../db';
import { NOW } from '../recordings/repository';

export type CallStatus =
  | 'reserved'
  | 'succeeded'
  | 'refused'
  | 'truncated'
  | 'invalid_output'
  | 'failed'
  | 'unknown_cost'
  | 'reused';

export interface LlmCallDto {
  id: string;
  runId: string;
  windowId: string | null;
  stage: 'triage' | 'deep';
  chunkIndex: number | null;
  attempt: number;
  model: string;
  promptVersion: string;
  requestHash: string;
  effort: string;
  maxTokens: number;
  status: CallStatus;
  reservedUsd: number;
  costUsd: number;
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  refusalCategory: string | null;
  refusalExplanation: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  reusedFromCallId: string | null;
  sentManifest: Record<string, unknown>;
  requestRelPath: string | null;
  responseRelPath: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface Row {
  id: string;
  run_id: string;
  window_id: string | null;
  stage: string;
  chunk_index: number | null;
  attempt: number;
  model: string;
  prompt_version: string;
  request_hash: string;
  effort: string;
  max_tokens: number;
  status: string;
  reserved_usd: number;
  cost_usd: number;
  input_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  stop_reason: string | null;
  refusal_category: string | null;
  refusal_explanation: string | null;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
  provider_request_id: string | null;
  reused_from_call_id: string | null;
  sent_manifest_json: string;
  request_rel_path: string | null;
  response_rel_path: string | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

const toDto = (r: Row): LlmCallDto => ({
  id: r.id,
  runId: r.run_id,
  windowId: r.window_id,
  stage: r.stage as LlmCallDto['stage'],
  chunkIndex: r.chunk_index,
  attempt: r.attempt,
  model: r.model,
  promptVersion: r.prompt_version,
  requestHash: r.request_hash,
  effort: r.effort,
  maxTokens: r.max_tokens,
  status: r.status as CallStatus,
  reservedUsd: r.reserved_usd,
  costUsd: r.cost_usd,
  inputTokens: r.input_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  cacheReadTokens: r.cache_read_tokens,
  outputTokens: r.output_tokens,
  stopReason: r.stop_reason,
  refusalCategory: r.refusal_category,
  refusalExplanation: r.refusal_explanation,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  httpStatus: r.http_status,
  providerRequestId: r.provider_request_id,
  reusedFromCallId: r.reused_from_call_id,
  sentManifest: JSON.parse(r.sent_manifest_json) as Record<string, unknown>,
  requestRelPath: r.request_rel_path,
  responseRelPath: r.response_rel_path,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

export interface NewCall {
  id: string;
  runId: string;
  windowId: string | null;
  stage: 'triage' | 'deep';
  chunkIndex: number | null;
  attempt: number;
  model: string;
  promptVersion: string;
  requestHash: string;
  effort: string;
  maxTokens: number;
  sentManifest: Record<string, unknown>;
  requestRelPath: string | null;
}

export interface CallResult {
  status: Exclude<CallStatus, 'reserved' | 'reused'>;
  /** Coût réel (ignoré pour `unknown_cost` : la réservation entière est comptée). */
  costUsd: number;
  usage?: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
  };
  stopReason?: string | null;
  refusalCategory?: string | null;
  refusalExplanation?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  httpStatus?: number | null;
  providerRequestId?: string | null;
  responseRelPath?: string | null;
  durationMs?: number;
}

const r6 = (n: number) => Math.round(n * 1e9) / 1e9;

export class LlmCallRepository {
  constructor(private readonly db: Db) {}

  get(id: string): LlmCallDto | null {
    const r = this.db.prepare('SELECT * FROM llm_calls WHERE id = ?').get(id) as Row | undefined;
    return r ? toDto(r) : null;
  }

  listForRun(runId: string): LlmCallDto[] {
    return (
      this.db
        .prepare('SELECT * FROM llm_calls WHERE run_id = ? ORDER BY created_at, rowid')
        .all(runId) as Row[]
    ).map(toDto);
  }

  /**
   * Réserve le pire cas AVANT l'envoi et enregistre l'appel, en une transaction.
   * Renvoie false si le plafond serait dépassé (ou si un dépassement a déjà eu lieu).
   */
  reserve(call: NewCall, amountUsd: number): boolean {
    const amount = r6(amountUsd);
    return this.db.transaction(() => {
      const ok = this.db
        .prepare(
          `UPDATE analysis_runs SET reserved_usd = reserved_usd + @amount, updated_at = ${NOW}
           WHERE id = @runId AND overrun_usd = 0
             AND spent_usd + reserved_usd + @amount <= budget_usd + 0.0000005`,
        )
        .run({ amount, runId: call.runId }).changes;
      if (!ok) return false;
      this.db
        .prepare(
          `INSERT INTO llm_calls (id, run_id, window_id, stage, chunk_index, attempt, model, prompt_version,
             request_hash, effort, max_tokens, status, reserved_usd, sent_manifest_json, request_rel_path)
           VALUES (@id, @runId, @windowId, @stage, @chunkIndex, @attempt, @model, @promptVersion,
             @requestHash, @effort, @maxTokens, 'reserved', @amount, @manifest, @requestRelPath)`,
        )
        .run({ ...call, amount, manifest: JSON.stringify(call.sentManifest) });
      return true;
    })();
  }

  /**
   * Remplace la réservation par le coût réel. `unknown_cost` : la réservation entière est
   * comptée comme dépensée (prudence). Un coût réel supérieur à la marge restante est
   * consigné dans `overrun_usd` (le coût réel reste exact dans l'appel).
   */
  finalize(callId: string, res: CallResult): { costUsd: number; overrunUsd: number } {
    return this.db.transaction(() => {
      const call = this.get(callId);
      if (!call || call.status !== 'reserved') return { costUsd: 0, overrunUsd: 0 };
      const cost = r6(res.status === 'unknown_cost' ? call.reservedUsd : Math.max(0, res.costUsd));
      const run = this.db
        .prepare('SELECT budget_usd, spent_usd, reserved_usd FROM analysis_runs WHERE id = ?')
        .get(call.runId) as { budget_usd: number; spent_usd: number; reserved_usd: number };
      const headroom = r6(run.budget_usd - run.spent_usd - (run.reserved_usd - call.reservedUsd));
      const counted = r6(Math.min(cost, Math.max(0, headroom)));
      const overrun = r6(cost - counted);
      this.db
        .prepare(
          `UPDATE analysis_runs SET reserved_usd = MAX(0, reserved_usd - @reserved),
             spent_usd = spent_usd + @counted, overrun_usd = overrun_usd + @overrun, updated_at = ${NOW}
           WHERE id = @runId`,
        )
        .run({ reserved: call.reservedUsd, counted, overrun, runId: call.runId });
      this.db
        .prepare(
          `UPDATE llm_calls SET status = @status, cost_usd = @cost, input_tokens = @in, cache_write_tokens = @cw,
             cache_read_tokens = @cr, output_tokens = @out, stop_reason = @stopReason,
             refusal_category = @refusalCategory, refusal_explanation = @refusalExplanation,
             error_code = @errorCode, error_message = @errorMessage, http_status = @httpStatus,
             provider_request_id = @providerRequestId, response_rel_path = @responseRelPath,
             duration_ms = @durationMs, completed_at = ${NOW}
           WHERE id = @id`,
        )
        .run({
          id: callId,
          status: res.status,
          cost,
          in: res.usage?.inputTokens ?? null,
          cw: res.usage?.cacheWriteTokens ?? null,
          cr: res.usage?.cacheReadTokens ?? null,
          out: res.usage?.outputTokens ?? null,
          stopReason: res.stopReason ?? null,
          refusalCategory: res.refusalCategory ?? null,
          refusalExplanation: res.refusalExplanation ?? null,
          errorCode: res.errorCode ?? null,
          errorMessage: res.errorMessage?.slice(0, 2000) ?? null,
          httpStatus: res.httpStatus ?? null,
          providerRequestId: res.providerRequestId ?? null,
          responseRelPath: res.responseRelPath ?? null,
          durationMs: res.durationMs ?? null,
        });
      return { costUsd: cost, overrunUsd: overrun };
    })();
  }

  /** Réponse déjà obtenue pour une requête identique (toutes analyses, ou une seule si `onlyRunId`). */
  findReusable(requestHash: string, onlyRunId?: string): LlmCallDto | null {
    const r = this.db
      .prepare(
        `SELECT * FROM llm_calls WHERE request_hash = ? AND status IN ('succeeded','refused','truncated')
           AND response_rel_path IS NOT NULL AND (? IS NULL OR run_id = ?)
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(requestHash, onlyRunId ?? null, onlyRunId ?? null) as Row | undefined;
    return r ? toDto(r) : null;
  }

  /** Réutilisation d'une réponse existante : 0 $, l'appel d'origine est référencé. */
  insertReused(call: NewCall, from: LlmCallDto): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, run_id, window_id, stage, chunk_index, attempt, model, prompt_version,
           request_hash, effort, max_tokens, status, reserved_usd, cost_usd, stop_reason, refusal_category,
           refusal_explanation, provider_request_id, reused_from_call_id, sent_manifest_json,
           request_rel_path, response_rel_path, completed_at)
         VALUES (@id, @runId, @windowId, @stage, @chunkIndex, @attempt, @model, @promptVersion,
           @requestHash, @effort, @maxTokens, 'reused', 0, 0, @stopReason, @refusalCategory,
           @refusalExplanation, @providerRequestId, @fromId, @manifest, @requestRelPath, @responseRelPath, ${NOW})`,
      )
      .run({
        ...call,
        stopReason: from.stopReason,
        refusalCategory: from.refusalCategory,
        refusalExplanation: from.refusalExplanation,
        providerRequestId: from.providerRequestId,
        fromId: from.id,
        manifest: JSON.stringify(call.sentManifest),
        responseRelPath: from.responseRelPath,
      });
  }

  /**
   * Au démarrage : un appel resté « réservé » a été interrompu après l'envoi peut-être.
   * Personne ne sait s'il a été facturé : sa réservation entière est comptée (prudence).
   */
  recoverStale(): number {
    const stale = this.db.prepare(`SELECT id FROM llm_calls WHERE status = 'reserved'`).all() as {
      id: string;
    }[];
    for (const s of stale) {
      this.finalize(s.id, {
        status: 'unknown_cost',
        costUsd: 0,
        errorCode: 'INTERRUPTED',
        errorMessage: 'Interrompu pendant l’appel : facturation inconnue, réservation comptée',
      });
    }
    return stale.length;
  }

  overrun(runId: string): number {
    const r = this.db.prepare('SELECT overrun_usd FROM analysis_runs WHERE id = ?').get(runId) as
      { overrun_usd: number } | undefined;
    return r?.overrun_usd ?? 0;
  }

  /**
   * Coûts réels d'une analyse : total, par étape, par fenêtre, et écarts avec le plafond.
   *  - `realCostUsd` : somme des coûts calculés des appels (jetons renvoyés par l'API × tarifs
   *    versionnés ; appel coupé = pire cas réservé). Il PEUT dépasser le plafond (`overrunUsd`).
   *  - `aboveReservationCalls` : appels dont le coût réel a dépassé leur propre réservation.
   */
  costs(runId: string) {
    const total = this.db
      .prepare(
        `SELECT COALESCE(SUM(c.cost_usd), 0) AS cost, COUNT(c.id) AS calls,
           SUM(c.status = 'reused') AS reused, SUM(c.status = 'unknown_cost') AS unknown,
           SUM(c.status <> 'reused' AND c.cost_usd > c.reserved_usd + 0.000000001) AS above,
           COALESCE(SUM(MAX(0, c.cost_usd - c.reserved_usd)), 0) AS aboveUsd,
           a.budget_usd AS budget, a.overrun_usd AS overrun
         FROM analysis_runs a LEFT JOIN llm_calls c ON c.run_id = a.id WHERE a.id = ?`,
      )
      .get(runId) as {
      cost: number;
      calls: number;
      reused: number | null;
      unknown: number | null;
      above: number | null;
      aboveUsd: number;
      budget: number | null;
      overrun: number | null;
    };
    const byStage = this.db
      .prepare(
        `SELECT stage, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls,
           COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheRead, COALESCE(SUM(output_tokens), 0) AS output
         FROM llm_calls WHERE run_id = ? GROUP BY stage`,
      )
      .all(runId) as {
      stage: string;
      cost: number;
      calls: number;
      input: number;
      cacheWrite: number;
      cacheRead: number;
      output: number;
    }[];
    const byWindow = this.db
      .prepare(
        `SELECT window_id AS windowId, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls
         FROM llm_calls WHERE run_id = ? AND window_id IS NOT NULL GROUP BY window_id`,
      )
      .all(runId) as { windowId: string; cost: number; calls: number }[];
    return {
      realCostUsd: r6(total.cost),
      budgetUsd: total.budget ?? 0,
      overrunUsd: r6(total.overrun ?? 0),
      budgetExceeded: (total.overrun ?? 0) > 0,
      aboveReservationCalls: total.above ?? 0,
      aboveReservationUsd: r6(total.aboveUsd),
      calls: total.calls,
      reusedCalls: total.reused ?? 0,
      unknownCostCalls: total.unknown ?? 0,
      byStage,
      byWindow,
    };
  }

  /** Coût réel cumulé d'un enregistrement (toutes analyses confondues, dépassements compris). */
  recordingCost(recordingId: string): {
    realCostUsd: number;
    calls: number;
    runs: number;
    overrunUsd: number;
    runsOverBudget: number;
  } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(c.cost_usd), 0) AS cost, COUNT(c.id) AS calls, COUNT(DISTINCT c.run_id) AS runs
         FROM llm_calls c JOIN analysis_runs a ON a.id = c.run_id WHERE a.recording_id = ?`,
      )
      .get(recordingId) as { cost: number; calls: number; runs: number };
    const o = this.db
      .prepare(
        `SELECT COALESCE(SUM(overrun_usd), 0) AS overrun, SUM(overrun_usd > 0) AS n
         FROM analysis_runs WHERE recording_id = ?`,
      )
      .get(recordingId) as { overrun: number; n: number | null };
    return {
      realCostUsd: r6(r.cost),
      calls: r.calls,
      runs: r.runs,
      overrunUsd: r6(o.overrun),
      runsOverBudget: o.n ?? 0,
    };
  }
}
