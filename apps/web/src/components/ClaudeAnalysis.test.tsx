import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAnalysis } from './ClaudeAnalysis';

let posted: unknown[];
let configured: boolean;

const proposal = (over: Record<string, unknown>) => ({
  id: 'p',
  tier: 'clip',
  title: 'Le plan infaillible',
  explanation: 'Ironie calme après un plan raté.',
  categories: ['humour'],
  relevance: 84,
  reliability: 90,
  reliabilityDetail: { reasons: ['réponses des coéquipiers non transmises'] },
  flags: [],
  srcStartMs: 110_000,
  srcEndMs: 133_800,
  uncertainty: null,
  evidence: [{ kind: 'quote', segmentId: 8, quote: 'j’adore perdre ce round', verified: true }],
  ...over,
});

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === '/api/analysis/config') {
        return json({
          mode: 'dry_run_and_claude',
          claudeConfigured: configured,
          models: { triage: 'claude-haiku-5-5', deep: 'claude-opus-5-5' },
          effort: 'high',
          budgetUsd: 5,
          minRelevance: 60,
          minReliability: 60,
        });
      }
      if (url === '/api/recordings/rec-1/analyses' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return json(
          {
            status: 'pending',
            run: { id: 'run-1', mode: 'claude' },
            job: { id: 'job-1', status: 'succeeded', progress: 1, error: null },
          },
          202,
        );
      }
      if (url === '/api/recordings/rec-1/analyses') return json({ runs: [] });
      if (url === '/api/analyses/run-1') {
        return json({
          run: {
            id: 'run-1',
            mode: 'claude',
            status: 'completed',
            stage: 'done',
            budgetUsd: 5,
            spentUsd: 0.42,
            reservedUsd: 0,
            windowCount: 3,
            error: null,
            createdAt: '',
          },
          windows: [
            { id: 'w1', status: 'analyzed', origin: 'triage', costUsd: 0.2 },
            { id: 'w2', status: 'analyzed', origin: 'signals', costUsd: 0.2 },
            { id: 'w3', status: 'refused', origin: 'signals', costUsd: 0 },
          ],
        });
      }
      if (url === '/api/analyses/run-1/proposals') {
        return json({
          proposals: [
            proposal({}),
            proposal({
              id: 'q',
              tier: 'secondary',
              title: 'Moment limite',
              relevance: 55,
              reliability: 50,
            }),
          ],
        });
      }
      if (url === '/api/analyses/run-1/calls') {
        return json({
          calls: [],
          costs: { realCostUsd: 0.42, calls: 4, reusedCalls: 1, unknownCostCalls: 0 },
        });
      }
      return json({ error: { message: `inattendu : ${url}` } }, 404);
    }),
  );
}

describe('ClaudeAnalysis', () => {
  beforeEach(() => {
    posted = [];
    configured = true;
    mockApi();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sans clé : aucun lancement possible', async () => {
    configured = false;
    render(<ClaudeAnalysis recordingId="rec-1" />);
    expect(await screen.findByText(/ANTHROPIC_API_KEY absente/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Lancer l’analyse/ })).toBeNull();
  });

  it('confirmation du plafond obligatoire, puis clips et moments secondaires séparés', async () => {
    render(<ClaudeAnalysis recordingId="rec-1" pollMs={10} />);
    const button = await screen.findByRole('button', { name: 'Lancer l’analyse avec Claude' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    await waitFor(() => expect(posted).toEqual([{ mode: 'claude', acceptBudgetUsd: 5 }]));
    expect(await screen.findByText('Clips (1)')).toBeTruthy();
    expect(screen.getByText(/Moments secondaires \(1\)/)).toBeTruthy();
    expect(screen.getAllByText(/Pertinence 84\/100 · Fiabilité 90\/100/)).toHaveLength(1);
    expect(screen.getAllByText(/« j’adore perdre ce round »/)).toHaveLength(2); // clip + secondaire
    expect(screen.getByText(/1 refusée\(s\)/)).toBeTruthy();
    expect(screen.getByText(/1 trouvée\(s\) par le repérage global/)).toBeTruthy();
    expect(screen.getByText('0.420 $')).toBeTruthy();
  });
});
