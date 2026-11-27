/**
 * Mesures stylistiques d'une vidéo montée (étape 10), entièrement LOCALES, en lecture seule et
 * sans shell. Aucune image, aucun son ni aucun texte n'est conservé : seulement des instants et
 * des niveaux, agrégés ensuite en caractéristiques.
 *
 *  - image (64×36, niveaux de gris) : changements de plan (`scdet`), passages par le noir
 *    (`blackdetect`), images figées (`freezedetect`) ;
 *  - son : silences (`silencedetect`, −40 dB) et sonie intégrée (`loudnorm`, analyse seule) ;
 *  - enveloppe sonore (paires brut + montage) : niveau RMS par fenêtre de 50 ms (`astats`).
 *
 * Ce que ces filtres NE font PAS : lire des sous-titres, reconnaître un visage, un zoom, un effet
 * ou une musique. Ces caractéristiques ne sont donc jamais déduites d'une vidéo de référence.
 */
import { AppError } from '@acs/shared';
import { isSpawnNotFound, runProcess } from './process';

/** Seuil de changement de plan (score `scdet`, 0..100) : prudent, évite les faux plans. */
export const SHOT_CUT_THRESHOLD = 12;
/** Fréquence de l'enveloppe sonore. */
export const ENVELOPE_RATE_HZ = 20;
const ENVELOPE_FLOOR_DB = -60;

async function run(
  ffmpegPath: string,
  args: string[],
  onLine: (line: string) => void,
  signal?: AbortSignal,
) {
  let r;
  try {
    r = await runProcess(ffmpegPath, args, {
      ...(signal ? { signal } : {}),
      onStdoutLine: onLine,
      captureStdout: false,
    });
  } catch (err) {
    if (isSpawnNotFound(err))
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${ffmpegPath})`);
    throw err;
  }
  if (r.aborted) throw new AppError('CANCELLED', 'Analyse annulée');
  // Les messages de FFmpeg peuvent contenir des chemins : jamais relayés tels quels.
  if (r.exitCode !== 0) throw new AppError('MEDIA_EXTRACT_FAILED', 'Analyse du fichier impossible');
  return r;
}

const common = ['-nostdin', '-hide_banner', '-v', 'error'];

export interface VideoStyleScan {
  cutsMs: number[];
  blacks: [number, number][];
  freezes: [number, number][];
}

/** Lit la sortie `metadata=mode=print` des filtres image. */
export function parseVideoStyle(lines: Iterable<string>, durationMs: number): VideoStyleScan {
  const out: VideoStyleScan = { cutsMs: [], blacks: [], freezes: [] };
  let blackStart: number | null = null;
  let freezeStart: number | null = null;
  const ms = (x: string) => Math.max(0, Math.round(Number(x) * 1000));
  for (const raw of lines) {
    const line = raw.trim();
    let m = /^lavfi\.scd\.time=([\d.]+)$/u.exec(line);
    if (m) {
      out.cutsMs.push(ms(m[1]!));
      continue;
    }
    if ((m = /^lavfi\.black_start=([\d.]+)$/u.exec(line))) blackStart = ms(m[1]!);
    else if ((m = /^lavfi\.black_end=([\d.]+)$/u.exec(line)) && blackStart !== null) {
      out.blacks.push([blackStart, ms(m[1]!)]);
      blackStart = null;
    } else if ((m = /^lavfi\.freezedetect\.freeze_start=([\d.]+)$/u.exec(line)))
      freezeStart = ms(m[1]!);
    else if (
      (m = /^lavfi\.freezedetect\.freeze_end=([\d.]+)$/u.exec(line)) &&
      freezeStart !== null
    ) {
      out.freezes.push([freezeStart, ms(m[1]!)]);
      freezeStart = null;
    }
  }
  // Passage noir ou image figée jusqu'à la fin du fichier.
  if (blackStart !== null) out.blacks.push([blackStart, durationMs]);
  if (freezeStart !== null) out.freezes.push([freezeStart, durationMs]);
  return out;
}

export async function scanVideoStyle(
  ffmpegPath: string,
  file: string,
  durationMs: number,
  opts: { signal?: AbortSignal } = {},
): Promise<VideoStyleScan> {
  const lines: string[] = [];
  await run(
    ffmpegPath,
    [
      ...common,
      '-i',
      file,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      `scale=64:36,format=gray,scdet=threshold=${SHOT_CUT_THRESHOLD},blackdetect=d=0.1:pix_th=0.1,freezedetect=n=0.003:d=0.4,metadata=mode=print:file=-`,
      '-f',
      'null',
      '-',
    ],
    (l) => {
      // Seules les lignes utiles sont gardées (pas les scores de chaque image).
      if (/^lavfi\.(scd\.time|black_|freezedetect\.freeze_(start|end))/u.test(l.trim()))
        lines.push(l);
    },
    opts.signal,
  );
  return parseVideoStyle(lines, durationMs);
}

export interface AudioStyleScan {
  silences: [number, number][];
  loudness: { integratedLufs: number; rangeLu: number } | null;
}

/** Résumé JSON de `loudnorm` (dans stderr), ou null. */
export function parseLoudnorm(stderr: string): { integratedLufs: number; rangeLu: number } | null {
  const i = stderr.lastIndexOf('{');
  const j = stderr.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try {
    const o = JSON.parse(stderr.slice(i, j + 1)) as Record<string, string>;
    const integratedLufs = Number(o['input_i']);
    const rangeLu = Number(o['input_lra']);
    if (!Number.isFinite(integratedLufs) || !Number.isFinite(rangeLu)) return null;
    return { integratedLufs, rangeLu };
  } catch {
    return null;
  }
}

export async function scanAudioStyle(
  ffmpegPath: string,
  file: string,
  durationMs: number,
  opts: { signal?: AbortSignal } = {},
): Promise<AudioStyleScan> {
  const silences: [number, number][] = [];
  let start: number | null = null;
  let r;
  try {
    r = await runProcess(
      ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        // `info` : le résumé de loudnorm est écrit à ce niveau (dans stderr, dont la fin est gardée).
        '-v',
        'info',
        '-nostats',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-af',
        'silencedetect=n=-40dB:d=0.3,ametadata=mode=print:file=-,loudnorm=print_format=json',
        '-f',
        'null',
        '-',
      ],
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        captureStdout: false,
        onStdoutLine: (raw) => {
          const line = raw.trim();
          let m = /^lavfi\.silence_start=([\d.]+)$/u.exec(line);
          if (m) start = Math.round(Number(m[1]) * 1000);
          else if ((m = /^lavfi\.silence_end=([\d.]+)$/u.exec(line)) && start !== null) {
            silences.push([start, Math.round(Number(m[1]) * 1000)]);
            start = null;
          }
        },
      },
    );
  } catch (err) {
    if (isSpawnNotFound(err))
      throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${ffmpegPath})`);
    throw err;
  }
  if (r.aborted) throw new AppError('CANCELLED', 'Analyse annulée');
  if (r.exitCode !== 0) throw new AppError('MEDIA_EXTRACT_FAILED', 'Analyse du son impossible');
  if (start !== null) silences.push([start, durationMs]);
  return { silences, loudness: parseLoudnorm(r.stderrTail) };
}

/** Enveloppe sonore (dBFS par fenêtre de 50 ms, bornée à −60) de la première piste audio. */
export async function audioEnvelope(
  ffmpegPath: string,
  file: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ rateHz: number; db: Float32Array }> {
  const values: number[] = [];
  const samplesPerWindow = 8000 / ENVELOPE_RATE_HZ;
  await run(
    ffmpegPath,
    [
      ...common,
      '-i',
      file,
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-af',
      `aresample=8000,pan=mono|c0=c0,asetnsamples=n=${samplesPerWindow}:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      '-f',
      'null',
      '-',
    ],
    (raw) => {
      const m = /^lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf)$/u.exec(raw.trim());
      if (!m) return;
      const v = m[1]!.endsWith('inf') ? ENVELOPE_FLOOR_DB : Number(m[1]);
      values.push(Math.max(ENVELOPE_FLOOR_DB, Math.min(0, v)));
    },
    opts.signal,
  );
  return { rateHz: ENVELOPE_RATE_HZ, db: Float32Array.from(values) };
}
