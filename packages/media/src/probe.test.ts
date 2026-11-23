import { describe, expect, it } from 'vitest';
import { normalizeProbe, parseClockDuration, parseFrameRate } from './probe';

describe('parseurs', () => {
  it('parseClockDuration', () => {
    expect(parseClockDuration('01:02:03.500000000')).toBeCloseTo(3723.5);
    expect(parseClockDuration('00:00:06')).toBe(6);
    expect(parseClockDuration('N/A')).toBeNull();
    expect(parseClockDuration(undefined)).toBeNull();
  });
  it('parseFrameRate', () => {
    expect(parseFrameRate('60/1')).toBe(60);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('0/0')).toBeNull();
  });
});

const base = {
  format: { format_name: 'matroska,webm', duration: '100.0', start_time: '0.000000' },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '60/1',
    },
    {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 2,
      sample_rate: '48000',
      start_time: '0.000',
      tags: { title: 'Micro' },
    },
    {
      index: 2,
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 2,
      sample_rate: '48000',
      start_time: '0.021',
      tags: { title: 'Discord', language: 'fre' },
    },
  ],
};

describe('normalizeProbe', () => {
  it('normalise un MKV OBS standard', () => {
    const info = normalizeProbe(base);
    expect(info.container).toBe('mkv');
    expect(info.durationSec).toBe(100);
    expect(info.durationSource).toBe('format');
    expect(info.video).toMatchObject({ width: 1920, height: 1080, fps: 60 });
    expect(info.audioTracks.map((t) => [t.audioIndex, t.streamIndex, t.title])).toEqual([
      [0, 1, 'Micro'],
      [1, 2, 'Discord'],
    ]);
    expect(info.audioTracks[1]?.sampleRate).toBe(48000);
    expect(info.warnings).toEqual([]); // 21 ms : sous la tolérance
  });

  it('se rabat sur le tag DURATION quand le conteneur ne donne rien', () => {
    const raw = structuredClone(base) as {
      format: Record<string, string>;
      streams: { tags?: Record<string, string> }[];
    };
    raw.format = { ...raw.format, duration: 'N/A' };
    raw.streams[0]!.tags = { 'DURATION-eng': '00:10:00.000000000' };
    const info = normalizeProbe(raw);
    expect(info.durationSec).toBe(600);
    expect(info.durationSource).toBe('tag');
  });

  it('signale une durée inconnue, un décalage audio et une absence de vidéo', () => {
    const info = normalizeProbe({
      format: { format_name: 'matroska,webm', start_time: '1.0' },
      streams: [{ index: 0, codec_type: 'audio', start_time: '3.5' }],
    });
    expect(info.durationSec).toBeNull();
    expect(info.audioTracks[0]?.startOffsetSec).toBeCloseTo(2.5);
    expect(info.warnings).toEqual(
      expect.arrayContaining(['duration_unknown', 'no_video', 'audio_track_offset']),
    );
  });

  it('rejette une sortie ffprobe de forme inattendue', () => {
    expect(() => normalizeProbe({ streams: 'oops' })).toThrow(/ffprobe/);
  });
});
