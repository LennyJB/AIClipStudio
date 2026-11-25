/**
 * Intégrité réelle d'une fenêtre source (docs/plan-etape-6.md §6.5).
 *
 * Un « manifeste » liste un ENSEMBLE D'OCTETS EXACT du fichier original et son SHA-256 :
 *  1. structure du conteneur : Matroska = en-tête EBML, en-tête du segment, tous les éléments de
 *     premier niveau autres que les clusters (SeekHead, Info, Tracks, Cues, Tags…) et l'en-tête de
 *     CHAQUE cluster ; MP4 = toutes les boîtes de premier niveau sauf le contenu de `mdat` ;
 *  2. données de la fenêtre : paquets (toutes pistes) depuis l'image clé précédant le début
 *     (moins 1 s) jusqu'à la fin (plus 1 s), alignés sur les clusters entiers en Matroska (le temps
 *     de référence d'un cluster est dans son en-tête) ;
 *  3. zone de détection initiale lue par FFmpeg à l'ouverture (`-probesize` imposé au rendu).
 * Repli « full_file » (SHA-256 du fichier entier) si la structure n'est pas analysable.
 *
 * La VÉRIFICATION n'utilise pas FFmpeg : taille identique puis relecture des plages. Que cet
 * ensemble suffise à déterminer le rendu est une propriété de FFmpeg, prouvée par test (tous les
 * autres octets mis à zéro ⇒ décodage identique) et rejouable par `doctor`.
 * La date de modification n'est jamais utilisée comme preuve.
 */
import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { AppError } from '@acs/shared';
import { z } from 'zod';
import { isSpawnNotFound, runProcess } from './process';

export const INTEGRITY_ALGO_VERSION = 1;
export const DEFAULT_PROBE_BYTES = 5_000_000;
/** Marge autour de la fenêtre, en plus de l'image clé précédente. */
export const INTEGRITY_MARGIN_MS = 1_000;

export type RangeRole = 'structure' | 'cluster_header' | 'probe' | 'window' | 'full';
/** [début, fin exclusive, rôle] */
export type ByteRange = [number, number, RangeRole];

export interface IntegrityManifest {
  method: 'byte_ranges' | 'full_file';
  container: string;
  fileSize: number;
  windowStartMs: number;
  windowEndMs: number;
  probeBytes: number;
  ranges: ByteRange[];
  protectedBytes: number;
  sha256: string;
  algoVersion: number;
}

export class UnsupportedStructure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedStructure';
  }
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

export type ReadAt = (pos: number, len: number) => Promise<Buffer>;

function readerFor(fh: FileHandle): ReadAt {
  return async (pos, len) => {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  };
}

/* ------------------------------------------------------------------ */
/* Matroska (EBML), premier niveau                                     */
/* ------------------------------------------------------------------ */

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const CLUSTER_ID = 0x1f43b675;

interface Vint {
  length: number;
  value: number;
  /** Tous les bits de valeur à 1 : taille inconnue. */
  unknown: boolean;
}

function readVint(buf: Buffer, off: number, keepMarker: boolean): Vint {
  const first = buf[off];
  if (first === undefined || first === 0) throw new UnsupportedStructure('nombre EBML invalide');
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || off + length > buf.length)
    throw new UnsupportedStructure('nombre EBML tronqué');
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = buf[off + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { length, value, unknown: !keepMarker && allOnes };
}

async function readElementHeader(read: ReadAt, pos: number) {
  const buf = await read(pos, 12);
  const id = readVint(buf, 0, true);
  const size = readVint(buf, id.length, false);
  return {
    id: id.value,
    headerLen: id.length + size.length,
    size: size.value,
    unknown: size.unknown,
  };
}

export interface ContainerLayout {
  container: 'matroska' | 'mp4';
  /** Plages de structure (en-têtes inclus). */
  structure: [number, number][];
  /** Matroska : clusters [début de l'élément, fin] ; MP4 : vide. */
  clusters: [number, number][];
  /** MP4 : début des données de `mdat` (zone de détection). */
  mediaDataStart: number | null;
}

export async function scanMatroska(read: ReadAt, size: number): Promise<ContainerLayout> {
  const ebml = await readElementHeader(read, 0);
  if (ebml.id !== EBML_ID || ebml.unknown) throw new UnsupportedStructure('en-tête EBML absent');
  const segPos = ebml.headerLen + ebml.size;
  const seg = await readElementHeader(read, segPos);
  if (seg.id !== SEGMENT_ID) throw new UnsupportedStructure('segment Matroska absent');
  const dataStart = segPos + seg.headerLen;
  const segEnd = seg.unknown ? size : Math.min(size, dataStart + seg.size);
  const structure: [number, number][] = [[0, dataStart]];
  const clusters: [number, number][] = [];
  let pos = dataStart;
  while (pos < segEnd) {
    const el = await readElementHeader(read, pos);
    if (el.unknown)
      throw new UnsupportedStructure('élément de taille inconnue (enregistrement interrompu ?)');
    const end = pos + el.headerLen + el.size;
    if (end > size) throw new UnsupportedStructure('élément tronqué');
    if (el.id === CLUSTER_ID) {
      clusters.push([pos, end]);
      structure.push([pos, pos + el.headerLen]);
    } else {
      structure.push([pos, end]);
    }
    pos = end;
  }
  // Tout ce qui suit le segment (rare) est protégé comme structure.
  if (segEnd < size) structure.push([segEnd, size]);
  return { container: 'matroska', structure, clusters, mediaDataStart: null };
}

/* ------------------------------------------------------------------ */
/* MP4 / MOV, premier niveau                                           */
/* ------------------------------------------------------------------ */

export async function scanMp4(read: ReadAt, size: number): Promise<ContainerLayout> {
  const structure: [number, number][] = [];
  let mediaDataStart: number | null = null;
  let pos = 0;
  while (pos < size) {
    const h = await read(pos, 16);
    if (h.length < 8) throw new UnsupportedStructure('boîte MP4 tronquée');
    let boxSize = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let headerLen = 8;
    if (boxSize === 1) {
      if (h.length < 16) throw new UnsupportedStructure('boîte MP4 tronquée');
      boxSize = Number(h.readBigUInt64BE(8));
      headerLen = 16;
    } else if (boxSize === 0) {
      boxSize = size - pos;
    }
    if (boxSize < headerLen || pos + boxSize > size)
      throw new UnsupportedStructure('boîte MP4 invalide');
    if (!/^[\x20-\x7e]{4}$/u.test(type))
      throw new UnsupportedStructure('type de boîte MP4 invalide');
    if (type === 'mdat') {
      structure.push([pos, pos + headerLen]);
      mediaDataStart ??= pos + headerLen;
    } else {
      structure.push([pos, pos + boxSize]);
    }
    pos += boxSize;
  }
  if (mediaDataStart === null) throw new UnsupportedStructure('aucune boîte mdat');
  return { container: 'mp4', structure, clusters: [], mediaDataStart };
}

export async function scanContainer(read: ReadAt, size: number): Promise<ContainerLayout> {
  const head = await read(0, 12);
  if (head.length >= 4 && head.readUInt32BE(0) === EBML_ID) return scanMatroska(read, size);
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') return scanMp4(read, size);
  throw new UnsupportedStructure('conteneur non reconnu');
}

/* ------------------------------------------------------------------ */
/* Plages de la fenêtre (pur)                                          */
/* ------------------------------------------------------------------ */

export interface PacketInfo {
  video: boolean;
  keyframe: boolean;
  timeMs: number;
  pos: number;
  size: number;
}

/** Fusionne des plages qui se touchent ou se chevauchent (le rôle le plus « fort » l'emporte). */
export function mergeRanges(ranges: readonly ByteRange[]): ByteRange[] {
  const order: RangeRole[] = ['full', 'window', 'probe', 'structure', 'cluster_header'];
  const sorted = [...ranges].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: ByteRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
      if (order.indexOf(r[2]) < order.indexOf(last[2])) last[2] = r[2];
    } else {
      out.push([r[0], r[1], r[2]]);
    }
  }
  return out;
}

export function windowByteRanges(
  layout: ContainerLayout,
  packets: readonly PacketInfo[],
  windowStartMs: number,
  windowEndMs: number,
  probeBytes: number,
): ByteRange[] {
  const hasVideo = packets.some((p) => p.video);
  const keyframes = packets.filter((p) => p.video && p.keyframe && p.timeMs <= windowStartMs);
  if (hasVideo && !keyframes.length) {
    throw new UnsupportedStructure('aucune image clé avant le début de la fenêtre');
  }
  const kf = hasVideo ? Math.max(...keyframes.map((p) => p.timeMs)) : windowStartMs;
  const lo = kf - INTEGRITY_MARGIN_MS;
  const hi = windowEndMs + INTEGRITY_MARGIN_MS;
  const sel = packets.filter((p) => p.timeMs >= lo && p.timeMs <= hi && p.size > 0);
  if (!sel.length) throw new UnsupportedStructure('aucun paquet dans la fenêtre');
  const spanStart = Math.min(...sel.map((p) => p.pos));
  const spanEnd = Math.max(...sel.map((p) => p.pos + p.size));

  const ranges: ByteRange[] = layout.structure.map(
    ([s, e]) =>
      [
        s,
        e,
        layout.clusters.some(([cs]) => cs === s) ? 'cluster_header' : 'structure',
      ] as ByteRange,
  );
  if (layout.container === 'matroska') {
    for (const [cs, ce] of layout.clusters) {
      if (ce > spanStart && cs < spanEnd) ranges.push([cs, ce, 'window']);
      else if (cs < probeBytes) ranges.push([cs, ce, 'probe']);
    }
    if (!layout.clusters.some(([cs, ce]) => ce > spanStart && cs < spanEnd)) {
      throw new UnsupportedStructure('paquets hors des clusters');
    }
  } else {
    ranges.push([spanStart, spanEnd, 'window']);
    const md = layout.mediaDataStart!;
    ranges.push([md, md + probeBytes, 'probe']);
  }
  return mergeRanges(ranges);
}

/* ------------------------------------------------------------------ */
/* Empreinte                                                           */
/* ------------------------------------------------------------------ */

const CHUNK = 4 * 1024 * 1024;

/** SHA-256 de : taille, liste des plages, puis octets de chaque plage dans l'ordre. */
export async function hashRanges(
  read: ReadAt,
  fileSize: number,
  ranges: readonly ByteRange[],
  signal?: AbortSignal,
): Promise<{ sha256: string; protectedBytes: number }> {
  const h = createHash('sha256');
  h.update(`acs-integrity-v${INTEGRITY_ALGO_VERSION}\nsize=${fileSize}\n`);
  for (const [s, e] of ranges) h.update(`${s}-${e}\n`);
  let total = 0;
  for (const [s, e] of ranges) {
    const end = Math.min(e, fileSize);
    for (let pos = s; pos < end; pos += CHUNK) {
      if (signal?.aborted) throw new AppError('CANCELLED', 'Vérification annulée');
      const buf = await read(pos, Math.min(CHUNK, end - pos));
      h.update(buf);
      total += buf.length;
    }
  }
  return { sha256: h.digest('hex'), protectedBytes: total };
}

/* ------------------------------------------------------------------ */
/* Positions des paquets (ffprobe)                                     */
/* ------------------------------------------------------------------ */

const num = z.union([z.string(), z.number()]).optional();
const ProbePackets = z.object({
  streams: z
    .array(z.object({ index: z.number().int(), codec_type: z.string().optional() }))
    .default([]),
  packets: z
    .array(
      z.object({
        stream_index: z.number().int(),
        pts_time: num,
        dts_time: num,
        size: num,
        pos: num,
        flags: z.string().optional(),
      }),
    )
    .default([]),
});

const toNum = (v: string | number | undefined) => {
  if (v === undefined || v === 'N/A') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function probePackets(
  ffprobePath: string,
  filePath: string,
  fromMs: number,
  toMs: number,
  signal?: AbortSignal,
): Promise<PacketInfo[]> {
  const args = [
    '-v',
    'error',
    '-hide_banner',
    '-print_format',
    'json',
    '-show_entries',
    'stream=index,codec_type:packet=stream_index,pts_time,dts_time,size,pos,flags',
    '-read_intervals',
    `${(Math.max(0, fromMs) / 1000).toFixed(3)}%${(toMs / 1000).toFixed(3)}`,
    filePath,
  ];
  let result;
  try {
    result = await runProcess(ffprobePath, args, signal ? { signal } : {});
  } catch (err) {
    if (isSpawnNotFound(err)) {
      throw new AppError('TOOL_MISSING', `ffprobe introuvable (${ffprobePath})`, { cause: err });
    }
    throw err;
  }
  if (result.aborted) throw new AppError('CANCELLED', 'Analyse annulée');
  if (result.exitCode !== 0) {
    throw new AppError('MEDIA_PROBE_FAILED', 'ffprobe ne peut pas lire les paquets', {
      details: { exitCode: result.exitCode, stderr: result.stderrTail.slice(-2000) },
    });
  }
  const parsed = ProbePackets.safeParse(JSON.parse(result.stdout || '{}'));
  if (!parsed.success) throw new AppError('MEDIA_PROBE_FAILED', 'Sortie ffprobe inattendue');
  const video = new Set(
    parsed.data.streams.filter((s) => s.codec_type === 'video').map((s) => s.index),
  );
  const out: PacketInfo[] = [];
  for (const p of parsed.data.packets) {
    const t = toNum(p.pts_time) ?? toNum(p.dts_time);
    const pos = toNum(p.pos);
    const size = toNum(p.size);
    if (t === null || pos === null || size === null || pos < 0) {
      throw new UnsupportedStructure('positions de paquets indisponibles');
    }
    out.push({
      video: video.has(p.stream_index),
      keyframe: (p.flags ?? '').startsWith('K'),
      timeMs: Math.round(t * 1000),
      pos,
      size,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Construction et vérification                                        */
/* ------------------------------------------------------------------ */

export interface BuildManifestOptions {
  ffprobePath: string;
  filePath: string;
  windowStartMs: number;
  windowEndMs: number;
  probeBytes?: number;
  signal?: AbortSignal;
  /** Tests : forcer la méthode de repli. */
  forceFullFile?: boolean;
}

/** Recul maximal pour trouver une image clé avant la fenêtre (GOP longs). */
const KEYFRAME_LOOKBACK_MS = [2_000, 30_000, 120_000];

export async function buildIntegrityManifest(o: BuildManifestOptions): Promise<IntegrityManifest> {
  if (!(o.windowStartMs < o.windowEndMs))
    throw new AppError('VALIDATION_FAILED', 'Fenêtre invalide');
  const probeBytes = o.probeBytes ?? DEFAULT_PROBE_BYTES;
  const st = await stat(o.filePath);
  const fh = await open(o.filePath, 'r');
  try {
    const read = readerFor(fh);
    let container = 'inconnu';
    let ranges: ByteRange[] | null = null;
    if (!o.forceFullFile) {
      try {
        const layout = await scanContainer(read, st.size);
        container = layout.container;
        for (const back of KEYFRAME_LOOKBACK_MS) {
          const packets = await probePackets(
            o.ffprobePath,
            o.filePath,
            o.windowStartMs - back,
            o.windowEndMs + INTEGRITY_MARGIN_MS + 1_000,
            o.signal,
          );
          try {
            ranges = windowByteRanges(layout, packets, o.windowStartMs, o.windowEndMs, probeBytes);
            break;
          } catch (err) {
            if (!(err instanceof UnsupportedStructure) || !/image clé/u.test(err.message))
              throw err;
            if (o.windowStartMs - back <= 0) throw err;
          }
        }
      } catch (err) {
        if (!(err instanceof UnsupportedStructure)) throw err;
        ranges = null;
      }
    }
    const method: IntegrityManifest['method'] = ranges ? 'byte_ranges' : 'full_file';
    const finalRanges: ByteRange[] = ranges ?? [[0, st.size, 'full']];
    const { sha256, protectedBytes } = await hashRanges(read, st.size, finalRanges, o.signal);
    return {
      method,
      container,
      fileSize: st.size,
      windowStartMs: o.windowStartMs,
      windowEndMs: o.windowEndMs,
      probeBytes,
      ranges: finalRanges,
      protectedBytes,
      sha256,
      algoVersion: INTEGRITY_ALGO_VERSION,
    };
  } finally {
    await fh.close();
  }
}

export type IntegrityCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'size_changed' | 'content_changed' | 'algo_unknown' };

export async function verifyIntegrity(
  filePath: string,
  m: Pick<IntegrityManifest, 'fileSize' | 'ranges' | 'sha256' | 'algoVersion'>,
  signal?: AbortSignal,
): Promise<IntegrityCheck> {
  if (m.algoVersion !== INTEGRITY_ALGO_VERSION) return { ok: false, reason: 'algo_unknown' };
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (size !== m.fileSize) return { ok: false, reason: 'size_changed' };
  const fh = await open(filePath, 'r');
  try {
    const { sha256 } = await hashRanges(readerFor(fh), size, m.ranges, signal);
    return sha256 === m.sha256 ? { ok: true } : { ok: false, reason: 'content_changed' };
  } finally {
    await fh.close();
  }
}
