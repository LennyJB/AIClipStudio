/**
 * Rendus des clips (étape 6b, docs/plan-etape-6.md §6.5–6.9).
 *
 * Garanties :
 *  - un rendu n'est demandé, exécuté et PUBLIÉ que si la décision effective est « acceptée » ;
 *    la publication (renommage vers la destination) se fait sous le verrou d'écriture SQLite
 *    (BEGIN IMMEDIATE), dans la même transaction que la revérification : une proposition refusée
 *    ne peut jamais faire apparaître un export ;
 *  - un fichier n'est un export que si sa ligne `clip_renders` est `succeeded` ;
 *  - audio et sous-titres : la règle d'audio exporté est revérifiée par le plan de rendu ;
 *  - l'original n'est lu qu'en entrée de FFmpeg ; son intégrité (ensemble d'octets protégé) est
 *    vérifiée avant le rendu et son empreinte rapide après ;
 *  - tout fichier temporaire est supprimé par son chemin EXACT, jamais par motif ;
 *  - un arrêt entre le renommage et la validation en base est récupéré au démarrage.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fingerprintFile, runProcess } from '@acs/media';
import {
  buildRenderPlan,
  checkOutput,
  mergeSuggestedEffects,
  RENDER_ENGINE_VERSION,
  RenderPlanError,
  rmsEnvelope,
  runFrame,
  runRender,
  suggestEffects,
  type EnergyEnvelope,
  type RenderKind,
  type RenderPlan,
} from '@acs/render';
import { AppError, isAppError } from '@acs/shared';
import {
  canonicalJson,
  displayCaptions,
  projectSegments,
  projectWarnings,
  type ClipProject,
} from '@acs/timeline';
import type { AppContext } from '../context';
import type { JobHandler, JobHandlerContext, JobRunner } from '../jobs/runner';
import { ProposalRepository } from '../analysis/proposals';
import { RecordingRepository, type JobDto, type RecordingDto } from '../recordings/repository';
import { openServableFile, type OpenedFile } from '../review/servable-file';
import type { Source } from '../review/repository';
import { parse } from '../routes/validation';
import { toAbs, toRel } from '../storage/paths';
import type { ExportAudioService } from './export-audio';
import { exportDirName } from './naming';
import type { ClipProjectService } from './service';

export const FONTS_DIR = fileURLToPath(new URL('../../../../assets/fonts', import.meta.url));

export const RenderRequestSchema = z
  .object({ requestId: z.uuid(), kind: z.enum(['preview', 'final']) })
  .strict();
export const SuggestEffectsSchema = z
  .object({ requestId: z.uuid(), baseRevision: z.number().int().min(1) })
  .strict();

type RenderStatus =
  'queued' | 'running' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled' | 'evicted';

export interface RenderRow {
  id: string;
  projectId: string;
  revision: number;
  kind: RenderKind;
  status: RenderStatus;
  planHash: string;
  jobId: string | null;
  stagingRelPath: string | null;
  outputRelPath: string | null;
  outputSha256: string | null;
  srtRelPath: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  warnings: { code: string; message: string }[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const toRow = (r: Record<string, unknown>): RenderRow => ({
  id: r.id as string,
  projectId: r.project_id as string,
  revision: r.revision as number,
  kind: r.kind as RenderKind,
  status: r.status as RenderStatus,
  planHash: r.plan_hash as string,
  jobId: (r.job_id as string | null) ?? null,
  stagingRelPath: (r.staging_rel_path as string | null) ?? null,
  outputRelPath: (r.output_rel_path as string | null) ?? null,
  outputSha256: (r.output_sha256 as string | null) ?? null,
  srtRelPath: (r.srt_rel_path as string | null) ?? null,
  sizeBytes: (r.size_bytes as number | null) ?? null,
  durationMs: (r.duration_ms as number | null) ?? null,
  width: (r.width as number | null) ?? null,
  height: (r.height as number | null) ?? null,
  warnings: JSON.parse(r.warnings_json as string) as RenderRow['warnings'],
  errorCode: (r.error_code as string | null) ?? null,
  errorMessage: (r.error_message as string | null) ?? null,
  createdAt: r.created_at as string,
  finishedAt: (r.finished_at as string | null) ?? null,
});

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
/** Plafond de générations d'image fixe simultanées (tous projets). */
export const MAX_FRAME_GENERATIONS = 2;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return h.digest('hex');
}

interface Built {
  row: ReturnType<ClipProjectService['projectRow']>;
  revision: number;
  doc: ClipProject;
  rec: RecordingDto;
  sourcePath: string;
  fingerprint: string;
  plan: RenderPlan;
  planHash: string;
  audioStateHash: string;
  title: string;
  manifestSha: string;
  privacyHash: string | null;
}

/** Points d'arrêt injectables (tests de concurrence et de récupération uniquement). */
export interface RenderTestHooks {
  beforePublishLock?: (renderId: string) => void | Promise<void>;
  /** Récupération : après le recalcul du plan, juste avant la transaction de publication. */
  beforeRecoveryLock?: (renderId: string) => void | Promise<void>;
  afterRename?: (renderId: string) => void;
  beforeCommit?: (renderId: string) => void;
  /** Image fixe : juste avant le lancement de FFmpeg (signal d'arrêt transmis). */
  beforeFrameProcess?: (projectId: string, signal: AbortSignal) => void | Promise<void>;
}

export class RenderService {
  private readonly recordings: RecordingRepository;
  private readonly proposals: ProposalRepository;
  private toolchain: { ffmpeg: string } | null = null;
  hooks: RenderTestHooks = {};

  constructor(
    private readonly ctx: AppContext,
    private readonly clips: ClipProjectService,
    private readonly exportAudio: ExportAudioService,
    private readonly runnerRef: () => JobRunner,
  ) {
    this.recordings = new RecordingRepository(ctx.db);
    this.proposals = new ProposalRepository(ctx.db);
  }

  private get paths() {
    return this.ctx.config.paths;
  }

  /* -------------------------------- Lecture -------------------------------- */

  get(renderId: string): RenderRow {
    const r = this.ctx.db.prepare('SELECT * FROM clip_renders WHERE id = ?').get(renderId);
    if (!r) throw new AppError('NOT_FOUND', 'Rendu introuvable');
    return toRow(r as Record<string, unknown>);
  }

  list(projectId: string): RenderRow[] {
    this.clips.projectRow(projectId);
    return (
      this.ctx.db
        .prepare('SELECT * FROM clip_renders WHERE project_id = ? ORDER BY created_at DESC, id')
        .all(projectId) as Record<string, unknown>[]
    ).map(toRow);
  }

  view(renderId: string) {
    const r = this.get(renderId);
    const job = r.jobId
      ? (this.ctx.db.prepare('SELECT status, progress FROM jobs WHERE id = ?').get(r.jobId) as
          { status: string; progress: number } | undefined)
      : undefined;
    const decision = this.clips.guard.effective(this.clips.projectRow(r.projectId).proposalId);
    return {
      render: r,
      progress: r.status === 'succeeded' ? 1 : (job?.progress ?? 0),
      decisionChangedSinceExport:
        r.status === 'succeeded' && r.kind === 'final' && decision.status !== 'accepted',
    };
  }

  /* -------------------------------- Plan -------------------------------- */

  private audioStateHash(recordingId: string): string {
    return sha(canonicalJson(this.exportAudio.state(recordingId)));
  }

  /** Construit le plan à partir de l'état COURANT (document, accords, confidentialité). */
  private async build(projectId: string, kind: RenderKind): Promise<Built> {
    const row = this.clips.projectRow(projectId);
    const { rev, doc } = this.clips.current(row);
    const rec = this.recordings.get(row.recordingId);
    const src = this.recordings.getSource(row.recordingId);
    if (!rec || !src) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    const manifest = this.clips.repo.manifest(doc.source.integrityManifestId);
    if (!manifest) throw new AppError('NOT_FOUND', 'Manifeste d’intégrité introuvable');
    const audio = this.exportAudio.decisionFor(rec);
    // Pseudonymisation : fichier de confidentialité invalide ⇒ refus (jamais de repli sans).
    const pseudonymize = await this.clips.pseudonymizer();
    const privacy = await this.clipsPrivacyHash();
    const roles = doc.captions.enabled ? doc.captions.sources : [];
    const captions = displayCaptions(
      projectSegments(doc),
      doc.captions.items,
      doc.captions.corrections,
      {
        roles,
        pseudonymize,
      },
    );
    let plan: RenderPlan;
    try {
      plan = buildRenderPlan({
        project: doc,
        revision: rev.revision,
        kind,
        presetConfig: {
          finalCrf: this.ctx.config.render.finalCrf,
          x264Preset: this.ctx.config.render.x264Preset,
          previewHeight: this.ctx.config.render.previewHeight,
        },
        source: {
          width: rec.video?.width ?? null,
          height: rec.video?.height ?? null,
          fps: rec.video?.fps ?? null,
        },
        audio,
        captions,
        probeBytes: manifest.probeBytes,
      });
    } catch (err) {
      if (err instanceof RenderPlanError) {
        throw new AppError(
          err.code === 'MEDIA_UNSUPPORTED' ? 'MEDIA_UNSUPPORTED' : err.code,
          err.message,
          {
            details: err.details,
          },
        );
      }
      throw err;
    }
    const audioStateHash = this.audioStateHash(rec.id);
    const planHash = sha(
      canonicalJson({
        plan,
        manifest: manifest.sha256,
        audio: audioStateHash,
        privacy,
        engine: RENDER_ENGINE_VERSION,
      }),
    );
    const title = this.proposals.getProposal(row.proposalId)?.title ?? 'clip';
    return {
      row,
      revision: rev.revision,
      doc,
      rec,
      sourcePath: src.sourcePath,
      fingerprint: src.fingerprint,
      plan,
      planHash,
      audioStateHash,
      title,
      manifestSha: manifest.sha256,
      privacyHash: privacy,
    };
  }

  /**
   * Empreinte du fichier de confidentialité, lue de façon SYNCHRONE : utilisable dans une
   * transaction SQLite, juste avant le renommage vers la destination.
   */
  private privacyHashSync(): string | null {
    const p = this.ctx.config.analysis.privacyFile;
    if (!existsSync(p)) return null;
    return sha(readFileSync(p));
  }

  private async clipsPrivacyHash(): Promise<string | null> {
    // L'empreinte du fichier de confidentialité entre dans celle du plan : un changement de
    // pseudonymes invalide les rendus antérieurs.
    const p = this.ctx.config.analysis.privacyFile;
    if (!existsSync(p)) return null;
    return sha(await readFile(p));
  }

  /* -------------------------------- Demande -------------------------------- */

  async request(projectId: string, body: unknown, source: Source) {
    const b = parse(RenderRequestSchema, body);
    void source;
    const row = this.clips.projectRow(projectId);
    this.clips.guard.assertAccepted(row.proposalId);
    const built = await this.build(projectId, b.kind);
    await this.assertDiskSpace(built.plan);

    const result = this.ctx.db
      .transaction(() => {
        this.clips.guard.assertAccepted(row.proposalId);
        const existing = this.ctx.db
          .prepare(
            `SELECT * FROM clip_renders WHERE plan_hash = ? AND kind = ?
               AND status IN ('queued','running','finalizing','succeeded')`,
          )
          .get(built.planHash, b.kind) as Record<string, unknown> | undefined;
        if (existing) return { id: existing.id as string, created: false };
        const id = randomUUID();
        this.ctx.db
          .prepare(
            `INSERT INTO clip_renders (id, project_id, revision, kind, status, plan_hash, warnings_json)
             VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
          )
          .run(
            id,
            projectId,
            built.revision,
            b.kind,
            built.planHash,
            JSON.stringify(projectWarnings(built.doc, built.revision)),
          );
        return { id, created: true };
      })
      .immediate();

    if (result.created) {
      const { job } = this.runnerRef().enqueue({
        type: 'render_clip',
        lane: b.kind === 'final' ? 'heavy' : 'interactive',
        targetKey: `render:${built.planHash}:${b.kind}`,
        recordingId: built.rec.id,
        params: { renderId: result.id },
        files: [
          { relPath: this.rel(this.workDir(result.id)), usage: 'output' },
          { relPath: this.rel(this.stagingDir(result.id, b.kind)), usage: 'output' },
        ],
      });
      this.ctx.db.prepare('UPDATE clip_renders SET job_id = ? WHERE id = ?').run(job.id, result.id);
    }
    return { ...this.view(result.id), created: result.created };
  }

  private async assertDiskSpace(plan: RenderPlan) {
    const mbps = plan.kind === 'final' ? 12 : 3;
    const needed = Math.round(((mbps * 1e6) / 8) * (plan.durationMs / 1000) * 1.5) + 50e6;
    const free = await statfs(this.paths.storage).then(
      (s) => s.bavail * s.bsize,
      () => Infinity,
    );
    if (free < needed) {
      throw new AppError('DISK_SPACE_LOW', 'Espace disque insuffisant pour ce rendu', {
        details: { neededBytes: needed, freeBytes: free },
      });
    }
  }

  /* -------------------------------- Chemins -------------------------------- */

  private rel(abs: string) {
    return toRel(this.paths.storage, abs);
  }
  private workDir(id: string) {
    return path.join(this.paths.processing, 'renders', 'tmp', id);
  }
  private stagingDir(id: string, kind: RenderKind) {
    // Zone d'attente sur le même volume que la destination (renommage atomique).
    return kind === 'final'
      ? path.join(this.paths.exports, '.staging', id)
      : path.join(this.paths.processing, 'renders', 'staging', id);
  }
  private destDir(id: string, kind: RenderKind, title: string) {
    return kind === 'final'
      ? path.join(this.paths.exports, exportDirName(title, id, new Date()))
      : path.join(this.paths.processing, 'renders', 'previews', id);
  }

  /* -------------------------------- Exécution -------------------------------- */

  handlers(): { render_clip: JobHandler } {
    return { render_clip: (job, hctx) => this.runJob(job, hctx) };
  }

  private setStatus(
    id: string,
    status: RenderStatus,
    extra: { code?: string; message?: string } = {},
  ) {
    this.ctx.db
      .prepare(
        `UPDATE clip_renders SET status = ?, error_code = COALESCE(?, error_code),
           error_message = COALESCE(?, error_message),
           finished_at = CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ${NOW} ELSE finished_at END
         WHERE id = ?`,
      )
      .run(status, extra.code ?? null, extra.message ?? null, status, id);
  }

  private async ffmpegVersion(): Promise<string> {
    if (!this.toolchain) {
      const r = await runProcess(this.ctx.config.tools.ffmpeg, ['-hide_banner', '-version']).catch(
        () => null,
      );
      this.toolchain = { ffmpeg: r?.stdout.split('\n')[0]?.trim() ?? 'inconnu' };
    }
    return this.toolchain.ffmpeg;
  }

  private async runJob(job: JobDto, hctx: JobHandlerContext) {
    const { renderId } = z.object({ renderId: z.uuid() }).parse(job.params);
    const r = this.get(renderId);
    if (r.status !== 'queued') return { skipped: r.status };
    this.setStatus(renderId, 'running');
    const work = this.workDir(renderId);
    const staging = this.stagingDir(renderId, r.kind);
    try {
      const proposalId = this.clips.projectRow(r.projectId).proposalId;
      this.clips.guard.assertAccepted(proposalId);
      await this.clips.verifySource(r.projectId);
      const built = await this.build(r.projectId, r.kind);
      if (built.planHash !== r.planHash) {
        throw new AppError(
          'VERSION_CONFLICT',
          'Le projet, les accords ou la confidentialité ont changé depuis la demande',
        );
      }
      await mkdir(work, { recursive: true });
      await mkdir(staging, { recursive: true });
      const part = path.join(staging, 'clip.mp4.part');
      await runRender({
        ffmpegPath: this.ctx.config.tools.ffmpeg,
        plan: built.plan,
        sourcePath: built.sourcePath,
        outputPath: part,
        workDir: work,
        fontsDir: FONTS_DIR,
        signal: hctx.signal,
        onProgress: (p) => hctx.reportProgress(p * 0.95),
      });
      const out = await checkOutput(this.ctx.config.tools.ffprobe, part, built.plan);
      // L'original n'a pas changé pendant le rendu.
      if ((await fingerprintFile(built.sourcePath)).hash !== built.fingerprint) {
        throw new AppError('MEDIA_SOURCE_CHANGED', 'L’original a changé pendant le rendu');
      }
      const video = path.join(staging, 'clip.mp4');
      await rename(part, video);
      if (built.plan.srt) await writeFile(path.join(staging, 'clip.srt'), built.plan.srt, 'utf8');
      if (r.kind === 'final') {
        await writeFile(
          path.join(staging, 'render.json'),
          `${JSON.stringify(await this.metadata(r, built), null, 2)}\n`,
          'utf8',
        );
      }
      const outputSha = await fileSha256(video);
      const size = statSync(video).size;
      const dest = this.destDir(renderId, r.kind, built.title);

      // Transaction A : chemins exacts et empreinte connus de la base (récupérable dès ici).
      this.ctx.db
        .prepare(
          `UPDATE clip_renders SET status = 'finalizing', staging_rel_path = ?, output_rel_path = ?,
             output_sha256 = ?, srt_rel_path = ?, size_bytes = ?, duration_ms = ?, width = ?, height = ?,
             toolchain_json = ? WHERE id = ?`,
        )
        .run(
          this.rel(staging),
          this.rel(path.join(dest, 'clip.mp4')),
          outputSha,
          built.plan.srt ? this.rel(path.join(dest, 'clip.srt')) : null,
          size,
          out.durationMs,
          out.width,
          out.height,
          JSON.stringify({
            ffmpeg: await this.ffmpegVersion(),
            engine: RENDER_ENGINE_VERSION,
            // État exact utilisé pour ce rendu : relu par la récupération pour expliquer un refus.
            guard: { audioStateHash: built.audioStateHash, privacyHash: built.privacyHash },
          }),
          renderId,
        );
      hctx.reportProgress(0.97);
      // Dernière vérification asynchrone (fichier de confidentialité) avant le verrou.
      const again = await this.build(r.projectId, r.kind);
      if (again.planHash !== r.planHash) {
        throw new AppError(
          'VERSION_CONFLICT',
          'Le projet, les accords ou la confidentialité ont changé pendant le rendu',
        );
      }
      await this.hooks.beforePublishLock?.(renderId);
      await this.publish(renderId, built.audioStateHash, built.privacyHash);
      hctx.reportProgress(1);
      return { renderId, status: this.get(renderId).status };
    } catch (err) {
      const cur = this.get(renderId);
      if (cur.status !== 'succeeded') {
        const cancelled = hctx.signal.aborted || (isAppError(err) && err.code === 'CANCELLED');
        this.setStatus(renderId, cancelled ? 'cancelled' : 'failed', {
          code: isAppError(err) ? err.code : 'RENDER_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
        await rm(staging, { recursive: true, force: true });
      }
      throw err;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private async metadata(r: RenderRow, b: Built) {
    const consent = this.exportAudio.state(b.rec.id);
    return {
      renderId: r.id,
      kind: r.kind,
      projectId: r.projectId,
      revision: r.revision,
      proposalId: b.row.proposalId,
      recordingId: b.rec.id,
      planHash: r.planHash,
      engineVersion: RENDER_ENGINE_VERSION,
      sourceIntegrity: b.manifestSha,
      durationMs: b.plan.durationMs,
      fps: b.plan.fps,
      audio: {
        tracks: b.plan.audio.tracks.map((t) => ({
          audioIndex: t.audioIndex,
          role: t.role,
          gainDb: t.gainDb,
        })),
        loudnormLufs: b.plan.audio.loudnorm ? -14 : null,
        silent: b.plan.audio.silent,
        consents: consent.consents,
        declarations: {
          mix: consent.mixComposition,
          game: consent.gameComposition,
          mic: consent.micComposition,
        },
      },
      captions: {
        sources: b.doc.captions.enabled ? b.doc.captions.sources : [],
        lines: b.plan.captionLines,
        corrections: b.doc.captions.corrections.length,
        pseudonymized: true,
      },
      layout: b.doc.layout.preset,
      masksDisabled: b.doc.layout.masks.filter((m) => m.mode === 'off').length,
      effects: b.plan.effects.map((e) => e.type),
      warnings: projectWarnings(b.doc, b.revision).map((w) => w.code),
      toolchain: { ffmpeg: await this.ffmpegVersion() },
      createdAt: new Date().toISOString(),
    };
  }

  /* ------------------------------ Publication ------------------------------ */

  /**
   * Transaction B (BEGIN IMMEDIATE) : décision effective, révision et accords revérifiés SOUS LE
   * VERROU, puis renommage de la zone d'attente vers la destination PENDANT que le verrou est
   * tenu, puis `succeeded`. Une décision de revue (qui prend le même verrou) est donc ordonnée
   * strictement avant ou après : jamais d'export pour une proposition déjà refusée.
   */
  private async publish(
    renderId: string,
    audioStateHash: string,
    privacyHash: string | null,
    attempt = 1,
  ): Promise<void> {
    const r = this.get(renderId);
    const staging = toAbs(this.paths.storage, r.stagingRelPath!);
    const dest = path.dirname(toAbs(this.paths.storage, r.outputRelPath!));
    let renamed = false;
    let refusal: AppError | null = null;
    try {
      this.ctx.db
        .transaction(() => {
          const project = this.clips.projectRow(r.projectId);
          const decision = this.clips.guard.effective(project.proposalId);
          if (decision.status !== 'accepted' || decision.merged) {
            refusal = new AppError('PROPOSAL_NOT_ACCEPTED', 'La décision a changé : export annulé');
          } else if (project.currentRevision !== r.revision) {
            refusal = new AppError('VERSION_CONFLICT', 'Le projet a été modifié pendant le rendu');
          } else if (this.audioStateHash(project.recordingId) !== audioStateHash) {
            refusal = new AppError(
              'EXPORT_CONSENT_REQUIRED',
              'Les accords ou déclarations audio ont changé pendant le rendu',
            );
          } else if (this.privacyHashSync() !== privacyHash) {
            // Dernière lecture, sous le verrou, juste avant le renommage.
            refusal = new AppError(
              'VERSION_CONFLICT',
              'Fichier de confidentialité modifié pendant le rendu : non publié',
            );
          }
          if (refusal) {
            this.setStatus(renderId, 'failed', { code: refusal.code, message: refusal.message });
            return;
          }
          if (existsSync(dest))
            throw new AppError('CONFLICT', 'Destination d’export déjà existante');
          mkdirSync(path.dirname(dest), { recursive: true });
          renameSync(staging, dest);
          renamed = true;
          this.hooks.afterRename?.(renderId);
          this.ctx.db
            .prepare(
              `UPDATE clip_renders SET status = 'succeeded', finished_at = ${NOW} WHERE id = ?`,
            )
            .run(renderId);
          this.hooks.beforeCommit?.(renderId);
        })
        .immediate();
    } catch (err) {
      // Échec du COMMIT (ou d'une étape après le renommage) : renommage inverse. Si lui aussi
      // échoue, la récupération du démarrage traitera le cas (état `finalizing` en base).
      if (renamed && existsSync(dest) && !existsSync(staging)) {
        try {
          renameSync(dest, staging);
        } catch {
          /* laissé à la récupération */
        }
      }
      const transient = !renamed && attempt < 3 && !(isAppError(err) && err.code === 'CONFLICT');
      if (transient && !isAppError(err)) {
        await new Promise((res) => setTimeout(res, 250 * attempt));
        return this.publish(renderId, audioStateHash, privacyHash, attempt + 1);
      }
      throw isAppError(err)
        ? err
        : new AppError('RENDER_FAILED', 'Publication du rendu impossible', { cause: err });
    }
    if (refusal) {
      await rm(staging, { recursive: true, force: true });
      throw refusal;
    }
  }

  /* ------------------------------ Récupération ------------------------------ */

  /** Au démarrage (après `runner.recover()`) : rendus en cours sans travail actif ⇒ échec. */
  recoverStale(): number {
    const stale = (
      this.ctx.db
        .prepare(
          `SELECT r.* FROM clip_renders r LEFT JOIN jobs j ON j.id = r.job_id
           WHERE r.status IN ('queued','running') AND (j.id IS NULL OR j.status NOT IN ('queued','running'))`,
        )
        .all() as Record<string, unknown>[]
    ).map(toRow);
    for (const r of stale) {
      this.setStatus(r.id, 'failed', {
        code: 'CANCELLED',
        message: 'Interrompu (arrêt du serveur)',
      });
      rmSync(this.workDir(r.id), { recursive: true, force: true });
      rmSync(this.stagingDir(r.id, r.kind), { recursive: true, force: true });
    }
    if (stale.length) this.ctx.log.warn({ count: stale.length }, 'Rendus interrompus au démarrage');
    return stale.length;
  }

  /**
   * Récupération des rendus `finalizing` (arrêt entre la transaction A et la fin de la
   * publication), à ATTENDRE au démarrage avant tout autre travail (plan §6.7).
   *
   * Rien n'est publié sans que TOUT ce qui a permis le rendu soit encore vrai :
   *  1. le plan est recalculé à partir de l'état ACTUEL (document, accords et déclarations audio,
   *     fichier de confidentialité, intégrité de la source, version du moteur) et son empreinte
   *     doit être IDENTIQUE à celle du rendu — un accord retiré, une déclaration changée, des
   *     sous-titres qui ne sont plus autorisés ou un fichier de confidentialité modifié l'empêchent ;
   *  2. sous le verrou d'écriture : décision effective acceptée, même révision, et état audio
   *     inchangé depuis le recalcul (aucun retrait d'accord ne peut s'intercaler) ;
   *  3. l'empreinte de la vidéo correspond à celle enregistrée.
   * Sinon : le fichier n'a jamais été un export (sa ligne n'a jamais été `succeeded`) ; il est
   * SUPPRIMÉ (accord retiré, décision ou plan changés) ou mis en QUARANTAINE (contenu inattendu
   * alors que tout le reste est valide), et la ligne passe à `failed` avec la raison précise.
   */
  async recoverFinalizing(): Promise<{
    published: number;
    withdrawn: number;
    quarantined: number;
  }> {
    const stats = { published: 0, withdrawn: 0, quarantined: 0 };
    const finalizing = (
      this.ctx.db.prepare(`SELECT * FROM clip_renders WHERE status = 'finalizing'`).all() as Record<
        string,
        unknown
      >[]
    ).map(toRow);
    for (const r of finalizing) {
      const staging = toAbs(this.paths.storage, r.stagingRelPath!);
      const video = toAbs(this.paths.storage, r.outputRelPath!);
      const dest = path.dirname(video);
      const destVideoSha = existsSync(video) ? await fileSha256(video) : null;
      const stored = this.storedGuard(r.id);

      // 1. Plan recalculé à partir de l'état actuel (asynchrone : confidentialité, sous-titres).
      let refusal: AppError | null = null;
      let fresh: Built | null = null;
      try {
        fresh = await this.build(r.projectId, r.kind);
        if (fresh.planHash !== r.planHash) refusal = this.explainPlanChange(stored, fresh);
      } catch (err) {
        refusal = isAppError(err)
          ? err
          : new AppError('RENDER_FAILED', 'Plan de rendu impossible à recalculer');
      }

      await this.hooks.beforeRecoveryLock?.(r.id);
      // Empreinte de confidentialité attendue : celle du rendu (enregistrée au passage en
      // « finalizing »), à défaut celle du plan recalculé (identique si le plan l'est).
      const expectedPrivacy =
        stored.privacyHash !== undefined ? stored.privacyHash : (fresh?.privacyHash ?? null);

      // 2. Décision sous verrou, puis publication ou retrait.
      this.ctx.db
        .transaction(() => {
          const project = this.clips.projectRow(r.projectId);
          const d = this.clips.guard.effective(project.proposalId);
          if (!refusal && (d.status !== 'accepted' || d.merged)) {
            refusal = new AppError(
              'PROPOSAL_NOT_ACCEPTED',
              'Décision changée avant la publication',
            );
          } else if (!refusal && project.currentRevision !== r.revision) {
            refusal = new AppError('VERSION_CONFLICT', 'Projet modifié avant la publication');
          } else if (
            !refusal &&
            fresh &&
            this.audioStateHash(project.recordingId) !== fresh.audioStateHash
          ) {
            refusal = new AppError(
              'EXPORT_CONSENT_REQUIRED',
              'Accords ou déclarations audio modifiés pendant la récupération',
            );
          } else if (!refusal && this.privacyHashSync() !== expectedPrivacy) {
            // Relu sous le verrou, juste avant tout renommage : un fichier de confidentialité
            // modifié après le recalcul du plan ne laisse jamais publier un ancien rendu.
            refusal = new AppError(
              'VERSION_CONFLICT',
              'Fichier de confidentialité modifié pendant la récupération : non publié',
            );
          }
          const stagingExists = existsSync(staging);
          const destExists = existsSync(dest);
          const remove = (dir: string) => {
            // Jamais devenu un export : retiré (renommé hors de la zone visible, puis supprimé).
            const tmp = path.join(this.paths.exports, '.staging', `${r.id}.retire`);
            mkdirSync(path.dirname(tmp), { recursive: true });
            renameSync(dir, tmp);
            rmSync(tmp, { recursive: true, force: true });
          };
          if (refusal) {
            if (destExists) remove(dest);
            if (stagingExists) rmSync(staging, { recursive: true, force: true });
            this.setStatus(r.id, 'failed', { code: refusal.code, message: refusal.message });
            stats.withdrawn++;
            return;
          }
          if (destExists) {
            if (destVideoSha === r.outputSha256) {
              this.setStatus(r.id, 'succeeded');
              stats.published++;
            } else {
              // Contenu inattendu alors que tout est valide : quarantaine, jamais supprimé.
              const q = path.join(this.paths.exports, '.staging', 'quarantine', r.id);
              mkdirSync(path.dirname(q), { recursive: true });
              renameSync(dest, q);
              this.setStatus(r.id, 'failed', {
                code: 'RENDER_FAILED',
                message: 'Empreinte inattendue : mis en quarantaine',
              });
              stats.quarantined++;
            }
            if (stagingExists) rmSync(staging, { recursive: true, force: true });
          } else if (stagingExists) {
            const stagedSha = existsSync(path.join(staging, 'clip.mp4'))
              ? sha(readFileSync(path.join(staging, 'clip.mp4')))
              : null;
            if (stagedSha !== r.outputSha256) {
              const q = path.join(this.paths.exports, '.staging', 'quarantine', r.id);
              mkdirSync(path.dirname(q), { recursive: true });
              renameSync(staging, q);
              this.setStatus(r.id, 'failed', {
                code: 'RENDER_FAILED',
                message: 'Empreinte inattendue : mis en quarantaine',
              });
              stats.quarantined++;
              return;
            }
            mkdirSync(path.dirname(dest), { recursive: true });
            renameSync(staging, dest);
            this.setStatus(r.id, 'succeeded');
            stats.published++;
          } else {
            this.setStatus(r.id, 'failed', {
              code: 'RENDER_FAILED',
              message: 'Fichiers du rendu introuvables',
            });
          }
        })
        .immediate();
    }
    if (finalizing.length) this.ctx.log.warn(stats, 'Rendus en publication récupérés au démarrage');
    return stats;
  }

  private storedGuard(renderId: string): { audioStateHash?: string; privacyHash?: string | null } {
    const row = this.ctx.db
      .prepare('SELECT toolchain_json FROM clip_renders WHERE id = ?')
      .get(renderId) as { toolchain_json: string | null } | undefined;
    try {
      return (
        (
          JSON.parse(row?.toolchain_json ?? '{}') as {
            guard?: { audioStateHash?: string; privacyHash?: string | null };
          }
        ).guard ?? {}
      );
    } catch {
      return {};
    }
  }

  /** Raison lisible d'un plan qui ne correspond plus à celui du rendu. */
  private explainPlanChange(
    stored: { audioStateHash?: string; privacyHash?: string | null },
    fresh: Built,
  ): AppError {
    if (stored.audioStateHash !== undefined && stored.audioStateHash !== fresh.audioStateHash) {
      return new AppError(
        'EXPORT_CONSENT_REQUIRED',
        'Accords ou déclarations audio modifiés depuis le rendu : non publié',
      );
    }
    if (stored.privacyHash !== undefined && stored.privacyHash !== fresh.privacyHash) {
      return new AppError(
        'VERSION_CONFLICT',
        'Fichier de confidentialité modifié depuis le rendu : non publié',
      );
    }
    return new AppError(
      'VERSION_CONFLICT',
      'Projet ou source modifiés depuis le rendu : non publié',
    );
  }

  /* ------------------------------- Annulation ------------------------------- */

  cancel(renderId: string) {
    const r = this.get(renderId);
    if (!r.jobId || !['queued', 'running'].includes(r.status)) {
      throw new AppError('CONFLICT', `Rendu déjà terminé (${r.status})`);
    }
    this.runnerRef().cancel(r.jobId);
    if (r.status === 'queued')
      this.setStatus(renderId, 'cancelled', { code: 'CANCELLED', message: 'Annulé' });
    return this.view(renderId);
  }

  /**
   * Une décision de revue a changé : les rendus en attente ou en cours des propositions
   * concernées sont annulés (économie de calcul ; la garantie reste la publication sous verrou).
   */
  cancelForProposals(proposalIds: readonly string[]) {
    if (!proposalIds.length) return 0;
    const rows = this.ctx.db
      .prepare(
        `SELECT r.id, r.job_id, r.status FROM clip_renders r JOIN clip_projects p ON p.id = r.project_id
         WHERE p.proposal_id IN (${proposalIds.map(() => '?').join(',')}) AND r.status IN ('queued','running')`,
      )
      .all(...proposalIds) as { id: string; job_id: string | null; status: string }[];
    for (const r of rows) {
      try {
        if (r.job_id) this.runnerRef().cancel(r.job_id);
      } catch {
        /* déjà terminé */
      }
      if (r.status === 'queued')
        this.setStatus(r.id, 'cancelled', {
          code: 'PROPOSAL_NOT_ACCEPTED',
          message: 'Décision changée',
        });
    }
    return rows.length;
  }

  /* -------------------------------- Fichiers -------------------------------- */

  /** Ouvre la vidéo d'un rendu réussi (chemin lu en base, jamais dans la requête). */
  async openVideo(renderId: string): Promise<OpenedFile & { kind: RenderKind }> {
    const r = this.get(renderId);
    if (r.status !== 'succeeded' || !r.outputRelPath) {
      throw new AppError('NOT_READY', 'Rendu indisponible');
    }
    const allowed =
      r.kind === 'final'
        ? this.paths.exports
        : path.join(this.paths.processing, 'renders', 'previews');
    const f = await openServableFile(toAbs(this.paths.storage, r.outputRelPath), allowed, '.mp4');
    if (r.kind === 'preview') {
      this.ctx.db
        .prepare(`UPDATE clip_renders SET last_served_at = ${NOW} WHERE id = ?`)
        .run(renderId);
    }
    return { ...f, kind: r.kind };
  }

  async openSubtitles(renderId: string): Promise<OpenedFile> {
    const r = this.get(renderId);
    if (r.status !== 'succeeded' || !r.srtRelPath)
      throw new AppError('NOT_READY', 'Sous-titres indisponibles');
    const allowed =
      r.kind === 'final'
        ? this.paths.exports
        : path.join(this.paths.processing, 'renders', 'previews');
    return openServableFile(toAbs(this.paths.storage, r.srtRelPath), allowed, '.srt');
  }

  downloadName(renderId: string): string {
    const r = this.get(renderId);
    if (r.kind !== 'final') throw new AppError('CONFLICT', 'Seul un export final se télécharge');
    return `${path.basename(path.dirname(r.outputRelPath ?? 'clip'))}.mp4`;
  }

  /** Générations d'image fixe en cours : au plus une par projet (la plus récente l'emporte). */
  private readonly frames = new Map<string, AbortController>();
  /** Plafond global (modifiable par les tests uniquement). */
  maxFrameGenerations = MAX_FRAME_GENERATIONS;

  /**
   * Image fixe de la disposition (même graphe que le rendu, sans sous-titres ni zoom).
   *
   * Annulation EFFECTIVE côté serveur (docs/plan-etape-6.md §19) :
   *  - `signal` (déconnexion du client) arrête FFmpeg ;
   *  - une demande plus récente sur le même projet arrête la précédente (`CANCELLED`) ;
   *  - au plus MAX_FRAME_GENERATIONS projets génèrent une image en même temps : au-delà, refus
   *    immédiat (`CONFLICT`), jamais de file d'attente.
   * L'arrêt n'est pas instantané : un FFmpeg remplacé peut survivre brièvement à son ordre d'arrêt.
   */
  async frame(projectId: string, atEditMs: number, signal?: AbortSignal): Promise<Buffer> {
    this.clips.projectRow(projectId);
    const previous = this.frames.get(projectId);
    if (!previous && this.frames.size >= this.maxFrameGenerations) {
      throw new AppError(
        'CONFLICT',
        'Génération d’image déjà en cours pour d’autres clips : réessayez dans un instant',
        { details: { reason: 'frame_busy' } },
      );
    }
    const ctrl = new AbortController();
    this.frames.set(projectId, ctrl);
    previous?.abort();
    const onClientAbort = () => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    signal?.addEventListener('abort', onClientAbort, { once: true });
    const work = path.join(this.paths.processing, 'renders', 'tmp', `image-${randomUUID()}`);
    try {
      const built = await this.build(projectId, 'preview');
      if (ctrl.signal.aborted) throw new AppError('CANCELLED', 'Image remplacée ou abandonnée');
      await mkdir(work, { recursive: true });
      const out = path.join(work, 'image.jpg');
      await this.hooks.beforeFrameProcess?.(projectId, ctrl.signal);
      await runFrame({
        ffmpegPath: this.ctx.config.tools.ffmpeg,
        plan: built.plan,
        sourcePath: built.sourcePath,
        outputPath: out,
        workDir: work,
        fontsDir: FONTS_DIR,
        atEditMs,
        signal: ctrl.signal,
      });
      return await readFile(out);
    } catch (err) {
      if (ctrl.signal.aborted) throw new AppError('CANCELLED', 'Image remplacée ou abandonnée');
      throw err;
    } finally {
      signal?.removeEventListener('abort', onClientAbort);
      if (this.frames.get(projectId) === ctrl) this.frames.delete(projectId);
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Nombre de générations d'image en cours (tests et diagnostic). */
  activeFrameGenerations(): number {
    return this.frames.size;
  }

  /* -------------------------------- Effets -------------------------------- */

  /** Énergie de la piste micro sur le clip (calcul LOCAL : rien n'est exporté). */
  private async micEnergy(
    doc: ClipProject,
    rec: RecordingDto,
    sourcePath: string,
  ): Promise<EnergyEnvelope | null> {
    const mic = rec.audioTracks.find((t) => t.role === 'mic');
    const seg = doc.segments[0];
    if (!mic || !seg || seg.kind !== 'source') return null;
    const work = path.join(this.paths.processing, 'renders', 'tmp', `energie-${randomUUID()}`);
    await mkdir(work, { recursive: true });
    try {
      const raw = path.join(work, 'micro.raw');
      const r = await runProcess(this.ctx.config.tools.ffmpeg, [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-loglevel',
        'error',
        '-ss',
        (seg.srcStartMs / 1000).toFixed(3),
        '-i',
        sourcePath,
        '-t',
        ((seg.srcEndMs - seg.srcStartMs) / 1000).toFixed(3),
        '-map',
        `0:a:${mic.audioIndex}`,
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        raw,
      ]);
      if (r.exitCode !== 0) return null;
      const buf = await readFile(raw);
      const copy = Buffer.from(buf);
      return rmsEnvelope(
        new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2)),
        8000,
        seg.srcStartMs,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async suggest(projectId: string, body: unknown) {
    const b = parse(SuggestEffectsSchema, body);
    const row = this.clips.projectRow(projectId);
    this.clips.guard.assertAccepted(row.proposalId);
    const { doc } = this.clips.current(row);
    const rec = this.recordings.get(row.recordingId)!;
    const src = this.recordings.getSource(row.recordingId)!;
    const energy = doc.mode === 'enrichi' ? await this.micEnergy(doc, rec, src.sourcePath) : null;
    const proposed = suggestEffects({ project: doc, energy });
    const types = new Set(proposed.map((e) => e.type));
    let suggested: typeof proposed = [];
    const res = this.clips.writeSystemRevision(projectId, b, (d) => {
      // Aucun choix existant n'est modifié ; un nouveau type d'effet arrive désactivé.
      const effects = mergeSuggestedEffects(d.effects, proposed);
      suggested = effects.filter((e) => e.origin === 'auto' && types.has(e.type));
      return {
        project: { ...d, effects },
        summary: `effets proposés : ${proposed.map((e) => e.type).join(', ') || 'aucun'}`,
      };
    });
    return { ...res, suggested };
  }
}
