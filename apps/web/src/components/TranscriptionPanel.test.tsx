import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recording, Segment, Transcription } from '../api';
import { TranscriptionPanel } from './TranscriptionPanel';

const recording: Recording = {
  id: 'rec-1',
  fileName: 'stream.mkv',
  durationSec: 3600,
  gameId: 'valorant',
  audioTracks: [
    { audioIndex: 0, role: 'mix', title: 'Tout' },
    { audioIndex: 1, role: 'mic', title: 'Micro' },
    { audioIndex: 2, role: 'discord', title: 'Discord' },
  ],
};

const run = (over: Partial<Transcription>): Transcription => ({
  id: 't',
  audioIndex: 1,
  model: 'large-v3-turbo',
  status: 'completed',
  devicesUsed: ['cuda'],
  fallbackError: null,
  language: 'fr',
  languageSource: 'detected',
  audioDurationMs: 3_600_000,
  checkpointMs: 3_600_000,
  segmentCount: 2,
  processingMs: 120_000,
  realtimeFactor: 30,
  error: null,
  createdAt: '2026-11-23T10:00:00Z',
  ...over,
});

const segment = (over: Partial<Segment>): Segment => ({
  id: 1,
  transcriptionId: 't',
  audioIndex: 1,
  role: 'mic',
  srcStartMs: 0,
  srcEndMs: 1000,
  text: '',
  suspicionScore: 0,
  suspicionReasons: [],
  ...over,
});

let state: { runs: Transcription[]; segments: Segment[]; jobStatus: string; posted: unknown[] };

function mockApi() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === '/api/transcription/config') {
      return json({
        defaultModel: 'large-v3-turbo',
        modelChoices: ['large-v3-turbo', 'large-v3'],
        device: 'auto',
        language: 'auto',
      });
    }
    if (url === `/api/recordings/${recording.id}/transcriptions` && init?.method === 'POST') {
      state.posted.push(JSON.parse(String(init.body)));
      return json(
        { status: 'pending', job: { id: 'job-1', status: 'running', progress: 0.25, error: null } },
        202,
      );
    }
    if (url === `/api/recordings/${recording.id}/transcriptions`) {
      const groups =
        new Set(state.runs.map((r) => r.model)).size > 1
          ? [
              {
                audioIndex: 1,
                role: 'mic',
                transcriptions: state.runs.filter((r) => r.audioIndex === 1),
              },
            ]
          : [];
      return json({ transcriptions: state.runs, comparisons: groups });
    }
    if (url.startsWith(`/api/recordings/${recording.id}/transcript`)) {
      const model = new URL(url, 'http://x').searchParams.get('model');
      const ids = new Set(state.runs.filter((r) => r.model === model).map((r) => r.id));
      return json({
        transcriptions: [],
        segments: state.segments.filter((s) => ids.has(s.transcriptionId)),
      });
    }
    if (url === '/api/jobs/job-1') {
      return json({
        job: {
          id: 'job-1',
          status: state.jobStatus,
          progress: state.jobStatus === 'succeeded' ? 1 : 0.5,
          error: null,
        },
      });
    }
    return json({ error: { message: `inattendu : ${url}` } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  state = { runs: [], segments: [], jobStatus: 'running', posted: [] };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TranscriptionPanel', () => {
  it('affiche les segments par ordre chronologique, pistes distinguées, horodatage source', async () => {
    state.runs = [
      run({ id: 't1', audioIndex: 1 }),
      run({ id: 't2', audioIndex: 2, devicesUsed: ['cpu'], fallbackError: 'cudnn' }),
    ];
    state.segments = [
      segment({
        id: 1,
        transcriptionId: 't1',
        audioIndex: 1,
        role: 'mic',
        srcStartMs: 61_250,
        srcEndMs: 62_000,
        text: 'On rush B',
      }),
      segment({
        id: 2,
        transcriptionId: 't2',
        audioIndex: 2,
        role: 'discord',
        srcStartMs: 62_100,
        srcEndMs: 63_500,
        text: 'Non attends',
      }),
      segment({
        id: 3,
        transcriptionId: 't1',
        audioIndex: 1,
        role: 'mic',
        srcStartMs: 70_000,
        srcEndMs: 71_000,
        text: "Sous-titres réalisés par la communauté d'Amara.org",
        suspicionScore: 0.6,
        suspicionReasons: ['known_hallucination'],
      }),
    ];
    mockApi();
    render(<TranscriptionPanel recording={recording} pollMs={20} />);

    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.text')?.textContent)).toEqual([
      'On rush B',
      'Non attends',
      "Sous-titres réalisés par la communauté d'Amara.org",
    ]);
    expect(items[0]).toHaveProperty('className', 'segment role-mic');
    expect(items[1]).toHaveProperty('className', 'segment role-discord');
    expect(within(items[0]!).getByText('00:01:01.250 → 00:01:02.000')).toBeTruthy();
    expect(items[2]!.className).toContain('suspect');
    expect(within(items[2]!).getByText('suspect').getAttribute('title')).toContain(
      'souvent inventée',
    );

    // Périphérique réel par piste : jamais « GPU » pour une piste traitée sur CPU.
    const table = screen.getAllByRole('table')[0]!;
    expect(within(table).getByText('GPU (CUDA)')).toBeTruthy();
    expect(within(table).getByText('CPU (repli après échec CUDA)')).toBeTruthy();
    expect(within(table).getAllByText('×30')).toHaveLength(2);
  });

  it('filtre une piste', async () => {
    state.runs = [run({ id: 't1', audioIndex: 1 }), run({ id: 't2', audioIndex: 2 })];
    state.segments = [
      segment({ id: 1, transcriptionId: 't1', audioIndex: 1, role: 'mic', text: 'micro' }),
      segment({
        id: 2,
        transcriptionId: 't2',
        audioIndex: 2,
        role: 'discord',
        srcStartMs: 2000,
        srcEndMs: 3000,
        text: 'discord',
      }),
    ];
    mockApi();
    render(<TranscriptionPanel recording={recording} />);
    await screen.findByText('discord');
    const filter = screen.getByLabelText('Filtre des pistes');
    fireEvent.click(within(filter).getAllByRole('checkbox')[1]!);
    expect(screen.queryByText('discord')).toBeNull();
    expect(screen.getByText('micro')).toBeTruthy();
  });

  it('lance la transcription avec le modèle choisi et suit la progression', async () => {
    const fetchMock = mockApi();
    render(<TranscriptionPanel recording={recording} pollMs={20} />);
    const select = await screen.findByRole('combobox');
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('large-v3-turbo'));
    fireEvent.change(select, { target: { value: 'large-v3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transcrire' }));
    await waitFor(() => expect(state.posted).toEqual([{ model: 'large-v3' }]));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Transcription en cours…' })).toHaveProperty(
      'disabled',
      true,
    );
    // Rafraîchissement du traitement jusqu'à sa fin.
    state.jobStatus = 'succeeded';
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('terminé'));
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/jobs/job-1')).toBe(true);
  });

  it('propose de reprendre une transcription interrompue', async () => {
    state.runs = [
      run({
        id: 't1',
        status: 'interrupted',
        checkpointMs: 1_200_000,
        error: { code: 'INTERRUPTED', message: 'Interrompue' },
      }),
    ];
    mockApi();
    render(<TranscriptionPanel recording={recording} />);
    expect(await screen.findByRole('button', { name: 'Reprendre la transcription' })).toBeTruthy();
    expect(screen.getByText('33 %')).toBeTruthy();
  });

  it('comparaison des modèles : métriques et bascule vers l’autre transcription', async () => {
    state.runs = [
      run({
        id: 'turbo',
        model: 'large-v3-turbo',
        processingMs: 60_000,
        realtimeFactor: 60,
        segmentCount: 10,
      }),
      run({
        id: 'v3',
        model: 'large-v3',
        processingMs: 180_000,
        realtimeFactor: 20,
        segmentCount: 12,
        devicesUsed: ['cpu'],
      }),
    ];
    state.segments = [
      segment({ id: 1, transcriptionId: 'turbo', text: 'version turbo' }),
      segment({ id: 2, transcriptionId: 'v3', text: 'version large' }),
    ];
    mockApi();
    render(<TranscriptionPanel recording={recording} />);
    await screen.findByText('version turbo');
    const compare = screen.getByLabelText('Comparaison 1');
    expect(within(compare).getByText('×60')).toBeTruthy();
    expect(within(compare).getByText('×20')).toBeTruthy();
    expect(within(compare).getByText('CPU')).toBeTruthy();
    expect(within(compare).getByText(/périphériques différents/)).toBeTruthy();
    fireEvent.click(
      within(compare)
        .getAllByRole('button', { name: 'Afficher' })
        .find((b) => !(b as HTMLButtonElement).disabled)!,
    );
    expect(await screen.findByText('version large')).toBeTruthy();
    expect(screen.queryByText('version turbo')).toBeNull();
  });
});
