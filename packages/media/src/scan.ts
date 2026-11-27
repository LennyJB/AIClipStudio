/**
 * Contrôle de lecture d'un enregistrement (étape 8) : ce que les métadonnées ne disent pas.
 * Un fichier téléchargé (rediffusion Twitch) ou un enregistrement interrompu peut annoncer une
 * durée fausse, être tronqué ou contenir des paquets illisibles. Lecture SEULE, sans shell.
 *
 *  - début : décodage des 3 premières secondes (erreurs de décodage) ;
 *  - fin   : décodage des 3 dernières secondes ANNONCÉES ; un fichier tronqué ne fournit pas ces
 *            images (« fin prématurée ») ;
 *  - lecture complète des paquets (sans décodage, rapide) quand la durée est absente, estimée
 *    (MPEG-TS), incohérente ou que la fin manque : durée MESURÉE.
 *
 * Seuls des compteurs sont conservés (les messages de FFmpeg peuvent contenir des chemins).
 */
import { AppError } from '@acs/shared';
import type { MediaInfo, MediaScanSummary, MediaWarning } from './probe';
import { isSpawnNotFound, runProcess } from './process';

/** Durée décodée en tête et en fin de fichier (secondes). */
export const SCAN_WINDOW_SEC = 3;

const PREMATURE_END = /ended prematurely|end of file|truncat|partial file/iu;

async function ffmpeg(tool: string, args: string[], signal?: AbortSignal) {
  try {
    const r = await runProcess(tool, args, {
      ...(signal ? { signal } : {}),
      captureStdout: true,
    });
    if (r.aborted) throw new AppError('CANCELLED', 'Contrôle annulé');
    return r;
  } catch (err) {
    if (isSpawnNotFound(err)) throw new AppError('TOOL_MISSING', `FFmpeg introuvable (${tool})`);
    throw err;
  }
}

/** Dernière valeur `out_time_us` de la sortie `-progress` (secondes), ou null. */
export function lastOutTime(stdout: string): number | null {
  let last: number | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const m = /^out_time_us=(\d+)$/u.exec(line.trim());
    if (m) last = Number(m[1]) / 1e6;
  }
  return last;
}

const errorLines = (stderr: string) => stderr.split(/\r?\n/u).filter((l) => l.trim().length > 0);

/** Erreurs d'une passe : messages de fin prématurée comptés à part (troncature, pas décodage). */
function tally(r: { stderrTail: string; exitCode: number | null }) {
  // « Last message repeated N times » répète une ligne déjà comptée.
  const lines = errorLines(r.stderrTail).filter((l) => !/Last message repeated/iu.test(l));
  const premature = lines.filter((l) => PREMATURE_END.test(l)).length;
  return {
    errors: lines.length - premature + (r.exitCode === 0 ? 0 : 1),
    premature: premature > 0,
  };
}

const common = ['-nostdin', '-hide_banner', '-v', 'error', '-progress', 'pipe:1', '-nostats'];
const nullOut = ['-f', 'null', '-'];

export interface ScanResult extends MediaScanSummary {
  /** Message de fin prématurée vu en lisant la fin annoncée. */
  prematureEnd: boolean;
}

/** Lit le fichier (début, fin, et si nécessaire tous les paquets). */
export async function scanMedia(
  ffmpegPath: string,
  file: string,
  info: MediaInfo,
  opts: { signal?: AbortSignal; forceFullScan?: boolean } = {},
): Promise<ScanResult> {
  const maps = ['-map', '0:a?', '-map', '0:v?'];
  const head = await ffmpeg(
    ffmpegPath,
    [...common, '-t', String(SCAN_WINDOW_SEC), '-i', file, ...maps, ...nullOut],
    opts.signal,
  );
  const h = tally(head);
  const headErrors = h.errors;
  let prematureEnd = h.premature;

  let tailErrors = 0;
  let tailDecodedSec: number | null = null;
  if (info.durationSec !== null && info.durationSec > 0) {
    const tail = await ffmpeg(
      ffmpegPath,
      [...common, '-sseof', `-${SCAN_WINDOW_SEC}`, '-i', file, ...maps, ...nullOut],
      opts.signal,
    );
    const t = tally(tail);
    prematureEnd ||= t.premature;
    tailErrors = t.errors;
    tailDecodedSec = lastOutTime(tail.stdout) ?? 0;
  }

  const expectedTail = Math.min(SCAN_WINDOW_SEC, info.durationSec ?? 0);
  const tailMissing = tailDecodedSec !== null && tailDecodedSec < expectedTail * 0.5;
  const needFull =
    opts.forceFullScan === true ||
    info.durationSec === null ||
    info.container === 'mpegts' ||
    info.warnings.includes('duration_mismatch') ||
    prematureEnd ||
    tailMissing;
  let measuredDurationSec: number | null = null;
  let scanErrors = 0;
  if (needFull) {
    // Paquets copiés sans décodage : lecture de tout le fichier, coût d'E/S seulement.
    const full = await ffmpeg(
      ffmpegPath,
      [...common, '-i', file, '-map', '0', '-c', 'copy', ...nullOut],
      opts.signal,
    );
    measuredDurationSec = lastOutTime(full.stdout);
    if (measuredDurationSec !== null && measuredDurationSec <= 0) measuredDurationSec = null;
    const f = tally(full);
    prematureEnd ||= f.premature;
    scanErrors = f.errors;
  }
  return { headErrors, tailErrors, tailDecodedSec, measuredDurationSec, scanErrors, prematureEnd };
}

/**
 * Applique le contrôle aux métadonnées (fonction PURE) :
 *  - fin annoncée absente ou « fin prématurée » ⇒ `truncated` ; durée remplacée par la durée
 *    MESURÉE (jamais la durée d'en-tête, fausse) ;
 *  - durée absente ou estimée ⇒ durée mesurée (`durationSource: 'scan'`) ; un écart avec
 *    l'estimation ⇒ `duration_mismatch` ;
 *  - erreurs de lecture ⇒ `decode_errors`.
 */
export function applyScan(info: MediaInfo, scan: ScanResult): MediaInfo {
  const warnings = new Set<MediaWarning>(info.warnings);
  let durationSec = info.durationSec;
  let durationSource = info.durationSource;
  const measured = scan.measuredDurationSec;
  const expectedTail = Math.min(SCAN_WINDOW_SEC, info.durationSec ?? 0);
  const tailMissing = scan.tailDecodedSec !== null && scan.tailDecodedSec < expectedTail * 0.5;
  const shorter =
    measured !== null &&
    info.durationSec !== null &&
    measured < info.durationSec - Math.max(1, info.durationSec * 0.02);

  if (scan.prematureEnd || tailMissing || (shorter && info.container !== 'mpegts')) {
    warnings.add('truncated');
  }
  if (measured !== null) {
    if (
      info.durationSec !== null &&
      Math.abs(measured - info.durationSec) > Math.max(1, info.durationSec * 0.02)
    ) {
      warnings.add('duration_mismatch');
    }
    if (
      info.durationSec === null ||
      info.container === 'mpegts' ||
      warnings.has('truncated') ||
      warnings.has('duration_mismatch')
    ) {
      durationSec = measured;
      durationSource = 'scan';
      warnings.delete('duration_unknown');
    }
  }
  const readErrors = scan.headErrors + scan.scanErrors + scan.tailErrors;
  if (readErrors > 0) warnings.add('decode_errors');
  const summary: MediaScanSummary = {
    headErrors: scan.headErrors,
    tailErrors: scan.tailErrors,
    tailDecodedSec: scan.tailDecodedSec,
    measuredDurationSec: scan.measuredDurationSec,
    scanErrors: scan.scanErrors,
  };
  return {
    ...info,
    durationSec,
    durationSource,
    warnings: [...warnings],
    scan: summary,
  };
}
