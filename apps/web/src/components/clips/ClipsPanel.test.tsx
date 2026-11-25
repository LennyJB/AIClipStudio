/**
 * Interface des clips (étape 6c) avec une API simulée : aucun réseau, aucun FFmpeg.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipsPanel } from './ClipsPanel';
import {
  decision,
  deferred,
  fakeState,
  installFakeApi,
  jpeg,
  PRJ,
  PRJ_RO,
  REC,
  render as renderRow,
  type FakeState,
} from './fake-api';
import { FRAME_DEBOUNCE_MS } from './useFrame';

let s: FakeState;

const patches = () => s.calls.filter((c) => c.method === 'PATCH');
const frames = () => s.calls.filter((c) => c.path.endsWith('/frame'));

async function openProject(title: RegExp | string) {
  render(<ClipsPanel recordingId={REC} />);
  const li = await screen.findByTestId(title === 'ro' ? 'clip-p2' : 'clip-p1');
  fireEvent.click(within(li).getByRole('button', { name: /Ouvrir le projet|Consulter/ }));
  return await screen.findByLabelText('Projet de clip');
}

beforeEach(() => {
  s = fakeState();
  installFakeApi(s);
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:image-${++n}`),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Liste des clips', () => {
  it('projets actifs, projets en lecture seule, dernier rendu ; création explicite d’un projet', async () => {
    render(<ClipsPanel recordingId={REC} />);
    const active = await screen.findByTestId('clip-p1');
    expect(active.textContent).toMatch(/dernier rendu : aperçu terminé/);
    const ro = screen.getByTestId('clip-p2');
    expect(ro.textContent).toMatch(/lecture seule — décision refusée/);
    expect(within(ro).getByRole('button', { name: 'Consulter' })).toBeTruthy();
    const none = screen.getByTestId('clip-p3');
    fireEvent.click(within(none).getByRole('button', { name: 'Créer le projet de clip' }));
    await waitFor(() =>
      expect(
        s.calls.some((c) => c.method === 'POST' && c.path === '/api/proposals/p3/clip-project'),
      ).toBe(true),
    );
  });
});

describe('Lecture seule', () => {
  it('aucun réglage ni rendu ; export antérieur consultable avec avertissement', async () => {
    const editor = await openProject('ro');
    expect(within(editor).getByText(/Projet non modifiable/)).toBeTruthy();
    // Tous les champs de réglage sont désactivés.
    for (const el of within(editor).queryAllByRole('checkbox'))
      expect((el as HTMLInputElement).disabled).toBe(true);
    for (const el of within(editor).queryAllByRole('combobox'))
      expect((el as HTMLSelectElement).disabled).toBe(true);
    for (const name of [
      /Générer l’aperçu/,
      /Exporter/,
      /Proposer des effets/,
      /Ajouter/,
      /Actualiser/,
    ])
      expect(within(editor).queryByRole('button', { name })).toBeNull();
    // Export final publié avant le changement de décision : lecteur et avertissement du serveur.
    const player = await within(editor).findByTestId('player-rf');
    expect(player.querySelector('video')!.getAttribute('src')).toBe('/api/renders/rf/video');
    expect(within(player).getByText(/Décision modifiée depuis l’export/)).toBeTruthy();
    expect(
      within(player)
        .getByRole('link', { name: /Télécharger/ })
        .getAttribute('href'),
    ).toBe('/api/renders/rf/download');
    // Aucune image fixe demandée (aucun FFmpeg) en lecture seule.
    await new Promise((r) => setTimeout(r, FRAME_DEBOUNCE_MS + 100));
    expect(frames()).toHaveLength(0);
  });
});

describe('Audio exporté', () => {
  it('déclaration impossible sans choix complet ; accord donné puis révoqué ; historique', async () => {
    render(<ClipsPanel recordingId={REC} />);
    const mic = await screen.findByRole('group', { name: 'Déclaration : Piste Micro' });
    const save = within(mic).getByRole('button', { name: 'Enregistrer la déclaration' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    // Aucun bouton coché par défaut.
    expect(
      within(mic)
        .getAllByRole('radio')
        .some((r) => (r as HTMLInputElement).checked),
    ).toBe(false);
    fireEvent.click(
      within(within(mic).getByRole('radiogroup', { name: 'Votre voix' })).getByLabelText(
        'présente',
      ),
    );
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      within(within(mic).getByRole('radiogroup', { name: /Voix de tiers/ })).getByLabelText(
        'absente',
      ),
    );
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        s.calls.find((c) => c.method === 'POST' && c.path.endsWith('/export-audio'))?.body,
      ).toMatchObject({
        kind: 'declaration',
        subject: 'mic_composition',
        payload: { creatorVoice: 'present', otherVoices: 'absent' },
      }),
    );

    fireEvent.change(screen.getByLabelText('Note pour voix Discord'), {
      target: { value: 'accord de A' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Enregistrer l’accord' })[0]!);
    await screen.findByRole('button', { name: 'Révoquer l’accord' });
    fireEvent.click(screen.getByRole('button', { name: 'Révoquer l’accord' }));
    await waitFor(() => expect(s.exportAudio.state.consents.discord_voices).toBe(false));
    const posts = s.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/export-audio'));
    expect(posts.slice(1).map((c) => [c.body!['action'], c.body!['note']])).toEqual([
      ['granted', 'accord de A'],
      ['revoked', undefined],
    ]);
    expect(screen.getByText(/Historique \(3\)/)).toBeTruthy();
  });

  it('Tout / Mix reste bloquée même avec un accord Discord (décision du serveur affichée)', async () => {
    s.exportAudio.state.consents.discord_voices = true;
    s.exportAudio.decision = decision(true);
    render(<ClipsPanel recordingId={REC} />);
    const mix = await screen.findByTestId('verdict-0');
    expect(mix.textContent).toMatch(/bloquée/);
    expect(mix.textContent).toMatch(/composition de la piste « Tout » non déclarée/);
    expect(within(mix).queryByRole('button')).toBeNull();
  });
});

describe('Panneau du clip', () => {
  it('audio : retrait possible, ajout seulement d’une piste autorisée, rien pour une piste non autorisée', async () => {
    const editor = await openProject('p1');
    const mic = within(editor).getByTestId('track-1');
    expect(within(mic).getByRole('button', { name: 'Retirer' })).toBeTruthy();
    // Discord non autorisé, Tout bloqué : aucun bouton d'ajout.
    const discord = within(editor).getByTestId('absent-2');
    expect(within(discord).queryByRole('button')).toBeNull();
    expect(discord.textContent).toMatch(/non autorisée : accord requis : voix Discord/);
    expect(within(within(editor).getByTestId('absent-0')).queryByRole('button')).toBeNull();

    // Retrait : la piste retirée non autorisée ne peut pas être réactivée.
    fireEvent.click(within(mic).getByRole('button', { name: 'Retirer' }));
    await waitFor(() =>
      expect(within(editor).getByTestId('track-1').textContent).toMatch(/retirée/),
    );
    expect(patches()[0]!.body).toMatchObject({
      baseRevision: 1,
      changes: { audio: { tracks: [{ audioIndex: 1, enabled: false }] } },
    });
    // Piste autorisée : « Réactiver » proposé.
    expect(
      within(within(editor).getByTestId('track-1')).getByRole('button', { name: 'Réactiver' }),
    ).toBeTruthy();
  });

  it('audio : Discord autorisé par le serveur ⇒ « Ajouter » ; refus du serveur affiché si l’accord a été révoqué entre-temps', async () => {
    s.views[PRJ] = { ...s.views[PRJ]!, audio: decision(true) };
    const editor = await openProject('p1');
    const discord = within(editor).getByTestId('absent-2');
    // Révocation ailleurs : le serveur refusera (il revérifie sous verrou).
    s.views[PRJ] = { ...s.views[PRJ]!, audio: decision(false) };
    fireEvent.click(within(discord).getByRole('button', { name: 'Ajouter' }));
    expect(
      await within(editor).findByText(/non autorisée à l’export : elle ne peut pas être ajoutée/),
    ).toBeTruthy();
    expect(patches()[0]!.body!['changes']).toEqual({
      audio: { tracks: [{ audioIndex: 2, enabled: true }] },
    });
    // Rien n'est appliqué : la piste reste absente du projet.
    expect(within(editor).queryByTestId('track-2')).toBeNull();
  });

  it('sous-titres : Discord grisé tant qu’il n’est pas autorisé ; texte d’origine consultable', async () => {
    const editor = await openProject('p1');
    const discord = within(editor).getByRole('checkbox', { name: /^Discord/ });
    expect((discord as HTMLInputElement).disabled).toBe(true);
    expect(discord.closest('label')!.textContent).toMatch(
      /non autorisé : accord ou déclaration manquant/,
    );
    const line = within(editor).getByTestId('caption-c1');
    expect(line.textContent).toMatch(/\[Coéquipier 1\]/);
    expect(line.textContent).toMatch(/noms remplacés/);
    expect(within(line).getByText('on va tenter le plan de Théo')).toBeTruthy();
  });

  it('masques : désactivation seulement après confirmation explicite, puis avertissement', async () => {
    const editor = await openProject('p1');
    const off = within(editor).getByRole('button', { name: 'Ne plus masquer' });
    expect((off as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(editor).getByRole('checkbox', { name: /Je comprends le risque/ }));
    expect((off as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(off);
    await within(editor).findByText(/n’est plus masquée/);
    expect(patches()[0]!.body!['changes']).toEqual({
      masks: { modes: [{ index: 0, mode: 'off' }], acknowledgeMaskRisk: true },
    });
  });

  it('effets : aucun appel au chargement ; proposés désactivés ; activation par clic seulement', async () => {
    const editor = await openProject('p1');
    expect(s.calls.some((c) => c.path.endsWith('/effects/suggest'))).toBe(false);
    expect(await within(editor).findByText(/Couper le silence avant la chute/)).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'Proposer des effets' }));
    const fx = await within(editor).findByTestId('effect-auto-punch_zoom');
    const box = within(fx).getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(fx.textContent).toMatch(/indice technique, à vérifier/);
    expect(patches()).toHaveLength(0);
    fireEvent.click(box);
    await waitFor(() =>
      expect(patches()[0]!.body!['changes']).toEqual({
        effects: [{ id: 'auto-punch_zoom', enabled: true }],
      }),
    );
  });

  it('durée : bornes à ±10 s ; confirmation explicite hors plage', async () => {
    s.views[PRJ] = { ...s.views[PRJ]!, durationAccepted: false, durationMs: 95_000 };
    const editor = await openProject('p1');
    const apply = within(editor).getByRole('button', { name: 'Appliquer les bornes' });
    fireEvent.change(within(editor).getByLabelText(/Décalage du début/), {
      target: { value: '-12' },
    });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(editor).getByLabelText(/Décalage du début/), {
      target: { value: '-2' },
    });
    fireEvent.click(apply);
    await waitFor(() =>
      expect(patches()[0]!.body!['changes']).toEqual({
        bounds: { startMs: 108_000, endMs: 134_000 },
      }),
    );
    expect(
      (within(editor).getByRole('button', { name: 'Générer l’aperçu' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Confirmer la durée hors plage' }));
    await waitFor(() => expect(patches()[1]!.body!['changes']).toEqual({ confirmDuration: true }));
  });
});

describe('Sauvegarde sûre', () => {
  it('modifications rapides envoyées en série, chacune sur la dernière révision confirmée', async () => {
    const editor = await openProject('p1');
    s.patchGate = deferred();
    fireEvent.change(within(editor).getByRole('combobox', { name: /Disposition/ }), {
      target: { value: 'gameplay_crop' },
    });
    fireEvent.click(within(editor).getByRole('checkbox', { name: /Normaliser/ }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    // Le second envoi attend la confirmation du premier.
    await new Promise((r) => setTimeout(r, 50));
    expect(patches()).toHaveLength(1);
    const gate = s.patchGate;
    s.patchGate = null;
    gate.resolve();
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches().map((c) => c.body!['baseRevision'])).toEqual([1, 2]);
  });

  it('conflit 409 : rechargement sans perte des modifications locales, puis « Réappliquer »', async () => {
    const editor = await openProject('p1');
    s.patchPlan = ['conflict'];
    fireEvent.change(within(editor).getByRole('combobox', { name: /Disposition/ }), {
      target: { value: 'gameplay_crop' },
    });
    expect(await within(editor).findByText(/modifié ailleurs \(révision 2\)/)).toBeTruthy();
    // Modifié par un autre onglet : révision 2 côté serveur.
    s.views[PRJ] = { ...s.views[PRJ]!, revision: 2 };
    const firstId = patches()[0]!.body!['requestId'];
    fireEvent.click(within(editor).getByRole('button', { name: 'Recharger' }));
    // Le brouillon est toujours listé ; rien n'a été renvoyé automatiquement.
    await within(editor).findByRole('button', { name: 'Réappliquer mes modifications' });
    expect(
      within(editor).getByRole('button', { name: 'abandonner' }).closest('li')!.textContent,
    ).toMatch(/^Disposition/);
    expect(patches()).toHaveLength(1);
    fireEvent.click(within(editor).getByRole('button', { name: 'Réappliquer mes modifications' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]!.body).toMatchObject({
      baseRevision: 2,
      changes: { layout: { preset: 'gameplay_crop' } },
    });
    expect(patches()[1]!.body!['requestId']).not.toBe(firstId);
  });

  it('erreur réseau : nouvel essai avec le même requestId', async () => {
    const editor = await openProject('p1');
    s.patchPlan = ['network'];
    fireEvent.click(within(editor).getByRole('checkbox', { name: /Normaliser/ }));
    expect(await within(editor).findByText(/Serveur injoignable/)).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]!.body!['requestId']).toBe(patches()[0]!.body!['requestId']);
    await waitFor(() => expect(within(editor).queryByText(/Serveur injoignable/)).toBeNull());
  });
});

describe('Image fixe', () => {
  it('debounce, abandon de la requête précédente, réponse obsolète ignorée', async () => {
    const editor = await openProject('p1');
    // Première image : programmée après le délai d'inactivité, pas immédiatement.
    expect(frames()).toHaveLength(0);
    await waitFor(() => expect(frames()).toHaveLength(1), { timeout: FRAME_DEBOUNCE_MS + 1000 });
    // Actualisation manuelle : la requête précédente est abandonnée côté client.
    fireEvent.click(within(editor).getByRole('button', { name: 'Actualiser l’image' }));
    expect(frames()).toHaveLength(2);
    expect(frames()[0]!.signal!.aborted).toBe(true);
    // La plus récente répond ; puis l'ancienne « répond » quand même : elle est ignorée.
    await act(async () => {
      s.frameReplies[1]!.resolve(jpeg('B'));
      await new Promise((r) => setTimeout(r, 10));
    });
    const img = await within(editor).findByAltText(/Image fixe du cadrage/);
    const shown = img.getAttribute('src');
    await act(async () => {
      s.frameReplies[0]!.resolve(jpeg('A'));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(
      within(editor)
        .getByAltText(/Image fixe du cadrage/)
        .getAttribute('src'),
    ).toBe(shown);
  });

  it('réponse obsolète ignorée même SANS annulation effective ; CANCELLED silencieux', async () => {
    s.frameIgnoreAbort = true;
    const editor = await openProject('p1');
    await waitFor(() => expect(frames()).toHaveLength(1), { timeout: FRAME_DEBOUNCE_MS + 1000 });
    fireEvent.click(within(editor).getByRole('button', { name: 'Actualiser l’image' }));
    expect(frames()[0]!.signal!.aborted).toBe(true);
    // La plus récente répond d'abord…
    await act(async () => {
      s.frameReplies[1]!.resolve(jpeg('B'));
      await new Promise((r) => setTimeout(r, 10));
    });
    const shown = (await within(editor).findByAltText(/Image fixe du cadrage/)).getAttribute('src');
    // …puis l'ancienne aboutit malgré l'abandon (navigateur ou serveur) : elle est ignorée.
    await act(async () => {
      s.frameReplies[0]!.resolve(jpeg('A'));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(
      within(editor)
        .getByAltText(/Image fixe du cadrage/)
        .getAttribute('src'),
    ).toBe(shown);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    // Demande remplacée côté serveur (409 CANCELLED) alors qu'une plus récente existe : silencieux.
    fireEvent.click(within(editor).getByRole('button', { name: 'Actualiser l’image' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Actualiser l’image' }));
    await act(async () => {
      s.frameReplies[2]!.resolve(
        new Response(JSON.stringify({ error: { code: 'CANCELLED', message: 'remplacée' } }), {
          status: 409,
        }),
      );
      s.frameReplies[3]!.resolve(jpeg('D'));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(within(editor).queryByText(/remplacée/)).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('cadrage confirmé par le serveur ⇒ nouvelle image après le délai d’inactivité', async () => {
    const editor = await openProject('p1');
    await waitFor(() => expect(frames()).toHaveLength(1), { timeout: FRAME_DEBOUNCE_MS + 1000 });
    fireEvent.change(within(editor).getByRole('combobox', { name: /Disposition/ }), {
      target: { value: 'gameplay_crop' },
    });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(frames()).toHaveLength(1);
    await waitFor(() => expect(frames()).toHaveLength(2), { timeout: FRAME_DEBOUNCE_MS + 1000 });
  });
});

describe('Rendus', () => {
  it('aperçu demandé, progression, lecteur et .srt ; annulation', async () => {
    const editor = await openProject('p1');
    fireEvent.click(within(editor).getByRole('button', { name: 'Générer l’aperçu' }));
    expect(await within(editor).findByText(/40 %/, {}, { timeout: 3000 })).toBeTruthy();
    // Fin du rendu : le suivi s'arrête et le lecteur apparaît.
    s.renderProgress['r-new'] = { progress: 1, status: 'succeeded' };
    const player = await within(editor).findByTestId('player-r-new', {}, { timeout: 3000 });
    expect(player.querySelector('video')!.getAttribute('src')).toBe('/api/renders/r-new/video');
    expect(
      within(player)
        .getByRole('link', { name: /Sous-titres/ })
        .getAttribute('href'),
    ).toBe('/api/renders/r-new/subtitles.srt');
    const polls = s.calls.filter((c) => c.path === '/api/renders/r-new').length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(s.calls.filter((c) => c.path === '/api/renders/r-new').length).toBe(polls);
  });

  it('annulation d’un rendu en cours', async () => {
    s.renders[PRJ] = [renderRow({ id: 'r-run', status: 'running' })];
    s.renderProgress['r-run'] = { progress: 0.2, status: 'running' };
    const editor = await openProject('p1');
    fireEvent.click(await within(editor).findByRole('button', { name: 'Annuler le rendu' }));
    await waitFor(() =>
      expect(
        s.calls.some((c) => c.method === 'POST' && c.path === '/api/renders/r-run/cancel'),
      ).toBe(true),
    );
  });

  it('aucune proposition de piste ni de rendu sans piste active (raison affichée)', async () => {
    s.views[PRJ] = {
      ...s.views[PRJ]!,
      document: {
        ...s.views[PRJ]!.document,
        audio: { ...s.views[PRJ]!.document.audio, tracks: [] },
      },
    };
    const editor = await openProject('p1');
    expect(
      (within(editor).getByRole('button', { name: 'Exporter (1080×1920)' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(editor).getByText(/aucune piste audio active/)).toBeTruthy();
    expect(s.views[PRJ_RO]).toBeDefined();
  });
});
