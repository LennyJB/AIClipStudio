import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisSettings, Recording } from '../api';
import { AnalysisPanel } from './AnalysisPanel';

const recording: Recording = {
  id: 'rec-1',
  fileName: 'stream.mkv',
  durationSec: 3600,
  gameId: 'valorant',
  audioTracks: [
    { audioIndex: 0, role: 'mic', title: 'Micro' },
    { audioIndex: 1, role: 'discord', title: 'Discord' },
  ],
};

let settings: AnalysisSettings;
let calls: { url: string; method: string; body: unknown }[];
let runStatus: string;

const RUN = {
  id: 'run-1',
  status: 'completed',
  mode: 'dry_run',
  windowCount: 1,
  budgetUsd: 5,
  spentUsd: 0,
  error: null,
  createdAt: '2026-11-23T10:00:00Z',
  estimate: {
    pricingVersion: '2026-11-23',
    models: { triage: 'claude-haiku-5-5', deep: 'claude-opus-5-5' },
    effort: 'high',
    budgetUsd: 5,
    assumptions: [],
    triage: { typicalUsd: 0.01, maxUsd: 0.02, chunks: [{}] },
    totals: { typicalUsd: 0.13, maxUsd: 0.29 },
    fit: { windowCount: 1, typicalWindows: 1, worstCaseWindows: 1 },
  },
};

function mockApi() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === '/api/recordings/rec-1/analysis-settings' && method === 'PUT') {
      settings = { ...settings, ...(JSON.parse(String(init!.body)) as Partial<AnalysisSettings>) };
      return json({ settings });
    }
    if (url === '/api/recordings/rec-1/analysis-settings') return json({ settings });
    if (url === '/api/framing-profiles')
      return json({
        profiles: [{ id: 'plein-ecran', displayName: 'Plein écran', facecam: null, masks: [] }],
      });
    if (url === '/api/recordings/rec-1/analyses' && method === 'POST') {
      return json(
        {
          status: 'pending',
          run: { ...RUN, status: 'pending' },
          job: { id: 'job-1', status: 'running', progress: 0.5, error: null },
        },
        202,
      );
    }
    if (url === '/api/recordings/rec-1/analyses') return json({ runs: [] });
    if (url === '/api/jobs/job-1')
      return json({ job: { id: 'job-1', status: runStatus, progress: 1, error: null } });
    if (url === '/api/analyses/run-1') {
      return json({
        run: RUN,
        windows: [
          {
            id: 'w1',
            rank: 1,
            coreStartMs: 61_000,
            coreEndMs: 90_000,
            startMs: 16_000,
            endMs: 110_000,
            localScore: 0.62,
            signals: [
              { kind: 'turn_taking', source: 'transcription', startMs: 0, endMs: 1, value: 1 },
            ],
            frames: [],
            estimate: { textTokens: 900, imageTokens: 0, typicalUsd: 0.12, maxUsd: 0.27 },
          },
        ],
      });
    }
    if (url === '/api/analyses/run-1/manifest') {
      return json({
        manifest: {
          nothingSent: true,
          tracks: [
            { audioIndex: 0, role: 'mic', textTransmitted: true, reason: 'micro du créateur' },
            { audioIndex: 1, role: 'discord', textTransmitted: false, reason: 'accord requis' },
          ],
          privacy: {
            imagesSent: false,
            noImagesReason: 'aucun profil de cadrage choisi',
            pseudonymLabelsUsed: [],
          },
          triage: { scope: 'full', chunks: [{ index: 1, startMs: 0, endMs: 1_200_000 }] },
        },
      });
    }
    if (url === '/api/analyses/run-1/windows/1/payload')
      return json({ text: '[00:01:01.0 #4 MIC] attends quoi ?' });
    return json({ error: { message: `inattendu : ${method} ${url}` } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

describe('AnalysisPanel', () => {
  beforeEach(() => {
    settings = {
      discordTextAllowed: false,
      discordConsentNote: null,
      discordConsentAt: null,
      facecamAllowed: false,
      framingProfileId: null,
      framingValidatedAt: null,
      framingStatus: 'none',
    };
    calls = [];
    runStatus = 'succeeded';
    mockApi();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('Discord non transmis par défaut ; l’accord exige une note', async () => {
    render(<AnalysisPanel recording={recording} />);
    expect(await screen.findByText('texte non transmis')).toBeTruthy();
    const allow = screen.getByRole('button', { name: /Autoriser le texte Discord/ });
    expect((allow as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Note d’accord Discord'), {
      target: { value: 'Accord de Max, 23/11' },
    });
    fireEvent.click(allow);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        discordTextAllowed: true,
        discordConsentNote: 'Accord de Max, 23/11',
      }),
    );
    expect(await screen.findByText('texte transmis')).toBeTruthy();
  });

  it('cadrage : aucune image sans profil ; validation impossible avant un aperçu', async () => {
    render(<AnalysisPanel recording={recording} />);
    expect(await screen.findByText(/aucun profil : aucune image envoyée/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Valider ce cadrage' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('prépare sans appel API, puis montre fenêtres, coûts et contenu qui serait transmis', async () => {
    render(<AnalysisPanel recording={recording} pollMs={10} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Préparer l’analyse \(sans appel API\)/ }),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ dryRun: true, force: false });
    expect(await screen.findByText(/Fenêtres candidates \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Piste 2 \(Discord\) : texte non transmis/)).toBeTruthy();
    expect(screen.getByText(/aucune \(aucun profil de cadrage choisi\)/)).toBeTruthy();
    expect(screen.getByText(/plafond 5\.00 \$/)).toBeTruthy();
    expect(screen.getByText('00:01:01.000 → 00:01:30.000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Voir le contenu' }));
    expect(await screen.findByText('[00:01:01.0 #4 MIC] attends quoi ?')).toBeTruthy();
    expect(calls.some((c) => /anthropic|claude/i.test(c.url))).toBe(false);
  });
});
