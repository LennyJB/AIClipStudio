/**
 * Bibliothèque de médias (étape 7, PR 7f, docs/plan-etape-7.md §8.2 « 7j ») : validation et
 * normalisation d'une image fixe ou d'un son importé par le créateur.
 *
 * Défense en profondeur, dans cet ordre (chaque étape refuse seule) :
 *  1. taille du fichier bornée ;
 *  2. format reconnu par sa SIGNATURE (octets), jamais par l'extension ; une extension qui
 *     contredit le contenu est refusée (« extension trompeuse ») ; tout format textuel (SVG,
 *     HTML, listes de lecture, scripts) est refusé d'office ;
 *  3. contrôles de structure : données après la fin de l'image (fichiers polyglottes), images
 *     animées (APNG, WebP animé, GIF de plusieurs images), en-têtes incohérents ;
 *  4. ffprobe avec le DÉMULTIPLEXEUR IMPOSÉ par la signature et `-protocol_whitelist file` :
 *     un fichier ne peut jamais faire lire un autre fichier ou une adresse réseau à FFmpeg ;
 *     dimensions, nombre d'images, durée et flux bornés AVANT tout décodage complet ;
 *  5. RÉ-ENCODAGE systématique dans un format normalisé (PNG RGBA, WAV PCM 48 kHz stéréo), sans
 *     métadonnées : seul le fichier normalisé est conservé et servi ; l'import d'origine est
 *     supprimé par l'appelant.
 *
 * Aucune commande n'est construite à partir du contenu du fichier : arguments en tableau, sans
 * shell (`runProcess`).
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '@acs/shared';
import { isSpawnNotFound, runProcess } from './process';
import { readWavInfo } from './wav';

/** Version du normaliseur (incrémentée si la normalisation change). */
export const ASSET_NORMALIZER_VERSION = 1;

export type AssetKind = 'image' | 'audio';
export type AssetSourceFormat =
  'png' | 'jpeg' | 'webp' | 'gif' | 'wav' | 'mp3' | 'ogg' | 'flac' | 'm4a';

export const ASSET_FORMAT_KIND: Record<AssetSourceFormat, AssetKind> = {
  png: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  wav: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  flac: 'audio',
  m4a: 'audio',
};

/** Démultiplexeur FFmpeg IMPOSÉ pour chaque format reconnu (jamais de détection automatique). */
const DEMUXER: Record<AssetSourceFormat, string> = {
  png: 'png_pipe',
  jpeg: 'jpeg_pipe',
  webp: 'webp_pipe',
  gif: 'gif',
  wav: 'wav',
  mp3: 'mp3',
  ogg: 'ogg',
  flac: 'flac',
  m4a: 'mov',
};

/** Extensions acceptées, par format. Une extension absente du tableau est refusée. */
const EXTENSIONS: Record<string, AssetSourceFormat[]> = {
  '.png': ['png'],
  '.jpg': ['jpeg'],
  '.jpeg': ['jpeg'],
  '.webp': ['webp'],
  '.gif': ['gif'],
  '.wav': ['wav'],
  '.wave': ['wav'],
  '.mp3': ['mp3'],
  '.ogg': ['ogg'],
  '.oga': ['ogg'],
  '.opus': ['ogg'],
  '.flac': ['flac'],
  '.m4a': ['m4a'],
  '.aac': ['m4a'],
};

export interface AssetLimits {
  maxBytes: number;
  maxImageSide: number;
  maxImagePixels: number;
  maxAudioMs: number;
}

export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxImageSide: 4096,
  maxImagePixels: 4096 * 4096,
  maxAudioMs: 60_000,
};

/** Côté le plus long de l'aperçu d'une image (vignette de la bibliothèque). */
export const ASSET_PREVIEW_SIDE = 256;
/** Nombre de pics de la forme d'onde d'un son (aperçu de la bibliothèque). */
export const ASSET_PEAKS = 120;

export const reject = (reason: string, message: string) =>
  new AppError('ASSET_REJECTED', message, { details: { reason } });

/* ------------------------------------------------------------------ */
/* 2. Signature                                                        */
/* ------------------------------------------------------------------ */

const ascii = (b: Buffer, s: number, e: number) => b.toString('latin1', s, e);

/** Format reconnu par les premiers octets, ou null (tout le reste est refusé). */
export function sniffAssetFormat(head: Buffer): AssetSourceFormat | null {
  if (head.length < 12) return null;
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return 'wav';
  if (ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (ascii(head, 0, 4) === 'fLaC') return 'flac';
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    return ['M4A ', 'M4B ', 'mp42', 'isom', 'iso2', 'dash'].includes(brand) ? 'm4a' : null;
  }
  if (ascii(head, 0, 3) === 'ID3') return 'mp3';
  // Trame MPEG audio couche III : synchronisation sur 11 bits, couche = 01.
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x06) === 0x02) return 'mp3';
  return null;
}

/** Extension du nom déclaré, cohérente avec le contenu (sinon : extension trompeuse). */
export function checkExtension(fileName: string, format: AssetSourceFormat) {
  const ext = path.extname(fileName).toLowerCase();
  const allowed = EXTENSIONS[ext];
  if (!allowed) {
    throw reject(
      'extension',
      `Extension refusée (${ext || 'aucune'}) : images PNG, JPEG, WebP, GIF fixe ou sons WAV, MP3, OGG, FLAC, M4A uniquement`,
    );
  }
  if (!allowed.includes(format)) {
    throw reject(
      'extension_mismatch',
      `Extension trompeuse : le contenu est un fichier ${format.toUpperCase()}, pas ${ext}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 3. Structure                                                        */
/* ------------------------------------------------------------------ */

export interface StructureInfo {
  width: number | null;
  height: number | null;
}

/** PNG : morceaux bien formés, aucune animation (`acTL`), rien après `IEND`. */
function checkPng(b: Buffer): StructureInfo {
  let off = 8;
  let width: number | null = null;
  let height: number | null = null;
  let first = true;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = ascii(b, off + 4, off + 8);
    const end = off + 12 + len;
    if (end > b.length) throw reject('corrupt', 'Image PNG tronquée');
    if (first) {
      if (type !== 'IHDR' || len !== 13) throw reject('corrupt', 'En-tête PNG invalide');
      width = b.readUInt32BE(off + 8);
      height = b.readUInt32BE(off + 12);
      first = false;
    }
    if (type === 'acTL' || type === 'fcTL')
      throw reject('animated', 'Image PNG animée (APNG) refusée : images fixes uniquement');
    if (type === 'IEND') {
      if (end !== b.length)
        throw reject(
          'trailing_data',
          'Données après la fin de l’image PNG (fichier polyglotte) : refusé',
        );
      return { width, height };
    }
    off = end;
  }
  throw reject('corrupt', 'Image PNG incomplète (fin absente)');
}

/** JPEG : rien après le dernier marqueur de fin d'image (EOI). */
function checkJpeg(b: Buffer): StructureInfo {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) {
    throw reject(
      'trailing_data',
      'Image JPEG incomplète ou données après sa fin (fichier polyglotte) : refusé',
    );
  }
  return { width: null, height: null };
}

/** RIFF (WebP, WAV) : taille annoncée cohérente (rien après) ; WebP : aucune animation. */
function checkRiff(b: Buffer, webp: boolean): StructureInfo {
  const declared = b.readUInt32LE(4) + 8;
  if (declared + (declared % 2) < b.length) {
    throw reject('trailing_data', 'Données après la fin du fichier (fichier polyglotte) : refusé');
  }
  if (declared > b.length) throw reject('corrupt', 'Fichier tronqué');
  if (webp) {
    let off = 12;
    while (off + 8 <= b.length) {
      const id = ascii(b, off, off + 4);
      const len = b.readUInt32LE(off + 4);
      if (id === 'ANIM' || id === 'ANMF')
        throw reject('animated', 'Image WebP animée refusée : images fixes uniquement');
      if (id === 'VP8X' && len >= 1 && (b[off + 8]! & 0x02) !== 0) {
        throw reject('animated', 'Image WebP animée refusée : images fixes uniquement');
      }
      off += 8 + len + (len % 2);
    }
  }
  return { width: null, height: null };
}

/** GIF : se termine par le marqueur de fin (0x3B) ; le nombre d'images est vérifié par ffprobe. */
function checkGif(b: Buffer): StructureInfo {
  if (b[b.length - 1] !== 0x3b) {
    throw reject(
      'trailing_data',
      'Image GIF incomplète ou données après sa fin (fichier polyglotte) : refusé',
    );
  }
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

export function checkAssetStructure(b: Buffer, format: AssetSourceFormat): StructureInfo {
  switch (format) {
    case 'png':
      return checkPng(b);
    case 'jpeg':
      return checkJpeg(b);
    case 'gif':
      return checkGif(b);
    case 'webp':
      return checkRiff(b, true);
    case 'wav':
      return checkRiff(b, false);
    default:
      return { width: null, height: null };
  }
}

/** Dimensions acceptables (avant tout décodage : protection contre les « bombes » d'images). */
export function checkImageSize(w: number | null, h: number | null, limits: AssetLimits) {
  if (!w || !h || w < 1 || h < 1) throw reject('corrupt', 'Dimensions d’image illisibles');
  if (w > limits.maxImageSide || h > limits.maxImageSide || w * h > limits.maxImagePixels) {
    throw reject(
      'too_large',
      `Image trop grande (${w}×${h}) : ${limits.maxImageSide} px par côté au plus`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 4. ffprobe (démultiplexeur imposé)                                  */
/* ------------------------------------------------------------------ */

const ProbeSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        duration: z.string().optional(),
        nb_read_packets: z.string().optional(),
        disposition: z.record(z.string(), z.number()).optional(),
      }),
    )
    .default([]),
  format: z.object({ duration: z.string().optional() }).optional(),
});

/** Arguments communs : aucune lecture réseau ni d'un autre fichier, démultiplexeur imposé. */
const inputArgs = (format: AssetSourceFormat, file: string) => [
  '-protocol_whitelist',
  'file',
  '-f',
  DEMUXER[format],
  '-i',
  file,
];

async function run(tool: string, args: string[], signal?: AbortSignal) {
  try {
    const r = await runProcess(tool, args, signal ? { signal } : {});
    if (r.aborted) throw new AppError('CANCELLED', 'Import annulé');
    return r;
  } catch (err) {
    if (isSpawnNotFound(err))
      throw new AppError('TOOL_MISSING', `${tool} introuvable`, { cause: err });
    throw err;
  }
}

export interface ProbedAsset {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  packets: number | null;
}

export async function probeAsset(
  ffprobe: string,
  file: string,
  format: AssetSourceFormat,
  signal?: AbortSignal,
): Promise<ProbedAsset> {
  const kind = ASSET_FORMAT_KIND[format];
  const args = [
    '-v',
    'error',
    '-hide_banner',
    '-protocol_whitelist',
    'file',
    '-f',
    DEMUXER[format],
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    ...(kind === 'image' ? ['-count_packets'] : []),
    file,
  ];
  const r = await run(ffprobe, args, signal);
  if (r.exitCode !== 0) throw reject('corrupt', 'Fichier illisible ou corrompu');
  let parsed;
  try {
    parsed = ProbeSchema.parse(JSON.parse(r.stdout));
  } catch {
    throw reject('corrupt', 'Fichier illisible ou corrompu');
  }
  const video = parsed.streams.filter(
    (s) => s.codec_type === 'video' && !(s.disposition?.['attached_pic'] === 1),
  );
  const audio = parsed.streams.filter((s) => s.codec_type === 'audio');
  const others = parsed.streams.filter(
    (s) => s.codec_type !== 'video' && s.codec_type !== 'audio' && s.codec_type !== 'data',
  );
  if (kind === 'image') {
    if (video.length !== 1 || audio.length || others.length) {
      throw reject('streams', 'Une image doit contenir une seule image, sans son');
    }
    const v = video[0]!;
    const packets = v.nb_read_packets ? Number(v.nb_read_packets) : null;
    if (packets !== null && packets > 1) {
      throw reject(
        'animated',
        'Image animée refusée : images fixes uniquement (GIF animés plus tard)',
      );
    }
    return { width: v.width ?? null, height: v.height ?? null, durationMs: null, packets };
  }
  if (audio.length < 1 || video.length || others.length) {
    throw reject('streams', 'Un son doit contenir au moins une piste audio, sans vidéo');
  }
  const dur = Number(parsed.format?.duration ?? audio[0]!.duration ?? NaN);
  return {
    width: null,
    height: null,
    durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null,
    packets: null,
  };
}

/* ------------------------------------------------------------------ */
/* 5. Normalisation                                                    */
/* ------------------------------------------------------------------ */

export interface NormalizedAsset {
  kind: AssetKind;
  sourceFormat: AssetSourceFormat;
  /** Fichier normalisé (PNG RGBA ou WAV PCM 48 kHz stéréo), dans `workDir`. */
  file: string;
  format: 'png' | 'wav';
  fileSha256: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Aperçu d'une image (PNG, côté ≤ 256 px), dans `workDir`. */
  preview: string | null;
  /** Forme d'onde d'un son (pics 0..1). */
  peaks: number[] | null;
}

export interface ImportAssetOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Fichier importé (déjà copié par l'appelant dans un dossier temporaire). */
  input: string;
  /** Nom déclaré par le créateur : sert UNIQUEMENT au contrôle de l'extension et à l'affichage. */
  declaredName: string;
  /** Dossier de travail (sortie normalisée et aperçu). */
  workDir: string;
  limits?: AssetLimits;
  signal?: AbortSignal;
}

export async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/** Dimensions de l'aperçu (côté le plus long ≤ 256 px, jamais agrandi, dimensions ≥ 1). */
export function previewSize(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, ASSET_PREVIEW_SIDE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Pics (0..1) d'un WAV PCM 16 bits, sur `count` fenêtres de même durée. */
export async function wavPeaks(file: string, count = ASSET_PEAKS): Promise<number[]> {
  const info = await readWavInfo(file);
  if (info.bitsPerSample !== 16) throw reject('corrupt', 'Son normalisé inattendu');
  const fh = await open(file, 'r');
  try {
    const data = Buffer.alloc(info.dataBytes);
    await fh.read(data, 0, data.length, info.dataOffset);
    const frames = Math.floor(data.length / (2 * info.channels));
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = Math.floor((i * frames) / count);
      const b = Math.max(a + 1, Math.floor(((i + 1) * frames) / count));
      let peak = 0;
      for (let f = a; f < Math.min(b, frames); f++) {
        for (let c = 0; c < info.channels; c++) {
          peak = Math.max(peak, Math.abs(data.readInt16LE((f * info.channels + c) * 2)));
        }
      }
      out.push(Math.round((peak / 32768) * 1000) / 1000);
    }
    return out;
  } finally {
    await fh.close();
  }
}

const fail = (r: { exitCode: number | null }, what: string) => {
  if (r.exitCode !== 0) throw reject('corrupt', `${what} : fichier illisible ou corrompu`);
};

/**
 * Valide puis normalise un média importé. Toute anomalie est un REFUS explicite
 * (`ASSET_REJECTED`, raison dans `details.reason`) ; rien n'est accepté « par défaut ».
 */
export async function importAsset(o: ImportAssetOptions): Promise<NormalizedAsset> {
  const limits = o.limits ?? DEFAULT_ASSET_LIMITS;
  const st = await stat(o.input);
  if (st.size === 0) throw reject('empty', 'Fichier vide');
  if (st.size > limits.maxBytes) {
    throw reject(
      'too_large',
      `Fichier trop volumineux (${Math.ceil(st.size / 1024 / 1024)} Mo, ${Math.floor(limits.maxBytes / 1024 / 1024)} Mo au plus)`,
    );
  }
  const bytes = await readFile(o.input);
  const format = sniffAssetFormat(bytes.subarray(0, 64));
  if (!format) {
    throw reject(
      'format',
      'Format non reconnu ou refusé (SVG, HTML, scripts et listes de lecture sont toujours refusés)',
    );
  }
  checkExtension(o.declaredName, format);
  const kind = ASSET_FORMAT_KIND[format];
  const structure = checkAssetStructure(bytes, format);
  if (kind === 'image' && structure.width !== null) {
    checkImageSize(structure.width, structure.height, limits);
  }
  const probed = await probeAsset(o.ffprobe, o.input, format, o.signal);
  if (kind === 'image') checkImageSize(probed.width, probed.height, limits);
  if (kind === 'audio') {
    if (probed.durationMs === null || probed.durationMs <= 0) {
      throw reject('corrupt', 'Durée du son illisible');
    }
    if (probed.durationMs > limits.maxAudioMs) {
      throw reject(
        'too_long',
        `Son trop long (${(probed.durationMs / 1000).toFixed(1)} s, ${limits.maxAudioMs / 1000} s au plus) : effets sonores courts uniquement`,
      );
    }
  }

  await mkdir(o.workDir, { recursive: true });
  const base = path.join(o.workDir, 'normalized');
  const common = ['-nostdin', '-v', 'error', '-hide_banner', '-y'];
  let file: string;
  let preview: string | null = null;
  let peaks: number[] | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  if (kind === 'image') {
    file = `${base}.png`;
    fail(
      await run(
        o.ffmpeg,
        [
          ...common,
          ...inputArgs(format, o.input),
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          'format=rgba',
          '-map_metadata',
          '-1',
          '-c:v',
          'png',
          '-f',
          'image2',
          '-update',
          '1',
          file,
        ],
        o.signal,
      ),
      'Image',
    );
    // Le fichier normalisé est revérifié comme une nouvelle importation (format imposé : PNG).
    const out = await readFile(file);
    const s = checkPng(out);
    checkImageSize(s.width, s.height, limits);
    width = s.width;
    height = s.height;
    const p = previewSize(width!, height!);
    preview = path.join(o.workDir, 'preview.png');
    fail(
      await run(
        o.ffmpeg,
        [
          ...common,
          ...inputArgs('png', file),
          '-vf',
          `scale=${p.w}:${p.h}:flags=lanczos,format=rgba`,
          '-map_metadata',
          '-1',
          '-c:v',
          'png',
          '-f',
          'image2',
          '-update',
          '1',
          preview,
        ],
        o.signal,
      ),
      'Aperçu',
    );
  } else {
    file = `${base}.wav`;
    fail(
      await run(
        o.ffmpeg,
        [
          ...common,
          ...inputArgs(format, o.input),
          '-map',
          '0:a:0',
          '-vn',
          '-sn',
          '-dn',
          '-map_metadata',
          '-1',
          '-ac',
          '2',
          '-ar',
          '48000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          file,
        ],
        o.signal,
      ),
      'Son',
    );
    const info = await readWavInfo(file);
    if (info.sampleRate !== 48_000 || info.channels !== 2 || info.durationSec <= 0) {
      throw reject('corrupt', 'Son normalisé invalide');
    }
    durationMs = Math.round(info.durationSec * 1000);
    if (durationMs > limits.maxAudioMs + 50) throw reject('too_long', 'Son trop long');
    peaks = await wavPeaks(file);
  }
  const outStat = await stat(file);
  return {
    kind,
    sourceFormat: format,
    file,
    format: kind === 'image' ? 'png' : 'wav',
    fileSha256: await sha256File(file),
    sizeBytes: outStat.size,
    width,
    height,
    durationMs,
    preview,
    peaks,
  };
}

/** Supprime un dossier de travail (sans erreur s'il n'existe plus). */
export async function removeWorkDir(dir: string) {
  await rm(dir, { recursive: true, force: true });
}
