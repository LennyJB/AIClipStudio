import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { loadGameProfile } from '@acs/editorial';
import { selectTranscriptionTracks } from '@acs/media';
import { AppError, isAppError } from '@acs/shared';
import {
  computeSuspicion,
  dedupeSegments,
  planBlock,
  selectCoreSegments,
  validateChunking,
  WhisperWorker,
  WORKER_SCRIPT,
  type BlockResult,
  type InitCommand,
} from '@acs/transcription';
import type { AppContext } from '../context';
import { canonicalJson, sha256 } from '../derivatives/cache-key';
import type { DerivativeService } from '../derivatives/service';
import type { JobHandler, JobHandlerContext, JobRunner } from '../jobs/runner';
import { JobRepository, RecordingRepository, type JobDto } from '../recordings/repository';
import { toAbs } from '../storage/paths';
import { TranscriptionRepository, type TranscriptionDto } from './repository';

/** À incrémenter si la logique de découpage/attribution change : invalide la réutilisation. */
export const TRANSCRIPTION_PIPELINE_VERSION = 1;

export const TranscribeRequestSchema = z
  .object({
    model: z
      .string()
      .regex(/^[\w.\-/]+$/)
      .optional(),
    language: z
      .string()
      .regex(/^(auto|[a-z]{2,3})$/)
      .optional(),
    /** Retranscrire même si une transcription identique existe déjà. */
    force: z.boolean().optional(),
  })
  .strict();
export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

/** Paramètres qui influencent le résultat : ils entrent dans la clé de cache. */
export interface TranscriptionParams {
  pipelineVersion: number;
  engine: 'faster-whisper';
  computeType: string;
  cpuComputeType: string;
  language: string;
  beamSize: number;
  batchSize: number;
  wordTimestamps: boolean;
  vad: AppContext['config']['whisper']['vad'];
  hotwords: string | null;
  chunking: AppContext['config']['whisper']['chunking'];
}

export interface TranscriptionRequestResult {
  status: 'ready' | 'pending';
  transcriptions: TranscriptionDto[];
  job: JobDto | null;
}

export interface ComparisonGroup {
  audioIndex: number;
  role: string | null;
  comparisonKey: string;
  /** Transcriptions comparables : même piste, même audio, mêmes paramètres hors modèle. */
  transcriptions: TranscriptionDto[];
  /**
   * Faux si les transcriptions n'ont pas tourné sur les mêmes périphériques :
   * les durées et facteurs temps réel ne sont alors PAS comparables.
   */
  sameDevices: boolean;
}

const JobParams = z
  .object({ recordingId: z.uuid(), transcriptionIds: z.array(z.string().min(1)).min(1) })
  .strict();

/**
 * Transcription locale des pistes d'un enregistrement (Faster-Whisper).
 * - Entrée : le WAV 16 kHz mono dérivé (réutilisé via le cache, produit si besoin).
 * - Blocs avec chevauchement ; segments + checkpoint enregistrés par transaction.
 * - Reprise au checkpoint ; réutilisation d'une transcription identique déjà terminée.
 */
export class TranscriptionService {
  readonly repo: TranscriptionRepository;
  private readonly recordings: RecordingRepository;
  private readonly jobs: JobRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly runnerRef: () => JobRunner,
    private readonly derivatives: DerivativeService,
  ) {
    this.repo = new TranscriptionRepository(ctx.db);
    this.recordings = new RecordingRepository(ctx.db);
    this.jobs = new JobRepository(ctx.db);
    validateChunking(ctx.config.whisper.chunking);
  }

  recover(): number {
    const n = this.repo.markStaleAsInterrupted();
    if (n)
      this.ctx.log.warn({ count: n }, 'Transcriptions interrompues détectées (reprise possible)');
    return n;
  }

  /* --------------------------------------------------------------------- */
  /* Paramètres                                                             */
  /* --------------------------------------------------------------------- */

  private async params(
    gameId: string,
    req: TranscribeRequest,
  ): Promise<{ model: string; params: TranscriptionParams }> {
    const w = this.ctx.config.whisper;
    const model = req.model ?? w.model;
    if (!w.modelChoices.includes(model)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Modèle non proposé : ${model} (choix : ${w.modelChoices.join(', ')})`,
      );
    }
    const profile = await loadGameProfile(this.ctx.config.paths.profiles, gameId);
    const hot = profile.transcription.useVocabulary
      ? [...profile.vocabulary, ...profile.transcription.extraTerms].join(', ')
      : '';
    return {
      model,
      params: {
        pipelineVersion: TRANSCRIPTION_PIPELINE_VERSION,
        engine: 'faster-whisper',
        computeType: w.computeType,
        cpuComputeType: w.cpuComputeType,
        language: req.language ?? w.language,
        beamSize: w.beamSize,
        batchSize: w.batchSize,
        wordTimestamps: w.wordTimestamps,
        vad: w.vad,
        hotwords: hot || null,
        chunking: w.chunking,
      },
    };
  }

  /* --------------------------------------------------------------------- */
  /* Demande                                                                */
  /* --------------------------------------------------------------------- */

  async request(
    recordingId: string,
    req: TranscribeRequest = {},
  ): Promise<TranscriptionRequestResult> {
    const rec = this.recordings.get(recordingId);
    const src = this.recordings.getSource(recordingId);
    if (!rec || !src) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    const tracks = selectTranscriptionTracks(rec.audioTracks);
    if (!tracks.length)
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste de voix ou de mix à transcrire');
    const { model, params } = await this.params(rec.gameId, req);

    const runs: TranscriptionDto[] = [];
    const todo: TranscriptionDto[] = [];
    for (const t of tracks) {
      const inputAudioKey = this.derivatives.transcriptionAudioKey(recordingId, t.audioIndex);
      const comparisonKey = sha256(canonicalJson({ inputAudioKey, params }));
      const cacheKey = sha256(canonicalJson({ inputAudioKey, model, params }));
      const done = req.force ? null : this.repo.findCompleted(cacheKey);
      if (done) {
        runs.push(done);
        continue;
      }
      const resumable = req.force ? null : this.repo.findResumable(cacheKey);
      const run =
        resumable ??
        this.repo.create({
          id: randomUUID(),
          recordingId,
          audioIndex: t.audioIndex,
          cacheKey,
          comparisonKey,
          inputAudioKey,
          sourceFingerprint: src.fingerprint,
          model,
          computeTypeRequested: params.computeType,
          deviceRequested: this.ctx.config.whisper.device,
          params: params as unknown as Record<string, unknown>,
        });
      runs.push(run);
      todo.push(run);
    }
    if (!todo.length) return { status: 'ready', transcriptions: runs, job: null };

    const ids = todo.map((r) => r.id).sort();
    const { job, created } = this.runnerRef().enqueue({
      type: 'transcribe_recording',
      lane: 'heavy',
      targetKey: `transcribe_recording:${sha256(ids.join(','))}`,
      recordingId,
      params: { recordingId, transcriptionIds: ids },
    });
    this.ctx.log.info(
      {
        recordingId,
        model,
        transcriptions: ids,
        jobId: job.id,
        created,
        resumed: todo.filter((r) => r.checkpointMs > 0).length,
      },
      'Transcription demandée',
    );
    return { status: 'pending', transcriptions: runs.map((r) => this.repo.get(r.id)!), job };
  }

  /* --------------------------------------------------------------------- */
  /* Lecture                                                                */
  /* --------------------------------------------------------------------- */

  list(recordingId: string): {
    transcriptions: TranscriptionDto[];
    comparisons: ComparisonGroup[];
  } {
    const all = this.repo.listForRecording(recordingId);
    const rec = this.recordings.get(recordingId);
    const groups = new Map<string, ComparisonGroup>();
    for (const t of all) {
      const g = groups.get(t.comparisonKey) ?? {
        audioIndex: t.audioIndex,
        role: rec?.audioTracks.find((a) => a.audioIndex === t.audioIndex)?.role ?? null,
        comparisonKey: t.comparisonKey,
        transcriptions: [],
        sameDevices: true,
      };
      g.transcriptions.push(t);
      groups.set(t.comparisonKey, g);
    }
    return {
      transcriptions: all,
      comparisons: [...groups.values()].filter(
        (g) => new Set(g.transcriptions.map((t) => t.model)).size > 1,
      ),
    };
  }

  /**
   * Transcription d'un enregistrement par ordre chronologique.
   * Par défaut : pour chaque piste, la plus récente du modèle demandé (terminée de préférence,
   * sinon en cours, pour afficher les blocs déjà enregistrés).
   */
  transcript(
    recordingId: string,
    q: {
      model?: string;
      transcriptionIds?: string[];
      audioIndexes?: number[];
      fromMs?: number;
      toMs?: number;
    },
  ) {
    const all = this.repo.listForRecording(recordingId);
    let chosen: TranscriptionDto[];
    if (q.transcriptionIds?.length) {
      chosen = all.filter((t) => q.transcriptionIds!.includes(t.id));
      if (chosen.length !== q.transcriptionIds.length) {
        throw new AppError('NOT_FOUND', 'Transcription introuvable pour cet enregistrement');
      }
    } else {
      const model = q.model ?? this.ctx.config.whisper.model;
      const byTrack = new Map<number, TranscriptionDto>();
      for (const t of all.filter((x) => x.model === model)) {
        const cur = byTrack.get(t.audioIndex);
        const better =
          !cur ||
          (t.status === 'completed' && cur.status !== 'completed') ||
          (t.status === cur.status && t.createdAt > cur.createdAt);
        if (better && (t.status === 'completed' || t.segmentCount > 0 || !cur))
          byTrack.set(t.audioIndex, t);
      }
      chosen = [...byTrack.values()];
    }
    return {
      transcriptions: chosen,
      segments: this.repo.segments({
        recordingId,
        transcriptionIds: chosen.map((t) => t.id),
        audioIndexes: q.audioIndexes,
        fromMs: q.fromMs,
        toMs: q.toMs,
      }),
    };
  }

  /* --------------------------------------------------------------------- */
  /* Traitement                                                             */
  /* --------------------------------------------------------------------- */

  handlers(): { transcribe_recording: JobHandler } {
    return { transcribe_recording: (job, hctx) => this.runJob(job, hctx) };
  }

  private workerCommand(): string[] {
    const w = this.ctx.config.whisper;
    return w.workerCommand ?? [this.ctx.config.tools.python, '-u', WORKER_SCRIPT];
  }

  private initCommand(
    model: string,
    params: TranscriptionParams,
    device: 'auto' | 'cuda' | 'cpu',
  ): InitCommand {
    const w = this.ctx.config.whisper;
    return {
      cmd: 'init',
      model,
      device,
      computeType: params.computeType,
      cpuFallback: w.cpuFallback,
      cpuComputeType: params.cpuComputeType,
      downloadRoot: w.modelDir,
      beamSize: params.beamSize,
      batchSize: params.batchSize,
      wordTimestamps: params.wordTimestamps,
      vad: params.vad,
      hotwords: params.hotwords,
    };
  }

  private async runJob(job: JobDto, hctx: JobHandlerContext) {
    const p = JobParams.parse(job.params);
    const runs = p.transcriptionIds.map((id) => {
      const t = this.repo.get(id);
      if (!t || t.recordingId !== p.recordingId)
        throw new AppError('NOT_FOUND', `Transcription introuvable : ${id}`);
      return t;
    });
    // Pistes traitées dans l'ordre de leur index (déterministe, journaux lisibles).
    const pending = runs
      .filter((t) => t.status !== 'completed')
      .sort((a, b) => a.audioIndex - b.audioIndex);
    if (!pending.length) return { transcriptionIds: p.transcriptionIds };
    try {
      await this.processRuns(job, hctx, p.recordingId, pending);
    } catch (err) {
      // Quel que soit le moment de l'échec (audio, chargement du modèle, bloc), aucune
      // transcription ne reste « en attente » : état et erreur explicites, checkpoint conservé.
      for (const t of pending) {
        if (this.repo.get(t.id)?.status !== 'completed') this.markFailed(t.id, err, hctx.signal);
      }
      throw err;
    }
    return { transcriptionIds: p.transcriptionIds };
  }

  private async processRuns(
    job: JobDto,
    hctx: JobHandlerContext,
    recordingId: string,
    pending: TranscriptionDto[],
  ) {
    const p = { recordingId };

    // 1. Audio d'entrée : WAV 16 kHz du cache (produit si absent), protégé pendant le traitement.
    const audio = await this.derivatives.ensureAudio(
      p.recordingId,
      'audio_transcription',
      pending.map((t) => t.audioIndex),
      null,
      {
        signal: hctx.signal,
        reportProgress: (r) => hctx.reportProgress(r * 0.05),
        logContext: { jobId: job.id },
      },
    );
    this.jobs.addFiles(
      job.id,
      audio.map((a) => ({ relPath: a.relPath, usage: 'input' as const })),
    );
    audio.forEach((a, i) => {
      // L'audio utilisé doit être celui qui a servi à calculer la clé de la transcription.
      if (
        a.cacheKey !== this.derivatives.transcriptionAudioKey(p.recordingId, pending[i]!.audioIndex)
      ) {
        throw new AppError(
          'TRANSCRIPTION_FAILED',
          'Audio d’entrée incohérent avec la transcription demandée',
        );
      }
    });

    // Progression : durée des pistes terminées dans ce traitement + position dans la piste en cours.
    const totalMs = audio.reduce((s, a) => s + (a.durationMs ?? 0), 0) || 1;
    let doneMs = 0;
    const progress = (positionInTrackMs: number) =>
      hctx.reportProgress(0.05 + 0.95 * Math.min(1, (doneMs + positionInTrackMs) / totalMs));

    // 2. Worker : un seul chargement du modèle pour toutes les pistes du traitement.
    const first = pending[0]!;
    const params = first.params as unknown as TranscriptionParams;
    let worker: WhisperWorker | null = null;
    let initFallbackError: string | null = null;
    const startWorker = async (device: 'auto' | 'cuda' | 'cpu') => {
      worker = await WhisperWorker.start({
        command: this.workerCommand(),
        init: this.initCommand(first.model, params, device),
        log: this.ctx.log,
        signal: hctx.signal,
      });
      const ready = worker.ready!;
      initFallbackError = ready.fallback?.error ?? null;
      this.ctx.log.info(
        {
          jobId: job.id,
          model: ready.model,
          device: ready.device,
          computeType: ready.computeType,
          cudaDevices: ready.cudaDeviceCount,
          loadMs: ready.loadMs,
          engineVersion: ready.engineVersion,
          fallback: ready.fallback,
        },
        ready.device === 'cuda' ? 'Modèle chargé sur GPU (CUDA)' : 'Modèle chargé sur CPU',
      );
      return worker;
    };

    /** Le worker a planté sur CUDA (ex. DLL cuDNN) : redémarrage sur CPU si autorisé. */
    const restartOnCpuAfterCrash = async (err: unknown): Promise<string> => {
      const usedCuda = (worker as WhisperWorker | null)?.ready?.device === 'cuda';
      if (!usedCuda || !this.ctx.config.whisper.cpuFallback || !isAppError(err)) throw err;
      if (err.code !== 'TRANSCRIPTION_WORKER_CRASHED') throw err;
      const stderr = (err.details as { stderr?: string } | undefined)?.stderr ?? '';
      const reason = `Arrêt du worker pendant l'utilisation de CUDA : ${stderr.slice(-500) || err.message}`;
      this.ctx.log.warn(
        { jobId: job.id, cudaError: reason },
        'Échec CUDA (arrêt du worker) : bascule sur CPU',
      );
      await startWorker('cpu');
      return reason;
    };

    try {
      try {
        await startWorker(this.ctx.config.whisper.device);
      } catch (err) {
        // Plantage pendant le chargement CUDA : nouvelle tentative sur CPU si autorisée.
        if (
          this.ctx.config.whisper.device !== 'cpu' &&
          this.ctx.config.whisper.cpuFallback &&
          isAppError(err) &&
          err.code === 'TRANSCRIPTION_WORKER_CRASHED'
        ) {
          const stderr = (err.details as { stderr?: string } | undefined)?.stderr ?? err.message;
          this.ctx.log.warn(
            { jobId: job.id, cudaError: stderr.slice(-1000) },
            'Worker arrêté au chargement : bascule sur CPU',
          );
          await startWorker('cpu');
          initFallbackError = `Arrêt du worker au chargement : ${stderr.slice(-500)}`;
        } else throw err;
      }

      // 3. Pistes une à une, bloc par bloc.
      for (const [i, t] of pending.entries()) {
        const wav = audio[i]!;
        const wavPath = toAbs(this.ctx.config.paths.storage, wav.relPath);
        if (!existsSync(wavPath))
          throw new AppError('MEDIA_NOT_FOUND', `WAV de transcription absent : ${wav.relPath}`);
        const durationMs = wav.durationMs ?? 0;
        const ready = worker!.ready!;
        this.repo.markRunning(t.id, {
          engineVersion: ready.engineVersion,
          ctranslate2Version: ready.ctranslate2Version,
          audioDurationMs: durationMs,
          modelLoadMs: ready.loadMs,
        });
        try {
          await this.transcribeTrack(t.id, wavPath, durationMs, params, hctx.signal, {
            worker: () => worker!,
            onCrash: restartOnCpuAfterCrash,
            takeInitFallback: () => {
              const e = initFallbackError;
              initFallbackError = null;
              return e;
            },
            onProgress: (positionInTrackMs) => progress(positionInTrackMs),
            jobId: job.id,
          });
          this.repo.complete(t.id);
          doneMs += durationMs;
          this.ctx.log.info(
            { jobId: job.id, transcription: this.summary(t.id) },
            'Piste transcrite',
          );
        } catch (err) {
          this.markFailed(t.id, err, hctx.signal);
          throw err;
        }
      }
    } finally {
      await (worker as WhisperWorker | null)?.close();
    }
  }

  private async transcribeTrack(
    transcriptionId: string,
    wavPath: string,
    durationMs: number,
    params: TranscriptionParams,
    signal: AbortSignal,
    h: {
      worker: () => WhisperWorker;
      onCrash: (err: unknown) => Promise<string>;
      takeInitFallback: () => string | null;
      /** Position atteinte dans la piste (ms source). */
      onProgress: (positionInTrackMs: number) => void;
      jobId: string;
    },
  ) {
    const forced = params.language !== 'auto' ? params.language : null;
    for (;;) {
      const t = this.repo.get(transcriptionId)!;
      const block = planBlock(t.checkpointMs, durationMs, params.chunking);
      if (!block) return;
      if (signal.aborted) throw new AppError('CANCELLED', 'Transcription annulée');

      const request = {
        wavPath,
        startMs: block.readStartMs,
        endMs: block.readEndMs,
        language: forced ?? t.language,
      };
      const onProgress = (processedMs: number) =>
        h.onProgress(Math.max(t.checkpointMs, Math.min(processedMs, block.coreEndMs)));
      let result: BlockResult;
      let crashFallback: string | null = null;
      try {
        result = await h.worker().transcribe(request, { onProgress, signal });
      } catch (err) {
        if (signal.aborted) throw err;
        crashFallback = await h.onCrash(err); // relance sur CPU ou relance l'erreur
        result = await h.worker().transcribe(request, { onProgress, signal });
      }

      const candidates = selectCoreSegments(
        result.segments,
        block,
        params.chunking.boundaryToleranceMs,
      );
      const near = this.repo.segmentsBetween(transcriptionId, block.readStartMs, block.readEndMs);
      const { kept, dropped } = dedupeSegments(candidates, near);
      const segments = kept.map((s) => {
        const sus = computeSuspicion(s);
        return { ...s, suspicionScore: sus.score, suspicionReasons: sus.reasons };
      });
      const fallbackError = result.fallbacks[0]?.error ?? crashFallback ?? h.takeInitFallback();
      const language =
        t.language === null && (forced || (result.language && result.segments.length > 0))
          ? {
              code: (forced ?? result.language)!,
              probability: forced ? null : result.languageProbability,
              source: forced ? ('forced' as const) : ('detected' as const),
            }
          : null;

      // Transaction unique : segments + bloc + checkpoint (n'avance pas en cas d'échec).
      this.repo.commitBlock({
        transcriptionId,
        expectedCheckpointMs: t.checkpointMs,
        coreStartMs: block.coreStartMs,
        coreEndMs: block.coreEndMs,
        device: result.device,
        computeType: result.computeType,
        fallbackError,
        elapsedMs: result.elapsedMs,
        audioMs: result.audioMs,
        segments,
        deduplicated: dropped.length,
        language,
      });
      this.ctx.log.info(
        {
          jobId: h.jobId,
          transcriptionId,
          coreStartMs: block.coreStartMs,
          coreEndMs: block.coreEndMs,
          device: result.device,
          computeType: result.computeType,
          elapsedMs: result.elapsedMs,
          realtimeFactor: result.elapsedMs
            ? Math.round(((block.coreEndMs - block.coreStartMs) / result.elapsedMs) * 10) / 10
            : null,
          kept: segments.length,
          deduplicated: dropped.length,
          outsideCore: result.segments.length - candidates.length,
        },
        'Bloc transcrit',
      );
      h.onProgress(block.coreEndMs);
    }
  }

  private markFailed(id: string, err: unknown, signal: AbortSignal) {
    if (signal.aborted) {
      const shutdown = signal.reason === 'shutdown';
      this.repo.finish(id, shutdown ? 'interrupted' : 'cancelled', {
        code: shutdown ? 'INTERRUPTED' : 'CANCELLED',
        message: shutdown
          ? 'Interrompue (arrêt du serveur) : reprise possible'
          : 'Annulée : reprise possible',
      });
      return;
    }
    this.repo.finish(id, 'failed', {
      code: isAppError(err) ? err.code : 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  private summary(id: string) {
    const t = this.repo.get(id)!;
    return {
      id,
      audioIndex: t.audioIndex,
      model: t.model,
      devicesUsed: t.devicesUsed,
      language: t.language,
      segments: t.segmentCount,
      processingMs: t.processingMs,
      realtimeFactor: t.realtimeFactor,
    };
  }
}
