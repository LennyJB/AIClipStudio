import { describe, expect, it } from 'vitest';
import { CONTENT_DETECTOR_VERSION } from '@acs/editorial';
import { contentDetectionKey, type ContentKeyParts } from './key';

const base: ContentKeyParts = {
  fingerprint: 'fp',
  transcriptions: [{ id: 't1', segmentCount: 10, completedAt: '2026-11-27T10:00:00Z' }],
  audioTracks: [{ audioIndex: 0, role: 'mic' }],
  game: { id: 'valorant', vocabulary: ['spike'] },
  contentProfiles: { just_chatting: { context: 'a' } },
  hasVideo: true,
};

describe('clé d’entrée d’une détection', () => {
  it('stable pour des entrées identiques, version courante par défaut', () => {
    expect(contentDetectionKey(base)).toBe(contentDetectionKey({ ...base }));
    expect(contentDetectionKey(base)).toBe(contentDetectionKey(base, CONTENT_DETECTOR_VERSION));
  });

  it('change avec la transcription, les profils, les rôles, la vidéo, l’original et la version du détecteur', () => {
    const k = contentDetectionKey(base);
    const variants: ContentKeyParts[] = [
      { ...base, transcriptions: [{ ...base.transcriptions[0]!, id: 't2' }] },
      { ...base, transcriptions: [{ ...base.transcriptions[0]!, segmentCount: 11 }] },
      { ...base, contentProfiles: { just_chatting: { context: 'b' } } },
      { ...base, game: { id: 'valorant', vocabulary: ['spike', 'ace'] } },
      { ...base, audioTracks: [{ audioIndex: 0, role: 'mix' }] },
      { ...base, hasVideo: false },
      { ...base, fingerprint: 'autre' },
    ];
    for (const v of variants) expect(contentDetectionKey(v)).not.toBe(k);
    expect(contentDetectionKey(base, 'content-v1')).not.toBe(k);
  });
});
