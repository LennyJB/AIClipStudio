/**
 * Bibliothèque de médias dans l'interface (étape 7, PR 7f), API simulée (aucun réseau) :
 * panneau d'import et de gestion, gestes « image / mème / effet sonore », composition canvas des
 * calques image (jamais sur le tampon source ; média manquant signalé).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyBatch,
  imageOverlayPlacements,
  sceneAt,
  type ClipProjectV2,
  type EditMs,
} from '@acs/timeline';
import { fixtureV2 } from '../../../../packages/timeline/src/v2/test-fixtures';
import { ApiError } from '../api';
import { addImageOverlay, addSfx, imageFrame, type PickedAsset } from '../editor/actions';
import { Compositor, type CanvasLike } from '../editor/player/compositor';
import type { AssetDto, LibraryApi } from './api';
import { LibraryPanel } from './LibraryPanel';

const IMG = 'b'.repeat(64);
const SND = 'a'.repeat(64);
const asset = (o: Partial<AssetDto>): AssetDto => ({
  id: IMG,
  kind: 'image',
  sourceFormat: 'png',
  displayName: 'logo.png',
  sizeBytes: 2048,
  width: 400,
  height: 200,
  durationMs: null,
  peaks: null,
  rights: 'own',
  rightsNote: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'ok',
  ...o,
});

function fakeApi(assets: AssetDto[], over: Partial<LibraryApi> = {}): LibraryApi {
  return {
    list: vi.fn(() => Promise.resolve({ assets })),
    upload: vi.fn(() => Promise.resolve({ asset: assets[0]!, duplicate: false })),
    remove: vi.fn(() => Promise.resolve({ deleted: true as const })),
    fileUrl: (id: string) => `/f/${id}`,
    previewUrl: (id: string) => `/p/${id}`,
    ...over,
  };
}

afterEach(() => cleanup());

describe('panneau de la bibliothèque', () => {
  it('import : déclaration de droits obligatoire ; refus du serveur affiché avec sa raison', async () => {
    const api = fakeApi([], {
      upload: vi.fn(() =>
        Promise.reject(
          new ApiError('Image animée refusée : images fixes uniquement', 422, 'ASSET_REJECTED', {
            reason: 'animated',
          }),
        ),
      ),
    });
    render(<LibraryPanel api={api} />);
    await screen.findByText('Aucun média pour l’instant.');
    const input = screen.getByTestId('library-file') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'anim.gif', { type: 'image/gif' });
    fireEvent.change(input, { target: { files: [file] } });
    expect((screen.getByTestId('library-import') as HTMLButtonElement).disabled).toBe(true); // droits non déclarés
    fireEvent.change(screen.getByTestId('library-rights'), { target: { value: 'licensed' } });
    fireEvent.click(screen.getByTestId('library-import'));
    await waitFor(() =>
      expect(screen.getByTestId('library-message').textContent).toContain(
        'Import refusé : Image animée refusée',
      ),
    );
    expect(api.upload).toHaveBeenCalledWith(file, {
      name: 'anim.gif',
      rights: 'licensed',
      rightsNote: '',
    });
  });

  it('liste : aperçu, métadonnées, fichier manquant signalé ; suppression d’un média utilisé : refus du serveur affiché', async () => {
    const api = fakeApi(
      [
        asset({}),
        asset({
          id: SND,
          kind: 'audio',
          displayName: 'boing.wav',
          durationMs: 600,
          width: null,
          height: null,
          peaks: [0.1, 0.9],
        }),
        asset({ id: 'c'.repeat(64), displayName: 'perdu.png', status: 'missing' }),
      ],
      {
        remove: vi.fn(() =>
          Promise.reject(
            new ApiError(
              'Média utilisé par 1 projet(s) : retirez-le d’abord des projets',
              409,
              'ASSET_IN_USE',
              {},
            ),
          ),
        ),
      },
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LibraryPanel api={api} />);
    const items = await screen.findAllByTestId('library-item');
    expect(items).toHaveLength(3);
    expect(items[0]!.querySelector('img')!.getAttribute('src')).toBe(`/p/${IMG}`);
    expect(items[0]!.textContent).toContain('400×200');
    expect(items[1]!.textContent).toContain('0.60 s');
    expect(items[1]!.querySelector('svg')).not.toBeNull();
    expect(items[2]!.textContent).toContain('Fichier manquant');
    expect(items[2]!.querySelector('img')).toBeNull();
    fireEvent.click(screen.getAllByTestId('library-delete')[0]!);
    await waitFor(() =>
      expect(screen.getByTestId('library-message').textContent).toContain(
        'Média utilisé par 1 projet',
      ),
    );
  });

  it('mode sélecteur (éditeur) : un média manquant ne peut pas être ajouté', async () => {
    const onPick = vi.fn();
    const api = fakeApi([asset({}), asset({ id: 'c'.repeat(64), status: 'missing' })]);
    render(<LibraryPanel api={api} onPick={onPick} kind="image" />);
    const buttons = await screen.findAllByTestId('library-pick');
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0]!);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: IMG }));
  });

  it('bibliothèque illisible : erreur affichée', async () => {
    const api = fakeApi([], { list: vi.fn(() => Promise.reject(new Error('API injoignable'))) });
    render(<LibraryPanel api={api} />);
    expect((await screen.findByRole('alert')).textContent).toContain('API injoignable');
  });
});

describe('gestes : calques image et effets sonores (validés par le réducteur partagé)', () => {
  const ctx = { allowedAudioIndexes: [1], allowedCaptionRoles: ['mic' as const] };
  const img: PickedAsset = { id: IMG, kind: 'image', width: 400, height: 200, durationMs: null };
  const snd: PickedAsset = { id: SND, kind: 'audio', width: null, height: null, durationMs: 600 };
  let n = 0;
  const uuid = () => `${(n++).toString(16).padStart(8, '0')}-0000`;

  it('cadre initial : rapport de l’image conservé dans l’image 9:16, borné', () => {
    const f = imageFrame(400, 200);
    expect(f.w).toBe(0.4);
    expect((f.w * 1080) / (f.h * 1920)).toBeCloseTo(2, 2);
    const tall = imageFrame(100, 1000);
    expect(tall.h).toBe(0.5);
    expect(tall.x + tall.w).toBeLessThanOrEqual(1);
  });

  it('image, mème et effet sonore ajoutés à la tête de lecture ; acceptés par le réducteur', () => {
    const d = fixtureV2();
    const g1 = addImageOverlay(d, 1500, img, 'meme', uuid);
    const g2 = addSfx(d, 1500, snd, uuid);
    const r = applyBatch(d, [...g1.ops, ...g2.ops], ctx).doc;
    expect(r.overlays[0]).toMatchObject({ kind: 'meme', assetId: IMG, text: null });
    expect(r.audio.sfx[0]).toMatchObject({
      assetId: SND,
      gainDb: 0,
      timing: { anchor: 'edit', offsetMs: 1500, durMs: 600 },
    });
    expect(() => addImageOverlay(d, 0, snd, 'image', uuid)).toThrow();
    expect(() => addSfx(d, 0, img, uuid)).toThrow();
  });
});

describe('compositeur : calques image', () => {
  type Call = { canvas: string; op: string; args: unknown[] };
  function recorder() {
    const calls: Call[] = [];
    const make = (name: string, w: number, h: number): CanvasLike => ({
      width: w,
      height: h,
      getContext: () =>
        new Proxy(
          {},
          {
            get: (_t, op: string) => {
              if (op === 'measureText') return () => ({ width: 10 });
              return (...args: unknown[]) => calls.push({ canvas: name, op, args });
            },
            set: () => true,
          },
        ) as unknown as CanvasRenderingContext2D,
    });
    let k = 0;
    const names = ['source', 'work', 'tmp'];
    const comp = new Compositor(make('out', 540, 960), (w, h) => make(names[k++] ?? `x${k}`, w, h));
    return { calls, comp };
  }
  const withImage = (): ClipProjectV2 => ({
    ...fixtureV2(),
    overlays: [
      {
        id: 'meme',
        kind: 'meme',
        assetId: IMG,
        text: null,
        timing: { anchor: 'edit', from: 'start', offsetMs: 500, durMs: 1000 },
        frame: { x: 0.7, y: 0, w: 0.3, h: 0.1 },
        opacity: 0.5,
        z: 0,
      },
    ],
  });
  const frame = (d: ClipProjectV2, t: number, image: CanvasImageSource | null) => {
    const scene = sceneAt(d, t as EditMs, {
      src: { width: 1920, height: 1080 },
      out: { width: 540, height: 960 },
      allowedAudioIndexes: [1],
      allowedCaptionRoles: ['mic'],
    });
    return {
      scene,
      video: {} as CanvasImageSource,
      videoSize: { width: 960, height: 540 },
      src: { width: 1920, height: 1080 },
      captions: [],
      overlays: [],
      globalStyle: d.captions.style,
      facecamZoom: 1,
      images: imageOverlayPlacements(d).map((placement) => ({ placement, image })),
    };
  };

  it('posé sur l’image composée (après la copie du tampon de travail), au cadre arrondi comme FFmpeg ; jamais sur le tampon source', () => {
    const d = withImage();
    const pic = { tag: 'image' } as unknown as CanvasImageSource;
    const { calls, comp } = recorder();
    comp.render(frame(d, 1000, pic));
    const copy = calls.findIndex((c) => c.canvas === 'out' && c.op === 'drawImage');
    const drawn = calls.findIndex(
      (c) => c.canvas === 'out' && c.op === 'drawImage' && c.args[0] === pic,
    );
    expect(drawn).toBeGreaterThan(copy);
    expect(calls[drawn]!.args.slice(1)).toEqual([378, 0, 162, 96]);
    expect(calls.some((c) => c.canvas === 'source' && c.args[0] === pic)).toBe(false);
    // Hors de sa plage : absent.
    const later = recorder();
    later.comp.render(frame(d, 2000, pic));
    expect(later.calls.some((c) => c.args[0] === pic)).toBe(false);
  });

  it('média manquant : signalé dans l’aperçu (hachures et libellé), jamais omis en silence', () => {
    const { calls, comp } = recorder();
    comp.render(frame(withImage(), 1000, null));
    expect(calls.some((c) => c.op === 'fillText' && c.args[0] === 'Média manquant')).toBe(true);
  });
});
