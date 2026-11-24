/**
 * CLI `npm run review`, lancée dans un processus séparé sur une base temporaire contenant des
 * propositions de test. Aucune clé Claude, aucun appel réseau.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../services/api/src/config';
import { openDatabase } from '../services/api/src/db';

const run = promisify(execFile);
const REC = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const P2 = '44444444-4444-4444-8444-444444444444';

let env: NodeJS.ProcessEnv;

async function cli(args: string[]) {
  try {
    const r = await run(process.execPath, ['--import', 'tsx', 'scripts/review.ts', ...args], {
      cwd: ROOT_DIR,
      env,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acs-review-cli-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = openDatabase(dbPath);
  db.prepare(
    `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
       game_id, media_info_json) VALUES (?, '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'valorant', '{}')`,
  ).run(REC);
  db.prepare(
    `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
       transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd, prompt_version)
     VALUES (?, ?, 'claude', 'completed', 2, 'p', 'k', '[]', '{}', '{}', '{}', 5, 'triage-v1+deep-v1')`,
  ).run(RUN, REC);
  const ins = db.prepare(
    `INSERT INTO clip_proposals (id, run_id, recording_id, tier, title, explanation, categories_json,
       relevance, reliability, reliability_json, src_start_ms, src_end_ms, setup_segment_id,
       punchline_segment_id, reaction_end_segment_id, punchline_ms, standalone)
     VALUES (?, ?, ?, ?, ?, 'e', '["humour"]', 80, 70, '{}', ?, ?, 1, ?, 3, ?, 1)`,
  );
  ins.run(P1, RUN, REC, 'clip', 'Le plan infaillible', 110_000, 133_800, 8, 125_000);
  ins.run(P2, RUN, REC, 'secondary', 'Le malentendu', 30_000, 50_000, 2, 38_000);
  db.close();
  env = {
    ...process.env,
    NODE_ENV: 'test',
    STORAGE_DIR: path.join(dir, 'storage'),
    DATABASE_PATH: dbPath,
    ANTHROPIC_API_KEY: '',
    LOG_LEVEL: 'error',
  };
}, 60_000);

describe('CLI npm run review', () => {
  it('liste, accepte, refuse (motifs multiples), réinitialise, détache, exporte', async () => {
    const list = await cli([REC]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/2 à examiner/);
    expect(list.out).toMatch(/« Le plan infaillible »/);

    expect((await cli(['--accept', P1, '--comment', 'top'])).out).toMatch(
      /Décision enregistrée : acceptée/,
    );
    // Relancer la même commande : aucun doublon.
    expect((await cli(['--accept', P1, '--comment', 'top'])).out).toMatch(/Aucun changement/);

    const bad = await cli(['--reject', P2, '--reason', 'autre']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/VALIDATION_FAILED/);
    expect((await cli(['--reject', P2, '--reason', 'nul'])).code).toBe(2);
    expect(
      (await cli(['--reject', P2, '--reason', 'trop_long', '--reason', 'pas_drole'])).out,
    ).toMatch(/refusée/);

    const show = await cli(['--show', P2]);
    expect(show.out).toMatch(/refusée \(Pas drôle, Trop long\)/);
    expect(show.out).toMatch(/proposal_rejected .*\[actuelle\]/);

    expect((await cli(['--reset', P2])).out).toMatch(/à examiner/);
    expect((await cli([REC, '--status', 'to_review'])).out).toMatch(/« Le malentendu »/);
    expect((await cli(['--detach', P1])).out).toMatch(/Déjà seule/);

    const exp = await cli(['--export']);
    const lines = exp.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; type?: string; source?: string });
    expect(lines.filter((l) => l.kind === 'event').map((l) => l.type)).toEqual([
      'proposal_accepted',
      'proposal_rejected',
      'proposal_reset',
    ]);
    expect(lines.filter((l) => l.kind === 'event').every((l) => l.source === 'cli')).toBe(true);
    expect(lines.filter((l) => l.kind === 'moment_decision')).toHaveLength(2);
  }, 120_000);

  it('sans argument : usage, code 2', async () => {
    const r = await cli([]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage/);
  }, 60_000);
});
