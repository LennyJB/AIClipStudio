import { z } from 'zod';
import { AppError } from '@acs/shared';
import { isSpawnNotFound, runProcess } from './process';

/* ------------------------------------------------------------------ */
/* Schéma de la sortie JSON de ffprobe (seuls les champs utiles).      */
/* ffprobe renvoie les nombres sous forme de chaînes, parfois "N/A".   */
/* ------------------------------------------------------------------ */

const Tags = z.record(z.string(), z.string()).optional();

const FfprobeStream = z.object({
  index: z.number().int(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  channels: z.number().int().optional(),
  channel_layout: z.string().optional(),
  sample_rate: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  start_time: z.string().optional(),
  duration: z.string().optional(),
  tags: Tags,
});

const FfprobeOutput = z.object({
  streams: z.array(FfprobeStream).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      start_time: z.string().optional(),
      size: z.string().optional(),
      bit_rate: z.string().optional(),
      tags: Tags,
    })
    .optional(),
});
export type FfprobeOutput = z.infer<typeof FfprobeOutput>;

/* ------------------------------------------------------------------ */
/* Modèle normalisé                                                    */
/* ------------------------------------------------------------------ */

export interface AudioTrackInfo {
  /** Position parmi les pistes audio (0 = première piste audio). Sert à `-map 0:a:N`. */
  audioIndex: number;
  /** Index du flux dans le conteneur (tous types confondus). */
  streamIndex: number;
  codec: string | null;
  channels: number | null;
  channelLayout: string | null;
  sampleRate: number | null;
  title: string | null;
  language: string | null;
  /** Début de la piste relativement au début du fichier (secondes). */
  startOffsetSec: number;
  durationSec: number | null;
}

export interface VideoInfo {
  streamIndex: number;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export type MediaWarning =
  'duration_unknown' | 'no_audio' | 'no_video' | 'audio_track_offset' | 'unexpected_container';

export interface MediaInfo {
  container: 'mkv' | 'mp4' | 'other';
  formatName: string | null;
  durationSec: number | null;
  durationSource: 'format' | 'stream' | 'tag' | null;
  sizeBytes: number | null;
  bitRate: number | null;
  video: VideoInfo | null;
  audioTracks: AudioTrackInfo[];
  tags: Record<string, string>;
  warnings: MediaWarning[];
}

/* ------------------------------------------------------------------ */

export function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num)) return null;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

/** Durée au format Matroska "HH:MM:SS.nnnnnnnnn" (tag DURATION écrit par OBS/FFmpeg). */
export function parseClockDuration(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(s) ? s : null;
}

function tagValue(tags: Record<string, string> | undefined, key: string): string | undefined {
  if (!tags) return undefined;
  const lower = key.toLowerCase();
  // Matroska peut suffixer la langue : "DURATION-eng".
  const found = Object.keys(tags).find((k) => {
    const kl = k.toLowerCase();
    return kl === lower || kl.startsWith(`${lower}-`);
  });
  return found === undefined ? undefined : tags[found];
}

function detectContainer(formatName: string | undefined): MediaInfo['container'] {
  if (!formatName) return 'other';
  if (formatName.includes('matroska')) return 'mkv';
  if (formatName.includes('mp4') || formatName.includes('mov')) return 'mp4';
  return 'other';
}

const OFFSET_TOLERANCE_SEC = 0.05;

/** Transforme la sortie brute de ffprobe en modèle normalisé (fonction pure, testable). */
export function normalizeProbe(raw: unknown): MediaInfo {
  const parsed = FfprobeOutput.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('MEDIA_PROBE_FAILED', 'Sortie ffprobe inattendue', {
      details: parsed.error.issues.slice(0, 5),
    });
  }
  const { streams, format } = parsed.data;
  const formatStart = parseNumber(format?.start_time) ?? 0;
  const warnings: MediaWarning[] = [];

  const streamDuration = (s: z.infer<typeof FfprobeStream>) =>
    parseNumber(s.duration) ?? parseClockDuration(tagValue(s.tags, 'DURATION'));

  const audioTracks: AudioTrackInfo[] = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, audioIndex) => {
      const start = parseNumber(s.start_time);
      return {
        audioIndex,
        streamIndex: s.index,
        codec: s.codec_name ?? null,
        channels: s.channels ?? null,
        channelLayout: s.channel_layout ?? null,
        sampleRate: parseNumber(s.sample_rate),
        title: tagValue(s.tags, 'title')?.trim() || null,
        language: tagValue(s.tags, 'language') ?? null,
        startOffsetSec: start === null ? 0 : Math.max(0, start - formatStart),
        durationSec: streamDuration(s),
      };
    });

  const v = streams.find((s) => s.codec_type === 'video');
  const video: VideoInfo | null = v
    ? {
        streamIndex: v.index,
        codec: v.codec_name ?? null,
        width: v.width ?? null,
        height: v.height ?? null,
        fps: parseFrameRate(v.avg_frame_rate) ?? parseFrameRate(v.r_frame_rate),
      }
    : null;

  // Durée : conteneur > plus longue durée de flux > tag DURATION.
  let durationSec = parseNumber(format?.duration);
  let durationSource: MediaInfo['durationSource'] = durationSec !== null ? 'format' : null;
  if (durationSec === null) {
    const fromStreams = streams
      .map((s) => parseNumber(s.duration))
      .filter((d): d is number => d !== null);
    if (fromStreams.length) {
      durationSec = Math.max(...fromStreams);
      durationSource = 'stream';
    } else {
      const fromTags = streams
        .map((s) => parseClockDuration(tagValue(s.tags, 'DURATION')))
        .filter((d): d is number => d !== null);
      if (fromTags.length) {
        durationSec = Math.max(...fromTags);
        durationSource = 'tag';
      }
    }
  }

  const container = detectContainer(format?.format_name);
  if (durationSec === null || durationSec <= 0) {
    durationSec = null;
    durationSource = null;
    warnings.push('duration_unknown');
  }
  if (!audioTracks.length) warnings.push('no_audio');
  if (!video) warnings.push('no_video');
  if (audioTracks.some((t) => t.startOffsetSec > OFFSET_TOLERANCE_SEC)) {
    warnings.push('audio_track_offset');
  }
  if (container === 'other') warnings.push('unexpected_container');

  return {
    container,
    formatName: format?.format_name ?? null,
    durationSec,
    durationSource,
    sizeBytes: parseNumber(format?.size),
    bitRate: parseNumber(format?.bit_rate),
    video,
    audioTracks,
    tags: format?.tags ?? {},
    warnings,
  };
}

/** Lit les métadonnées d'un fichier média avec ffprobe (lecture seule). */
export async function probeMedia(
  ffprobePath: string,
  filePath: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MediaInfo> {
  const args = [
    '-v',
    'error',
    '-hide_banner',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
  let result;
  try {
    result = await runProcess(ffprobePath, args, opts.signal ? { signal: opts.signal } : {});
  } catch (err) {
    if (isSpawnNotFound(err)) {
      throw new AppError('TOOL_MISSING', `ffprobe introuvable (${ffprobePath})`, { cause: err });
    }
    throw err;
  }
  if (result.aborted) throw new AppError('CANCELLED', 'Analyse annulée');
  if (result.exitCode !== 0) {
    throw new AppError('MEDIA_PROBE_FAILED', 'ffprobe ne peut pas lire ce fichier', {
      details: { exitCode: result.exitCode, stderr: result.stderrTail.slice(-2000) },
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch (cause) {
    throw new AppError('MEDIA_PROBE_FAILED', 'Réponse ffprobe illisible', { cause });
  }
  const info = normalizeProbe(json);
  if (!info.audioTracks.length && !info.video) {
    throw new AppError('MEDIA_PROBE_FAILED', 'Aucun flux audio ou vidéo détecté');
  }
  return info;
}
