/**
 * Étape 8 : import par chemin et état du fichier (API simulée, aucun réseau).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type Recording } from '../api';
import { RecordingHealth, Recordings } from './Recordings';

const rec = (o: Partial<Recording> = {}): Recording => ({
  id: 'r1',
  fileName: 'rediffusion.mp4',
  durationSec: 3600,
  gameId: 'generic',
  container: 'mp4',
  audioTracks: [{ audioIndex: 0, role: 'mix', roleSource: 'single_track', title: null }],
  warnings: [],
  health: { status: 'ok', issues: [] },
  ...o,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('état d’un enregistrement', () => {
  it('piste unique : « Tout », son mixé jamais séparé, composition à déclarer', () => {
    render(<RecordingHealth recording={rec()} />);
    const el = screen.getByTestId('recording-health');
    expect(el.textContent).toContain('Fichier lisible');
    expect(el.textContent).toContain('Tout');
    expect(el.textContent).toContain('jamais séparé');
  });

  it('fichier tronqué : jamais présenté comme valide, anomalies graves en erreur', () => {
    render(
      <RecordingHealth
        recording={rec({
          warnings: ['truncated', 'video_track_offset'],
          health: { status: 'degraded', issues: ['truncated'] },
        })}
      />,
    );
    const el = screen.getByTestId('recording-health');
    expect(el.textContent).toContain('partiellement exploitable');
    expect(el.textContent).not.toContain('Fichier lisible');
    const items = el.querySelectorAll('li');
    expect(items[0]!.className).toBe('error');
    expect(items[0]!.textContent).toContain('tronqué');
    expect(items[1]!.className).toBe('muted');
  });
});

describe('import par chemin', () => {
  it('importe, affiche l’état ; refus du serveur affiché', async () => {
    vi.spyOn(api, 'recordings').mockResolvedValue({ recordings: [] });
    const imp = vi
      .spyOn(api, 'importRecording')
      .mockResolvedValueOnce({
        recording: rec({
          health: { status: 'degraded', issues: ['truncated'] },
          warnings: ['truncated'],
        }),
        created: true,
      })
      .mockRejectedValueOnce(
        new ApiError('Format non pris en charge (.avi)', 400, 'MEDIA_UNSUPPORTED', null),
      );
    render(<Recordings />);
    const input = await screen.findByTestId('import-path');
    fireEvent.change(input, { target: { value: 'D:\\Rediffusions\\rediffusion.mp4' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('import-notice').textContent).toContain(
        'partiellement exploitable',
      ),
    );
    expect(imp).toHaveBeenCalledWith({ path: 'D:\\Rediffusions\\rediffusion.mp4' });
    expect(screen.getByTestId('recording-degraded')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'D:\\x.avi' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByTestId('import-error')).textContent).toContain(
      'Format non pris en charge',
    );
  });
});

describe('confirmation des rôles supposés', () => {
  it('rôles « config » : confirmation explicite proposée, envoyée telle quelle ; absente pour une piste unique', async () => {
    const assumed = rec({
      audioTracks: [
        { audioIndex: 0, role: 'mix', roleSource: 'config', title: null },
        { audioIndex: 1, role: 'mic', roleSource: 'config', title: null },
      ],
      warnings: ['track_roles_from_config'],
    });
    const onChange = vi.fn();
    const confirm = vi.spyOn(api, 'confirmTrackRoles').mockResolvedValue({
      recording: {
        ...assumed,
        audioTracks: assumed.audioTracks.map((t) => ({ ...t, roleSource: 'override' })),
      },
    });
    render(<RecordingHealth recording={assumed} onChange={onChange} />);
    expect(screen.getByTestId('confirm-roles').textContent).toContain(
      'ni exportées ni sous-titrées',
    );
    const selects = screen.getByTestId('confirm-roles').querySelectorAll('select');
    fireEvent.change(selects[1]!, { target: { value: 'discord' } });
    fireEvent.click(screen.getByTestId('confirm-roles-submit'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith('r1', ['mix', 'discord']);
    cleanup();
    render(<RecordingHealth recording={rec()} onChange={onChange} />);
    expect(screen.queryByTestId('confirm-roles')).toBeNull();
  });
});
