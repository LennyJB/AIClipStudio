import { describe, expect, it } from 'vitest';
import {
  allowedAudio,
  EMPTY_AUDIO_STATE,
  VOICE_CATEGORIES,
  type ExportAudioState,
  type GameComposition,
  type MixComposition,
  type TrackIn,
  type TrackRoleIn,
} from './audio';

const OBS: TrackIn[] = [
  { audioIndex: 0, role: 'mix' },
  { audioIndex: 1, role: 'mic' },
  { audioIndex: 2, role: 'discord' },
  { audioIndex: 3, role: 'game' },
];
const state = (
  o: Partial<Omit<ExportAudioState, 'consents'>> & {
    consents?: Partial<ExportAudioState['consents']>;
  },
) =>
  ({
    ...EMPTY_AUDIO_STATE,
    ...o,
    consents: { ...EMPTY_AUDIO_STATE.consents, ...(o.consents ?? {}) },
  }) as ExportAudioState;
const roles = (d: ReturnType<typeof allowedAudio>) => d.selected.map((t) => t.role);

describe('allowedAudio : règle d’audio exporté', () => {
  it('sans aucun accord ni déclaration : micro seul, ni Discord, ni jeu, ni « tout »', () => {
    const d = allowedAudio(OBS, EMPTY_AUDIO_STATE);
    expect(d.mode).toBe('individual');
    expect(roles(d)).toEqual(['mic']);
    expect(d.captionRoles).toEqual(['mic']);
    const byRole = Object.fromEntries(d.tracks.map((t) => [t.role, t]));
    expect(byRole.mix!.missing).toContainEqual({ kind: 'declaration', subject: 'mix_composition' });
    expect(byRole.game!.missing).toContainEqual({
      kind: 'declaration',
      subject: 'game_composition',
    });
    expect(byRole.discord!.missing).toEqual([{ kind: 'consent', subject: 'discord_voices' }]);
  });

  it('l’accord Discord seul n’autorise JAMAIS la piste « tout »', () => {
    const s = state({ consents: { discord_voices: true } });
    const mixOnly = allowedAudio([{ audioIndex: 0, role: 'mix' }], s);
    expect(mixOnly.mode).toBe('none');
    expect(mixOnly.captionRoles).toEqual([]);
    // Même déclarée « Discord seulement », il faut l'accord ; déclarée avec le chat du jeu,
    // il faut les deux accords.
    const declared = state({
      consents: { discord_voices: true },
      mixComposition: { discord: 'present', gameVoiceChat: 'present', otherVoices: 'absent' },
    });
    const d = allowedAudio([{ audioIndex: 0, role: 'mix' }], declared);
    expect(d.mode).toBe('none');
    expect(d.missing).toEqual([{ kind: 'consent', subject: 'game_voice_chat' }]);
    const both = allowedAudio(
      [{ audioIndex: 0, role: 'mix' }],
      state({ ...declared, consents: { discord_voices: true, game_voice_chat: true } }),
    );
    expect(both.mode).toBe('mix');
    expect(both.captionRoles).toEqual(['mix']);
  });

  it('piste jeu : exclue sans déclaration ; chat vocal présent ⇒ accord requis', () => {
    const tracks: TrackIn[] = [
      { audioIndex: 1, role: 'mic' },
      { audioIndex: 3, role: 'game' },
    ];
    expect(roles(allowedAudio(tracks, EMPTY_AUDIO_STATE))).toEqual(['mic']);
    expect(
      roles(allowedAudio(tracks, state({ gameComposition: { gameVoiceChat: 'absent' } }))),
    ).toEqual(['mic', 'game']);
    const present = state({ gameComposition: { gameVoiceChat: 'present' } });
    expect(roles(allowedAudio(tracks, present))).toEqual(['mic']);
    expect(
      roles(allowedAudio(tracks, state({ ...present, consents: { game_voice_chat: true } }))),
    ).toEqual(['mic', 'game']);
  });

  it('les pistes séparées sont préférées à « tout », jamais superposées', () => {
    const all = state({
      consents: { discord_voices: true, game_voice_chat: true, other_voices: true },
      mixComposition: { discord: 'present', gameVoiceChat: 'present', otherVoices: 'present' },
      gameComposition: { gameVoiceChat: 'absent' },
    });
    const d = allowedAudio(OBS, all);
    expect(d.mode).toBe('individual');
    expect(roles(d)).toEqual(['mic', 'discord', 'game']);
    expect(d.captionRoles).toEqual(['mic', 'discord', 'mix']);
  });

  it('piste unique d’un MP4 de secours : comme « tout »', () => {
    const t: TrackIn[] = [{ audioIndex: 0, role: 'unknown' }];
    expect(allowedAudio(t, EMPTY_AUDIO_STATE).mode).toBe('none');
    const ok = allowedAudio(
      t,
      state({
        mixComposition: { discord: 'absent', gameVoiceChat: 'absent', otherVoices: 'absent' },
      }),
    );
    expect(ok.mode).toBe('mix');
    expect(ok.tracks[0]!.reason).toMatch(/aucune voix de tiers/);
  });

  it('propriété exhaustive : une piste sélectionnée a TOUJOURS ses accords et sa déclaration', () => {
    const presences = ['present', 'absent'] as const;
    const mixes: (MixComposition | null)[] = [null];
    for (const a of presences)
      for (const b of presences)
        for (const c of presences) mixes.push({ discord: a, gameVoiceChat: b, otherVoices: c });
    const games: (GameComposition | null)[] = [
      null,
      { gameVoiceChat: 'present' },
      { gameVoiceChat: 'absent' },
    ];
    const roleSets: TrackRoleIn[][] = [
      ['mix', 'mic', 'discord', 'game'],
      ['mix'],
      ['unknown'],
      ['mix', 'discord'],
      ['mix', 'game'],
      ['discord', 'game'],
      ['mic'],
    ];
    let checked = 0;
    for (let mask = 0; mask < 8; mask++) {
      const consents = Object.fromEntries(
        VOICE_CATEGORIES.map((c, i) => [c, Boolean(mask & (1 << i))]),
      ) as ExportAudioState['consents'];
      for (const mixComposition of mixes)
        for (const gameComposition of games)
          for (const rs of roleSets) {
            const s: ExportAudioState = { consents, mixComposition, gameComposition };
            const d = allowedAudio(
              rs.map((role, audioIndex) => ({ audioIndex, role })),
              s,
            );
            for (const t of d.selected) {
              if (t.role === 'discord') expect(consents.discord_voices).toBe(true);
              if (t.role === 'game') {
                expect(gameComposition).not.toBeNull();
                if (gameComposition!.gameVoiceChat === 'present')
                  expect(consents.game_voice_chat).toBe(true);
              }
              if (t.role === 'mix' || t.role === 'unknown') {
                expect(mixComposition).not.toBeNull();
                if (mixComposition!.discord === 'present')
                  expect(consents.discord_voices).toBe(true);
                if (mixComposition!.gameVoiceChat === 'present')
                  expect(consents.game_voice_chat).toBe(true);
                if (mixComposition!.otherVoices === 'present')
                  expect(consents.other_voices).toBe(true);
                // Jamais superposée à des pistes séparées.
                expect(d.selected).toHaveLength(1);
              }
            }
            // Sous-titres : jamais d'un rôle dont la piste n'est pas exportable.
            if (d.captionRoles.includes('discord')) expect(consents.discord_voices).toBe(true);
            if (d.captionRoles.includes('mix'))
              expect(
                d.tracks.find((t) => t.role === 'mix' || t.role === 'unknown')?.exportable,
              ).toBe(true);
            if (d.mode === 'none') expect(d.missing.length).toBeGreaterThan(0);
            checked++;
          }
    }
    expect(checked).toBe(8 * 9 * 3 * 7);
  });
});
