/**
 * Génère de petits fichiers de test avec FFmpeg (sources synthétiques lavfi).
 * Aucun vrai enregistrement n'est versionné.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/**
 * Vrai si FFmpeg et ffprobe sont utilisables. En CI (REQUIRE_FFMPEG=1), leur absence
 * est une ERREUR : les tests d'intégration ne doivent jamais être ignorés en silence.
 */
export function ffmpegAvailable(): boolean {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if (process.env.REQUIRE_FFMPEG === '1') {
      throw new Error(
        `REQUIRE_FFMPEG=1 mais FFmpeg/ffprobe est introuvable (${FFMPEG}, ${FFPROBE})`,
        {
          cause: err,
        },
      );
    }
    return false;
  }
}

function ff(args: string[]) {
  execFileSync(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

const VIDEO = ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=6'];
const sine = (freq: number, d: number) => ['-f', 'lavfi', '-i', `sine=f=${freq}:d=${d}`];

export interface Fixtures {
  dir: string;
  /** MKV type OBS : 3 pistes nommées Tout / Micro / Discord. */
  obsMkv: string;
  /** MKV 3 pistes sans nom. */
  untitledMkv: string;
  /** MP4 de secours : une seule piste. */
  singleMp4: string;
  /** Piste audio démarrant 2 s après la vidéo. */
  delayedMkv: string;
  /** MKV écrit sans finalisation (comme un OBS qui plante) : durée inconnue. */
  unfinalizedMkv: string;
  /** MKV tronqué à 60 %. */
  truncatedMkv: string;
  /** Fichier non média renommé en .mkv. */
  garbageMkv: string;
  /** 60 min d'audio, pour tester l'annulation et les traitements longs. */
  longMkv: string;
  /** MKV OBS à 4 pistes nommées : Tout / Micro / Discord / Jeu. */
  gameMkv: string;
  /** Impulsions de 0,5 s chaque seconde : repères pour mesurer l'alignement. */
  pulseMkv: string;
}

export function createFixtures(): Fixtures {
  const dir = mkdtempSync(path.join(tmpdir(), 'acs-media-'));
  const p = (n: string) => path.join(dir, n);
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'];

  ff([
    ...VIDEO,
    ...sine(220, 6),
    ...sine(440, 6),
    ...sine(880, 6),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-map',
    '3:a',
    ...enc,
    '-metadata:s:a:0',
    'title=Tout',
    '-metadata:s:a:1',
    'title=Micro',
    '-metadata:s:a:2',
    'title=Discord',
    p('obs.mkv'),
  ]);
  ff([
    ...VIDEO,
    ...sine(220, 6),
    ...sine(440, 6),
    ...sine(880, 6),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-map',
    '3:a',
    ...enc,
    p('untitled.mkv'),
  ]);
  ff([...VIDEO, ...sine(440, 6), '-map', '0:v', '-map', '1:a', ...enc, p('single.mp4')]);
  ff([
    ...VIDEO,
    '-itsoffset',
    '2',
    ...sine(440, 4),
    '-map',
    '0:v',
    '-map',
    '1:a',
    ...enc,
    p('delayed.mkv'),
  ]);
  // Sortie non « seekable » : l'en-tête Matroska n'est jamais complété.
  const live = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-nostdin',
      ...VIDEO,
      ...sine(440, 6),
      '-map',
      '0:v',
      '-map',
      '1:a',
      ...enc,
      '-f',
      'matroska',
      'pipe:1',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(p('unfinalized.mkv'), live);
  const full = readFileSync(p('obs.mkv'));
  writeFileSync(p('truncated.mkv'), full.subarray(0, Math.floor(full.length * 0.6)));
  writeFileSync(p('garbage.mkv'), 'ceci n’est pas une vidéo\n'.repeat(200));
  ff([
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=3600:sample_rate=8000',
    '-c:a',
    'pcm_s16le',
    p('long.mkv'),
  ]);

  ff([
    '-f',
    'lavfi',
    '-i',
    "sine=f=300:d=10,volume='if(lt(mod(t,1),0.5),1,0)':eval=frame",
    '-c:a',
    'aac',
    p('pulse.mkv'),
  ]);

  ff([
    ...VIDEO,
    ...sine(220, 6),
    ...sine(440, 6),
    ...sine(880, 6),
    ...sine(330, 6),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-map',
    '3:a',
    '-map',
    '4:a',
    ...enc,
    '-metadata:s:a:0',
    'title=Tout',
    '-metadata:s:a:1',
    'title=Micro',
    '-metadata:s:a:2',
    'title=Discord',
    '-metadata:s:a:3',
    'title=Jeu',
    p('game.mkv'),
  ]);

  return {
    dir,
    gameMkv: p('game.mkv'),
    pulseMkv: p('pulse.mkv'),
    obsMkv: p('obs.mkv'),
    untitledMkv: p('untitled.mkv'),
    singleMp4: p('single.mp4'),
    delayedMkv: p('delayed.mkv'),
    unfinalizedMkv: p('unfinalized.mkv'),
    truncatedMkv: p('truncated.mkv'),
    garbageMkv: p('garbage.mkv'),
    longMkv: p('long.mkv'),
  };
}

/** RMS normalisé (0..1) d'un WAV PCM 16 bits mono sur [fromSec, toSec[. */
export function wavRms(
  filePath: string,
  fromSec: number,
  toSec: number,
  sampleRate = 16000,
): number {
  const buf = readFileSync(filePath);
  const dataStart = buf.indexOf('data') + 8;
  const start = dataStart + Math.floor(fromSec * sampleRate) * 2;
  const end = Math.min(buf.length, dataStart + Math.floor(toSec * sampleRate) * 2);
  let sum = 0;
  let n = 0;
  for (let i = start; i + 1 < end; i += 2) {
    const s = buf.readInt16LE(i) / 32768;
    sum += s * s;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function wavSamples(filePath: string): Int16Array {
  const buf = readFileSync(filePath);
  const start = buf.indexOf('data') + 8;
  const copy = Buffer.from(buf.subarray(start, start + Math.floor((buf.length - start) / 2) * 2));
  return new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
}

/**
 * Décalage (ms) qui aligne au mieux `windowWav` sur `fullWav` à partir de `offsetMs`
 * (WAV mono 16 kHz). 0 = alignement parfait.
 */
export function bestLagMs(
  fullWav: string,
  windowWav: string,
  offsetMs: number,
  sampleRate = 16000,
): number {
  const full = wavSamples(fullWav);
  const win = wavSamples(windowWav);
  const base = Math.round((offsetMs / 1000) * sampleRate);
  let best = 0;
  let bestErr = Infinity;
  const n = Math.min(win.length, sampleRate);
  for (let lag = -800; lag <= 800; lag++) {
    let err = 0;
    for (let i = 0; i < n; i += 7) err += Math.abs((full[base + lag + i] ?? 0) - win[i]!);
    if (err < bestErr) {
      bestErr = err;
      best = lag;
    }
  }
  return (best / sampleRate) * 1000;
}

/**
 * Vidéo 320×180 de 6 s, avec deux pistes audio nommées Micro / Discord :
 * fond ROUGE de 0 à 2 s, VERT de 2 à 4 s, BLEU de 4 à 6 s (instants vérifiables au pixel).
 */
export function createColorVideo(dir: string): string {
  const out = path.join(dir, 'couleurs.mkv');
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x180:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=lime:s=320x180:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x180:r=30:d=2',
    ...sine(440, 6),
    ...sine(660, 6),
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '3:a',
    '-map',
    '4:a',
    '-metadata:s:a:0',
    'title=Micro',
    '-metadata:s:a:1',
    'title=Discord',
    '-c:v',
    'libx264',
    '-g',
    '15',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    out,
  ]);
  return out;
}

/** Couleur RVB d'un pixel d'une image (décodée par FFmpeg). */
export function pixelAt(imagePath: string, x: number, y: number): [number, number, number] {
  const raw = execFileSync(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-i', imagePath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const probe = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width',
      '-of',
      'csv=p=0',
      imagePath,
    ],
    { encoding: 'utf8' },
  );
  const width = Number(probe.trim());
  const i = (y * width + x) * 3;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
}

/**
 * Vidéo grise légère de `seconds` secondes (2 images/s), pistes Micro / Discord.
 * `withMix` ajoute une 3e piste « Tout » (index 2), sans changer l'index des deux premières.
 */
export function createTalkVideo(
  dir: string,
  seconds: number,
  opts: { withMix?: boolean } = {},
): string {
  const out = path.join(dir, `parole-${seconds}s${opts.withMix ? '-tout' : ''}.mkv`);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=160x90:r=2:d=${seconds}`,
    ...sine(440, seconds),
    ...sine(660, seconds),
    ...(opts.withMix ? sine(330, seconds) : []),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    ...(opts.withMix ? ['-map', '3:a', '-metadata:s:a:2', 'title=Tout'] : []),
    '-metadata:s:a:0',
    'title=Micro',
    '-metadata:s:a:1',
    'title=Discord',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    out,
  ]);
  return out;
}
