import Fastify, { type FastifyInstance } from 'fastify';
import { isAppError } from '@acs/shared';
import type { AppConfig } from './config';
import type { Db } from './db';
import { loggerOptions } from './logger';

export interface AppDeps {
  config: AppConfig;
  db: Db;
}

const APP_VERSION = '0.1.0';

export function buildApp({ config, db }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: loggerOptions(config) });

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      request.log.warn({ code: error.code, details: error.details }, error.message);
      return reply.status(400).send({ error: { code: error.code, message: error.message } });
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

  return app;
}
