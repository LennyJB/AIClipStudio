import { describe, expect, it } from 'vitest';
import {
  allowedAudio,
  EMPTY_AUDIO_STATE,
  VOICE_CATEGORIES,
  type ExportAudioState,
  type GameComposition,
  type MicComposition,
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
/** Micro déclaré : voix du créateur seule. */
const MIC_ALONE: MicComposition = { creatorVoice: 'present', otherVoices: 'absent' };

describe('allowedAudio : micro', () => {
  it('composition du micro inconnue : piste bloquée, sous-titres micro refusés', () => {
    const d = allowedAudio(OBS, EMPTY_AUDIO_STATE);
    expect(d.mode).toBe('none');
    expect(roles(d)).toEqual([]);
    expect(d.captionRoles).toEqual([]);
    const mic = d.tracks.find((t) => t.role === 'mic')!;
    expect(mic.exportable).toBe(false);
    expect(mic.missing).toEqual([
      { kind: 'declaration', subject: 'mic_composition' },
      { kind: 'consent', subject: 'other_voices' },
    ]);
    expect(mic.reason).toMatch(/composition du micro .* non déclarée/);
    expect(d.missing).toContainEqual({ kind: 'declaration', subject: 'mic_composition' });
  });

  it('même avec l’accord « autres voix », une composition non déclarée reste bloquée', () => {
    const d = allowedAudio(
      [{ audioIndex: 1, role: 'mic' }],
      state({ consents: { other_voices: true } }),
    );
    expect(d.mode).toBe('none');
    expect(d.tracks[0]!.missing).toEqual([{ kind: 'declaration', subject: 'mic_composition' }]);
  });

  it('voix du créateur seule : exportable sans accord ; raison explicite', () => {
    const d = allowedAudio([{ audioIndex: 1, role: 'mic' }], state({ micComposition: MIC_ALONE }));
    expect(roles(d)).toEqual(['mic']);
    expect(d.captionRoles).toEqual(['mic']);
    expect(d.tracks[0]!.reason).toBe(
      'autorisée (voix du créateur ; aucune voix de tiers déclarée)',
    );
  });

  it('voix de tiers captées par le micro : accord other_voices exigé, ni Discord ni jeu ne suffisent', () => {
    const withThirds = { creatorVoice: 'present', otherVoices: 'present' } as const;
    const blocked = allowedAudio(
      [{ audioIndex: 1, role: 'mic' }],
      state({
        micComposition: withThirds,
        consents: { discord_voices: true, game_voice_chat: true },
      }),
    );
    expect(blocked.mode).toBe('none');
    expect(blocked.captionRoles).toEqual([]);
    expect(blocked.tracks[0]!.missing).toEqual([{ kind: 'consent', subject: 'other_voices' }]);
    const ok = allowedAudio(
      [{ audioIndex: 1, role: 'mic' }],
      state({ micComposition: withThirds, consents: { other_voices: true } }),
    );
    expect(roles(ok)).toEqual(['mic']);
    expect(ok.captionRoles).toEqual(['mic']);
    expect(ok.tracks[0]!.reason).toMatch(/voix du créateur ; autres voix de tiers : accord donné/);
  });

  it('micro sans voix du créateur : distingué dans la raison, mêmes règles pour les tiers', () => {
    const d = allowedAudio(
      [{ audioIndex: 1, role: 'mic' }],
      state({ micComposition: { creatorVoice: 'absent', otherVoices: 'absent' } }),
    );
    expect(d.tracks[0]!.reason).toMatch(/sans voix du créateur/);
    expect(roles(d)).toEqual(['mic']);
  });

  it('micro bloqué : Discord autorisé reste exporté seul ; « tout » n’est pas utilisée pour compenser', () => {
    const d = allowedAudio(
      OBS,
      state({
        consents: { discord_voices: true },
        mixComposition: { discord: 'present', gameVoiceChat: 'absent', otherVoices: 'absent' },
      }),
    );
    // Une piste séparée exploitable existe (Discord) : jamais de « tout » en plus.
    expect(d.mode).toBe('individual');
    expect(roles(d)).toEqual(['discord']);
    expect(d.captionRoles).toEqual(['discord', 'mix']);
  });
});

describe('allowedAudio : règles inchangées (Discord, jeu, « tout »)', () => {
  it('Discord : accord requis, jamais de déclaration', () => {
    const t: TrackIn[] = [{ audioIndex: 2, role: 'discord' }];
    expect(allowedAudio(t, EMPTY_AUDIO_STATE).tracks[0]!.missing).toEqual([
      { kind: 'consent', subject: 'discord_voices' },
    ]);
    expect(roles(allowedAudio(t, state({ consents: { discord_voices: true } })))).toEqual([
      'discord',
    ]);
  });

  it('l’accord Discord seul n’autorise JAMAIS la piste « tout »', () => {
    const s = state({ consents: { discord_voices: true } });
    const mixOnly = allowedAudio([{ audioIndex: 0, role: 'mix' }], s);
    expect(mixOnly.mode).toBe('none');
    expect(mixOnly.captionRoles).toEqual([]);
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
    const base = { micComposition: MIC_ALONE };
    expect(roles(allowedAudio(tracks, state(base)))).toEqual(['mic']);
    expect(
      roles(allowedAudio(tracks, state({ ...base, gameComposition: { gameVoiceChat: 'absent' } }))),
    ).toEqual(['mic', 'game']);
    const present = state({ ...base, gameComposition: { gameVoiceChat: 'present' } });
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
      micComposition: MIC_ALONE,
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
});

describe('allowedAudio : propriété exhaustive', () => {
  it('une piste sélectionnée a TOUJOURS sa déclaration et ses accords ; sous-titres idem', () => {
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
    const mics: (MicComposition | null)[] = [null];
    for (const a of presences)
      for (const b of presences) mics.push({ creatorVoice: a, otherVoices: b });
    const roleSets: TrackRoleIn[][] = [
      ['mix', 'mic', 'discord', 'game'],
      ['mix'],
      ['unknown'],
      ['mix', 'discord'],
      ['mix', 'game'],
      ['mix', 'mic'],
      ['discord', 'game'],
      ['mic'],
      ['mic', 'discord'],
    ];
    let checked = 0;
    for (let mask = 0; mask < 8; mask++) {
      const consents = Object.fromEntries(
        VOICE_CATEGORIES.map((c, i) => [c, Boolean(mask & (1 << i))]),
      ) as ExportAudioState['consents'];
      for (const mixComposition of mixes)
        for (const gameComposition of games)
          for (const micComposition of mics)
            for (const rs of roleSets) {
              const s: ExportAudioState = {
                consents,
                mixComposition,
                gameComposition,
                micComposition,
              };
              const d = allowedAudio(
                rs.map((role, audioIndex) => ({ audioIndex, role })),
                s,
              );
              const micAllowed =
                micComposition !== null &&
                (micComposition.otherVoices === 'absent' || consents.other_voices);
              for (const t of d.selected) {
                if (t.role === 'mic') expect(micAllowed).toBe(true);
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
              // Micro : exportable exactement quand la règle l'autorise (ni plus, ni moins).
              if (rs.includes('mic')) {
                expect(d.tracks.find((t) => t.role === 'mic')!.exportable).toBe(micAllowed);
                expect(d.selected.some((t) => t.role === 'mic')).toBe(micAllowed);
              }
              // Sous-titres : jamais d'un rôle dont la piste n'est pas exportable.
              expect(d.captionRoles.includes('mic')).toBe(rs.includes('mic') && micAllowed);
              if (d.captionRoles.includes('discord')) expect(consents.discord_voices).toBe(true);
              if (d.captionRoles.includes('mix'))
                expect(
                  d.tracks.find((t) => t.role === 'mix' || t.role === 'unknown')?.exportable,
                ).toBe(true);
              if (d.mode === 'none') expect(d.missing.length).toBeGreaterThan(0);
              checked++;
            }
    }
    expect(checked).toBe(8 * 9 * 3 * 5 * 9);
  });
});
