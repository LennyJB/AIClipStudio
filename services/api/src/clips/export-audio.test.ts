import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db';
import type { AppContext } from '../context';
import { audioStateFromEvents, ExportAudioBodySchema, ExportAudioService } from './export-audio';

const REC = '11111111-1111-4111-8111-111111111111';

function service() {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
       game_id, media_info_json) VALUES (?, '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`,
  ).run(REC);
  const ins = db.prepare(
    `INSERT INTO audio_tracks (recording_id, audio_index, stream_index, role, role_source, title)
     VALUES (?, ?, ?, ?, 'title', ?)`,
  );
  ins.run(REC, 0, 1, 'mix', 'Tout');
  ins.run(REC, 1, 2, 'mic', 'Micro');
  ins.run(REC, 2, 3, 'discord', 'Discord');
  ins.run(REC, 3, 4, 'game', 'Jeu');
  return new ExportAudioService({ db } as unknown as AppContext);
}

describe('ExportAudioService', () => {
  it('schéma : consentements et déclarations stricts', () => {
    const ok = (b: unknown) =>
      ExportAudioBodySchema.safeParse({ requestId: randomUUID(), ...(b as object) }).success;
    expect(ok({ kind: 'consent', subject: 'discord_voices', action: 'granted' })).toBe(true);
    expect(ok({ kind: 'consent', subject: 'mix_composition', action: 'granted' })).toBe(false);
    expect(
      ok({
        kind: 'declaration',
        subject: 'mix_composition',
        payload: { discord: 'present', gameVoiceChat: 'absent', otherVoices: 'absent' },
      }),
    ).toBe(true);
    expect(
      ok({
        kind: 'declaration',
        subject: 'game_composition',
        payload: { gameVoiceChat: 'peut-être' },
      }),
    ).toBe(false);
    expect(
      ok({ kind: 'declaration', subject: 'game_composition', payload: { discord: 'absent' } }),
    ).toBe(false);
  });

  it('état = dernier événement par sujet ; « tout » exige déclaration ET accords', () => {
    const s = service();
    expect(s.view(REC).decision.selected.map((t) => t.role)).toEqual(['mic']);
    s.record(
      REC,
      { requestId: randomUUID(), kind: 'consent', subject: 'discord_voices', action: 'granted' },
      'cli',
    );
    s.record(
      REC,
      {
        requestId: randomUUID(),
        kind: 'declaration',
        subject: 'game_composition',
        payload: { gameVoiceChat: 'present' },
      },
      'cli',
    );
    let v = s.view(REC);
    expect(v.decision.selected.map((t) => t.role)).toEqual(['mic', 'discord']);
    s.record(
      REC,
      {
        requestId: randomUUID(),
        kind: 'declaration',
        subject: 'game_composition',
        payload: { gameVoiceChat: 'absent' },
      },
      'cli',
    );
    v = s.view(REC);
    expect(v.decision.selected.map((t) => t.role)).toEqual(['mic', 'discord', 'game']);
    expect(v.state.gameComposition).toEqual({ gameVoiceChat: 'absent' });
    expect(v.history.map((h) => h.subject)).toEqual([
      'discord_voices',
      'game_composition',
      'game_composition',
    ]);
    expect(v.decision.tracks.find((t) => t.role === 'mix')!.exportable).toBe(false);
  });

  it('idempotence : même demande rejouée sans effet, contenu différent refusé', () => {
    const s = service();
    const requestId = randomUUID();
    const body = {
      requestId,
      kind: 'consent',
      subject: 'other_voices',
      action: 'granted',
      note: 'ok',
    };
    expect(s.record(REC, body, 'ui').replayed).toBe(false);
    expect(s.record(REC, body, 'ui').replayed).toBe(true);
    expect(s.history(REC)).toHaveLength(1);
    expect(() => s.record(REC, { ...body, action: 'revoked' }, 'ui')).toThrow(/déjà servi/);
  });

  it('audioStateFromEvents : révocation', () => {
    const st = audioStateFromEvents([
      {
        id: 'a',
        kind: 'consent',
        subject: 'discord_voices',
        action: 'granted',
        payload: null,
        note: null,
        source: 'ui',
        createdAt: '',
      },
      {
        id: 'b',
        kind: 'consent',
        subject: 'discord_voices',
        action: 'revoked',
        payload: null,
        note: null,
        source: 'ui',
        createdAt: '',
      },
    ]);
    expect(st.consents.discord_voices).toBe(false);
  });
});
