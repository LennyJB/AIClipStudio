import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentTypesView, Recording } from '../api';
import { ContentTypesPanel, parseClock } from './ContentTypesPanel';

const recording: Recording = {
  id: 'rec-1',
  fileName: 'stream.mkv',
  durationSec: 3600,
  gameId: 'valorant',
  audioTracks: [{ audioIndex: 0, role: 'mix', title: 'Tout' }],
};
const MIN = 60_000;

const detected: ContentTypesView = {
  recordingId: 'rec-1',
  durationMs: 60 * MIN,
  detection: {
    id: 1,
    createdAt: '2026-11-27T10:00:00Z',
    stale: false,
    detection: {
      durationMs: 60 * MIN,
      segments: [
        {
          startMs: 0,
          endMs: 20 * MIN,
          type: 'just_chatting',
          confidence: 0.82,
          source: 'auto',
          basis: ['transcription', 'visuel'],
          candidates: [{ type: 'just_chatting', score: 0.7 }],
        },
        {
          startMs: 20 * MIN,
          endMs: 30 * MIN,
          type: 'unknown',
          confidence: 0,
          source: 'auto',
          basis: [],
          candidates: [
            { type: 'reaction', score: 0.4 },
            { type: 'irl', score: 0.38 },
          ],
          reason: 'indices trop proches (reaction / irl)',
        },
        {
          startMs: 30 * MIN,
          endMs: 60 * MIN,
          type: 'gaming',
          confidence: 0.55,
          source: 'auto',
          basis: ['transcription'],
          candidates: [{ type: 'gaming', score: 0.6 }],
        },
      ],
      summary: { kind: 'mixed', types: [], unknownShare: 0.17 },
      limits: [
        'Voix non séparées (piste unique) : la répartition de la parole entre interlocuteurs est inconnue.',
      ],
    },
  },
  correction: null,
  effective: {
    source: 'auto',
    segments: [
      { startMs: 0, endMs: 20 * MIN, type: 'just_chatting', confidence: 0.82, source: 'auto' },
      { startMs: 20 * MIN, endMs: 30 * MIN, type: 'unknown', confidence: 0, source: 'auto' },
      { startMs: 30 * MIN, endMs: 60 * MIN, type: 'gaming', confidence: 0.55, source: 'auto' },
    ],
    summary: { kind: 'mixed', types: [], unknownShare: 0.17 },
  },
  job: null,
};

let state: { view: ContentTypesView; puts: unknown[]; posts: unknown[]; jobStatus: string };

function mockApi() {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/recordings/rec-1/content-types' && (!init || init.method === undefined))
      return json(state.view);
    if (url === '/api/recordings/rec-1/content-types/detect') {
      state.posts.push(JSON.parse(String(init?.body)));
      return json(
        {
          status: 'pending',
          job: { id: 'job-1', status: 'queued', progress: 0, error: null },
          view: state.view,
        },
        202,
      );
    }
    if (url === '/api/jobs/job-1') {
      if (state.jobStatus === 'succeeded') state.view = detected;
      return json({ job: { id: 'job-1', status: state.jobStatus, progress: 1, error: null } });
    }
    if (url === '/api/recordings/rec-1/content-types' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as {
        requestId: string;
        segments: { startMs: number; endMs: number; type: string }[] | null;
      };
      state.puts.push(body);
      state.view = body.segments
        ? {
            ...detected,
            correction: { id: 1, createdAt: '2026-11-27T11:00:00Z', segments: null },
            effective: {
              source: 'manual',
              segments: body.segments.map((s) => ({
                ...s,
                type: s.type as 'gaming',
                confidence: 1,
                source: 'manual' as const,
              })),
              summary: { kind: 'mixed', types: [], unknownShare: 0 },
            },
          }
        : detected;
      return json(state.view);
    }
    return json({ error: { message: `inattendu ${url}` } }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  state = {
    view: { ...detected, detection: null, effective: null },
    puts: [],
    posts: [],
    jobStatus: 'running',
  };
  mockApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseClock', () => {
  it('accepte h:mm:ss, mm:ss et des secondes ; refuse le reste', () => {
    expect(parseClock('1:02:03')).toBe(3_723_000);
    expect(parseClock('12:30')).toBe(750_000);
    expect(parseClock('45')).toBe(45_000);
    for (const bad of ['', '1:75', 'abc', '1:2:3:4', '-5']) expect(parseClock(bad)).toBeNull();
  });
});

describe('ContentTypesPanel', () => {
  it('sans segmentation : le dit, puis lance la détection et affiche le résultat', async () => {
    render(<ContentTypesPanel recording={recording} pollMs={10} />);
    expect((await screen.findByTestId('content-none')).textContent).toContain('gaming');
    fireEvent.click(screen.getByRole('button', { name: 'Détecter les types de contenu' }));
    await screen.findByTestId('content-job');
    expect(state.posts).toEqual([{ force: false }]);
    state.jobStatus = 'succeeded';
    expect((await screen.findByTestId('content-summary')).textContent).toContain('Mixte');
  });

  it('affiche segments, confiance, « non conclu » avec ses pistes, indices et limites', async () => {
    state.view = detected;
    render(<ContentTypesPanel recording={recording} />);
    const list = await screen.findByTestId('content-segments');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('Just Chatting');
    expect(items[0]!.textContent).toContain('probable (82 %)');
    expect(items[0]!.textContent).toContain('activité de l’image');
    expect(items[1]!.textContent).toContain('Indéterminé');
    expect(items[1]!.textContent).toContain('non conclu');
    expect(items[1]!.textContent).toContain('pistes : Réaction, IRL');
    expect(items[2]!.textContent).toContain('incertain (55 %)');
    expect(screen.getByTestId('content-limits').textContent).toContain('piste unique');
  });

  it('corrige : change un type, coupe, fusionne, enregistre une segmentation complète ; puis revient à l’automatique', async () => {
    state.view = detected;
    render(<ContentTypesPanel recording={recording} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Corriger' }));
    const editor = screen.getByTestId('content-editor');
    // L'indéterminé devient Réaction.
    fireEvent.change(within(editor).getByLabelText('Type du segment 2'), {
      target: { value: 'reaction' },
    });
    // Coupe invalide refusée, puis coupe du segment gaming à 45:00.
    fireEvent.change(within(editor).getByLabelText('Couper le segment 3 à'), {
      target: { value: '10:00' },
    });
    fireEvent.click(within(editor).getAllByRole('button', { name: 'Couper' })[2]!);
    expect(screen.getByText(/Instant de coupe invalide/u)).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Couper le segment 3 à'), {
      target: { value: '45:00' },
    });
    fireEvent.click(within(editor).getAllByRole('button', { name: 'Couper' })[2]!);
    fireEvent.change(within(editor).getByLabelText('Type du segment 4'), {
      target: { value: 'just_chatting' },
    });
    // Fusion des deux premiers : Just Chatting 0–30 min (type du premier).
    fireEvent.click(
      within(editor).getAllByRole('button', { name: 'Fusionner avec le suivant' })[0]!,
    );
    fireEvent.click(within(editor).getByRole('button', { name: 'Enregistrer la correction' }));

    await waitFor(() => expect(state.puts).toHaveLength(1));
    const put = state.puts[0] as { requestId: string; segments: unknown };
    expect(put.requestId.length).toBeGreaterThanOrEqual(8);
    expect(put.segments).toEqual([
      { startMs: 0, endMs: 30 * MIN, type: 'just_chatting' },
      { startMs: 30 * MIN, endMs: 45 * MIN, type: 'gaming' },
      { startMs: 45 * MIN, endMs: 60 * MIN, type: 'just_chatting' },
    ]);
    expect(
      await screen.findByText('segmentation corrigée par vous', { exact: false }),
    ).toBeTruthy();
    expect(screen.getAllByText(/confirmé par vous/u)).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Revenir à la détection automatique' }));
    await waitFor(() => expect(state.puts).toHaveLength(2));
    expect((state.puts[1] as { segments: unknown }).segments).toBeNull();
    expect(await screen.findByText('détection automatique', { exact: false })).toBeTruthy();
  });
});
