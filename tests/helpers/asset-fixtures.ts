/**
 * Fichiers de la bibliothèque de médias pour les tests (étape 7, PR 7f) : images et sons
 * synthétiques produits par FFmpeg (lavfi), et fichiers PIÉGÉS construits octet par octet.
 * Aucun vrai média n'est versionné.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { FFMPEG } from './media-fixtures';

function ff(args: string[]) {
  execFileSync(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/** Image unie (couleur FFmpeg, ex. `0xFF00FF`) au format déduit de l'extension. */
export function solidImage(dir: string, name: string, color: string, w = 64, h = 32): string {
  const out = path.join(dir, name);
  const ext = path.extname(name);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${w}x${h}:d=1`,
    '-frames:v',
    '1',
    ...(ext === '.gif' ? [] : ext === '.png' ? ['-pix_fmt', 'rgba'] : []),
    ...(ext === '.webp' ? ['-c:v', 'libwebp'] : []),
    '-update',
    '1',
    out,
  ]);
  return out;
}

/** PNG RGBA : moitié gauche opaque (couleur), moitié droite TRANSPARENTE. */
export function halfTransparentPng(dir: string, name: string, color: string, w = 64, h = 32) {
  const out = path.join(dir, name);
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${w}x${h}:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),255,0)'`,
    '-frames:v',
    '1',
    '-update',
    '1',
    out,
  ]);
  return out;
}

/** GIF animé (plusieurs images). */
export function animatedGif(dir: string, name = 'anim.gif') {
  const out = path.join(dir, name);
  ff(['-f', 'lavfi', '-i', 'testsrc=s=32x32:r=5:d=1', out]);
  return out;
}

/** Son : bip sinusoïdal (fréquence, durée en s), format déduit de l'extension. */
export function tone(dir: string, name: string, freq = 1000, seconds = 0.5) {
  const out = path.join(dir, name);
  ff(['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${seconds}`, out]);
  return out;
}

/** Petite vidéo (image + son) : un « son » qui contient de la vidéo doit être refusé. */
export function tinyVideo(dir: string, name = 'video.m4a') {
  const out = path.join(dir, name);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=32x32:r=5:d=0.4',
    '-f',
    'lavfi',
    '-i',
    'sine=d=0.4',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-f',
    'mp4',
    out,
  ]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Fichiers piégés                                                     */
/* ------------------------------------------------------------------ */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG dont l'en-tête annonce des dimensions énormes (« bombe » de décompression). */
export function hugePngHeader(dir: string, name = 'huge.png', w = 100_000, h = 100_000) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const out = path.join(dir, name);
  // Une seule ligne compressée : le fichier est petit, l'image décodée serait gigantesque.
  writeFileSync(
    out,
    Buffer.concat([
      PNG_SIG,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(1 + 4 * 8))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
  return out;
}

/** APNG : un PNG valide auquel on insère un morceau d'animation `acTL`. */
export function apng(dir: string, base: string, name = 'anim.png') {
  const b = readFileSync(base);
  const ihdrEnd = 8 + 12 + 13;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const out = path.join(dir, name);
  writeFileSync(
    out,
    Buffer.concat([b.subarray(0, ihdrEnd), chunk('acTL', actl), b.subarray(ihdrEnd)]),
  );
  return out;
}

/** Polyglotte : image valide suivie d'une archive ZIP / d'un document HTML. */
export function polyglot(dir: string, base: string, name: string) {
  const out = path.join(dir, name);
  writeFileSync(
    out,
    Buffer.concat([
      readFileSync(base),
      Buffer.from('PK\x03\x04<html><script>alert(1)</script></html>PK\x05\x06', 'latin1'),
    ]),
  );
  return out;
}

/** Fichier tronqué (moitié des octets). */
export function truncated(dir: string, base: string, name: string) {
  const b = readFileSync(base);
  const out = path.join(dir, name);
  writeFileSync(out, b.subarray(0, Math.floor(b.length / 2)));
  return out;
}

/** Fichier texte quelconque (SVG, liste de lecture, liste ffconcat…). */
export function textFile(dir: string, name: string, content: string) {
  const out = path.join(dir, name);
  writeFileSync(out, content);
  return out;
}
