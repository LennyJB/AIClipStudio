import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { effectiveDecisions } from '@acs/memory';
import { loadConfig, ROOT_DIR } from '../config';
import { openDatabase, type Db } from '../db';
import type { TranscriptionService } from '../transcriptions/service';
import { ReviewService } from './service';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 100) });

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

let db: Db;
let svc: ReviewService;
let clock = 0;
const at = () =>
  `2026-11-24T10:00:${String(Math.floor(clock / 1000)).padStart(2, '0')}.${String(clock++ % 1000).padStart(3, '0')}Z`;

function setup() {
  db = openDatabase(':memory:');
  clock = 0;
  db.prepare(
    `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
       game_id, media_info_json) VALUES ('11111111-1111-4111-8111-111111111111', '/a.mkv', 'a.mkv', 1, 1,
       'fp', 'mkv', 'valorant', '{}')`,
  ).run();
  const config = loadConfig({ NODE_ENV: 'test', STORAGE_DIR: '/tmp/acs-review-unit' }, ROOT_DIR);
  svc = new ReviewService({ config, db, log: silent }, {} as TranscriptionService);
}
const REC = '11111111-1111-4111-8111-111111111111';

function run(status = 'completed'): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
       transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd, prompt_version, created_at)
     VALUES (?, ?, 'claude', ?, 2, 'p', 'k', '[]', '{}', '{}', '{}', 5, 'triage-v1+deep-v1', ?)`,
  ).run(id, REC, status, at());
  return id;
}

/** Proposition : chute (segment, instant) et plage source. */
function proposal(
  runId: string,
  seg: number,
  punchMs: number,
  start: number,
  end: number,
  extra: { mergedInto?: string; tier?: 'clip' | 'secondary' } = {},
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clip_proposals (id, run_id, recording_id, tier, title, explanation, categories_json,
       relevance, reliability, reliability_json, src_start_ms, src_end_ms, setup_segment_id,
       punchline_segment_id, reaction_end_segment_id, punchline_ms, standalone, merged_into_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'e', '["humour"]', 80, 70, '{}', ?, ?, 1, ?, 3, ?, 1, ?, ?)`,
  ).run(
    id,
    runId,
    REC,
    extra.tier ?? 'clip',
    `p${seg}`,
    start,
    end,
    seg,
    punchMs,
    extra.mergedInto ?? null,
    at(),
  );
  return id;
}

const req = () => randomUUID();
const accept = (
  pid: string,
  o: { reevaluate?: boolean; comment?: string; requestId?: string } = {},
) =>
  svc.decide(
    pid,
    {
      requestId: o.requestId ?? req(),
      decision: 'accepted',
      ...(o.comment ? { comment: o.comment } : {}),
      ...(o.reevaluate ? { reevaluate: true } : {}),
    },
    'api',
  );
const reject = (
  pid: string,
  reasons: string[],
  o: { reevaluate?: boolean; comment?: string; requestId?: string } = {},
) =>
  svc.decide(
    pid,
    {
      requestId: o.requestId ?? req(),
      decision: 'rejected',
      reasons: reasons as never,
      ...(o.comment ? { comment: o.comment } : {}),
      ...(o.reevaluate ? { reevaluate: true } : {}),
    },
    'api',
  );
const reset = (pid: string, o: { reevaluate?: boolean; requestId?: string } = {}) =>
  svc.decide(
    pid,
    {
      requestId: o.requestId ?? req(),
      decision: 'pending',
      ...(o.reevaluate ? { reevaluate: true } : {}),
    },
    'api',
  );
const count = (t: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
const stateOf = (pid: string) => svc.detail(pid);
const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`attendu : ${code}`);
};

beforeEach(setup);

describe('décisions', () => {
  it('accepter puis refuser (plusieurs motifs) : un événement chacun, décision courante remplacée', () => {
    const r = run();
    const a = proposal(r, 10, 10_000, 0, 30_000);
    const res = accept(a, { comment: 'top' });
    expect(res).toMatchObject({ outcome: 'applied', replayed: false, state: 'accepted' });
    expect(res.event).toMatchObject({
      type: 'proposal_accepted',
      recordingId: REC,
      gameId: 'valorant',
      proposalId: a,
      runId: r,
      previousStatus: 'pending',
      newStatus: 'accepted',
      comment: 'top',
      source: 'api',
    });
    expect(res.event!.snapshot).toMatchObject({
      tier: 'clip',
      durationMs: 30_000,
      memoryVersion: null,
    });
    expect(res.event!.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const r2 = reject(a, ['trop_long', 'pas_drole']);
    expect(r2.review).toMatchObject({
      status: 'rejected',
      reasons: ['pas_drole', 'trop_long'],
      comment: null,
    });
    expect(count('feedback_events')).toBe(2);
  });

  it('règles de saisie : motif obligatoire, « autre » avec commentaire, motif inconnu → 400', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    expectCode(() => reject(a, []), 'VALIDATION_FAILED');
    expectCode(() => reject(a, ['autre']), 'VALIDATION_FAILED');
    expectCode(() => reject(a, ['nul']), 'VALIDATION_FAILED');
    expect(reject(a, ['autre'], { comment: 'son saturé' }).outcome).toBe('applied');
    expect(count('feedback_events')).toBe(1);
  });

  it('proposition fusionnée ou analyse non terminée : non jugeable', () => {
    const r = run();
    const a = proposal(r, 10, 10_000, 0, 30_000);
    const m = proposal(r, 11, 10_000, 0, 30_000, { mergedInto: a });
    expectCode(() => accept(m), 'PROPOSAL_NOT_REVIEWABLE');
    const running = proposal(run('running'), 12, 50_000, 40_000, 70_000);
    expectCode(() => accept(running), 'PROPOSAL_NOT_REVIEWABLE');
    expect(count('feedback_events')).toBe(0);
  });
});

describe('idempotence', () => {
  it('même requestId : réponse d’origine rejouée, un seul événement', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    const id = req();
    const first = accept(a, { requestId: id });
    const again = accept(a, { requestId: id });
    expect(again).toEqual({ ...first, replayed: true });
    expect(count('feedback_events')).toBe(1);
  });

  it('demande sans effet rejouée après un changement d’état : réponse noop d’origine, rien n’est défait', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a);
    const x = req();
    const noop = accept(a, { requestId: x });
    expect(noop).toMatchObject({ outcome: 'noop', event: null, state: 'accepted' });
    reject(a, ['deja_vu']); // la demande Y change l'état
    const replay = accept(a, { requestId: x });
    expect(replay).toEqual({ ...noop, replayed: true });
    expect(stateOf(a).state).toBe('rejected'); // X n'a rien défait
    expect(count('feedback_events')).toBe(2);
    expect(
      db.prepare(`SELECT outcome, event_id FROM review_requests WHERE request_id = ?`).get(x),
    ).toEqual({
      outcome: 'noop',
      event_id: null,
    });
  });

  it('même requestId avec un autre contenu → IDEMPOTENCY_MISMATCH', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    const id = req();
    accept(a, { requestId: id });
    expectCode(() => reject(a, ['pas_drole'], { requestId: id }), 'IDEMPOTENCY_MISMATCH');
    expect(count('feedback_events')).toBe(1);
  });

  it('un refus (409) n’est pas enregistré ; version périmée → VERSION_CONFLICT', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a);
    const id = req();
    expectCode(
      () =>
        svc.decide(
          a,
          { requestId: id, decision: 'rejected', reasons: ['pas_drole'], expectedVersion: 0 },
          'ui',
        ),
      'VERSION_CONFLICT',
    );
    expect(svc.repo.findRequest(id)).toBeNull();
    const ok = svc.decide(
      a,
      { requestId: id, decision: 'rejected', reasons: ['pas_drole'], expectedVersion: 1 },
      'ui',
    );
    expect(ok).toMatchObject({ outcome: 'applied', version: 2 });
  });
});

describe('doublons entre analyses (moments)', () => {
  it('décision héritée sans événement ; réévaluation explicite ; un seul moment compté', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a);
    const b = proposal(run(), 10, 10_200, 500, 31_000); // --force : même chute
    expect(stateOf(b)).toMatchObject({
      state: 'already_reviewed',
      review: null,
      effective: { inherited: true, sourceProposalId: a },
    });
    expect(count('feedback_events')).toBe(1);
    const list = svc.list(REC, { status: 'to_review' });
    expect(list.items).toEqual([]);
    expect(svc.list(REC, { status: 'already_reviewed' }).items.map((i) => i.proposal.id)).toEqual([
      b,
    ]);

    expectCode(() => reject(b, ['deja_vu']), 'ALREADY_REVIEWED');
    expect(count('feedback_events')).toBe(1);
    const re = reject(b, ['deja_vu'], { reevaluate: true });
    expect(re.event).toMatchObject({
      reevaluatesEventId: expect.any(String),
      previousStatus: 'accepted',
    });
    expect(stateOf(a)).toMatchObject({
      state: 'already_reviewed',
      review: null,
      supersededReview: { status: 'accepted' },
    });
    expect(stateOf(b)).toMatchObject({ state: 'rejected' });
    expect(svc.list(REC).summary).toMatchObject({ moments: 1, rejected: 1, accepted: 0 });
    // Réévaluation sans changement → noop
    expect(accept(a, { reevaluate: true })).toMatchObject({ outcome: 'applied' });
    expect(accept(b, { reevaluate: true })).toMatchObject({ outcome: 'noop' });
  });

  it('nouvelle transcription (autre segment) : rapprochement par chute proche et recouvrement', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a);
    const b = proposal(run(), 99, 11_500, 1_000, 29_000);
    expect(stateOf(b).state).toBe('already_reviewed');
    const c = proposal(run(), 98, 60_000, 50_000, 80_000); // autre passage
    expect(stateOf(c).state).toBe('to_review');
  });

  it('stabilité : relister ou lancer une nouvelle analyse ne modifie aucune appartenance existante', () => {
    const r1 = run();
    proposal(r1, 1, 10_000, 5_000, 15_000);
    proposal(r1, 2, 11_500, 6_000, 16_000);
    svc.list(REC);
    const snap = () =>
      db
        .prepare(
          'SELECT proposal_id, moment_id, match_kind, score, rule_version, linked_at FROM moment_members ORDER BY proposal_id',
        )
        .all();
    const before = snap();
    svc.list(REC);
    svc.list(REC, { status: 'to_review' });
    proposal(run(), 3, 13_000, 7_000, 17_000);
    svc.list(REC);
    const after = snap() as { proposal_id: string }[];
    for (const row of before as { proposal_id: string }[]) {
      expect(after.find((x) => x.proposal_id === row.proposal_id)).toEqual(row);
    }
    expect(after).toHaveLength(3);
  });

  it('A-B-C sur trois analyses successives : A et C jamais réunis', () => {
    const a = proposal(run(), 1, 10_000, 5_000, 15_000);
    const b = proposal(run(), 2, 11_500, 6_000, 16_000);
    const c = proposal(run(), 3, 13_000, 7_000, 17_000);
    svc.ensureMoments(REC);
    const m = (p: string) => svc.repo.membership(p)!.momentId;
    expect(m(a)).toBe(m(b));
    expect(m(c)).not.toBe(m(a));
  });
});

describe('réinitialisation', () => {
  it('décision héritée : annuler est refusé, même avec reevaluate ; aucune écriture', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a);
    const b = proposal(run(), 10, 10_000, 0, 30_000);
    expectCode(() => reset(b), 'DECISION_ELSEWHERE');
    expectCode(() => reset(b, { reevaluate: true }), 'DECISION_ELSEWHERE');
    expect(count('feedback_events')).toBe(1);
    expect(count('review_requests')).toBe(1);
  });

  it('scénario A acceptée, B refusée, puis réinitialisation : sur A refusée, sur B tout le moment redevient à examiner', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a, { comment: 'bien' });
    const b = proposal(run(), 10, 10_000, 0, 30_000);
    reject(b, ['pas_drole'], { reevaluate: true, comment: 'finalement non' });
    expectCode(() => reset(a), 'DECISION_ELSEWHERE');
    expect(stateOf(a).effective.status).toBe('rejected');
    reset(b);
    for (const p of [a, b]) {
      const d = stateOf(p);
      expect(d).toMatchObject({
        state: 'to_review',
        review: null,
        effective: { status: 'pending', reasons: [], comment: null },
      });
    }
    // L'ancienne acceptation de A ne réapparaît pas comme décision actuelle :
    expect(stateOf(a).supersededReview).toMatchObject({ status: 'accepted', comment: 'bien' });
    expect(svc.repo.review(b)).toMatchObject({
      status: 'pending',
      reasons: [],
      comment: null,
      decidedAt: null,
    });
    const h = svc.history(a);
    expect(h.events.map((e) => e.type)).toEqual([
      'proposal_accepted',
      'proposal_rejected',
      'proposal_reset',
    ]);
    expect(h.events.map((e) => e.current)).toEqual([false, false, true]);
  });

  it('variante : A réévaluée redevient la source, puis réinitialisée → à examiner ; le refus de B ne réapparaît pas', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a);
    const b = proposal(run(), 10, 10_000, 0, 30_000);
    reject(b, ['trop_court'], { reevaluate: true });
    accept(a, { reevaluate: true });
    reset(a);
    expect(stateOf(b)).toMatchObject({ state: 'to_review', effective: { status: 'pending' } });
    const members = new Map([
      [a, svc.repo.membership(a)!.momentId],
      [b, svc.repo.membership(b)!.momentId],
    ]);
    expect(
      effectiveDecisions(svc.repo.decisionEvents(), members).get(members.get(a)!),
    ).toMatchObject({ status: 'pending' });
  });

  it('refus avec motifs puis annulation puis acceptation : aucun ancien motif courant', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    reject(a, ['pas_drole', 'autre'], { comment: 'bof' });
    reset(a);
    expect(svc.repo.review(a)).toMatchObject({ status: 'pending', reasons: [], comment: null });
    const r = accept(a);
    expect(r.review).toMatchObject({ status: 'accepted', reasons: [], comment: null });
    expect(reset(proposal(run(), 50, 90_000, 80_000, 100_000)).outcome).toBe('noop');
  });
});

describe('détachement explicite', () => {
  it('nouveau moment, trace technique, aucun événement éditorial ; rejeu sans effet', () => {
    const a = proposal(run(), 10, 10_000, 0, 30_000);
    accept(a);
    const b = proposal(run(), 10, 10_000, 0, 30_000);
    expect(stateOf(b).state).toBe('already_reviewed');
    const id = req();
    const d = svc.detach(b, { requestId: id, comment: 'autre blague' }, 'cli');
    expect(d).toMatchObject({ outcome: 'applied', state: 'to_review' });
    expect(svc.repo.membership(b)).toMatchObject({ matchKind: 'detached' });
    expect(count('moment_changes')).toBe(1);
    expect(count('feedback_events')).toBe(1);
    expect(svc.detach(b, { requestId: id, comment: 'autre blague' }, 'cli')).toMatchObject({
      replayed: true,
    });
    expect(count('moment_changes')).toBe(1);
    expect(svc.detach(b, { requestId: req() }, 'cli')).toMatchObject({ outcome: 'noop' }); // déjà seule
    expect(stateOf(a).state).toBe('accepted');
  });
});

describe('cohérence base ↔ effectiveDecisions (propriété)', () => {
  it('pour toute suite de décisions, réévaluations, réinitialisations et détachements', () => {
    const op = fc.record({
      kind: fc.constantFrom('accept', 'reject', 'reset', 'detach'),
      target: fc.nat(5),
      reevaluate: fc.boolean(),
      reason: fc.constantFrom('pas_drole', 'trop_long', 'deja_vu'),
    });
    fc.assert(
      fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
        setup();
        // 2 passages × 3 analyses : propositions équivalentes deux à deux.
        const ids = [0, 1, 2].flatMap(() => {
          const r = run();
          return [proposal(r, 10, 10_000, 0, 30_000), proposal(r, 20, 60_000, 50_000, 80_000)];
        });
        svc.ensureMoments(REC);
        for (const o of ops) {
          const pid = ids[o.target % ids.length]!;
          try {
            if (o.kind === 'accept') accept(pid, { reevaluate: o.reevaluate });
            else if (o.kind === 'reject') reject(pid, [o.reason], { reevaluate: o.reevaluate });
            else if (o.kind === 'reset') reset(pid, { reevaluate: o.reevaluate });
            else svc.detach(pid, { requestId: req() }, 'api');
          } catch (e) {
            expect(['ALREADY_REVIEWED', 'DECISION_ELSEWHERE']).toContain(
              (e as { code: string }).code,
            );
          }
        }
        const members = new Map(svc.repo.allMemberships().map((m) => [m.proposalId, m.momentId]));
        const pure = effectiveDecisions(svc.repo.decisionEvents(), members);
        for (const momentId of new Set(members.values())) {
          const fromDb = svc.repo.effectiveForMoment(momentId);
          const p = pure.get(momentId);
          expect({
            status: fromDb.status,
            source: fromDb.sourceProposalId,
            reasons: fromDb.reasons,
          }).toEqual({
            status: p?.status ?? 'pending',
            source: p?.sourceProposalId ?? null,
            reasons: p?.reasons ?? [],
          });
        }
      }),
    );
  });
});

describe('journal', () => {
  it('survit à la suppression de l’analyse ; export par moment', () => {
    const r = run();
    const a = proposal(r, 10, 10_000, 0, 30_000);
    accept(a);
    const lines = svc.exportLines().map((l) => JSON.parse(l) as { kind: string });
    expect(lines.map((l) => l.kind).sort()).toEqual(['event', 'membership', 'moment_decision']);
    db.prepare('DELETE FROM analysis_runs WHERE id = ?').run(r);
    expect(svc.journal({ recordingId: REC }).events).toHaveLength(1);
  });
});
