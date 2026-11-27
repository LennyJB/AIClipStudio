import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeModel,
  ModelCallError,
  parseModelJson,
  TriageResultSchema,
  type FakeReply,
  type ModelRequest,
} from '@acs/editorial';
import { loadConfig, ROOT_DIR } from '../config';
import { openDatabase, type Db } from '../db';
import type { DerivativeService } from '../derivatives/service';
import { CallExecutor } from './executor';
import { LlmCallRepository } from './calls';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 60) });

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
const VALID = { moments: [], streamSummary: '' };
const req = (text = 'tranche'): ModelRequest => ({
  stage: 'triage',
  model: 'claude-haiku-5-5',
  effort: 'medium',
  maxTokens: 4000,
  promptVersion: 'triage-v1',
  system: 'système',
  userText: text,
  images: [],
  schemaName: 'TriageResult',
  schema: { type: 'object' },
});
const err = (
  kind: ModelCallError['kind'],
  code: string,
  extra: Partial<ModelCallError['info']> = {},
) =>
  new ModelCallError(kind, code, code, {
    status: null,
    retryAfterMs: null,
    providerRequestId: null,
    maybeBilled: false,
    ...extra,
  });

let db: Db;
let storage: string;
let sleeps: number[];

function setup(budget = 5, maxAttempts = 3) {
  storage = mkdtempSync(path.join(tmpdir(), 'acs-exec-'));
  const config = loadConfig(
    { NODE_ENV: 'test', STORAGE_DIR: storage, ANALYSIS_MAX_ATTEMPTS: String(maxAttempts) },
    ROOT_DIR,
  );
  db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
       game_id, media_info_json) VALUES ('r', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
       transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd)
     VALUES ('run', 'r', 'claude', 'running', 1, 'p', 'k', '[]', '{}', '{}', '{}', ?)`,
  ).run(budget);
  sleeps = [];
  return (script: (r: ModelRequest, i: number) => FakeReply) => {
    const model = new FakeModel(script);
    const ex = new CallExecutor(
      { config, db, log: silent },
      model,
      {} as DerivativeService,
      (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    );
    return { model, ex };
  };
}

const run = () =>
  db
    .prepare(
      'SELECT spent_usd AS spent, reserved_usd AS reserved, overrun_usd AS overrun, budget_usd AS budget FROM analysis_runs',
    )
    .get() as {
    spent: number;
    reserved: number;
    overrun: number;
    budget: number;
  };
const statuses = () =>
  (db.prepare('SELECT status FROM llm_calls ORDER BY rowid').all() as { status: string }[]).map(
    (r) => r.status,
  );

const exec = (
  ex: CallExecutor,
  r = req(),
  o: { force?: boolean; signal?: AbortSignal; runId?: string } = {},
) =>
  ex.execute({
    runId: o.runId ?? 'run',
    windowId: null,
    chunkIndex: 1,
    req: r,
    sentManifest: { tracks: ['MIC'] },
    parse: (t) => parseModelJson(TriageResultSchema, t),
    signal: o.signal ?? new AbortController().signal,
    forceRecall: o.force ?? false,
    runRelDir: 'analysis/r/run',
  });

describe('CallExecutor', () => {
  let make: ReturnType<typeof setup>;
  beforeEach(() => {
    make = setup();
  });

  it('succès : coût réel enregistré, réservation libérée, requête et réponse sur disque', async () => {
    const { ex, model } = make(() => ({ kind: 'json', value: VALID }));
    const r = await exec(ex);
    expect(r).toMatchObject({ status: 'ok', reused: false });
    expect(model.calls).toHaveLength(1);
    const call = db.prepare('SELECT * FROM llm_calls').get() as Record<string, unknown>;
    expect(call).toMatchObject({ status: 'succeeded', input_tokens: 1000, output_tokens: 500 });
    expect(call['cost_usd']).toBeCloseTo((1000 * 0.1 + 500 * 0.5) / 1e6, 9);
    expect(run()).toMatchObject({ reserved: 0, overrun: 0 });
    expect(run().spent).toBeCloseTo(call['cost_usd'] as number, 9);
    expect(existsSync(path.join(storage, call['request_rel_path'] as string))).toBe(true);
    expect(existsSync(path.join(storage, call['response_rel_path'] as string))).toBe(true);
  });

  it('requête identique : réponse réutilisée (0 $), aucun nouvel appel ; --force-recall rappelle', async () => {
    const { ex, model } = make(() => ({ kind: 'json', value: VALID }));
    await exec(ex);
    const spent = run().spent;
    const again = await exec(ex);
    expect(again).toMatchObject({ status: 'ok', reused: true });
    expect(model.calls).toHaveLength(1);
    expect(run().spent).toBe(spent);
    expect(statuses()).toEqual(['succeeded', 'reused']);
    // --force-recall : une AUTRE analyse redemande réellement à Claude…
    db.prepare(
      `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version,
         input_key, transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd, force_recall)
       VALUES ('run2', 'r', 'claude', 'running', 1, 'p', 'k', '[]', '{}', '{}', '{}', 5, 1)`,
    ).run();
    expect(await exec(ex, req(), { force: true, runId: 'run2' })).toMatchObject({
      status: 'ok',
      reused: false,
    });
    expect(model.calls).toHaveLength(2);
    // …mais à la reprise de cette même analyse, un appel déjà réussi n'est jamais repayé.
    expect(await exec(ex, req(), { force: true, runId: 'run2' })).toMatchObject({
      status: 'ok',
      reused: true,
    });
    expect(model.calls).toHaveLength(2);
  });

  it('refus : enregistré, aucune nouvelle tentative, réutilisé tel quel ensuite', async () => {
    const { ex, model } = make(() => ({ kind: 'refused', category: 'cyber' }));
    expect(await exec(ex)).toMatchObject({ status: 'refused', category: 'cyber' });
    expect(model.calls).toHaveLength(1);
    expect(await exec(ex)).toMatchObject({ status: 'refused', reused: true });
    expect(model.calls).toHaveLength(1);
  });

  it('sortie tronquée : aucune nouvelle tentative, coût compté', async () => {
    const { ex, model } = make(() => ({ kind: 'truncated' }));
    expect((await exec(ex)).status).toBe('truncated');
    expect(model.calls).toHaveLength(1);
    expect(run().spent).toBeGreaterThan(0);
  });

  it('JSON invalide : UNE nouvelle tentative, réservée à part', async () => {
    const { ex, model } = make((_, i) =>
      i === 0 ? { kind: 'text', text: '{"moments": ' } : { kind: 'json', value: VALID },
    );
    expect((await exec(ex)).status).toBe('ok');
    expect(model.calls).toHaveLength(2);
    expect(statuses()).toEqual(['invalid_output', 'succeeded']);
    const { ex: ex2, model: m2 } = setup()(() => ({
      kind: 'json',
      value: { moments: [], streamSummary: '', commande: 'x' },
    }));
    expect((await exec(ex2)).status).toBe('invalid');
    expect(m2.calls).toHaveLength(2);
  });

  it('erreurs passagères : nouvelles tentatives (retry-after respecté) puis échec après la limite', async () => {
    const { ex, model } = make((_, i) =>
      i === 0
        ? { kind: 'error', error: err('retryable', 'HTTP_429', { retryAfterMs: 2000 }) }
        : { kind: 'json', value: VALID },
    );
    expect((await exec(ex)).status).toBe('ok');
    expect(model.calls).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    const { ex: ex2, model: m2 } = setup(
      5,
      3,
    )(() => ({ kind: 'error', error: err('retryable', 'HTTP_529') }));
    expect(await exec(ex2)).toMatchObject({ status: 'failed', code: 'HTTP_529' });
    expect(m2.calls).toHaveLength(3);
    expect(statuses()).toEqual(['failed', 'failed', 'failed']);
  });

  it('coupure après l’envoi : facturation inconnue, la réservation entière est comptée', async () => {
    const { ex } = setup(
      5,
      1,
    )(() => ({ kind: 'error', error: err('retryable', 'CONNECTION', { maybeBilled: true }) }));
    await exec(ex);
    const c = db.prepare('SELECT status, reserved_usd, cost_usd FROM llm_calls').get() as Record<
      string,
      number | string
    >;
    expect(c['status']).toBe('unknown_cost');
    expect(c['cost_usd']).toBe(c['reserved_usd']);
    expect(run().spent).toBeCloseTo(c['reserved_usd'] as number, 9);
  });

  it('clé invalide : toute l’analyse s’arrête', async () => {
    const { ex } = make(() => ({ kind: 'error', error: err('run', 'CLAUDE_AUTH_FAILED') }));
    await expect(exec(ex)).rejects.toMatchObject({ code: 'CLAUDE_AUTH_FAILED' });
  });

  it('plafond : aucun envoi si la réservation du pire cas ne tient pas', async () => {
    const { ex, model } = setup(0.001)(() => ({ kind: 'json', value: VALID }));
    await expect(exec(ex)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(model.calls).toHaveLength(0);
    expect(run()).toMatchObject({ spent: 0, reserved: 0 });
  });

  it('coût réel supérieur à la réservation : consigné à part, plafond respecté, analyse arrêtée', async () => {
    const { ex } = setup(0.01)(() => ({
      kind: 'json',
      value: VALID,
      usage: { inputTokens: 200_000, outputTokens: 4000 },
    }));
    await exec(ex);
    const r = run();
    expect(r.overrun).toBeGreaterThan(0);
    expect(r.spent + r.reserved).toBeLessThanOrEqual(r.budget + 1e-6);
    // Le coût réel de l'appel reste exact, au-delà du plafond, et visible dans les coûts.
    const calls = new LlmCallRepository(db);
    const c = calls.costs('run');
    const dbCost = (db.prepare('SELECT cost_usd FROM llm_calls').get() as { cost_usd: number })
      .cost_usd;
    expect(c.realCostUsd).toBeCloseTo(dbCost, 9);
    expect(c.realCostUsd).toBeGreaterThan(r.budget);
    expect(c).toMatchObject({ budgetExceeded: true, aboveReservationCalls: 1 });
    expect(c.overrunUsd).toBeCloseTo(c.realCostUsd - r.spent, 9);
    await expect(exec(ex, req('autre'))).rejects.toMatchObject({ code: 'BUDGET_OVERRUN' });
  });

  it('annulation pendant un appel : coût inconnu compté, erreur CANCELLED', async () => {
    const { ex } = make(() => ({ kind: 'hang' }));
    const ac = new AbortController();
    const p = exec(ex, req(), { signal: ac.signal });
    setTimeout(() => ac.abort('shutdown'), 10);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(statuses()).toEqual(['unknown_cost']);
  });

  it('reprise au démarrage : un appel resté « réservé » est compté au pire cas', async () => {
    const { ex } = make(() => ({ kind: 'json', value: VALID }));
    expect(
      ex.calls.reserve(
        {
          id: 'c1',
          runId: 'run',
          windowId: null,
          stage: 'deep',
          chunkIndex: null,
          attempt: 1,
          model: 'claude-opus-5-5',
          promptVersion: 'deep-v1',
          requestHash: 'h',
          effort: 'high',
          maxTokens: 12000,
          sentManifest: {},
          requestRelPath: null,
        },
        0.3,
      ),
    ).toBe(true);
    expect(ex.calls.recoverStale()).toBe(1);
    expect(run()).toMatchObject({ reserved: 0 });
    expect(run().spent).toBeCloseTo(0.3, 9);
    expect(statuses()).toEqual(['unknown_cost']);
  });

  it('propriété : quelle que soit la suite d’appels, dépensé + réservé ≤ plafond', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0.0005, max: 0.05, noNaN: true }),
        fc.array(
          fc.record({
            kind: fc.constantFrom('ok', 'refused', 'truncated', 'billed', 'error'),
            out: fc.integer({ min: 0, max: 4000 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (budget, plan) => {
          const { ex } = setup(
            budget,
            2,
          )((_, i) => {
            const p = plan[i % plan.length]!;
            const usage = { inputTokens: 10, outputTokens: p.out };
            if (p.kind === 'ok') return { kind: 'json', value: VALID, usage };
            if (p.kind === 'refused') return { kind: 'refused', usage };
            if (p.kind === 'truncated') return { kind: 'truncated', usage: { inputTokens: 10 } };
            if (p.kind === 'billed')
              return {
                kind: 'error',
                error: err('retryable', 'CONNECTION', { maybeBilled: true }),
              };
            return { kind: 'error', error: err('retryable', 'HTTP_500') };
          });
          for (let i = 0; i < plan.length; i++) {
            try {
              await exec(ex, req(`t${i}`), { force: true });
            } catch (e) {
              expect((e as { code: string }).code).toBe('BUDGET_EXHAUSTED');
              break;
            }
            const r = run();
            expect(r.spent + r.reserved).toBeLessThanOrEqual(r.budget + 1e-6);
            expect(r.overrun).toBe(0);
          }
        },
      ),
    );
    // Propriété (60 tirages, une base par tirage) : même délai que les autres tests de propriétés,
    // pour une machine de CI chargée (job Windows : tests unitaires et de l'interface en parallèle).
  }, 60_000);
});
