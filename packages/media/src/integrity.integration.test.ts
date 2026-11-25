/**
 * Intégrité d'une fenêtre source (docs/plan-etape-6.md §6.5), sur des fichiers générés par
 * FFmpeg qui imitent des enregistrements OBS (H.264, plusieurs pistes AAC titrées).
 *
 *  - PREUVE DE SUFFISANCE : tous les octets hors de l'ensemble protégé mis à zéro ⇒ le décodage
 *    de la fenêtre (framemd5, toutes pistes) est identique à celui de l'original ;
 *  - NÉCESSITÉ : sans les clusters entiers ou sans la zone de détection, ce n'est plus vrai ;
 *  - DÉTECTION : un octet modifié dans l'ensemble est détecté, taille et date restaurées ;
 *  - REPLI : structure non analysable ⇒ empreinte du fichier entier.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FFMPEG, FFPROBE, ffmpegAvailable } from '../../../tests/helpers/media-fixtures';
import {
  buildIntegrityManifest,
  mergeRanges,
  verifyIntegrity,
  type ByteRange,
  type IntegrityManifest,
} from './integrity';

const enabled = ffmpegAvailable();
const PROBE = 150_000;

/** MKV de type OBS : vidéo 60 i/s, GOP donné, pistes « Micro » et « Discord ». */
function obsLike(
  dir: string,
  name: string,
  gopSeconds: number,
  container: 'mkv' | 'mp4' = 'mkv',
  faststart = false,
) {
  const out = path.join(dir, name);
  execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=60',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:sample_rate=48000',
      '-f',
      'lavfi',
      '-i',
      'sine=f=880:sample_rate=48000',
      '-t',
      '30',
      '-map',
      '0',
      '-map',
      '1',
      '-map',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      String(gopSeconds * 60),
      '-bf',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-metadata:s:a:0',
      'title=Micro',
      '-metadata:s:a:1',
      'title=Discord',
      ...(faststart ? ['-movflags', '+faststart'] : []),
      out,
    ],
    { stdio: 'ignore' },
  );
  void container;
  return out;
}

/** Décodage de [start, end] (toutes pistes) avec les options imposées au rendu. */
function decode(file: string, startMs: number, endMs: number): string {
  return execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-probesize',
      String(PROBE),
      '-ss',
      (startMs / 1000).toFixed(3),
      '-i',
      file,
      '-t',
      ((endMs - startMs) / 1000).toFixed(3),
      '-map',
      '0',
      '-f',
      'framemd5',
      '-',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .join('\n');
}

/** Copie où seuls les octets de `keep` sont conservés (le reste à zéro). */
function zeroOutside(src: string, dst: string, keep: readonly ByteRange[]) {
  const data = readFileSync(src);
  const out = Buffer.alloc(data.length);
  for (const [s, e] of keep) data.copy(out, s, s, e);
  writeFileSync(dst, out);
}

/** Modifie un octet en conservant taille et date de modification. */
function flipByte(src: string, dst: string, pos: number) {
  copyFileSync(src, dst);
  const data = readFileSync(dst);
  data[pos] = data[pos]! ^ 0x55;
  writeFileSync(dst, data);
  const st = statSync(src);
  utimesSync(dst, st.atime, st.mtime);
}

const manifest = (
  file: string,
  a: number,
  b: number,
  extra: Partial<Parameters<typeof buildIntegrityManifest>[0]> = {},
) =>
  buildIntegrityManifest({
    ffprobePath: FFPROBE,
    filePath: file,
    windowStartMs: a,
    windowEndMs: b,
    probeBytes: PROBE,
    ...extra,
  });

function packetPos(file: string, atMs: number, video = true): number {
  const out = execFileSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      video ? 'v:0' : 'a:0',
      '-show_entries',
      'packet=pts_time,pos',
      '-of',
      'csv=p=0',
      '-read_intervals',
      `${atMs / 1000}%+3`,
      file,
    ],
    { encoding: 'utf8' },
  );
  for (const line of out.trim().split('\n')) {
    const [t, pos] = line.split(',');
    if (Number(t) * 1000 >= atMs) return Number(pos);
  }
  throw new Error('paquet introuvable');
}

const inRanges = (ranges: readonly ByteRange[], pos: number) =>
  ranges.some(([s, e]) => pos >= s && pos < e);

describe('fusion des plages', () => {
  it('fusionne les plages contiguës et garde le rôle le plus fort', () => {
    expect(
      mergeRanges([
        [10, 20, 'cluster_header'],
        [0, 5, 'structure'],
        [15, 40, 'window'],
        [40, 50, 'probe'],
        [60, 60, 'structure'],
      ]),
    ).toEqual([
      [0, 5, 'structure'],
      [10, 50, 'window'],
    ]);
  });
});

describe.skipIf(!enabled)('manifeste d’intégrité (FFmpeg réel)', () => {
  let dir: string;
  let gop2: string;
  let gop10: string;
  let mp4: string;
  let mp4Fast: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acs-integrity-'));
    gop2 = obsLike(dir, 'gop2.mkv', 2);
    gop10 = obsLike(dir, 'gop10.mkv', 10);
    mp4 = obsLike(dir, 'secours.mp4', 2, 'mp4');
    mp4Fast = obsLike(dir, 'faststart.mp4', 2, 'mp4', true);
  }, 120_000);

  for (const [label, file, a, b] of [
    ['MKV, GOP 2 s', () => gop2, 8_300, 20_000],
    ['MKV, GOP 10 s', () => gop10, 12_300, 24_000],
    ['MP4 (index en fin)', () => mp4, 8_300, 20_000],
    ['MP4 (index au début)', () => mp4Fast, 8_300, 20_000],
  ] as const) {
    it(`${label} : tout le reste mis à zéro, le décodage de la fenêtre est identique`, async () => {
      const m = await manifest(file(), a, b);
      expect(m.method).toBe('byte_ranges');
      expect(m.protectedBytes).toBeLessThan(m.fileSize);
      const z = path.join(dir, `zero-${path.basename(file())}`);
      zeroOutside(file(), z, m.ranges);
      // Aux deux extrémités de la fenêtre et au milieu (copie démarrant à l'image clé précédente).
      for (const [s, e] of [
        [a, a + 3_000],
        [b - 3_000, b],
        [a + 2_000, b - 2_000],
      ] as const) {
        expect(decode(z, s, e), `${s}–${e}`).toBe(decode(file(), s, e));
      }
      expect(await verifyIntegrity(file(), m)).toEqual({ ok: true });
    }, 60_000);
  }

  it('nécessité : sans horodatage de cluster ou sans zone de détection, le décodage diffère ou échoue', async () => {
    const m = await manifest(gop10, 12_300, 24_000);
    const same = (f: string) => {
      try {
        return decode(f, 12_300, 15_300) === decode(gop10, 12_300, 15_300);
      } catch {
        return false;
      }
    };
    // 1. Clusters non entiers : on retire l'élément Timestamp (juste après l'en-tête) de chaque
    //    cluster de la fenêtre.
    const data = readFileSync(gop10);
    const headers: number[] = [];
    let pos = 0;
    for (;;) {
      const c = data.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]), pos);
      if (c < 0) break;
      headers.push(c);
      pos = c + 4;
    }
    const keep: ByteRange[] = [...m.ranges];
    const holes = headers.filter((c) =>
      m.ranges.some(([s, e, r]) => r === 'window' && c >= s && c < e),
    );
    expect(holes.length).toBeGreaterThan(0);
    const z1 = path.join(dir, 'sans-horodatage.mkv');
    zeroOutside(gop10, z1, keep);
    const buf = readFileSync(z1);
    for (const c of holes) {
      const first = buf[c + 4]!;
      let len = 1;
      for (let mask = 0x80; !(first & mask); mask >>= 1) len++;
      buf.fill(0, c + 4 + len, c + 4 + len + 4); // élément Timestamp du cluster
    }
    writeFileSync(z1, buf);
    expect(same(z1)).toBe(false);
    // 2. Sans la zone de détection initiale.
    const z2 = path.join(dir, 'sans-detection.mkv');
    zeroOutside(
      gop10,
      z2,
      m.ranges.filter(([, , r]) => r !== 'probe'),
    );
    expect(m.ranges.some(([, , r]) => r === 'probe')).toBe(true);
    expect(same(z2)).toBe(false);
  }, 60_000);

  it('détection : données, en-tête de bloc, titre de piste, index, troncature (taille et date restaurées)', async () => {
    const m: IntegrityManifest = await manifest(gop2, 8_300, 20_000);
    const data = readFileSync(gop2);
    const titlePos = data.indexOf('Discord');
    const cuesPos = data.lastIndexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
    const pkt = packetPos(gop2, 12_000);
    const cases: [string, number][] = [
      ['données d’une image', pkt + 50],
      ['en-tête de bloc (horodatage)', pkt - 2],
      ['titre de la piste Discord', titlePos],
      ['index (Cues)', cuesPos + 8],
    ];
    for (const [label, pos] of cases) {
      expect(pos, label).toBeGreaterThan(0);
      expect(inRanges(m.ranges, pos), label).toBe(true);
      const f = path.join(dir, 'modifie.mkv');
      flipByte(gop2, f, pos);
      // Date de modification restaurée (à la milliseconde près selon le système de fichiers).
      expect(Math.abs(statSync(f).mtimeMs - statSync(gop2).mtimeMs), label).toBeLessThanOrEqual(1);
      expect(await verifyIntegrity(f, m), label).toEqual({ ok: false, reason: 'content_changed' });
    }
    const t = path.join(dir, 'tronque.mkv');
    writeFileSync(t, data.subarray(0, data.length - 1));
    expect(await verifyIntegrity(t, m)).toEqual({ ok: false, reason: 'size_changed' });
    expect(await verifyIntegrity(path.join(dir, 'absent.mkv'), m)).toEqual({
      ok: false,
      reason: 'missing',
    });
  }, 60_000);

  it('hors de l’ensemble protégé : non détecté, et sans effet sur le rendu de la fenêtre', async () => {
    const m = await manifest(gop2, 8_300, 20_000);
    const pos = packetPos(gop2, 27_000);
    expect(inRanges(m.ranges, pos)).toBe(false);
    const f = path.join(dir, 'hors-fenetre.mkv');
    flipByte(gop2, f, pos + 50);
    expect(await verifyIntegrity(f, m)).toEqual({ ok: true });
    expect(decode(f, 8_300, 20_000)).toBe(decode(gop2, 8_300, 20_000));
  }, 60_000);

  it('repli sur le fichier entier : cluster de taille inconnue, ou demande explicite', async () => {
    // Cluster dont la taille est réécrite « inconnue » (tous bits à 1, même longueur).
    const data = Buffer.from(readFileSync(gop2));
    const c = data.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
    const first = data[c + 4]!;
    let len = 1;
    for (let mask = 0x80; !(first & mask); mask >>= 1) len++;
    data[c + 4] = (0xff >> (len - 1)) | 0;
    for (let i = 1; i < len; i++) data[c + 4 + i] = 0xff;
    const u = path.join(dir, 'taille-inconnue.mkv');
    writeFileSync(u, data);
    const m = await manifest(u, 8_300, 20_000);
    expect(m.method).toBe('full_file');
    expect(m.ranges).toEqual([[0, data.length, 'full']]);
    expect(await verifyIntegrity(u, m)).toEqual({ ok: true });
    const forced = await manifest(gop2, 8_300, 20_000, { forceFullFile: true });
    expect(forced.method).toBe('full_file');
    // Repli : n'importe quel octet modifié est détecté.
    const f = path.join(dir, 'modifie-plein.mkv');
    flipByte(gop2, f, packetPos(gop2, 27_000) + 50);
    expect(await verifyIntegrity(f, forced)).toEqual({ ok: false, reason: 'content_changed' });
  }, 60_000);

  it('empreinte déterministe ; version d’algorithme inconnue refusée', async () => {
    const a = await manifest(gop2, 8_300, 20_000);
    const b = await manifest(gop2, 8_300, 20_000);
    expect(b).toEqual(a);
    expect(await verifyIntegrity(gop2, { ...a, algoVersion: 99 })).toEqual({
      ok: false,
      reason: 'algo_unknown',
    });
  }, 60_000);
});
