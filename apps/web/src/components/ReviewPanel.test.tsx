import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REJECT_REASON_LABELS as MEMORY_LABELS,
  REJECT_REASONS as MEMORY_REASONS,
} from '../../../../packages/memory/src/reasons';
import { REJECT_REASON_LABELS, REJECT_REASONS } from '../api';
import { ReviewPanel } from './ReviewPanel';

type Status = 'pending' | 'accepted' | 'rejected';
interface FakeProp {
  id: string;
  runId: string;
  tier: 'clip' | 'secondary';
  title: string;
  status: Status;
  reasons: string[];
  comment: string | null;
  version: number;
  inheritedFrom?: { proposalId: string; runId: string; title: string; status: Status };
}

let props: FakeProp[];
let decisions: Record<string, unknown>[];
let listQueries: string[];
let failNextDecision: 'network' | 'conflict' | null;
let audioMode: 'ok' | 'missing';
let history: Record<string, unknown>[];

const RUN1 = 'run-1';
const RUN2 = 'run-2';

function base(id: string, tier: 'clip' | 'secondary', title: string, runId = RUN1): FakeProp {
  return { id, runId, tier, title, status: 'pending', reasons: [], comment: null, version: 0 };
}

function item(p: FakeProp) {
  const inherited = !!p.inheritedFrom;
  const eff = inherited
    ? {
        status: p.inheritedFrom!.status,
        reasons: [],
        comment: null,
        sourceProposalId: p.inheritedFrom!.proposalId,
        eventId: 'e0',
        inherited: true,
        source: {
          proposalId: p.inheritedFrom!.proposalId,
          runId: p.inheritedFrom!.runId,
          title: p.inheritedFrom!.title,
          decidedAt: '2026-11-24T10:00:00.000Z',
        },
      }
    : {
        status: p.status,
        reasons: p.reasons,
        comment: p.comment,
        sourceProposalId: p.status === 'pending' ? null : p.id,
        eventId: null,
        inherited: false,
        source: null,
      };
  return {
    proposal: {
      id: p.id,
      runId: p.runId,
      recordingId: 'rec-1',
      tier: p.tier,
      title: p.title,
      explanation: 'Explication.',
      categories: ['humour'],
      relevance: 84,
      reliability: 90,
      reliabilityDetail: { reasons: [] },
      flags: [],
      srcStartMs: 110_000,
      srcEndMs: 133_800,
      punchlineMs: 125_000,
      uncertainty: null,
      mergedIntoId: null,
      editingHint: null,
      evidence: [{ kind: 'quote', segmentId: 8, quote: 'j’adore perdre ce round', verified: true }],
    },
    momentId: `m-${p.id}`,
    review:
      !inherited && p.status !== 'pending'
        ? { status: p.status, reasons: p.reasons, comment: p.comment }
        : null,
    supersededReview: null,
    effective: eff,
    state: inherited ? 'already_reviewed' : p.status === 'pending' ? 'to_review' : p.status,
    version: p.version,
  };
}

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const u = new URL(url, 'http://x');
      if (u.pathname === '/api/recordings/rec-1/proposals') {
        listQueries.push(u.search);
        const runId = u.searchParams.get('runId') ?? RUN1;
        const tier = u.searchParams.get('tier');
        const status = u.searchParams.get('status') ?? 'all';
        const all = props.filter((p) => p.runId === runId).map(item);
        return json({
          run: { id: runId, status: 'completed', createdAt: '2026-11-24T10:00:00.000Z' },
          runs: [
            { id: RUN1, status: 'completed', createdAt: '2026-11-24T10:00:00.000Z' },
            { id: RUN2, status: 'completed', createdAt: '2026-11-23T10:00:00.000Z' },
          ],
          items: all.filter(
            (i) => (!tier || i.proposal.tier === tier) && (status === 'all' || i.state === status),
          ),
          counts: {
            all: all.length,
            to_review: all.filter((i) => i.state === 'to_review').length,
            accepted: 0,
            rejected: 0,
            already_reviewed: 0,
            merged: 0,
          },
        });
      }
      const m = /^\/api\/proposals\/([^/]+)(\/[a-z]+)?$/.exec(u.pathname);
      if (m) {
        const p = props.find((x) => x.id === m[1])!;
        const sub = m[2];
        if (!sub)
          return json({
            ...item(p),
            moment: {
              id: `m-${p.id}`,
              members: [{ proposalId: p.id, runId: p.runId, title: p.title, isSource: true }],
            },
            run: null,
          });
        if (sub === '/context')
          return json({
            clip: { srcStartMs: 110_000, srcEndMs: 133_800 },
            segments: [
              {
                id: 7,
                role: 'mic',
                srcStartMs: 118_000,
                srcEndMs: 121_000,
                text: 'Bon on va tenter le plan',
                inClip: true,
                marker: 'setup',
                sentToClaude: true,
              },
              {
                id: 8,
                role: 'mic',
                srcStartMs: 125_000,
                srcEndMs: 128_000,
                text: 'Ah super, j’adore perdre ce round',
                inClip: true,
                marker: 'punchline',
                sentToClaude: true,
              },
              {
                id: 9,
                role: 'discord',
                srcStartMs: 122_000,
                srcEndMs: 124_000,
                text: 'fais-moi confiance',
                inClip: true,
                marker: null,
                sentToClaude: false,
              },
            ],
          });
        if (sub === '/events')
          return json({ events: history.filter((e) => e['proposalId'] === p.id) });
        if (sub === '/audio' && init?.method === 'POST') {
          if (audioMode === 'missing')
            return json(
              {
                error: {
                  code: 'AUDIO_TRACK_MISSING',
                  message: 'Écoute indisponible : cet enregistrement n’a pas de piste « tout »',
                },
              },
              409,
            );
          return json({
            status: 'ready',
            derivativeId: 'd1',
            durationMs: 26_800,
            windowStartMs: 108_500,
            windowEndMs: 135_300,
          });
        }
        if (sub === '/decision') {
          const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
          decisions.push(body);
          if (failNextDecision === 'network') {
            failNextDecision = null;
            throw new TypeError('Failed to fetch');
          }
          if (failNextDecision === 'conflict') {
            failNextDecision = null;
            p.status = 'accepted';
            p.version += 1;
            return json({ error: { code: 'VERSION_CONFLICT', message: 'modifiée' } }, 409);
          }
          if (p.inheritedFrom && body['decision'] === 'pending')
            return json({ error: { code: 'DECISION_ELSEWHERE', message: 'ailleurs' } }, 409);
          const prev = p.status;
          delete p.inheritedFrom;
          p.status = body['decision'] as Status;
          p.reasons = (body['reasons'] as string[] | undefined) ?? [];
          p.comment = (body['comment'] as string | undefined) ?? null;
          p.version += 1;
          for (const e of history) if (e['proposalId'] === p.id) e['current'] = false;
          history.push({
            seq: history.length + 1,
            id: `e${history.length + 1}`,
            type:
              p.status === 'accepted'
                ? 'proposal_accepted'
                : p.status === 'rejected'
                  ? 'proposal_rejected'
                  : 'proposal_reset',
            occurredAt: '2026-11-24T11:00:00.000Z',
            proposalId: p.id,
            runId: p.runId,
            newStatus: p.status,
            reasons: p.reasons,
            comment: p.comment,
            reevaluatesEventId: null,
            current: true,
          });
          return json({
            ...item(p),
            outcome: prev === p.status ? 'noop' : 'applied',
            replayed: false,
          });
        }
      }
      return json({ error: { message: `inattendu : ${url}` } }, 404);
    }),
  );
}

const open = async (title: string) => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
  return screen.findByRole('article', { name: new RegExp(title) });
};

describe('ReviewPanel', () => {
  beforeEach(() => {
    props = [base('p1', 'clip', 'Le plan infaillible'), base('p2', 'secondary', 'Le malentendu')];
    decisions = [];
    listQueries = [];
    failNextDecision = null;
    audioMode = 'ok';
    history = [];
    mockApi();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('motifs identiques à ceux de @acs/memory', () => {
    expect(REJECT_REASONS).toEqual(MEMORY_REASONS);
    expect(REJECT_REASON_LABELS).toEqual(MEMORY_LABELS);
  });

  it('clips et moments secondaires séparés ; filtre « À examiner » par défaut', async () => {
    render(<ReviewPanel recordingId="rec-1" />);
    expect(await screen.findByRole('button', { name: /Le plan infaillible/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Le malentendu/ })).toBeNull();
    expect(listQueries[0]).toContain('tier=clip');
    expect(listQueries[0]).toContain('status=to_review');
    fireEvent.click(screen.getByRole('tab', { name: 'Moments secondaires' }));
    expect(await screen.findByRole('button', { name: /Le malentendu/ })).toBeTruthy();
  });

  it('refus : impossible sans motif ; « Autre » exige un commentaire ; plusieurs motifs envoyés', async () => {
    render(<ReviewPanel recordingId="rec-1" />);
    const card = await open('Le plan infaillible');
    fireEvent.click(within(card).getByRole('button', { name: 'Refuser' }));
    const dialog = await screen.findByRole('dialog', { name: 'Motifs du refus' });
    const confirm = within(dialog).getByRole('button', {
      name: 'Confirmer le refus',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText('Autre'));
    expect(confirm.disabled).toBe(true); // commentaire obligatoire
    fireEvent.click(within(dialog).getByLabelText('Trop long'));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'trop lent' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toMatchObject({
      decision: 'rejected',
      reasons: ['autre', 'trop_long'],
      comment: 'trop lent',
      expectedVersion: 0,
    });
    expect(decisions[0]!['requestId']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('coupure réseau : la nouvelle tentative renvoie le même requestId', async () => {
    render(<ReviewPanel recordingId="rec-1" />);
    const card = await open('Le plan infaillible');
    failNextDecision = 'network';
    fireEvent.click(within(card).getByRole('button', { name: 'Accepter' }));
    expect(await within(card).findByRole('alert')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Accepter' }));
    await waitFor(() => expect(decisions).toHaveLength(2));
    expect(decisions[1]!['requestId']).toBe(decisions[0]!['requestId']);
    // Une action différente ensuite : nouvel identifiant.
    await waitFor(() => expect(within(card).getByText(/Acceptée/, { selector: 'p' })).toBeTruthy());
  });

  it('conflit de version (409) : message et état actualisé', async () => {
    render(<ReviewPanel recordingId="rec-1" />);
    const card = await open('Le plan infaillible');
    failNextDecision = 'conflict';
    fireEvent.click(within(card).getByRole('button', { name: 'Refuser' }));
    const dialog = await screen.findByRole('dialog', { name: 'Motifs du refus' });
    fireEvent.click(within(dialog).getByLabelText('Pas drôle'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmer le refus' }));
    expect((await within(card).findByRole('alert')).textContent).toMatch(/modifiée entre-temps/);
    await waitFor(() =>
      expect(within(card).getByLabelText('Décision actuelle').textContent).toMatch(/Acceptée/),
    );
  });

  it('annulation : la décision actuelle redevient « À examiner », l’ancienne n’apparaît que dans l’historique', async () => {
    render(<ReviewPanel recordingId="rec-1" />);
    const card = await open('Le plan infaillible');
    fireEvent.click(within(card).getByRole('button', { name: 'Refuser' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('Chute coupée'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmer le refus' }));
    await waitFor(() =>
      expect(within(card).getByLabelText('Décision actuelle').textContent).toMatch(/Chute coupée/),
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Annuler la décision' }));
    await waitFor(() =>
      expect(within(card).getByLabelText('Décision actuelle').textContent).toMatch(/À examiner/),
    );
    expect(within(card).getByLabelText('Décision actuelle').textContent).not.toMatch(
      /Chute coupée/,
    );
    const h = within(card).getByLabelText('Historique des décisions').textContent ?? '';
    expect(h).toMatch(/Refusée \(Chute coupée\) — décision antérieure/);
    expect(h).toMatch(/Décision annulée — décision actuelle/);
  });

  it('décision héritée : pas d’« Annuler », lien vers la source, « Réévaluer » nécessaire', async () => {
    props = [
      {
        ...base('p3', 'clip', 'Le plan (relance)'),
        inheritedFrom: {
          proposalId: 'src',
          runId: RUN2,
          title: 'Le plan infaillible',
          status: 'accepted',
        },
      },
      { ...base('src', 'clip', 'Le plan infaillible', RUN2), status: 'accepted', version: 1 },
    ];
    render(<ReviewPanel recordingId="rec-1" />);
    fireEvent.click(await screen.findByRole('radio', { name: /Toutes/ }));
    const card = await open('Le plan \\(relance\\)');
    expect(within(card).getByRole('note').textContent).toMatch(
      /Déjà examinée : acceptée.*« Le plan infaillible »/,
    );
    expect(within(card).queryByRole('button', { name: 'Annuler la décision' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Accepter' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Réévaluer' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Refuser' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('Déjà vu'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmer le refus' }));
    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toMatchObject({
      decision: 'rejected',
      reasons: ['deja_vu'],
      reevaluate: true,
    });
  });

  it('« Ouvrir la proposition source » bascule sur l’analyse de la source', async () => {
    props = [
      {
        ...base('p3', 'clip', 'Le plan (relance)'),
        inheritedFrom: {
          proposalId: 'src',
          runId: RUN2,
          title: 'Le plan infaillible',
          status: 'accepted',
        },
      },
      { ...base('src', 'clip', 'Le plan infaillible', RUN2), status: 'accepted', version: 1 },
    ];
    render(<ReviewPanel recordingId="rec-1" />);
    fireEvent.click(await screen.findByRole('radio', { name: /Toutes/ }));
    const card = await open('Le plan \\(relance\\)');
    fireEvent.click(within(card).getByRole('button', { name: 'Ouvrir la proposition source' }));
    expect(await screen.findByRole('article', { name: /« Le plan infaillible »/ })).toBeTruthy();
    await waitFor(() => expect(listQueries.at(-1)).toContain(`runId=${RUN2}`));
  });

  it('contexte : marqueurs et pistes non transmises à Claude signalées', async () => {
    render(<ReviewPanel recordingId="rec-1" />);
    const card = await open('Le plan infaillible');
    const ctx = await within(card).findByLabelText('Transcription autour du moment');
    await waitFor(() => expect(ctx.textContent).toMatch(/\[chute\] Ah super/));
    expect(ctx.textContent).toMatch(/fais-moi confiance non transmis à Claude/);
  });

  it('écoute : lecteur audio prêt ; enregistrement sans piste « tout » : message clair', async () => {
    render(<ReviewPanel recordingId="rec-1" />);
    let card = await open('Le plan infaillible');
    fireEvent.click(within(card).getByRole('button', { name: 'Écouter le passage' }));
    const player = await within(card).findByLabelText('Extrait audio (piste « tout »)');
    expect(player.getAttribute('src')).toBe('/api/proposals/p1/audio?v=d1');
    cleanup();
    audioMode = 'missing';
    render(<ReviewPanel recordingId="rec-1" />);
    card = await open('Le plan infaillible');
    fireEvent.click(within(card).getByRole('button', { name: 'Écouter le passage' }));
    expect(await within(card).findByText(/pas de piste « tout »/)).toBeTruthy();
  });
});
