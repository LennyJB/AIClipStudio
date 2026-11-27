/**
 * Types de contenu et segmentation temporelle (étape 9).
 *
 *  - détection AUTOMATIQUE, locale (job `detect_content_types`, voie « analysis ») : réutilise
 *    le matériel de l'analyse locale (segments transcrits, signaux, profil de jeu) et mesure
 *    l'activité de l'image avec FFmpeg. Aucun appel à Claude API, aucun service externe ;
 *  - CORRECTION par le créateur : segmentation complète qui remplace la détection (confiance 1),
 *    ou retour explicite à la détection automatique. Journal en ajout seul, idempotent ;
 *  - la segmentation effective est lue par l'analyse éditoriale (`ContentRepository.effective`).
 */
import { z } from 'zod';
import {
  GENERIC_GAME_PROFILE_ID,
  detectContentTypes,
  loadContentProfiles,
  normalizeManualSegments,
  stableHash,
  summarizeContent,
  type VisualSample,
} from '@acs/editorial';
import { scanVisualActivity } from '@acs/media';
import { AppError, ContentSegmentInputSchema } from '@acs/shared';
import type { AnalysisService, ContentStatus } from '../analysis/service';
import type { AppContext } from '../context';
import type { DerivativeService } from '../derivatives/service';
import type { JobHandler, JobHandlerContext, JobRunner } from '../jobs/runner';
import { JobRepository, RecordingRepository, type JobDto } from '../recordings/repository';
import { contentDetectionKey } from './key';
import {
  ContentRepository,
  type ContentCorrectionDto,
  type ContentDetectionDto,
} from './repository';

export const DetectRequestSchema = z
  .object({
    /** Refaire la détection même si une détection identique existe. */
    force: z.boolean().default(false),
  })
  .strict();

export const CorrectionSchema = z
  .object({
    /** Identifiant d'idempotence choisi par le client (renvoyer la même requête est sans effet). */
    requestId: z.string().min(8).max(100),
    /** Segmentation complète (contiguë, couvrant tout l'enregistrement), ou null : revenir à l'automatique. */
    segments: z.array(ContentSegmentInputSchema).min(1).max(500).nullable(),
  })
  .strict();
export type CorrectionInput = z.infer<typeof CorrectionSchema>;

const JobParams = z.object({ recordingId: z.uuid(), force: z.boolean() }).strict();

export interface ContentTypesView {
  recordingId: string;
  durationMs: number | null;
  detection: (ContentDetectionDto & { stale: boolean | null }) | null;
  correction: ContentCorrectionDto | null;
  /** Segmentation utilisée par l'analyse (null : aucune, comportement d'avant l'étape 9). */
  effective: {
    source: 'manual' | 'auto';
    segments: {
      startMs: number;
      endMs: number;
      type: string;
      confidence: number;
      source: string;
    }[];
    summary: ReturnType<typeof summarizeContent>;
  } | null;
  /**
   * Ce que la prochaine analyse éditoriale fera de cette segmentation (même règle que
   * `resolveContent`) ; null si l'état ne peut pas être établi (transcription absente…).
   */
  analysis: ContentStatus | null;
  job: JobDto | null;
}

export class ContentTypeService {
  readonly repo: ContentRepository;
  private readonly recordings: RecordingRepository;
  private readonly jobs: JobRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly runnerRef: () => JobRunner,
    private readonly analysis: AnalysisService,
    private readonly derivatives: DerivativeService,
  ) {
    this.repo = new ContentRepository(ctx.db);
    this.recordings = new RecordingRepository(ctx.db);
    this.jobs = new JobRepository(ctx.db);
  }

  private recording(recordingId: string) {
    const rec = this.recordings.get(recordingId);
    if (!rec) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return rec;
  }

  private targetKey(recordingId: string) {
    return `detect_content_types:${recordingId}`;
  }

  /**
   * Clé d'entrée d'une détection : ce qui la détermine (transcriptions, original, profils,
   * version du détecteur). Indépendante des corrections : une correction ne périme rien.
   */
  private async detectionKey(recordingId: string) {
    const inp = await this.analysis.inputs(recordingId);
    const profiles = await loadContentProfiles(this.ctx.config.paths.profiles);
    const key = contentDetectionKey({
      fingerprint: this.recordings.getSource(recordingId)?.fingerprint,
      transcriptions: inp.transcriptions,
      audioTracks: inp.rec.audioTracks,
      game: inp.game,
      contentProfiles: profiles,
      hasVideo: Boolean(inp.rec.video?.width),
    });
    return { key, inp, profiles };
  }

  private durationMs(recordingId: string): number | null {
    const d = this.repo.latestDetection(recordingId);
    if (d) return d.detection.durationMs;
    const rec = this.recording(recordingId);
    return rec.durationSec ? Math.round(rec.durationSec * 1000) : null;
  }

  async view(recordingId: string): Promise<ContentTypesView> {
    this.recording(recordingId);
    const detection = this.repo.latestDetection(recordingId);
    let stale: boolean | null = null;
    let analysis: ContentStatus | null = null;
    try {
      // Même calcul que l'analyse : une seule source de vérité.
      const inp = await this.analysis.inputs(recordingId);
      analysis = inp.contentStatus;
      if (detection) stale = (await this.detectionKey(recordingId)).key !== detection.inputKey;
    } catch {
      // transcription absente, profil invalide… : on ne sait pas.
    }
    const eff = this.repo.effective(recordingId);
    const durationMs = this.durationMs(recordingId);
    return {
      recordingId,
      durationMs,
      detection: detection ? { ...detection, stale } : null,
      correction: this.repo.latestCorrection(recordingId),
      analysis,
      effective: eff
        ? {
            source: eff.source,
            segments: eff.segments,
            summary: summarizeContent(eff.segments, durationMs ?? eff.segments.at(-1)!.endMs),
          }
        : null,
      job: this.jobs.findActiveByTarget(this.targetKey(recordingId)),
    };
  }

  /** Demande une détection (job). Déjà faite avec les mêmes entrées : renvoyée telle quelle. */
  async requestDetection(
    recordingId: string,
    body: z.input<typeof DetectRequestSchema> = {},
  ): Promise<{ status: 'ready' | 'pending'; job: JobDto | null; view: ContentTypesView }> {
    const opts = DetectRequestSchema.parse(body);
    this.recording(recordingId);
    // Vérifie tout de suite que la détection est possible (transcription terminée, profils valides).
    const { key } = await this.detectionKey(recordingId);
    const latest = this.repo.latestDetection(recordingId);
    if (!opts.force && latest?.inputKey === key) {
      return { status: 'ready', job: null, view: await this.view(recordingId) };
    }
    const { job } = this.runnerRef().enqueue({
      type: 'detect_content_types',
      lane: 'analysis',
      targetKey: this.targetKey(recordingId),
      recordingId,
      params: { recordingId, force: opts.force },
    });
    return { status: 'pending', job, view: await this.view(recordingId) };
  }

  handlers(): { detect_content_types: JobHandler } {
    return { detect_content_types: (job, hctx) => this.runJob(job, hctx) };
  }

  private async runJob(job: JobDto, { signal, reportProgress }: JobHandlerContext) {
    const { recordingId, force } = JobParams.parse(job.params);
    const { key, inp, profiles } = await this.detectionKey(recordingId);
    const latest = this.repo.latestDetection(recordingId);
    if (!force && latest?.inputKey === key) return { detectionId: latest.id, reused: true };

    // 1. Matériel de l'analyse locale (mêmes segments, mêmes signaux).
    const c = await this.analysis.buildContext(inp);
    reportProgress(0.2);
    if (signal.aborted) throw new AppError('CANCELLED', 'Détection annulée');

    // 2. Activité de l'image (lecture seule de l'original), si une vidéo existe.
    let visual: VisualSample[] | null = null;
    let visualIssue: string | null = null;
    if (inp.rec.video?.width) {
      const { sourcePath, fp } = this.derivatives.sourceInfo(recordingId);
      await this.derivatives.assertSourceUnchanged(sourcePath, fp);
      try {
        visual = await scanVisualActivity(this.ctx.config.tools.ffmpeg, sourcePath, { signal });
      } catch (err) {
        if (signal.aborted || (err instanceof AppError && err.code === 'CANCELLED')) throw err;
        if (err instanceof AppError && err.code === 'TOOL_MISSING') throw err;
        visualIssue = 'Mesure de l’activité de l’image impossible sur ce fichier.';
        this.ctx.log.warn({ recordingId }, visualIssue);
      }
    }
    reportProgress(0.9);

    // 3. Détection (pure) et enregistrement.
    const detection = detectContentTypes({
      durationMs: c.durationMs,
      segments: c.segments,
      signals: c.signals,
      profiles,
      gameTermsMeaningful:
        inp.game.id !== GENERIC_GAME_PROFILE_ID && inp.game.vocabulary.length > 0,
      visual,
    });
    if (!inp.rec.video?.width) detection.limits.unshift('Aucune piste vidéo dans ce fichier.');
    if (visualIssue) detection.limits.unshift(visualIssue);
    const saved = this.repo.insertDetection(recordingId, key, detection);
    this.ctx.log.info(
      {
        recordingId,
        detectionId: saved.id,
        summary: detection.summary.kind,
        segments: detection.segments.length,
      },
      'Types de contenu détectés',
    );
    return { detectionId: saved.id, reused: false };
  }

  /**
   * Correction du créateur (ou retour à la détection automatique). Idempotente par `requestId` :
   * la même requête renvoyée ne crée rien ; un identifiant réutilisé pour un autre contenu est refusé.
   */
  async correct(recordingId: string, input: CorrectionInput): Promise<ContentTypesView> {
    this.recording(recordingId);
    const body = CorrectionSchema.parse(input);
    const durationMs = this.durationMs(recordingId);
    const segments =
      body.segments === null
        ? null
        : (() => {
            if (durationMs === null) {
              throw new AppError(
                'VALIDATION_FAILED',
                'Durée de l’enregistrement inconnue : lancez d’abord une détection',
              );
            }
            return normalizeManualSegments(body.segments, durationMs);
          })();
    const existing = this.repo.correctionByRequest(body.requestId);
    if (existing) {
      if (
        existing.recordingId !== recordingId ||
        stableHash(existing.segments) !== stableHash(segments)
      ) {
        throw new AppError(
          'IDEMPOTENCY_MISMATCH',
          'Identifiant de requête déjà utilisé pour une autre correction',
        );
      }
      return this.view(recordingId);
    }
    if (segments === null && !this.repo.latestCorrection(recordingId)?.segments) {
      // Déjà sur la détection automatique : rien à journaliser.
      return this.view(recordingId);
    }
    const detection = this.repo.latestDetection(recordingId);
    this.repo.insertCorrection({
      recordingId,
      basedOnDetectionId: detection?.id ?? null,
      segments,
      requestId: body.requestId,
    });
    this.ctx.log.info(
      { recordingId, segments: segments?.length ?? null },
      segments ? 'Types de contenu corrigés par le créateur' : 'Retour à la détection automatique',
    );
    return this.view(recordingId);
  }
}
