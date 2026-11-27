import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { loadGameProfile, GENERIC_GAME_PROFILE_ID } from '@acs/editorial';
import {
  applyScan,
  fingerprintFile,
  mediaHealth,
  probeMedia,
  resolveTrackRoles,
  scanMedia,
} from '@acs/media';
import { AppError, SUPPORTED_EXTENSIONS, type TrackRole } from '@acs/shared';
import type { AppContext } from '../context';
import { RecordingRepository, type RecordingDto } from './repository';

export interface ImportInput {
  /** Chemin absolu de l'enregistrement OBS (référencé, jamais copié ni modifié). */
  path: string;
  gameId?: string | undefined;
  trackRoles?: TrackRole[] | undefined;
}

export interface ImportResult {
  recording: RecordingDto;
  created: boolean;
}

export async function validateSourcePath(rawPath: string): Promise<{ path: string; size: number }> {
  if (!path.isAbsolute(rawPath)) {
    throw new AppError('VALIDATION_FAILED', 'Le chemin de l’enregistrement doit être absolu');
  }
  const resolved = path.resolve(rawPath);
  const ext = path.extname(resolved).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new AppError(
      'MEDIA_UNSUPPORTED',
      `Format non pris en charge (${ext || 'aucune extension'}) : MKV, MP4, MOV, M4V ou TS attendu`,
    );
  }
  let st;
  try {
    st = await stat(resolved);
  } catch (cause) {
    throw new AppError('MEDIA_NOT_FOUND', `Fichier introuvable : ${resolved}`, { cause });
  }
  if (!st.isFile())
    throw new AppError('MEDIA_NOT_FOUND', `Ce chemin n’est pas un fichier : ${resolved}`);
  if (st.size === 0) throw new AppError('MEDIA_UNSUPPORTED', 'Le fichier est vide');
  return { path: resolved, size: st.size };
}

/**
 * Importe un enregistrement : contrôle, empreinte, lecture des métadonnées,
 * identification des pistes. Le fichier est seulement référencé.
 * Ré-importer le même fichier renvoie l'enregistrement existant.
 */
export async function importRecording(ctx: AppContext, input: ImportInput): Promise<ImportResult> {
  const repo = new RecordingRepository(ctx.db);
  const source = await validateSourcePath(input.path);

  const gameId = input.gameId ?? GENERIC_GAME_PROFILE_ID;
  await loadGameProfile(ctx.config.paths.profiles, gameId); // lève si le profil n'existe pas

  const fp = await fingerprintFile(source.path);
  const existingId = repo.findIdByFingerprint(fp.hash);
  if (existingId) {
    ctx.log.info({ recordingId: existingId, path: source.path }, 'Enregistrement déjà importé');
    return { recording: repo.get(existingId)!, created: false };
  }

  const started = Date.now();
  const probed = await probeMedia(ctx.config.tools.ffprobe, source.path);
  // Contrôle de lecture : début, fin annoncée, et durée MESURÉE si elle est absente, estimée ou
  // fausse. Un fichier incomplet est signalé (`degraded`), jamais présenté comme valide.
  let media = applyScan(probed, await scanMedia(ctx.config.tools.ffmpeg, source.path, probed));
  if (!media.audioTracks.length) {
    throw new AppError(
      'MEDIA_UNSUPPORTED',
      'Aucune piste audio : rien à transcrire dans ce fichier',
    );
  }
  if (input.trackRoles && input.trackRoles.length !== media.audioTracks.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${input.trackRoles.length} rôle(s) fourni(s) pour ${media.audioTracks.length} piste(s) audio`,
    );
  }
  const tracks = resolveTrackRoles(
    media.audioTracks,
    ctx.config.audioTrackRoles,
    input.trackRoles,
    {
      configOrder: media.container === 'mkv' || media.container === 'mp4',
    },
  );
  if (tracks.some((t) => t.roleSource === 'config')) {
    // Rôles déduits de l'ordre configuré (pistes sans nom) : à vérifier par le créateur.
    media = { ...media, warnings: [...media.warnings, 'track_roles_from_config'] };
  }

  const id = randomUUID();
  repo.insert({
    id,
    sourcePath: source.path,
    fileName: path.basename(source.path),
    sizeBytes: fp.sizeBytes,
    mtimeMs: fp.mtimeMs,
    fingerprint: fp.hash,
    gameId,
    media,
    tracks,
  });
  ctx.log.info(
    {
      recordingId: id,
      path: source.path,
      container: media.container,
      durationSec: media.durationSec,
      audioTracks: tracks.map((t) => t.role),
      warnings: media.warnings,
      health: mediaHealth(media.warnings).status,
      elapsedMs: Date.now() - started,
    },
    'Enregistrement importé',
  );
  return { recording: repo.get(id)!, created: true };
}
