import { pino } from 'pino';
import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config';

/**
 * Logs JSON structurés (pino) en production/test ; affichage lisible en dev.
 * Les en-têtes sensibles sont masqués par précaution.
 */
export function loggerOptions(config: AppConfig): NonNullable<FastifyServerOptions['logger']> {
  const base = {
    level: config.env === 'test' ? 'silent' : config.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]', '*.apiKey'],
      censor: '[masqué]',
    },
  };
  if (config.env === 'development' && process.stdout.isTTY) {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }
  return base;
}

/** Logger autonome pour les scripts CLI (même format que l'API). */
export function createLogger(config: AppConfig) {
  const opts = loggerOptions(config);
  return pino(typeof opts === 'object' ? opts : { level: config.logLevel });
}
