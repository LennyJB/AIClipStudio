/**
 * Tests de bout en bout de l'éditeur (étape 7) : API RÉELLE (`tests/e2e/server.ts`, FFmpeg,
 * transcription simulée, faux modèle : aucun appel à Claude), interface servie par Vite
 * (`apps/web/vite.config.ts`, proxy `changeOrigin: false`), Chromium de Playwright.
 * Lancés par `npm run test:e2e` (job dédié de la CI, Chromium installé par une étape dédiée).
 */
import { defineConfig, devices } from '@playwright/test';
import { E2E } from './tests/e2e/constants';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  retries: 0,
  use: {
    baseURL: E2E.origin,
    trace: 'off',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 1000 },
  },
  webServer: [
    {
      command: 'npx tsx tests/e2e/server.ts',
      url: `http://127.0.0.1:${E2E.apiPort}/api/health`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: { E2E_STATE: E2E.stateFile },
    },
    {
      command: `npx vite --port ${E2E.webPort} --strictPort`,
      cwd: 'apps/web',
      url: E2E.origin,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ACS_API_URL: `http://127.0.0.1:${E2E.apiPort}` },
    },
  ],
});
