import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractAudioTracks, fingerprintFile, selectTranscriptionTracks } from '@acs/media';
import { AppError } from '@acs/shared';
import type { AppContext } from '../context';
import { RecordingRepository } from '../recordings/repository';
import type { JobHandler } from './runner';

export function audioOutputPath(
  processingDir: string,
  recordingId: string,
  audioIndex: number,
  role: string,
) {
  return path.join(processingDir, recordingId, 'audio', `track-${audioIndex + 1}-${role}.wav`);
}

/**
 * Extrait les pistes à transcrire en WAV 16 kHz mono.
 * Toutes les pistes en attente sont extraites en un seul passage (lecture unique
 * de l'original). Reprise : les pistes déjà extraites (fichier présent) sont ignorées.
 */
export function createExtractAudioHandler(ctx: AppContext): JobHandler {
  const repo = new RecordingRepository(ctx.db);

  return async (job, { signal, reportProgress }) => {
    const recording = repo.get(job.recordingId);
    const source = repo.getSource(job.recordingId);
    if (!recording || !source) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');

    // L'original a-t-il été déplacé ou modifié depuis l'import ?
    if (!existsSync(source.sourcePath)) {
      throw new AppError('MEDIA_NOT_FOUND', `Original introuvable : ${source.sourcePath}`);
    }
    const fp = await fingerprintFile(source.sourcePath);
    if (fp.hash !== source.fingerprint) {
      throw new AppError(
        'MEDIA_SOURCE_CHANGED',
        'L’original a été modifié depuis l’import : ré-importez-le',
      );
    }

    const targets = selectTranscriptionTracks(recording.audioTracks);
    if (!targets.length) {
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste de voix ou de mix à extraire');
    }

    const done = targets
      .map((t) => recording.audioTracks.find((x) => x.audioIndex === t.audioIndex)!)
      .filter((t) => t.extracted && existsSync(t.extracted.path));
    const pending = targets
      .map((t) => recording.audioTracks.find((x) => x.audioIndex === t.audioIndex)!)
      .filter((t) => !done.includes(t));
    let longest = Math.max(0, ...done.map((t) => t.extracted!.durationSec));
    if (done.length) {
      ctx.log.info(
        { jobId: job.id, audioIndexes: done.map((t) => t.audioIndex) },
        'Pistes déjà extraites : ignorées',
      );
    }

    if (pending.length) {
      const started = Date.now();
      const results = await extractAudioTracks({
        ffmpegPath: ctx.config.tools.ffmpeg,
        inputPath: source.sourcePath,
        targets: pending.map((t) => ({
          audioIndex: t.audioIndex,
          outputPath: audioOutputPath(
            ctx.config.paths.processing,
            recording.id,
            t.audioIndex,
            t.role,
          ),
        })),
        allowedDir: ctx.config.paths.processing,
        expectedDurationSec: recording.durationSec,
        signal,
        onProgress: (ratio) => reportProgress(ratio),
      });
      for (const res of results) {
        repo.setTrackExtracted(recording.id, res.audioIndex, res.outputPath, res.durationSec);
        longest = Math.max(longest, res.durationSec);
      }
      ctx.log.info(
        {
          jobId: job.id,
          tracks: results.map((r) => ({
            audioIndex: r.audioIndex,
            durationSec: Math.round(r.durationSec * 10) / 10,
            sizeMB: Math.round(r.dataBytes / 1e5) / 10,
          })),
          elapsedMs: Date.now() - started,
        },
        'Pistes audio extraites',
      );
    }
    if (longest > 0) repo.setDurationFromAudioIfUnknown(recording.id, longest);
  };
}
