import { defineConfig } from 'vitest/config';

/**
 * Deux projets distincts (exécutés séparément en CI) :
 *  - unit        : code pur, SQLite en mémoire ; aucun outil externe requis ;
 *  - integration : FFmpeg réel, fichiers, API complète (`*.integration.test.ts`, `tests/`).
 * Avec REQUIRE_FFMPEG=1 (CI), l'absence de FFmpeg fait ÉCHOUER les tests d'intégration
 * au lieu de les ignorer silencieusement.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'services/*/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/*/src/**/*.integration.test.ts',
            'services/*/src/**/*.integration.test.ts',
            'tests/**/*.test.ts',
          ],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
