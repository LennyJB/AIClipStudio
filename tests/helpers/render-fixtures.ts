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

/* ------------------------------------------------------------------ */
/* Montage multi-segments (étape 7, PR 7c)                             */
/* ------------------------------------------------------------------ */

/** Code-barres du numéro d'image source : 10 carrés de 24 px en haut, plus un pilote toujours blanc. */
export const BARCODE = { bits: 10, size: 24, pilotX: 264 } as const;
/** Tonalités de la fixture de montage (Hz) : fond continu et bip de chaque seconde. */
export const EDIT_TONES = { bed: 440, beep: 1000 } as const;

/**
 * Vidéo 320×180 de montage : fond gris foncé, numéro d'image source en code-barres (haut),
 * éclair BLANC de 2 images à chaque seconde entière (bas), tonalité continue de 440 Hz et bip de
 * 1 kHz de 50 ms synchrone de chaque éclair. `tracks` pistes identiques (1 = piste unique
 * « Tout »).
 */
export function createEditVideo(
  dir: string,
  o: { fps?: number; seconds?: number; tracks?: number; name?: string } = {},
): string {
  const fps = o.fps ?? 30;
  const seconds = o.seconds ?? 20;
  const tracks = o.tracks ?? 1;
  const out = path.join(dir, o.name ?? `montage-${fps}-${tracks}.mkv`);
  const s = BARCODE.size;
  const bits = Array.from(
    { length: BARCODE.bits },
    (_, i) =>
      `drawbox=x=${i * s}:y=0:w=${s}:h=${s}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** i}),2),1)'`,
  ).join(',');
  const audioLabels = Array.from({ length: tracks }, (_, k) => `[a${k}]`).join('');
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=0x202020:s=320x180:r=${fps}:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=${EDIT_TONES.bed}:sample_rate=48000:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=${EDIT_TONES.beep}:sample_rate=48000:d=${seconds}`,
    '-filter_complex',
    [
      `[0:v]${bits},drawbox=x=${BARCODE.pilotX}:y=0:w=${s}:h=${s}:color=white:t=fill,` +
        `drawbox=x=0:y=120:w=320:h=60:color=white:t=fill:enable='lt(mod(n,${fps}),2)'[v]`,
      // `sine` produit une amplitude de 1/8 : fond à 0,25, bip à 0,5.
      `[1:a]volume=2[bed]`,
      `[2:a]volume='if(lt(mod(t,1),0.05),4,0)':eval=frame[beep]`,
      `[bed][beep]amix=inputs=2:normalize=0,asplit=${tracks}${audioLabels}`,
    ].join(';'),
    '-map',
    '[v]',
    ...Array.from({ length: tracks }, (_, k) => ['-map', `[a${k}]`]).flat(),
    ...(tracks === 1 ? ['-metadata:s:a:0', 'title=Tout'] : ['-metadata:s:a:0', 'title=Micro']),
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
 * Images de la sortie (disposition « fond flouté », premier plan pleine largeur) ramenées à la
 * taille de la source : pour chaque image, numéro d'image source lu dans le code-barres (null si
 * le pilote est absent : vide ou fond), et présence de l'éclair.
 */
export function decodeEditFrames(
  file: string,
  fg: { y: number; h: number; w: number },
): { source: number | null; flash: boolean }[] {
  const raw = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      file,
      '-vf',
      `crop=${fg.w}:${fg.h}:0:${fg.y},scale=320:180:flags=neighbor,format=gray`,
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  const size = 320 * 180;
  const px = (f: number, x: number, y: number) => raw[f * size + y * 320 + x]!;
  const c = BARCODE.size / 2;
  const out: { source: number | null; flash: boolean }[] = [];
  for (let f = 0; (f + 1) * size <= raw.length; f++) {
    const pilot = px(f, BARCODE.pilotX + c, c) > 160;
    let n = 0;
    for (let i = 0; i < BARCODE.bits; i++) if (px(f, i * BARCODE.size + c, c) > 160) n |= 1 << i;
    out.push({ source: pilot ? n : null, flash: px(f, 160, 150) > 160 });
  }
  return out;
}

/** Énergie d'une fréquence (Goertzel) sur une fenêtre [startMs, startMs + durMs). */
export function toneLevelAt(
  samples: Float32Array,
  freq: number,
  startMs: number,
  durMs: number,
  rate = 48000,
): number {
  const a = Math.max(0, Math.round((startMs * rate) / 1000));
  const b = Math.min(samples.length, Math.round(((startMs + durMs) * rate) / 1000));
  const k = 2 * Math.cos((2 * Math.PI * freq) / rate);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s = samples[i]! + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return b > a ? Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (b - a) : 0;
}

/** Débuts des bips (ms) : fenêtres de 5 ms où l'énergie à `freq` franchit le seuil. */
export function beepOnsetsMs(samples: Float32Array, freq: number, threshold = 0.05): number[] {
  const out: number[] = [];
  let on = false;
  const total = (samples.length / 48000) * 1000;
  for (let t = 0; t + 5 <= total; t += 5) {
    const lvl = toneLevelAt(samples, freq, t, 5);
    if (!on && lvl > threshold) {
      out.push(t);
      on = true;
    } else if (on && lvl < threshold / 4) on = false;
  }
  return out;
}

/** Valeur absolue maximale des échantillons d'une fenêtre (silence numérique ⇒ 0). */
export function peakAt(
  samples: Float32Array,
  startMs: number,
  durMs: number,
  rate = 48000,
): number {
  const a = Math.max(0, Math.round((startMs * rate) / 1000));
  const b = Math.min(samples.length, Math.round(((startMs + durMs) * rate) / 1000));
  let m = 0;
  for (let i = a; i < b; i++) m = Math.max(m, Math.abs(samples[i]!));
  return m;
}
