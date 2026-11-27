import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StylePanel, formatValue } from './StylePanel';
import type { FeatureDef, ProfileDetail } from './api';

const features: FeatureDef[] = [
  {
    key: 'rythme.cutsPerMinute',
    group: 'rythme',
    label: 'Coupes par minute',
    type: { kind: 'number', min: 0, max: 240, unit: '/min' },
    measuredBy: ['reference', 'pair', 'editor'],
  },
  {
    key: 'sous_titres.font',
    group: 'sous_titres',
    label: 'Police',
    type: { kind: 'enum', options: ['Montserrat ExtraBold', 'Inter'] },
    measuredBy: ['editor'],
    note: 'Non mesurable dans une vidéo de référence : aucune reconnaissance de texte (OCR).',
  },
  {
    key: 'audio.musicBed',
    group: 'audio',
    label: 'Musique de fond',
    type: { kind: 'enum', options: ['aucune', 'discrete', 'presente'] },
    measuredBy: [],
    note: 'Non mesurable.',
  },
];

const summary = (over = {}) => ({
  id: 'gaming',
  name: 'Gaming',
  contentTypes: ['gaming'],
  builtin: true,
  archived: false,
  activeVersion: 1,
  validatedAt: '2026-11-27T10:00:00Z',
  latestVersion: 2,
  draftPending: true,
  references: 1,
  applications: 3,
  ...over,
});

const detail: ProfileDetail = {
  profile: summary(),
  active: {
    version: 1,
    hash: 'a'.repeat(64),
    origin: 'learned',
    evidence: {},
    createdAt: '',
    features: {
      'rythme.cutsPerMinute': { value: 8, origin: 'learned', samples: 2, sources: ['reference'] },
    },
  },
  draft: {
    version: 2,
    hash: 'b'.repeat(64),
    origin: 'learned',
    evidence: {},
    createdAt: '',
    features: {
      'rythme.cutsPerMinute': {
        value: 12,
        origin: 'learned',
        samples: 3,
        sources: ['reference', 'editor'],
      },
      'sous_titres.font': { value: 'Inter', origin: 'manual', samples: 0, sources: [] },
    },
  },
  changes: ['rythme.cutsPerMinute', 'sous_titres.font'],
  versions: [
    { version: 1, origin: 'learned', createdAt: '', validated: true },
    { version: 2, origin: 'learned', createdAt: '', validated: false },
  ],
  references: [],
};

let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === '/api/style/catalog')
        return json({
          groups: { rythme: 'Rythme', sous_titres: 'Sous-titres', audio: 'Son' },
          features,
        });
      if (url === '/api/style-profiles')
        return json({ profiles: [summary(), summary({ id: 'irl', name: 'IRL' })] });
      if (url.startsWith('/api/style-profiles/') && method === 'GET') return json(detail);
      if (url.startsWith('/api/style-profiles/')) return json(detail);
      if (url === '/api/style-references' && method === 'GET') return json({ references: [] });
      if (url === '/api/style-references' && method === 'POST')
        return json({ created: true, reference: { id: 'ref-1', status: 'pending' } }, 201);
      if (url === '/api/style-references/ref-1/analyze')
        return json({ job: { id: 'j' }, reference: { id: 'ref-1', status: 'analyzing' } }, 202);
      return json({ error: { message: `inattendu ${method} ${url}` } }, 500);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StylePanel', () => {
  it('valeurs validées et brouillon, provenance, changements surlignés, caractéristique non mesurable signalée', async () => {
    render(<StylePanel />);
    const panel = await screen.findByTestId('style-profile');
    expect(panel.textContent).toContain('version validée 1');
    expect(panel.textContent).toContain('brouillon v2 à valider');
    const cuts = await waitFor(() => {
      const r = panel.querySelector('[data-feature="rythme.cutsPerMinute"]');
      if (!r) throw new Error('ligne absente');
      return r as HTMLElement;
    });
    expect(cuts.className).toBe('style-changed');
    expect(cuts.textContent).toContain('8 /min');
    expect(cuts.textContent).toContain('12 /min');
    expect(cuts.textContent).toContain('appris (3 obs. · référence, vos montages)');
    const font = panel.querySelector('[data-feature="sous_titres.font"]')!;
    expect(font.textContent).toContain('réglé par vous');
    expect(panel.querySelector('[data-feature="audio.musicBed"]')!.textContent).toContain(
      '(non mesurable)',
    );
  });

  it('réglage manuel enregistré en brouillon (version de base envoyée) ; validation avec l’empreinte affichée', async () => {
    render(<StylePanel />);
    await screen.findByTestId('style-profile');
    fireEvent.change(await screen.findByLabelText('Valeur : Musique de fond'), {
      target: { value: 'discrete' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retirer Police' }));
    expect(
      (screen.getByRole('button', { name: /Valider le brouillon/u }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer mes réglages (brouillon)' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/style-profiles/gaming/draft');
    expect(put.body).toMatchObject({
      baseVersion: 2,
      set: { 'audio.musicBed': 'discrete' },
      clear: ['sous_titres.font'],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Valider le brouillon v2' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/validate'))!.body).toMatchObject({
      version: 2,
      featuresHash: 'b'.repeat(64),
    });
  });

  it('import d’une paire : chemins des deux vidéos, associée au profil choisi, puis analysée', async () => {
    render(<StylePanel />);
    await screen.findByTestId('style-profile');
    const box = screen.getByTestId('style-import');
    fireEvent.change(within(box).getByLabelText('Type de référence'), {
      target: { value: 'pair' },
    });
    fireEvent.change(within(box).getByLabelText('Chemin de la vidéo montée'), {
      target: { value: 'D:\\m.mp4' },
    });
    const button = within(box).getByRole('button', {
      name: /Importer et analyser/u,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); // brut manquant
    fireEvent.change(within(box).getByLabelText('Chemin de la vidéo brute'), {
      target: { value: 'D:\\b.mkv' },
    });
    fireEvent.click(button);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/analyze'))).toBe(true));
    expect(
      calls.find((c) => c.url === '/api/style-references' && c.method === 'POST')!.body,
    ).toEqual({
      kind: 'pair',
      path: 'D:\\m.mp4',
      rawPath: 'D:\\b.mkv',
      profileId: 'gaming',
    });
  });

  it('formatage : pourcentages, durées, oui/non', () => {
    const n = (unit: string): FeatureDef => ({
      key: 'k',
      group: 'g',
      label: 'l',
      type: { kind: 'number', min: 0, max: 1e7, unit },
      measuredBy: [],
    });
    expect(formatValue(n('ratio'), 0.355)).toBe('36 %');
    expect(formatValue(n('ms'), 2500)).toBe('2.5 s');
    expect(formatValue(n('ms'), 400)).toBe('400 ms');
    expect(formatValue(undefined, true)).toBe('oui');
    expect(formatValue(undefined, undefined)).toBe('—');
  });
});
