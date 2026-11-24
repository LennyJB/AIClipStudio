/**
 * Étape 5 : la décision du créateur vit dans proposal_reviews. L'ancienne colonne
 * clip_proposals.review_status (migration 5) ne doit plus jamais être lue ni écrite : seule sa
 * déclaration (migration publiée, immuable) et le test de la migration 5 peuvent la nommer.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_DIR } from './config';

const ALLOWED = new Set([
  'services/api/src/db.ts',
  'services/api/src/migration-5.test.ts',
  'services/api/src/review-status.architecture.test.ts',
]);
const ROOTS = ['apps', 'packages', 'services', 'scripts', 'tests'];

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) yield p;
  }
}

describe('architecture : clip_proposals.review_status n’est jamais utilisée', () => {
  it('aucune occurrence hors de la migration 5 et de son test', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sources(path.join(ROOT_DIR, root))) {
        const rel = path.relative(ROOT_DIR, file).split(path.sep).join('/');
        if (ALLOWED.has(rel)) continue;
        if (/review_status|reviewStatus/.test(readFileSync(file, 'utf8'))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
