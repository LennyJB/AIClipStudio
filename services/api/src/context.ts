import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config';
import type { Db } from './db';

/** Dépendances partagées par l'API, le runner de travaux et les scripts CLI. */
export interface AppContext {
  config: AppConfig;
  db: Db;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
}
