import Fastify, { type FastifyInstance } from 'fastify';
import { isAppError, type AppErrorCode } from '@acs/shared';
import type { AppConfig } from './config';
import type { Db } from './db';
import { createExtractAudioHandler } from './jobs/extract-audio';
import { JobRunner } from './jobs/runner';
import { loggerOptions } from './logger';
import { registerRecordingRoutes } from './routes/recordings';

export interface AppDeps {
  config: AppConfig;
  db: Db;
}

const APP_VERSION = '0.2.0';

const STATUS_BY_CODE: Partial<Record<AppErrorCode, number>> = {
  NOT_FOUND: 404,
  MEDIA_NOT_FOUND: 404,
  PROFILE_NOT_FOUND: 404,
  CONFLICT: 409,
  TOOL_MISSING: 503,
  INTERNAL: 500,
};

export function buildApp({ config, db }: AppDeps): { app: FastifyInstance; runner: JobRunner } {
  const app = Fastify({ logger: loggerOptions(config), bodyLimit: 64 * 1024 });
  const ctx = { config, db, log: app.log };
  const runner = new JobRunner(ctx, { extract_audio: createExtractAudioHandler(ctx) });
  runner.recover();

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      const status = STATUS_BY_CODE[error.code] ?? 400;
      const level = status >= 500 ? 'error' : 'warn';
      request.log[level]({ code: error.code, details: error.details }, error.message);
      const details = error.code === 'VALIDATION_FAILED' ? error.details : undefined;
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

  registerRecordingRoutes(app, ctx, runner);
  app.addHook('onClose', async () => {
    await runner.stop();
  });

  return { app, runner };
}
