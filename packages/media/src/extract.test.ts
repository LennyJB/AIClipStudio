import { describe, expect, it } from 'vitest';
import { AUDIO_PROFILES, buildExtractArgs, partPath } from './extract';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('profils d’extraction audio', () => {
  it('profil « preview » (écoute de la revue) : WAV PCM 16 bits, mono, 48 kHz, plage et piste', () => {
    expect(AUDIO_PROFILES.preview).toEqual({ sampleRate: 48_000, channels: 1, codec: 'pcm_s16le' });
    const args = buildExtractArgs(
      '/src/stream.mkv',
      [{ audioIndex: 2, outputPath: '/proc/x.wav' }],
      'preview',
      { startMs: 108_500, endMs: 135_300 },
    );
    expect(after(args, '-ss')).toBe('108.500');
    expect(after(args, '-t')).toBe('26.800');
    expect(after(args, '-map')).toBe('0:a:2');
    expect(after(args, '-ac')).toBe('1');
    expect(after(args, '-ar')).toBe('48000');
    expect(after(args, '-c:a')).toBe('pcm_s16le');
    expect(after(args, '-af')).toBe('aresample=async=1:first_pts=0'); // même alignement
    expect(args.at(-1)).toBe(partPath('/proc/x.wav')); // écrit d'abord en .part
    expect(args).not.toContain('/src/stream.mkv.part'); // jamais d'écriture sur l'original
  });

  it('les profils existants restent inchangés', () => {
    expect(AUDIO_PROFILES.transcription).toEqual({
      sampleRate: 16_000,
      channels: 1,
      codec: 'pcm_s16le',
    });
    expect(AUDIO_PROFILES.editor).toEqual({ sampleRate: 48_000, channels: 2, codec: 'pcm_s16le' });
  });
});
