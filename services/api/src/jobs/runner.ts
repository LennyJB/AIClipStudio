import { randomUUID } from 'node:crypto';
import { AppError, isAppError, type JobLane, type JobType } from '@acs/shared';
import type { AppContext } from '../context';
import { JobRepository, type JobDto, type JobFile } from '../recordings/repository';

export interface JobHandlerContext {
  signal: AbortSignal;
  /** Progression globale du travail (0..1). Écriture en base limitée en fréquence. */
  reportProgress: (ratio: number) => void;
}

/** Un handler renvoie le résultat du traitement (enregistré en JSON). */
export type JobHandler = (job: JobDto, ctx: JobHandlerContext) => Promise<unknown>;

export interface EnqueueSpec {
  type: JobType;
  lane: JobLane;
  /** Deux traitements actifs ne peuvent pas avoir la même clé : le second se rattache au premier. */
  targetKey: string;
  recordingId?: string | null;
  params: Record<string, unknown>;
  /** Fichiers lus et écrits (chemins relatifs au stockage) : protégés du nettoyage. */
  files?: readonly JobFile[];
}

export interface RunnerHooks {
  onSucceeded?: (job: JobDto) => void | Promise<void>;
}

const PROGRESS_MIN_INTERVAL_MS = 1000;
const LANES: readonly JobLane[] = ['heavy', 'interactive', 'analysis'];

interface LaneState {
  current: { id: string; controller: AbortController } | null;
  loop: Promise<void> | null;
}

/**
 * File de traitements persistée dans SQLite, avec trois files d'exécution
 * indépendantes (un traitement à la fois dans chacune) :
 *  - heavy       : transcription, extraction complète, rendu ;
 *  - interactive : préparation de clips (pistes de montage, formes d'onde) ;
 *  - analysis    : analyse éditoriale (indépendante du GPU).
 */
export class JobRunner {
  private readonly jobs: JobRepository;
  private readonly lanes: Record<JobLane, LaneState> = {
    heavy: { current: null, loop: null },
    interactive: { current: null, loop: null },
    analysis: { current: null, loop: null },
  };
  private stopped = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly handlers: Partial<Record<JobType, JobHandler>>,
    private readonly hooks: RunnerHooks = {},
  ) {
    this.jobs = new JobRepository(ctx.db);
  }

  /** À appeler au démarrage : les travaux restés actifs sont marqués interrompus. */
  recover(): number {
    const n = this.jobs.markStaleAsInterrupted();
    if (n)
      this.ctx.log.warn({ count: n }, 'Travaux interrompus détectés au démarrage (relançables)');
    return n;
  }

  /** Ajoute un traitement, ou renvoie le traitement actif identique (même clé de cible). */
  enqueue(spec: EnqueueSpec): { job: JobDto; created: boolean } {
    if (!this.handlers[spec.type]) {
      throw new AppError('VALIDATION_FAILED', `Type de traitement inconnu : ${spec.type}`);
    }
    if (this.stopped) throw new AppError('CONFLICT', 'Arrêt en cours : traitement refusé');
    const res = this.jobs.createOrGetActive({
      id: randomUUID(),
      type: spec.type,
      lane: spec.lane,
      targetKey: spec.targetKey,
      recordingId: spec.recordingId ?? null,
      params: spec.params,
      files: spec.files ?? [],
    });
    if (res.created) {
      this.ctx.log.info(
        { jobId: res.job.id, type: spec.type, lane: spec.lane, recordingId: spec.recordingId },
        'Traitement ajouté à la file',
      );
      this.kick(spec.lane);
    }
    return res;
  }

  cancel(jobId: string): JobDto {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('NOT_FOUND', 'Traitement introuvable');
    const current = this.lanes[job.lane].current;
    if (job.status === 'queued') {
      this.jobs.finish(jobId, 'cancelled', {
        error: { code: 'CANCELLED', message: 'Annulé par l’utilisateur' },
      });
    } else if (job.status === 'running' && current?.id === jobId) {
      current.controller.abort();
    } else {
      throw new AppError('CONFLICT', `Traitement déjà terminé (${job.status})`);
    }
    return this.jobs.get(jobId)!;
  }

  /** Attend que toutes les files soient vides (tests, CLI). */
  async idle(): Promise<void> {
    for (;;) {
      const loops = LANES.map((l) => this.lanes[l].loop).filter(
        (p): p is Promise<void> => p !== null,
      );
      if (!loops.length) return;
      await Promise.all(loops);
    }
  }

  /** Arrêt propre : les traitements en cours sont interrompus et marqués comme tels. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const l of LANES) this.lanes[l].current?.controller.abort('shutdown');
    await this.idle();
  }

  private kick(lane: JobLane) {
    const state = this.lanes[lane];
    if (state.loop || this.stopped) return;
    state.loop = this.drain(lane).finally(() => {
      state.loop = null;
      // Un traitement a pu être ajouté entre la dernière lecture de la file et cette ligne.
      if (!this.stopped && this.jobs.nextQueued(lane)) this.kick(lane);
    });
  }

  private async drain(lane: JobLane) {
    for (;;) {
      if (this.stopped) return;
      const job = this.jobs.nextQueued(lane);
      if (!job) return;
      await this.execute(job);
    }
  }

  private async execute(job: JobDto) {
    const handler = this.handlers[job.type];
    const state = this.lanes[job.lane];
    const controller = new AbortController();
    state.current = { id: job.id, controller };
    this.jobs.markRunning(job.id);
    const log = { jobId: job.id, recordingId: job.recordingId, type: job.type, lane: job.lane };
    this.ctx.log.info(log, 'Traitement démarré');
    const started = Date.now();

    let lastWrite = 0;
    const reportProgress = (ratio: number) => {
      const now = Date.now();
      if (now - lastWrite < PROGRESS_MIN_INTERVAL_MS && ratio < 1) return;
      lastWrite = now;
      this.jobs.setProgress(job.id, ratio);
    };

    try {
      if (!handler) throw new AppError('VALIDATION_FAILED', `Aucun handler pour ${job.type}`);
      const result = await handler(job, { signal: controller.signal, reportProgress });
      this.jobs.finish(job.id, 'succeeded', { result: result ?? null });
      this.ctx.log.info({ ...log, elapsedMs: Date.now() - started }, 'Traitement terminé');
      try {
        await this.hooks.onSucceeded?.(this.jobs.get(job.id)!);
      } catch (err) {
        this.ctx.log.error({ ...log, err }, 'Erreur après traitement (ignorée)');
      }
    } catch (err) {
      if (controller.signal.aborted) {
        const shutdown = controller.signal.reason === 'shutdown';
        this.jobs.finish(job.id, shutdown ? 'interrupted' : 'cancelled', {
          error: {
            code: shutdown ? 'INTERRUPTED' : 'CANCELLED',
            message: shutdown ? 'Interrompu par l’arrêt du serveur' : 'Annulé par l’utilisateur',
          },
        });
        this.ctx.log.warn(log, shutdown ? 'Traitement interrompu' : 'Traitement annulé');
      } else {
        const code = isAppError(err) ? err.code : 'INTERNAL';
        const message = err instanceof Error ? err.message : String(err);
        this.jobs.finish(job.id, 'failed', { error: { code, message } });
        this.ctx.log.error(
          { ...log, err, code, details: isAppError(err) ? err.details : undefined },
          'Traitement en échec',
        );
      }
    } finally {
      state.current = null;
    }
  }
}
