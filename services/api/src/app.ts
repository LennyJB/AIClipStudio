import Fastify, { type FastifyInstance } from 'fastify';
import type { EditorialModel } from '@acs/editorial';
import { isAppError, type AppErrorCode } from '@acs/shared';
import type { AppConfig } from './config';
import type { Db } from './db';
import { loggerOptions } from './logger';
import { registerAnalysisRoutes } from './routes/analysis';
import { registerAssetRoutes } from './routes/assets';
import { registerClipRoutes } from './routes/clips';
import { registerContentTypeRoutes } from './routes/content-types';
import { registerStyleRoutes } from './routes/style';
import { registerEditorMediaRoutes } from './routes/editor-media';
import { registerReviewRoutes } from './routes/review';
import { registerRecordingRoutes } from './routes/recordings';
import { registerStorageRoutes } from './routes/storage';
import { createServices, recoverServices, type Services } from './services';
import { registerTranscriptionRoutes } from './routes/transcriptions';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  /** Modèle éditorial injecté (tests : faux modèle). Absent : Claude API si une clé existe. */
  model?: EditorialModel | null;
}

const APP_VERSION = '0.4.0';

/** Codes dont les détails sont renvoyés au client (jamais de chemin ni de secret dedans). */
const DETAILED_CODES = new Set<AppErrorCode>([
  'VALIDATION_FAILED',
  'ALREADY_REVIEWED',
  'DECISION_ELSEWHERE',
  'VERSION_CONFLICT',
  'HISTORY_CHANGED',
  'PRECONDITION_FAILED',
  'DOCUMENT_DIVERGED',
  'EDITOR_REQUIRED',
  'RENDER_FEATURE_UNSUPPORTED',
  'PROPOSAL_NOT_REVIEWABLE',
  'EXPORT_CONSENT_REQUIRED',
  'DURATION_OUT_OF_RANGE',
  'DISK_SPACE_LOW',
  'ASSET_REJECTED',
  'ASSET_IN_USE',
  'ASSET_MISSING',
]);

const STATUS_BY_CODE: Partial<Record<AppErrorCode, number>> = {
  NOT_FOUND: 404,
  ANALYSIS_NOT_READY: 409,
  CLAUDE_NOT_CONFIGURED: 409,
  BUDGET_NOT_CONFIRMED: 400,
  MEDIA_NOT_FOUND: 404,
  PROFILE_NOT_FOUND: 404,
  CONFLICT: 409,
  CANCELLED: 409,
  ALREADY_REVIEWED: 409,
  DECISION_ELSEWHERE: 409,
  IDEMPOTENCY_MISMATCH: 409,
  VERSION_CONFLICT: 409,
  EDITOR_REQUIRED: 409,
  HISTORY_CHANGED: 409,
  JOURNAL_CORRUPTED: 500,
  PRECONDITION_FAILED: 409,
  MASK_RISK_NOT_ACKNOWLEDGED: 422,
  DOCUMENT_DIVERGED: 409,
  RENDER_FEATURE_UNSUPPORTED: 409,
  FORBIDDEN: 403,
  ASSET_REJECTED: 422,
  ASSET_IN_USE: 409,
  ASSET_MISSING: 409,
  PROPOSAL_NOT_REVIEWABLE: 409,
  AUDIO_TRACK_MISSING: 409,
  NOT_READY: 409,
  PROPOSAL_NOT_ACCEPTED: 409,
  EXPORT_CONSENT_REQUIRED: 422,
  DURATION_OUT_OF_RANGE: 422,
  DISK_SPACE_LOW: 507,
  RENDER_FAILED: 500,
  TOOL_MISSING: 503,
  INTERNAL: 500,
};

export function buildApp({ config, db, model }: AppDeps): {
  app: FastifyInstance;
  services: Services;
} {
  const app = Fastify({ logger: loggerOptions(config), bodyLimit: 64 * 1024 });
  const ctx = { config, db, log: app.log };
  const services = createServices(ctx, model === undefined ? {} : { model });
  recoverServices(services);

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      const status = STATUS_BY_CODE[error.code] ?? 400;
      const level = status >= 500 ? 'error' : 'warn';
      request.log[level]({ code: error.code, details: error.details }, error.message);
      const details = DETAILED_CODES.has(error.code) ? error.details : undefined;
      return reply
        .status(status)
        .send({ error: { code: error.code, message: error.message, details } });
    }
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) request.log.error({ err: error }, 'Erreur interne');
    // Aucune pile d'appel ni détail interne n'est renvoyé au client.
    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
        message: status >= 500 ? 'Erreur interne' : (error as Error).message,
      },
    });
  });

  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get();
    return {
      status: 'ok' as const,
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      database: 'ok' as const,
      // Booléen uniquement : la clé elle-même ne quitte jamais le serveur.
      claudeConfigured: Boolean(config.claude.apiKey),
    };
  });

  registerRecordingRoutes(app, ctx, services);
  registerStorageRoutes(app, services);
  registerTranscriptionRoutes(app, ctx, services);
  registerAnalysisRoutes(app, services);
  registerReviewRoutes(app, services);
  registerClipRoutes(app, services);
  registerEditorMediaRoutes(app, services);
  registerAssetRoutes(app, services);
  registerContentTypeRoutes(app, services);
  registerStyleRoutes(app, services);
  app.addHook('onClose', async () => {
    await services.runner.stop();
  });

  return { app, services };
}
