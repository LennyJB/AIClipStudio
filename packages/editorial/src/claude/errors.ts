/**
 * Classement des erreurs d'appel. Le SDK ne refait JAMAIS une tentative lui-même
 * (`maxRetries: 0`) : chaque tentative est décidée ici et réservée au budget à part.
 */
import Anthropic from '@anthropic-ai/sdk';

export type ModelErrorKind =
  | 'retryable' // 429, 5xx, délai, connexion : nouvelle tentative possible
  | 'window' //    requête refusée (400, 404, 413…) : la fenêtre échoue
  | 'run' //       clé invalide, droits, facturation : toute l'analyse s'arrête
  | 'aborted'; //  annulation ou arrêt du serveur

export class ModelCallError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    readonly code: string,
    message: string,
    readonly info: {
      status: number | null;
      retryAfterMs: number | null;
      providerRequestId: string | null;
      /** Vrai si l'appel a pu être facturé (coupure après l'envoi) : coût compté par prudence. */
      maybeBilled: boolean;
    },
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

function retryAfterMs(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

export function classifyError(err: unknown, aborted: boolean): ModelCallError {
  if (err instanceof ModelCallError) return err;
  const base = { status: null, retryAfterMs: null, providerRequestId: null };
  // Ordre : du plus précis au plus général (APIConnectionError hérite d'APIError).
  if (aborted || err instanceof Anthropic.APIUserAbortError) {
    return new ModelCallError('aborted', 'ABORTED', 'Appel annulé', { ...base, maybeBilled: true });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ModelCallError('retryable', 'TIMEOUT', 'Délai dépassé', {
      ...base,
      maybeBilled: true,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ModelCallError('retryable', 'CONNECTION', `Connexion interrompue : ${err.message}`, {
      ...base,
      maybeBilled: true,
    });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? null;
    const info = {
      status,
      retryAfterMs: retryAfterMs(err.headers),
      providerRequestId: err.requestID ?? null,
      // Une réponse d'erreur HTTP n'est pas une génération facturée.
      maybeBilled: false,
    };
    const msg = `HTTP ${status ?? '?'} ${err.type ?? ''} ${err.errorCode ?? ''}`.trim();
    if (status === 401 || status === 403)
      return new ModelCallError('run', 'CLAUDE_AUTH_FAILED', msg, info);
    if (
      status === 402 ||
      err.type === 'billing_error' ||
      err.errorCode === 'enforced_spend_limit_reached'
    ) {
      return new ModelCallError('run', 'CLAUDE_BILLING', msg, info);
    }
    if (status === 408 || status === 409 || status === 429 || (status !== null && status >= 500)) {
      return new ModelCallError('retryable', `HTTP_${status}`, msg, info);
    }
    return new ModelCallError('window', `HTTP_${status ?? 'UNKNOWN'}`, msg, info);
  }
  // Erreur inattendue (flux coupé, réponse illisible…) : prudence, coût possible.
  const message = err instanceof Error ? err.message : String(err);
  return new ModelCallError('retryable', 'UNEXPECTED', message, { ...base, maybeBilled: true });
}
