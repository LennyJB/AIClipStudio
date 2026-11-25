/**
 * Fixtures et mesures pour les tests du moteur de rendu (étape 6b). Sources synthétiques lavfi ;
 * aucun vrai enregistrement n'est versionné.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { FFMPEG, FFPROBE } from './media-fixtures';

function ff(args: string[]) {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-nostdin', ...args], { stdio: 'ignore' });
}

/** Rectangles des zones de la fixture « cadrage » (image 1280×720). */
export const LAYOUT_ZONES = {
  width: 1280,
  height: 720,
  /** Moitié gauche rouge, moitié droite bleue. */
  facecam: { x: 960, y: 504, w: 320, h: 216 }, // vert
  mask: { x: 922, y: 29, w: 346, h: 144 }, // blanc (doit toujours disparaître)
};

/** Tonalités par piste (Hz) : Micro, Discord, Jeu, Tout (= somme des trois + tonalité propre). */
export const TONES = { mic: 440, discord: 660, game: 880, mixOnly: 330 } as const;

/**
 * Vidéo 1280×720 : gauche ROUGE, droite BLEUE, facecam VERTE en bas à droite, zone sensible
 * BLANCHE en haut à droite. Quatre pistes : Micro, Discord, Jeu, Tout.
 */
export function createLayoutVideo(
  dir: string,
  seconds = 12,
  fps = 30,
  name = 'cadrage.mkv',
): string {
  const out = path.join(dir, name);
  const z = LAYOUT_ZONES;
  const sine = (f: number) => ['-f', 'lavfi', '-i', `sine=f=${f}:sample_rate=48000:d=${seconds}`];
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=${z.width}x${z.height}:r=${fps}:d=${seconds}`,
    ...sine(TONES.mic),
    ...sine(TONES.discord),
    ...sine(TONES.game),
    ...sine(TONES.mixOnly),
    '-filter_complex',
    [
      `[0:v]drawbox=x=0:y=0:w=${z.width / 2}:h=${z.height}:color=red:t=fill,` +
        `drawbox=x=${z.facecam.x}:y=${z.facecam.y}:w=${z.facecam.w}:h=${z.facecam.h}:color=lime:t=fill,` +
        `drawbox=x=${z.mask.x}:y=${z.mask.y}:w=${z.mask.w}:h=${z.mask.h}:color=white:t=fill[v]`,
      // « Tout » = Micro + Discord + Jeu + une voix présente seulement dans Tout.
      '[1:a][2:a][3:a][4:a]amix=inputs=4:normalize=0[mixall]',
    ].join(';'),
    '-map',
    '[v]',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-map',
    '3:a',
    '-map',
    '[mixall]',
    '-metadata:s:a:0',
    'title=Micro',
    '-metadata:s:a:1',
    'title=Discord',
    '-metadata:s:a:2',
    'title=Jeu',
    '-metadata:s:a:3',
    'title=Tout',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    String(fps),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    out,
  ]);
  return out;
}

/**
 * Vidéo noire avec un flash BLANC de 2 images à chaque seconde entière, et un bip de 50 ms
 * synchrone sur la piste Micro (mesure de la précision de coupe et de la synchronisation).
 */
export function createSyncVideo(dir: string, fps = 30, seconds = 12, name?: string): string {
  const out = path.join(dir, name ?? `synchro-${fps}.mkv`);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=320x180:r=${fps}:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=1000:sample_rate=48000:d=${seconds}`,
    '-filter_complex',
    `[0:v]drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='lt(mod(n,${fps}),2)'[v];` +
      `[1:a]volume='if(lt(mod(t,1),0.05),1,0)':eval=frame[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-metadata:s:a:0',
    'title=Micro',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    String(fps),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    out,
  ]);
  return out;
}

/** Image RVB d'un instant de la vidéo : pixels lisibles par (x, y). */
export function frameAt(
  file: string,
  atSec: number,
): { width: number; height: number; rgb: (x: number, y: number) => [number, number, number] } {
  const info = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split(',')
    .map(Number);
  const [width, height] = [info[0]!, info[1]!];
  const raw = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-nostdin',
      // Pas de -ss sur une image fixe : le démultiplexeur d'images n'en renverrait aucune.
      ...(atSec > 0 ? ['-ss', atSec.toFixed(3)] : []),
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return {
    width,
    height,
    rgb: (x, y) => {
      const i = (y * width + x) * 3;
      return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
    },
  };
}

/** Échantillons audio mono 48 kHz (flottants) de la sortie. */
export function audioSamples(file: string): Float32Array {
  const raw = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      '-',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const copy = Buffer.from(raw);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

/** Énergie relative d'une fréquence (Goertzel) sur tout le signal. */
export function toneLevel(samples: Float32Array, freq: number, rate = 48000): number {
  const k = 2 * Math.cos((2 * Math.PI * freq) / rate);
  let s1 = 0;
  let s2 = 0;
  const n = Math.min(samples.length, rate * 4);
  for (let i = 0; i < n; i++) {
    const s = samples[i]! + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / n;
}

/** Instant (ms) du premier échantillon dépassant le seuil. */
export function firstBeepMs(samples: Float32Array, threshold = 0.2, rate = 48000): number {
  const i = samples.findIndex((s) => Math.abs(s) > threshold);
  return i < 0 ? -1 : (i / rate) * 1000;
}

/** Instant (ms) de la première image claire (moyenne de luminance > 128). */
export function firstFlashMs(file: string): number {
  const raw = execFileSync(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-i', file, '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const fps = videoFps(file);
  for (let f = 0; f * 64 < raw.length; f++) {
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += raw[f * 64 + i]!;
    if (sum / 64 > 128) return (f / fps) * 1000;
  }
  return -1;
}

export function videoFps(file: string): number {
  const r = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=r_frame_rate',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  ).trim();
  const [a, b] = r.split('/').map(Number);
  return a! / (b ?? 1);
}

/** Sonie intégrée (LUFS) mesurée par FFmpeg (ebur128, résumé écrit sur stderr). */
export function integratedLufs(file: string): number {
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const m = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/gu)].at(-1);
  return m ? Number(m[1]) : NaN;
}
