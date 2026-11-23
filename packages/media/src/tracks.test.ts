import { describe, expect, it } from 'vitest';
import type { AudioTrackInfo } from './probe';
import {
  resolveTrackRoles,
  roleFromTitle,
  selectEditorTracks,
  selectTranscriptionTracks,
} from './tracks';

const track = (audioIndex: number, title: string | null = null): AudioTrackInfo => ({
  audioIndex,
  streamIndex: audioIndex + 1,
  codec: 'aac',
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48000,
  title,
  language: null,
  startOffsetSec: 0,
  durationSec: 10,
});

describe('roleFromTitle', () => {
  it.each([
    ['Micro', 'mic'],
    ['Mon micro', 'mic'],
    ['DISCORD', 'discord'],
    ['Tout', 'mix'],
    ['Jeu + navigateur', 'game'],
    ['Track1', null],
    [null, null],
  ])('%s → %s', (title, role) => expect(roleFromTitle(title)).toBe(role));
});

describe('resolveTrackRoles', () => {
  const config = ['mix', 'mic', 'discord'] as const;

  it('utilise l’ordre configuré quand les pistes ne sont pas nommées', () => {
    const r = resolveTrackRoles([track(0), track(1), track(2)], config);
    expect(r.map((t) => [t.role, t.roleSource])).toEqual([
      ['mix', 'config'],
      ['mic', 'config'],
      ['discord', 'config'],
    ]);
  });

  it('privilégie le nom de piste OBS sur la configuration', () => {
    const r = resolveTrackRoles([track(0, 'Discord'), track(1, 'Micro'), track(2)], config);
    expect(r.map((t) => t.role)).toEqual(['discord', 'mic', 'discord']);
  });

  it('considère un fichier à piste unique (MP4 de secours) comme un mix', () => {
    expect(resolveTrackRoles([track(0, 'Micro')], config)[0]).toMatchObject({
      role: 'mix',
      roleSource: 'single_track',
    });
  });

  it('applique les rôles imposés en priorité', () => {
    const r = resolveTrackRoles([track(0), track(1)], config, ['game', 'mic']);
    expect(r.map((t) => [t.role, t.roleSource])).toEqual([
      ['game', 'override'],
      ['mic', 'override'],
    ]);
  });

  it('marque inconnues les pistes au-delà de la configuration', () => {
    expect(resolveTrackRoles([track(0), track(1), track(2), track(3)], config)[3]?.role).toBe(
      'unknown',
    );
  });
});

describe('selectTranscriptionTracks', () => {
  const r = (roles: string[]) =>
    roles.map(
      (role, audioIndex) => ({ audioIndex, role, roleSource: 'config' }) as const,
    ) as Parameters<typeof selectTranscriptionTracks>[0];

  it('transcrit micro et Discord séparément, jamais le mix en plus', () => {
    expect(
      selectTranscriptionTracks(r(['mix', 'mic', 'discord'])).map((t) => t.audioIndex),
    ).toEqual([1, 2]);
  });
  it('se rabat sur le mix sans voix séparées', () => {
    expect(selectTranscriptionTracks(r(['mix'])).map((t) => t.audioIndex)).toEqual([0]);
  });
  it('ne transcrit jamais une piste de jeu seule', () => {
    expect(selectTranscriptionTracks(r(['game']))).toEqual([]);
  });
});

describe('selectEditorTracks', () => {
  const r = (roles: string[]) =>
    roles.map(
      (role, audioIndex) => ({ audioIndex, role, roleSource: 'config' }) as const,
    ) as Parameters<typeof selectEditorTracks>[0];
  const idx = (roles: string[]) => selectEditorTracks(r(roles)).map((t) => t.audioIndex);

  it('avec une piste jeu : micro + Discord + jeu, jamais le mix', () => {
    expect(idx(['mix', 'mic', 'discord', 'game'])).toEqual([1, 2, 3]);
  });
  it('sans piste jeu : le mix seul (pas de voix doublées)', () => {
    expect(idx(['mix', 'mic', 'discord'])).toEqual([0]);
  });
  it('MP4 de secours : le mix', () => {
    expect(idx(['mix'])).toEqual([0]);
  });
  it('voix seules sans mix ni jeu : les voix', () => {
    expect(idx(['mic', 'discord'])).toEqual([0, 1]);
  });
});
