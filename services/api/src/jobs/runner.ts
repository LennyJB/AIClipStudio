import { randomUUID } from 'node:crypto';
import { AppError, isAppError, type JobType } from '@acs/shared';
import type { AppContext } from '../context';
import { JobRepository, type JobDto } from '../recordings/repository';

export interface JobHandlerContext {
  signal: AbortSignal;
  /** Progression globale du travail (0..1). Écriture en base limitée en fréquence. */
  reportProgress: (ratio: number) => void;
}

export type JobHandler = (job: JobDto, ctx: JobHandlerContext) => Promise<void>;

const PROGRESS_MIN_INTERVAL_MS = 1000;

/**
 * File de travaux en mémoire, persistée dans SQLite.
 * Un seul travail à la fois : les traitements lourds (FFmpeg, Whisper)
 * ne doivent pas se concurrencer sur la machine.
 */
export class JobRunner {
  private readonly jobs: JobRepository;
  private current: { id: string; controller: AbortController } | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly handlers: Partial<Record<JobType, JobHandler>>,
  ) {
    this.jobs = new JobRepository(ctx.db);
  }

  /** À appeler au démarrage : les travaux restés « en cours » sont marqués interrompus. */
  recover(): number {
    const n = this.jobs.markStaleAsInterrupted();
    if (n)
      this.ctx.log.warn({ count: n }, 'Travaux interrompus détectés au démarrage (relançables)');
    return n;
  }

  /** Ajoute un travail ; si le même est déjà actif pour cet enregistrement, le renvoie. */
  enqueue(recordingId: string, type: JobType): { job: JobDto; created: boolean } {
    if (!this.handlers[type])
      throw new AppError('VALIDATION_FAILED', `Type de travail inconnu : ${type}`);
    const active = this.jobs.findActive(recordingId, type);
    if (active) return { job: active, created: false };
    const job = this.jobs.create(randomUUID(), recordingId, type);
    this.ctx.log.info({ jobId: job.id, recordingId, type }, 'Travail ajouté à la file');
    this.kick();
    return { job, created: true };
  }

  cancel(jobId: string): JobDto {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('NOT_FOUND', 'Travail introuvable');
    if (job.status === 'queued') {
      this.jobs.finish(jobId, 'cancelled');
    } else if (job.status === 'running' && this.current?.id === jobId) {
      this.current.controller.abort();
    } else {
      throw new AppError('CONFLICT', `Travail déjà terminé (${job.status})`);
    }
    return this.jobs.get(jobId)!;
  }

  /** Attend que la file soit vide (utile aux tests et au CLI). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  /** Arrêt propre : le travail en cours est interrompu et marqué comme tel. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.current) this.current.controller.abort('shutdown');
    await this.idle();
  }

  private kick() {
    if (this.loop || this.stopped) return;
    this.loop = this.drain().finally(() => {
      this.loop = null;
      // Un travail a pu être ajouté entre la dernière lecture de la file et cette ligne.
      if (!this.stopped && this.jobs.nextQueued()) this.kick();
    });
  }

  private async drain() {
    for (;;) {
      if (this.stopped) return;
      const job = this.jobs.nextQueued();
      if (!job) return;
      await this.execute(job);
    }
  }

  private async execute(job: JobDto) {
    const handler = this.handlers[job.type]!;
    const controller = new AbortController();
    this.current = { id: job.id, controller };
    this.jobs.markRunning(job.id);
    const log = { jobId: job.id, recordingId: job.recordingId, type: job.type };
    this.ctx.log.info(log, 'Travail démarré');
    const started = Date.now();

    let lastWrite = 0;
    const reportProgress = (ratio: number) => {
      const now = Date.now();
      if (now - lastWrite < PROGRESS_MIN_INTERVAL_MS && ratio < 1) return;
      lastWrite = now;
      this.jobs.setProgress(job.id, ratio);
    };

    try {
      await handler(job, { signal: controller.signal, reportProgress });
      this.jobs.finish(job.id, 'succeeded');
      this.ctx.log.info({ ...log, elapsedMs: Date.now() - started }, 'Travail terminé');
    } catch (err) {
      if (controller.signal.aborted) {
        const shutdown = controller.signal.reason === 'shutdown';
        this.jobs.finish(job.id, shutdown ? 'interrupted' : 'cancelled', {
          code: shutdown ? 'INTERRUPTED' : 'CANCELLED',
          message: shutdown ? 'Interrompu par l’arrêt du serveur' : 'Annulé par l’utilisateur',
        });
        this.ctx.log.warn(log, shutdown ? 'Travail interrompu' : 'Travail annulé');
      } else {
        const code = isAppError(err) ? err.code : 'INTERNAL';
        const message = err instanceof Error ? err.message : String(err);
        this.jobs.finish(job.id, 'failed', { code, message });
        this.ctx.log.error(
          { ...log, err, code, details: isAppError(err) ? err.details : undefined },
          'Travail en échec',
        );
      }
    } finally {
      this.current = null;
    }
  }
}
