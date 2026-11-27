/**
 * Fichiers de test de l'étape 8 (rediffusions Twitch, fichiers incomplets, multipiste hors OBS),
 * produits par FFmpeg (lavfi). Aucune vraie vidéo n'est versionnée ; aucune connexion à Twitch.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FFMPEG } from './media-fixtures';

function ff(args: string[]) {
  execFileSync(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

const SECONDS = 8;
const video = (d = SECONDS) => ['-f', 'lavfi', '-i', `testsrc=size=320x180:rate=30:duration=${d}`];
/** Son stéréo 48 kHz (comme une rediffusion Twitch) : `freq` Hz. */
const stereo = (freq: number, d = SECONDS) => [
  '-f',
  'lavfi',
  '-i',
  `sine=f=${freq}:d=${d}:sample_rate=48000,aformat=channel_layouts=stereo`,
];
const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];

export interface TwitchFixtures {
  dir: string;
  /** Rediffusion Twitch téléchargée : MP4 (H.264 + AAC stéréo), UNE piste mixée. */
  twitchMp4: string;
  /** Flux Twitch enregistré tel quel : MPEG-TS, une piste mixée (horodatages non nuls). */
  twitchTs: string;
  /** MP4 à deux pistes audio sans nom (hors OBS). */
  multiMp4: string;
  /** MPEG-TS à deux pistes audio. */
  multiTs: string;
  /** MOV à piste unique. */
  singleMov: string;
  /** Vidéo qui commence 1 s après le son (MKV : MP4 le masquerait par une liste d'édition). */
  videoOffsetMkv: string;
  /** Piste audio de 3 s pour une vidéo de 8 s (fin muette). */
  audioShortMp4: string;
  /** MKV écrit en flux (non « seekable ») : aucune durée dans l'en-tête. */
  noDurationMkv: string;
  /** MKV tronqué à 55 % (téléchargement ou enregistrement interrompu). */
  truncatedMkv: string;
  /** MP4 tronqué (index `moov` absent) : illisible. */
  truncatedMp4: string;
  /** Extension refusée. */
  avi: string;
}

export function createTwitchFixtures(): TwitchFixtures {
  const dir = mkdtempSync(path.join(tmpdir(), 'acs-twitch-'));
  const p = (n: string) => path.join(dir, n);

  ff([
    ...video(),
    ...stereo(440),
    '-map',
    '0:v',
    '-map',
    '1:a',
    ...enc,
    '-movflags',
    '+faststart',
    p('twitch.mp4'),
  ]);
  ff([
    ...video(),
    ...stereo(440),
    '-map',
    '0:v',
    '-map',
    '1:a',
    ...enc,
    '-f',
    'mpegts',
    p('twitch.ts'),
  ]);
  ff([
    ...video(),
    ...stereo(440),
    ...stereo(660),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    ...enc,
    p('multi.mp4'),
  ]);
  ff([
    ...video(),
    ...stereo(440),
    ...stereo(660),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    ...enc,
    '-f',
    'mpegts',
    p('multi.ts'),
  ]);
  ff([...video(), ...stereo(440), '-map', '0:v', '-map', '1:a', ...enc, p('single.mov')]);
  ff([
    '-itsoffset',
    '1',
    ...video(7),
    ...stereo(440),
    '-map',
    '0:v',
    '-map',
    '1:a',
    ...enc,
    p('video-offset.mkv'),
  ]);
  ff([...video(), ...stereo(440, 3), '-map', '0:v', '-map', '1:a', ...enc, p('audio-short.mp4')]);
  const live = execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-nostdin',
      ...video(),
      ...stereo(440),
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
  writeFileSync(p('no-duration.mkv'), live);
  ff([...video(), ...stereo(440), '-map', '0:v', '-map', '1:a', ...enc, p('complete.mkv')]);
  const mkv = readFileSync(p('complete.mkv'));
  writeFileSync(p('truncated.mkv'), mkv.subarray(0, Math.floor(mkv.length * 0.55)));
  ff([...video(), ...stereo(440), '-map', '0:v', '-map', '1:a', ...enc, p('complete.mp4')]);
  const mp4 = readFileSync(p('complete.mp4'));
  // Sans `faststart`, l'index (moov) est à la fin : un téléchargement interrompu le perd.
  writeFileSync(p('truncated.mp4'), mp4.subarray(0, Math.floor(mp4.length * 0.6)));
  writeFileSync(p('stream.avi'), 'RIFF');
  return {
    dir,
    twitchMp4: p('twitch.mp4'),
    twitchTs: p('twitch.ts'),
    multiMp4: p('multi.mp4'),
    multiTs: p('multi.ts'),
    singleMov: p('single.mov'),
    videoOffsetMkv: p('video-offset.mkv'),
    audioShortMp4: p('audio-short.mp4'),
    noDurationMkv: p('no-duration.mkv'),
    truncatedMkv: p('truncated.mkv'),
    truncatedMp4: p('truncated.mp4'),
    avi: p('stream.avi'),
  };
}
