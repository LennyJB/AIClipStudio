/**
 * Exécution d'un appel à Claude, avec :
 *  - réutilisation d'une réponse déjà obtenue pour une requête identique (0 $) ;
 *  - réservation du pire cas AVANT l'envoi (plafond strict), coût réel après ;
 *  - tentatives limitées pour les erreurs passagères, chacune réservée à part ;
 *  - UNE nouvelle tentative si la réponse complète n'est pas un JSON valide ;
 *  - aucune nouvelle tentative après un refus ou une sortie tronquée ;
 *  - traçabilité : requête et réponse écrites sur disque, appel en base.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  costUsd,
  estimateTextTokens,
  ModelCallError,
  requestHash,
  reservationUsd,
  toReviewBody,
  type CallOptions,
  type EditorialModel,
  type ModelOutcome,
  type ModelRequest,
  type RequestImage,
} from '@acs/editorial';
import { AppError } from '@acs/shared';
import type { AppContext } from '../context';
import type { DerivativeService } from '../derivatives/service';
import { toAbs } from '../storage/paths';
import { LlmCallRepository, type NewCall } from './calls';

/** Majoration locale prudente d'une image (au plus ≈ 1 600 jetons pour 1024 px de large). */
const IMAGE_TOKENS_FALLBACK = 2_000;

export type ExecuteResult<T> =
  | { status: 'ok'; value: T; callId: string; reused: boolean }
  | {
      status: 'refused';
      callId: string;
      category: string | null;
      explanation: string | null;
      reused: boolean;
    }
  | { status: 'truncated'; callId: string; reused: boolean }
  | { status: 'invalid'; callId: string; error: string }
  | { status: 'failed'; callId: string | null; code: string; message: string };

export interface ExecuteParams<T> {
  runId: string;
  windowId: string | null;
  chunkIndex: number | null;
  req: ModelRequest;
  /** Ce qui est transmis (pistes, images, pseudonymes) : enregistré avec l'appel. */
  sentManifest: Record<string, unknown>;
  parse: (text: string) => { ok: true; value: T } | { ok: false; error: string };
  signal: AbortSignal;
  forceRecall: boolean;
  /** Dossier de l'analyse, relatif au stockage (les fichiers d'appels vont dans appels/). */
  runRelDir: string;
}

/** Résultat sans le message brut (Omit distributif : chaque variante garde ses champs). */
type StoredOutcome = ModelOutcome extends infer U
  ? U extends unknown
    ? Omit<U, 'raw'>
    : never
  : never;

interface StoredResponse {
  callId: string;
  outcome: StoredOutcome;
  raw: unknown;
}

export class CallExecutor {
  readonly calls: LlmCallRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly model: EditorialModel,
    private readonly derivatives: DerivativeService,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  ) {
    this.calls = new LlmCallRepository(ctx.db);
  }

  private get cfg() {
    return this.ctx.config.analysis;
  }

  private abs(rel: string) {
    return toAbs(this.ctx.config.paths.storage, rel);
  }

  /** Octets d'une image, après vérification de son empreinte (l'image envoyée = l'image relue). */
  private loadImage = async (img: RequestImage): Promise<string> => {
    const d = this.derivatives.repo.get(img.derivativeId);
    if (!d) throw new AppError('NOT_FOUND', `Image ${img.label} introuvable`);
    const bytes = await readFile(this.derivatives.abs(d.relPath));
    if (createHash('sha256').update(bytes).digest('hex') !== img.sha256) {
      throw new AppError('CONFLICT', `L’image ${img.label} a changé depuis la préparation`);
    }
    return bytes.toString('base64');
  };

  async execute<T>(p: ExecuteParams<T>): Promise<ExecuteResult<T>> {
    const hash = requestHash(p.req);
    const base: Omit<NewCall, 'id' | 'attempt' | 'requestRelPath'> = {
      runId: p.runId,
      windowId: p.windowId,
      stage: p.req.stage,
      chunkIndex: p.chunkIndex,
      model: p.req.model,
      promptVersion: p.req.promptVersion,
      requestHash: hash,
      effort: p.req.effort,
      maxTokens: p.req.maxTokens,
      sentManifest: p.sentManifest,
    };
    const callsDir = `${p.runRelDir}/appels`;
    await mkdir(this.abs(callsDir), { recursive: true });

    // 1. Réponse déjà obtenue pour exactement la même requête ?
    if (!p.forceRecall) {
      const prior = this.calls.findReusable(hash);
      if (prior?.responseRelPath && existsSync(this.abs(prior.responseRelPath))) {
        const stored = JSON.parse(
          await readFile(this.abs(prior.responseRelPath), 'utf8'),
        ) as StoredResponse;
        const id = randomUUID();
        this.calls.insertReused(
          { ...base, id, attempt: 1, requestRelPath: prior.requestRelPath },
          prior,
        );
        const r = this.interpret(stored.outcome, p.parse);
        if (r.status === 'ok') return { status: 'ok', value: r.value, callId: id, reused: true };
        if (r.status === 'refused')
          return {
            status: 'refused',
            callId: id,
            category: r.category,
            explanation: r.explanation,
            reused: true,
          };
        if (r.status === 'truncated') return { status: 'truncated', callId: id, reused: true };
        // Réponse enregistrée devenue illisible (schéma changé) : on refait l'appel.
      }
    }

    const opts: CallOptions = {
      signal: p.signal,
      timeoutMs: this.cfg.requestTimeoutMs,
      loadImage: this.loadImage,
    };
    let attempt = 0;
    let transientAttempts = 0;
    let invalidRetries = 0;
    for (;;) {
      if (this.calls.overrun(p.runId) > 0) {
        throw new AppError(
          'BUDGET_EXHAUSTED',
          'Le coût réel d’un appel a dépassé sa réservation : analyse arrêtée par prudence',
        );
      }
      attempt += 1;
      transientAttempts += 1;
      let counted: number | null = null;
      try {
        counted = await this.model.countTokens(p.req, opts);
      } catch (err) {
        if (p.signal.aborted) throw new AppError('CANCELLED', 'Analyse annulée');
        // Le comptage est facultatif : estimation locale plus prudente.
        this.ctx.log.warn({ err: (err as Error).message }, 'Comptage des jetons indisponible');
      }
      const local =
        estimateTextTokens(p.req.system) +
        estimateTextTokens(p.req.userText) +
        p.req.images.length * IMAGE_TOKENS_FALLBACK;
      const amount = reservationUsd({
        model: p.req.model,
        countedInputTokens: counted,
        localInputTokens: local,
        schemaJson: JSON.stringify(p.req.schema),
        maxOutputTokens: p.req.maxTokens,
      });

      const id = randomUUID();
      const requestRelPath = `${callsDir}/${id}.request.json`;
      await writeFile(
        this.abs(requestRelPath),
        JSON.stringify(
          {
            callId: id,
            stage: p.req.stage,
            attempt,
            requestHash: hash,
            reservedUsd: amount,
            countedInputTokens: counted,
            sent: p.sentManifest,
            body: toReviewBody(p.req),
          },
          null,
          2,
        ),
      );
      if (!this.calls.reserve({ ...base, id, attempt, requestRelPath }, amount)) {
        throw new AppError(
          'BUDGET_EXHAUSTED',
          `Plafond atteint : l’appel suivant pourrait coûter jusqu’à ${amount.toFixed(4)} $`,
        );
      }

      const started = Date.now();
      let outcome: ModelOutcome;
      try {
        outcome = await this.model.call(p.req, opts);
      } catch (raw) {
        const err =
          raw instanceof ModelCallError
            ? raw
            : raw instanceof AppError
              ? new ModelCallError('window', raw.code, raw.message, {
                  status: null,
                  retryAfterMs: null,
                  providerRequestId: null,
                  maybeBilled: false,
                })
              : new ModelCallError(
                  'retryable',
                  'UNEXPECTED',
                  String((raw as Error)?.message ?? raw),
                  {
                    status: null,
                    retryAfterMs: null,
                    providerRequestId: null,
                    maybeBilled: true,
                  },
                );
        this.calls.finalize(id, {
          status: err.info.maybeBilled ? 'unknown_cost' : 'failed',
          costUsd: 0,
          errorCode: err.code,
          errorMessage: err.message,
          httpStatus: err.info.status,
          providerRequestId: err.info.providerRequestId,
          durationMs: Date.now() - started,
        });
        if (err.kind === 'aborted' || p.signal.aborted)
          throw new AppError('CANCELLED', 'Analyse annulée');
        if (err.kind === 'run') {
          throw new AppError(
            err.code === 'CLAUDE_AUTH_FAILED' ? 'CLAUDE_AUTH_FAILED' : 'CLAUDE_API_ERROR',
            `Claude API : ${err.message} — analyse arrêtée`,
          );
        }
        if (err.kind === 'window' || transientAttempts >= this.cfg.maxAttempts) {
          return { status: 'failed', callId: id, code: err.code, message: err.message };
        }
        const wait =
          err.info.retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** (transientAttempts - 1));
        this.ctx.log.warn(
          { code: err.code, attempt, waitMs: wait },
          'Appel à Claude : nouvelle tentative',
        );
        await this.sleep(wait + Math.floor(Math.random() * 250), p.signal);
        continue;
      }

      const responseRelPath = `${callsDir}/${id}.response.json`;
      const { raw: rawMessage, ...rest } = outcome;
      const stored = rest as StoredOutcome;
      await writeFile(
        this.abs(responseRelPath),
        JSON.stringify(
          { callId: id, outcome: stored, raw: rawMessage } satisfies StoredResponse,
          null,
          2,
        ),
      );
      const r = this.interpret(stored, p.parse);
      const fin = {
        costUsd: costUsd(p.req.model, outcome.usage),
        usage: outcome.usage,
        stopReason: outcome.stopReason,
        providerRequestId: outcome.providerRequestId,
        responseRelPath,
        durationMs: Date.now() - started,
      };
      if (r.status === 'refused') {
        this.calls.finalize(id, {
          ...fin,
          status: 'refused',
          refusalCategory: r.category,
          refusalExplanation: r.explanation,
        });
        // Refus : enregistré tel quel. Aucune nouvelle tentative, aucun autre modèle.
        return {
          status: 'refused',
          callId: id,
          category: r.category,
          explanation: r.explanation,
          reused: false,
        };
      }
      if (r.status === 'truncated') {
        this.calls.finalize(id, { ...fin, status: 'truncated' });
        return { status: 'truncated', callId: id, reused: false };
      }
      if (r.status === 'invalid') {
        this.calls.finalize(id, {
          ...fin,
          status: 'invalid_output',
          errorCode: 'INVALID_OUTPUT',
          errorMessage: r.error,
        });
        if (invalidRetries < 1) {
          invalidRetries += 1;
          transientAttempts = 0;
          continue;
        }
        return { status: 'invalid', callId: id, error: r.error };
      }
      this.calls.finalize(id, { ...fin, status: 'succeeded' });
      return { status: 'ok', value: r.value, callId: id, reused: false };
    }
  }

  private interpret<T>(
    o: StoredOutcome,
    parse: ExecuteParams<T>['parse'],
  ):
    | { status: 'ok'; value: T }
    | { status: 'refused'; category: string | null; explanation: string | null }
    | { status: 'truncated' }
    | { status: 'invalid'; error: string } {
    if (o.kind === 'refused')
      return { status: 'refused', category: o.category, explanation: o.explanation };
    if (o.kind === 'truncated') return { status: 'truncated' };
    if (o.unexpectedBlocks.length) {
      return { status: 'invalid', error: `Blocs inattendus : ${o.unexpectedBlocks.join(', ')}` };
    }
    const parsed = parse(o.text);
    return parsed.ok
      ? { status: 'ok', value: parsed.value }
      : { status: 'invalid', error: parsed.error };
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AppError('CANCELLED', 'Analyse annulée'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AppError('CANCELLED', 'Analyse annulée'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Chemin d'un dossier d'analyse (utilitaire). */
export const runDir = (recordingId: string, runId: string) =>
  path.posix.join('analysis', recordingId, runId);
