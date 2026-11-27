/**
 * Page de l'éditeur (jsdom) branchée sur le faux serveur (même réducteur) : chaque action de
 * l'interface passe par une opération et produit UNE entrée ; raccourcis clavier ; inspecteurs ;
 * lecture seule stricte ; confirmation explicite avant de désactiver une zone masquée ; le flou
 * rangé dans les effets avec son avertissement.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureV2 } from '../../../../packages/timeline/src/v2/test-fixtures';
import { memoryDrafts } from './drafts';
import { EditorPage } from './EditorPage';
import type { EditorDeps } from './store';
import { FakeEditServer, sha256Hex } from './test/fake-server';

const CTX = { allowedAudioIndexes: [1], allowedCaptionRoles: ['mic'] };

function mount(server = new FakeEditServer(fixtureV2(), CTX)) {
  const deps: Partial<EditorDeps> & { media: boolean } = {
    api: server.api(),
    drafts: memoryDrafts(),
    channel: () => null,
    sha256: sha256Hex,
    setInterval: () => 0,
    clearInterval: () => {},
    media: false,
  };
  render(<EditorPage projectId="p" onClose={() => {}} deps={deps} />);
  return server;
}

const ready = () =>
  waitFor(() => expect(screen.getByTestId('editor-version').textContent).toContain('enregistré'));

afterEach(cleanup);

describe('page de l’éditeur', () => {
  it('couper (barre d’outils puis S), annuler (Ctrl+Z), rétablir (Ctrl+Maj+Z) : une entrée par geste', async () => {
    const server = mount();
    await ready();
    const segs = () => document.querySelectorAll('[data-testid^="segment-"]').length;
    expect(segs()).toBe(1);
    // Tête de lecture à 2 s (cliquer sur la règle), puis couper.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await act(async () => {
      for (let i = 0; i < 60; i++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    });
    fireEvent.click(screen.getByTestId('split'));
    await waitFor(() => expect(server.entries).toHaveLength(1));
    await waitFor(() => expect(segs()).toBe(2));
    await act(async () => {
      for (let i = 0; i < 60; i++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    });
    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(server.entries).toHaveLength(2));
    await waitFor(() => expect(segs()).toBe(3));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(segs()).toBe(2));
    expect(server.entries.at(-1)!.kind).toBe('undo');
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(segs()).toBe(3));
    expect(server.entries.map((e) => e.kind)).toEqual(['do', 'do', 'undo', 'redo']);
    await waitFor(() =>
      expect(screen.getByTestId('undo').textContent).toContain('Annuler : coupe à'),
    );
  });

  it('suppression au clavier du segment sélectionné : Suppr (avec décalage), Maj+Suppr (sans décalage)', async () => {
    const base = fixtureV2();
    const s0 = base.segments[0]!;
    if (s0.kind !== 'source') throw new Error('source attendu');
    const server = new FakeEditServer(
      {
        ...base,
        segments: [
          { ...s0, srcEndMs: s0.srcStartMs + 5000 },
          { ...s0, id: 'b', srcStartMs: s0.srcStartMs + 6000, srcEndMs: s0.srcStartMs + 11_000 },
          { ...s0, id: 'c', srcStartMs: s0.srcStartMs + 12_000, srcEndMs: s0.srcEndMs },
        ],
      },
      CTX,
    );
    mount(server);
    await ready();
    fireEvent.pointerDown(screen.getByTestId('segment-b'));
    fireEvent.pointerUp(screen.getByTestId('segment-b'));
    fireEvent.keyDown(window, { key: 'Delete', shiftKey: true });
    await waitFor(() => expect(server.entries).toHaveLength(1));
    expect(server.doc.segments.map((s) => s.kind)).toEqual(['source', 'gap', 'source']);
    await waitFor(() =>
      expect(screen.getByTestId('editor-version').textContent).toContain('enregistré'),
    );
    // Le vide créé est supprimé AVEC décalage : les segments se rejoignent.
    const gap = server.doc.segments[1]!.id;
    fireEvent.pointerDown(screen.getByTestId(`segment-${gap}`));
    fireEvent.pointerUp(screen.getByTestId(`segment-${gap}`));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() =>
      expect(server.doc.segments.map((x) => x.id)).toEqual([server.doc.segments[0]!.id, 'c']),
    );
  });

  it('inspecteur : corriger un sous-titre = une entrée ; texte d’origine consultable', async () => {
    const server = mount();
    await ready();
    const item = server.doc.captions.items.find(
      (i) => i.speakerRole === 'mic' && i.srcStartMs >= 110_000,
    )!;
    fireEvent.pointerDown(screen.getByTestId(`caption-${item.id}`));
    const input = await screen.findByTestId('caption-text');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'texte corrigé' } });
    fireEvent.blur(input);
    await waitFor(() => expect(server.entries).toHaveLength(1));
    expect(server.entries[0]!.ops[0]).toMatchObject({
      type: 'editCaptionText',
      itemId: item.id,
      text: 'texte corrigé',
    });
    expect(screen.getByText(/Texte d’origine/u)).toBeTruthy();
  });

  it('zone masquée : désactiver exige une confirmation explicite, puis l’avertissement reste affiché', async () => {
    const server = mount();
    await ready();
    const mask = server.doc.masks[0]!;
    fireEvent.click(
      within(screen.getByTestId('mask-list')).getByRole('button', { name: mask.label }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Désactiver…' }));
    expect(server.entries).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Je confirme le risque' }));
    await waitFor(() => expect(server.entries).toHaveLength(1));
    expect(server.entries[0]!.ops[0]).toMatchObject({
      type: 'setEntity',
      collection: 'mask',
      acknowledgeMaskRisk: true,
    });
    await waitFor(() => expect(screen.getByTestId('masks-disabled')).toBeTruthy());
  });

  it('flou créatif : rangé dans « Effets », avec l’avertissement « pas une protection »', async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByTestId('effect-type'), { target: { value: 'blur_region' } });
    expect(
      screen.getByText('Le flou n’est pas une protection : utilisez une zone masquée.'),
    ).toBeTruthy();
    expect(within(screen.getByTestId('mask-list')).queryByText(/flou/iu)).toBeNull();
  });

  it('lecture seule : bannière, aucune action possible, rien n’est envoyé', async () => {
    const server = new FakeEditServer(fixtureV2(), CTX);
    server.editable = false;
    mount(server);
    await waitFor(() => expect(screen.getByTestId('read-only')).toBeTruthy());
    expect((screen.getByTestId('split') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('undo') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 's' });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.calls).toEqual([]);
    expect(document.querySelectorAll('.tl-handle')).toHaveLength(0);
  });
});
