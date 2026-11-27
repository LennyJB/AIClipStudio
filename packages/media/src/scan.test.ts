/**
 * Étape 8 : sonde enrichie et application du contrôle de lecture (fonctions pures).
 */
import { describe, expect, it } from 'vitest';
import { mediaHealth, normalizeProbe, type MediaInfo } from './probe';
import { applyScan, lastOutTime, type ScanResult } from './scan';
import { resolveTrackRoles } from './tracks';

const stream = (o: Record<string, unknown>) => ({ index: 0, ...o });
const raw = (o: { format?: Record<string, unknown>; streams?: Record<string, unknown>[] }) => ({
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '60.0',
    start_time: '0',
    ...o.format,
  },
  streams: o.streams ?? [
    stream({ index: 0, codec_type: 'video', codec_name: 'h264', start_time: '0', duration: '60' }),
    stream({
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 2,
      sample_rate: '48000',
      start_time: '0',
      duration: '60',
    }),
  ],
});
const clean: ScanResult = {
  headErrors: 0,
  tailErrors: 0,
  tailDecodedSec: 3,
  measuredDurationSec: null,
  scanErrors: 0,
  prematureEnd: false,
};

describe('sonde : décalages, durées, métadonnées (étape 8)', () => {
  it('MP4 Twitch cohérent : aucune anomalie', () => {
    const m = normalizeProbe(raw({}));
    expect(m.warnings).toEqual([]);
    expect(mediaHealth(m.warnings).status).toBe('ok');
  });

  it('MPEG-TS : conteneur reconnu, durée estimée, horodatages de départ ramenés au début du fichier', () => {
    const m = normalizeProbe(
      raw({
        format: { format_name: 'mpegts', start_time: '1.400', duration: '60' },
        streams: [
          stream({
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            start_time: '1.423',
            duration: '60',
          }),
          stream({
            index: 1,
            codec_type: 'audio',
            codec_name: 'aac',
            channels: 2,
            sample_rate: '48000',
            start_time: '1.400',
            duration: '59.8',
          }),
        ],
      }),
    );
    expect(m.container).toBe('mpegts');
    expect(m.audioTracks[0]!.startOffsetSec).toBe(0);
    expect(m.video!.startOffsetSec).toBeCloseTo(0.023, 3);
    expect(m.warnings).toEqual(['duration_estimated']);
  });

  it('vidéo décalée ; piste audio trop courte ; flux plus long que le conteneur ; métadonnées audio absentes', () => {
    const offset = normalizeProbe(
      raw({
        streams: [
          stream({
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            start_time: '1.5',
            duration: '58.5',
          }),
          stream({
            index: 1,
            codec_type: 'audio',
            codec_name: 'aac',
            channels: 2,
            sample_rate: '48000',
            start_time: '0',
            duration: '60',
          }),
        ],
      }),
    );
    expect(offset.warnings).toEqual(['video_track_offset']);
    const short = normalizeProbe(
      raw({
        streams: [
          stream({ index: 0, codec_type: 'video', codec_name: 'h264', duration: '60' }),
          stream({
            index: 1,
            codec_type: 'audio',
            codec_name: 'aac',
            channels: 2,
            sample_rate: '48000',
            duration: '20',
          }),
        ],
      }),
    );
    expect(mediaHealth(short.warnings)).toEqual({
      status: 'degraded',
      issues: ['audio_track_short'],
    });
    const longer = normalizeProbe(
      raw({
        format: { duration: '30' },
        streams: [
          stream({ index: 0, codec_type: 'video', codec_name: 'h264', duration: '60' }),
          stream({
            index: 1,
            codec_type: 'audio',
            codec_name: 'aac',
            channels: 2,
            sample_rate: '48000',
            duration: '30',
          }),
        ],
      }),
    );
    expect(longer.warnings).toContain('duration_mismatch');
    const meta = normalizeProbe(
      raw({
        streams: [
          stream({ index: 0, codec_type: 'video', codec_name: 'h264', duration: '60' }),
          stream({ index: 1, codec_type: 'audio', duration: '60' }),
        ],
      }),
    );
    expect(mediaHealth(meta.warnings).issues).toEqual(['audio_metadata_incomplete']);
  });
});

describe('application du contrôle de lecture', () => {
  const info = (o: Partial<MediaInfo> = {}): MediaInfo => ({ ...normalizeProbe(raw({})), ...o });

  it('fichier complet : inchangé, santé ok, résumé conservé', () => {
    const m = applyScan(info(), clean);
    expect(m.durationSec).toBe(60);
    expect(m.warnings).toEqual([]);
    expect(m.scan).toEqual({
      headErrors: 0,
      tailErrors: 0,
      tailDecodedSec: 3,
      measuredDurationSec: null,
      scanErrors: 0,
    });
  });

  it('fin annoncée absente ou « fin prématurée » : tronqué, durée mesurée retenue (jamais la durée d’en-tête)', () => {
    for (const scan of [
      { ...clean, tailDecodedSec: 0, measuredDurationSec: 33 },
      { ...clean, prematureEnd: true, measuredDurationSec: 58.5 },
    ]) {
      const m = applyScan(info(), scan);
      expect(m.warnings).toContain('truncated');
      expect(m.durationSource).toBe('scan');
      expect(m.durationSec).toBe(scan.measuredDurationSec);
      expect(mediaHealth(m.warnings).status).toBe('degraded');
    }
  });

  it('durée absente : mesurée (plus « inconnue ») ; MPEG-TS : mesure retenue, écart signalé', () => {
    const unknown = applyScan(
      info({ durationSec: null, durationSource: null, warnings: ['duration_unknown'] }),
      { ...clean, tailDecodedSec: null, measuredDurationSec: 61.2 },
    );
    expect(unknown).toMatchObject({ durationSec: 61.2, durationSource: 'scan', warnings: [] });
    const ts = applyScan(info({ container: 'mpegts', warnings: ['duration_estimated'] }), {
      ...clean,
      measuredDurationSec: 52,
    });
    expect(ts.durationSec).toBe(52);
    expect(ts.warnings).toEqual(['duration_estimated', 'duration_mismatch']);
    expect(ts.warnings).not.toContain('truncated');
  });

  it('erreurs de lecture au début, à la fin ou en cours ⇒ partiellement exploitable', () => {
    for (const k of ['headErrors', 'tailErrors', 'scanErrors'] as const) {
      expect(applyScan(info(), { ...clean, [k]: 2 }).warnings).toEqual(['decode_errors']);
    }
  });

  it('progression FFmpeg : dernière valeur out_time_us', () => {
    expect(lastOutTime('out_time_us=1000\nfoo=1\nout_time_us=2500000\n')).toBe(2.5);
    expect(lastOutTime('out_time_us=N/A\n')).toBeNull();
  });
});

describe('rôles des pistes hors OBS', () => {
  const t = (audioIndex: number, title: string | null = null) => ({
    audioIndex,
    streamIndex: audioIndex + 1,
    codec: 'aac',
    channels: 2,
    channelLayout: 'stereo',
    sampleRate: 48000,
    title,
    language: null,
    startOffsetSec: 0,
    durationSec: 60,
  });
  it('piste unique : toujours « Tout », même si l’ordre configuré dit micro', () => {
    expect(resolveTrackRoles([t(0)], ['mic'], undefined, { configOrder: false })).toEqual([
      { audioIndex: 0, role: 'mix', roleSource: 'single_track' },
    ]);
  });
  it('conteneur non OBS : l’ordre configuré n’est pas appliqué (inconnu), les noms de piste le sont', () => {
    expect(
      resolveTrackRoles([t(0), t(1, 'Discord')], ['mix', 'mic'], undefined, { configOrder: false }),
    ).toEqual([
      { audioIndex: 0, role: 'unknown', roleSource: 'default' },
      { audioIndex: 1, role: 'discord', roleSource: 'title' },
    ]);
    // Comportement OBS inchangé par défaut.
    expect(resolveTrackRoles([t(0), t(1)], ['mix', 'mic']).map((r) => r.roleSource)).toEqual([
      'config',
      'config',
    ]);
  });
});
