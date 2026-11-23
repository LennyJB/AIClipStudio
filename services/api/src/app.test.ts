import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

function makeApp(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ NODE_ENV: 'test', ...env }, '/tmp/acs-root');
  app = buildApp({ config, db: openDatabase(':memory:') }).app;
  return app;
}

describe('API', () => {
  it('GET /api/health répond ok', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'ok', claudeConfigured: false });
  });

  it('ne divulgue jamais la clé API', async () => {
    const res = await makeApp({ ANTHROPIC_API_KEY: 'sk-ant-test-secret' }).inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(res.json()).toMatchObject({ claudeConfigured: true });
    expect(res.body).not.toContain('sk-ant-test-secret');
  });

  it('renvoie une erreur 404 structurée pour une route inconnue', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/api/inexistant' });
    expect(res.statusCode).toBe(404);
  });
});
