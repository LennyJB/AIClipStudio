/**
 * Analyse éditoriale — étape 4a : préparation LOCALE uniquement.
 * Aucun appel à Claude API n'est fait ici : on calcule les signaux et les fenêtres, on
 * prépare le contenu exact qui serait transmis, on l'écrit sur disque pour relecture, et
 * on estime les coûts sous le plafond. Les appels arriveront à l'étape 4b.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  buildCandidateWindows,
  buildTriageChunks,
  buildWindowPayload,
  computeSignals,
  createPseudonymizer,
  deepRequest,
  estimateTextTokens,
  DEFAULT_SIGNAL_PROVIDERS,
  estimateAnalysis,
  imageTokens,
  loadCreatorProfile,
  loadFramingProfile,
  loadGameProfile,
  listFramingProfiles,
  PAYLOAD_VERSION,
  PRICING_VERSION,
  pricingFor,
  profileHash,
  rankWindows,
  stableHash,
  SUMMARY_PLACEHOLDER,
  triageRequest,
  type AnalysisSegment,
  DEEP_PROMPT_VERSION,
  TRIAGE_PROMPT_VERSION,
  type EditorialModel,
  type EnergyTrack,
  type ModelRequest,
  type PreparedFrame,
  type RequestImage,
  type RenderStats,
  type Speaker,
} from '@acs/editorial';
import {
  outputSize,
  readWaveform,
  toPixelRect,
  extractFrame,
  type NormalizedRect,
} from '@acs/media';
import {
  AppError,
  effectiveClipDuration,
  PrivacyFileSchema,
  type FramingProfile,
  type PrivacyFile,
  type TrackRole,
} from '@acs/shared';
import type { AppContext } from '../context';
import type { DerivativeService, FrameRequest } from '../derivatives/service';
import type { JobHandler, JobHandlerContext, JobRunner } from '../jobs/runner';
import {
  JobRepository,
  RecordingRepository,
  type JobDto,
  type RecordingDto,
} from '../recordings/repository';
import { toAbs } from '../storage/paths';
import { TranscriptionRepository, type TranscriptionDto } from '../transcriptions/repository';
import { LlmCallRepository } from './calls';
import { ClaudeRunner } from './claude-run';
import { ProposalRepository } from './proposals';
import {
  AnalysisRepository,
  isAwaitingReview,
  type AnalysisRunDto,
  type AnalysisSettingsDto,
  type AnalysisWindowDto,
  type NewWindow,
} from './repository';
import {
  deepRequestName,
  recordedHash,
  REQUEST_FILE_RE,
  triageRequestName,
  writeRequestFile,
} from './request-files';

/** Version de la chaîne de préparation (fait partie de la clé d'entrée). */
export const ANALYSIS_PIPELINE_VERSION = 2; // 2 : requêtes exactes (prompts) dans la préparation

const SPEAKER_BY_ROLE: Partial<Record<TrackRole, Speaker>> = {
  mic: 'creator',
  discord: 'teammates',
  mix: 'mixed',
  unknown: 'mixed',
};

export const SettingsUpdateSchema = z
  .object({
    discordTextAllowed: z.boolean().optional(),
    /** Obligatoire pour accorder la transmission du texte Discord : qui a donné son accord, quand. */
    discordConsentNote: z
      .string()
      .trim()
      .min(3, 'au moins 3 caractères : précisez qui a donné son accord, et quand')
      .max(500)
      .optional(),
    facecamAllowed: z.boolean().optional(),
    /** Changer de profil annule sa validation. */
    framingProfileId: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .nullable()
      .optional(),
  })
  .strict();
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

export const AnalysisRequestSchema = z
  .object({
    /** `dry_run` : préparation locale, AUCUN appel. `claude` : analyse payante (confirmation requise). */
    mode: z.enum(['dry_run', 'claude']).default('dry_run'),
    /** Ancien paramètre de l'étape 4a (équivaut à mode = dry_run). */
    dryRun: z.literal(true).optional(),
    /** Refaire même si une analyse identique existe. */
    force: z.boolean().default(false),
    /** Mode claude : redemander à Claude même les requêtes déjà obtenues (payant). */
    forceRecall: z.boolean().default(false),
    /** Mode claude : plafond accepté par le créateur (doit être égal au plafond configuré). */
    acceptBudgetUsd: z.number().positive().optional(),
    /**
     * Mode claude : pause après le repérage pour relire les requêtes Opus avant tout envoi
     * (défaut). `false` enchaîne tout, explicitement.
     */
    review: z.boolean().default(true),
  })
  .strict();

export type FramingStatus = 'none' | 'not_validated' | 'changed' | 'missing' | 'validated';

export interface SettingsView extends AnalysisSettingsDto {
  framingStatus: FramingStatus;
}

export interface Inputs {
  rec: RecordingDto;
  settings: AnalysisSettingsDto;
  framing: FramingProfile | null;
  framingStatus: FramingStatus;
  privacyFile: PrivacyFile | null;
  transcriptions: TranscriptionDto[];
  config: Record<string, unknown>;
  privacy: Record<string, unknown>;
  profiles: Record<string, unknown>;
  inputKey: string;
  creator: Awaited<ReturnType<typeof loadCreatorProfile>>;
  game: Awaited<ReturnType<typeof loadGameProfile>>;
}

const RunJobParams = z.object({ runId: z.uuid() }).strict();

const pad = (n: number, w: number) => String(n).padStart(w, '0');

export class AnalysisService {
  readonly repo: AnalysisRepository;
  private readonly recordings: RecordingRepository;
  private readonly transcriptionRepo: TranscriptionRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly runnerRef: () => JobRunner,
    private readonly derivatives: DerivativeService,
    /** Modèle éditorial (Claude API, ou faux modèle en test) ; null si aucune clé configurée. */
    private readonly modelProvider: () => EditorialModel | null = () => null,
  ) {
    this.repo = new AnalysisRepository(ctx.db);
    this.recordings = new RecordingRepository(ctx.db);
    this.transcriptionRepo = new TranscriptionRepository(ctx.db);
  }

  private get cfg() {
    return this.ctx.config.analysis;
  }

  /** Au démarrage : analyses « en cours » interrompues ; appels « réservés » comptés au pire cas. */
  recover(): number {
    const calls = new LlmCallRepository(this.ctx.db).recoverStale();
    if (calls)
      this.ctx.log.warn(
        { calls },
        'Appels interrompus : facturation inconnue, réservation comptée',
      );
    return this.repo.markStaleAsInterrupted();
  }

  private recording(recordingId: string): RecordingDto {
    const rec = this.recordings.get(recordingId);
    if (!rec) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return rec;
  }

  /** Configuration exposée (aucun secret). */
  publicConfig() {
    return {
      mode: 'dry_run_and_claude' as const,
      claudeConfigured: Boolean(this.ctx.config.claude.apiKey),
      models: { triage: this.ctx.config.claude.triageModel, deep: this.ctx.config.claude.model },
      effort: this.cfg.effort,
      triageEffort: this.cfg.triageEffort,
      minRelevance: this.cfg.minRelevance,
      minReliability: this.cfg.minReliability,
      budgetUsd: this.cfg.maxCostUsd,
      triageScope: this.cfg.triageScope,
      framesPerWindow: this.cfg.framesPerWindow,
      pricingVersion: PRICING_VERSION,
    };
  }

  /* ------------------------------ Réglages ------------------------------ */

  private async framingState(
    settings: AnalysisSettingsDto,
  ): Promise<{ framing: FramingProfile | null; status: FramingStatus }> {
    if (!settings.framingProfileId) return { framing: null, status: 'none' };
    let framing: FramingProfile;
    try {
      framing = await loadFramingProfile(this.ctx.config.paths.profiles, settings.framingProfileId);
    } catch {
      return { framing: null, status: 'missing' };
    }
    if (!settings.framingValidatedAt) return { framing, status: 'not_validated' };
    if (settings.framingProfileHash !== profileHash(framing)) return { framing, status: 'changed' };
    return { framing, status: 'validated' };
  }

  /** Profil de cadrage de l'enregistrement s'il est VALIDÉ et inchangé depuis, sinon null. */
  async validatedFraming(recordingId: string): Promise<FramingProfile | null> {
    const { framing, status } = await this.framingState(this.repo.getSettings(recordingId));
    return status === 'validated' ? framing : null;
  }

  /** Fichier de confidentialité configuré (null s'il n'existe pas) ; invalide ⇒ erreur. */
  async privacy(): Promise<{ file: PrivacyFile | null; hash: string | null }> {
    return this.readPrivacyFile();
  }

  async settings(recordingId: string): Promise<SettingsView> {
    this.recording(recordingId);
    const s = this.repo.getSettings(recordingId);
    return { ...s, framingStatus: (await this.framingState(s)).status };
  }

  async updateSettings(recordingId: string, input: SettingsUpdate): Promise<SettingsView> {
    this.recording(recordingId);
    // Validé ici (et pas seulement par la route) : la CLI passe aussi par ce service.
    const parsed = SettingsUpdateSchema.safeParse(input);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ');
      throw new AppError('VALIDATION_FAILED', `Réglages invalides — ${why}`, {
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const u = parsed.data;
    const s = { ...this.repo.getSettings(recordingId) };
    if (u.discordTextAllowed === true) {
      const note = u.discordConsentNote ?? s.discordConsentNote;
      if (!note) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Accord Discord : précisez qui a donné son accord (note obligatoire)',
        );
      }
      s.discordTextAllowed = true;
      s.discordConsentNote = note;
      s.discordConsentAt = new Date().toISOString();
    } else if (u.discordTextAllowed === false) {
      s.discordTextAllowed = false;
      s.discordConsentNote = null;
      s.discordConsentAt = null;
    }
    if (u.facecamAllowed !== undefined) s.facecamAllowed = u.facecamAllowed;
    if (u.framingProfileId !== undefined && u.framingProfileId !== s.framingProfileId) {
      if (u.framingProfileId)
        await loadFramingProfile(this.ctx.config.paths.profiles, u.framingProfileId);
      s.framingProfileId = u.framingProfileId;
      s.framingProfileHash = null;
      s.framingValidatedAt = null;
    }
    this.repo.saveSettings(s);
    this.ctx.log.info(
      {
        recordingId,
        discordTextAllowed: s.discordTextAllowed,
        facecamAllowed: s.facecamAllowed,
        framingProfileId: s.framingProfileId,
      },
      'Réglages d’analyse modifiés',
    );
    return this.settings(recordingId);
  }

  /** Valide le profil de cadrage (après relecture de l'aperçu) : son empreinte est mémorisée. */
  async validateFraming(recordingId: string, profileId: string): Promise<SettingsView> {
    this.recording(recordingId);
    const framing = await loadFramingProfile(this.ctx.config.paths.profiles, profileId);
    const s = this.repo.getSettings(recordingId);
    this.repo.saveSettings({
      ...s,
      framingProfileId: profileId,
      framingProfileHash: profileHash(framing),
      framingValidatedAt: new Date().toISOString(),
    });
    this.ctx.log.info({ recordingId, profileId }, 'Profil de cadrage validé');
    return this.settings(recordingId);
  }

  framingProfiles() {
    return listFramingProfiles(this.ctx.config.paths.profiles);
  }

  private framingDir(recordingId: string) {
    return path.join(this.cfg.outputDir, recordingId, 'framing');
  }

  /**
   * Aperçu de cadrage : l'image annotée (zones dessinées) et l'image telle qu'elle serait
   * envoyée (recadrée, zones masquées), plus la facecam seulement si elle est autorisée.
   */
  async framingPreview(
    recordingId: string,
    profileId: string,
    atMs?: number,
  ): Promise<{
    atMs: number;
    files: {
      kind: 'annotated' | 'gameplay' | 'facecam';
      name: string;
      width: number;
      height: number;
    }[];
  }> {
    const rec = this.recording(recordingId);
    const framing = await loadFramingProfile(this.ctx.config.paths.profiles, profileId);
    const { sourcePath, fp, width, height } = this.derivatives.sourceInfo(recordingId);
    if (!width || !height)
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste vidéo exploitable');
    const durationMs = rec.durationSec ? Math.round(rec.durationSec * 1000) : 0;
    const at = Math.max(
      0,
      Math.min(atMs ?? Math.round(durationMs / 2), Math.max(0, durationMs - 500)),
    );
    await this.derivatives.assertSourceUnchanged(sourcePath, fp);
    const dir = this.framingDir(recordingId);
    const settings = this.repo.getSettings(recordingId);
    const base = {
      ffmpegPath: this.ctx.config.tools.ffmpeg,
      inputPath: sourcePath,
      allowedDir: this.cfg.outputDir,
      atMs: at,
      videoWidth: width,
      videoHeight: height,
    };
    const files: {
      kind: 'annotated' | 'gameplay' | 'facecam';
      name: string;
      width: number;
      height: number;
    }[] = [];
    const run = async (
      kind: (typeof files)[number]['kind'],
      extra: Pick<Parameters<typeof extractFrame>[0], 'crop' | 'masks' | 'maxWidth' | 'outlines'>,
    ) => {
      const name = `${profileId}-${at}-${kind}.jpg`;
      const f = await extractFrame({ ...base, ...extra, outputPath: path.join(dir, name) });
      files.push({ kind, name, width: f.width, height: f.height });
    };
    await run('annotated', {
      crop: { x: 0, y: 0, w: 1, h: 1 },
      masks: [],
      maxWidth: 1280,
      outlines: [
        { rect: framing.gameplay, color: 'yellow' },
        ...(framing.facecam ? [{ rect: framing.facecam, color: 'blue' }] : []),
        ...framing.masks.map((m) => ({ rect: m, color: 'red' })),
      ],
    });
    const g = this.frameRequests(framing, settings, at);
    for (const r of g) {
      await run(r.region === 'gameplay' ? 'gameplay' : 'facecam', {
        crop: r.crop,
        masks: r.masks,
        maxWidth: r.maxWidth,
      });
    }
    return { atMs: at, files };
  }

  /** Chemin d'un fichier d'aperçu (nom vérifié : aucune sortie du dossier possible). */
  framingPreviewFile(recordingId: string, name: string): string {
    if (!/^[a-z0-9-]+-\d+-(annotated|gameplay|facecam)\.jpg$/.test(name)) {
      throw new AppError('NOT_FOUND', 'Aperçu introuvable');
    }
    this.recording(recordingId);
    const p = path.join(this.framingDir(recordingId), name);
    if (!existsSync(p)) throw new AppError('NOT_FOUND', 'Aperçu introuvable');
    return p;
  }

  /** Images à produire pour un instant : gameplay (facecam toujours masquée) + facecam si accord. */
  private frameRequests(
    framing: FramingProfile,
    settings: AnalysisSettingsDto,
    atMs: number,
  ): FrameRequest[] {
    const masks: NormalizedRect[] = [
      ...framing.masks.map(({ x, y, w, h }) => ({ x, y, w, h })),
      ...(framing.facecam ? [framing.facecam] : []),
    ];
    const out: FrameRequest[] = [
      { atMs, region: 'gameplay', crop: framing.gameplay, masks, maxWidth: this.cfg.frameWidth },
    ];
    if (settings.facecamAllowed && framing.facecam) {
      out.push({
        atMs,
        region: 'facecam',
        crop: framing.facecam,
        masks: framing.masks.map(({ x, y, w, h }) => ({ x, y, w, h })),
        maxWidth: Math.min(512, this.cfg.frameWidth),
      });
    }
    return out;
  }

  /* ------------------------------ Entrées ------------------------------ */

  private async readPrivacyFile(): Promise<{ file: PrivacyFile | null; hash: string | null }> {
    const p = this.cfg.privacyFile;
    if (!existsSync(p)) return { file: null, hash: null };
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(p, 'utf8')) as unknown;
    } catch (cause) {
      throw new AppError(
        'PRIVACY_CONFIG_INVALID',
        `Fichier de confidentialité illisible (JSON) : ${p}`,
        { cause },
      );
    }
    const r = PrivacyFileSchema.safeParse(raw);
    if (!r.success) {
      throw new AppError('PRIVACY_CONFIG_INVALID', `Fichier de confidentialité invalide : ${p}`, {
        // Jamais les valeurs (noms réels) : seulement l'emplacement de l'erreur.
        details: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return { file: r.data, hash: stableHash(r.data) };
  }

  /** Dernière transcription terminée de chaque piste de voix. */
  private selectTranscriptions(rec: RecordingDto): TranscriptionDto[] {
    const voice = new Set(
      rec.audioTracks.filter((t) => SPEAKER_BY_ROLE[t.role]).map((t) => t.audioIndex),
    );
    const latest = new Map<number, TranscriptionDto>();
    for (const t of this.transcriptionRepo.listForRecording(rec.id)) {
      if (t.status !== 'completed' || !voice.has(t.audioIndex)) continue;
      const cur = latest.get(t.audioIndex);
      if (!cur || (t.completedAt ?? '') > (cur.completedAt ?? '')) latest.set(t.audioIndex, t);
    }
    return [...latest.values()].sort((a, b) => a.audioIndex - b.audioIndex);
  }

  async inputs(recordingId: string): Promise<Inputs> {
    const rec = this.recording(recordingId);
    const settings = this.repo.getSettings(recordingId);
    const { framing, status: framingStatus } = await this.framingState(settings);
    const privacyFile = await this.readPrivacyFile();
    const transcriptions = this.selectTranscriptions(rec);
    if (!transcriptions.length) {
      throw new AppError(
        'ANALYSIS_NOT_READY',
        'Aucune transcription terminée : transcrivez d’abord l’enregistrement (étape 3)',
      );
    }
    const creator = await loadCreatorProfile(this.ctx.config.paths.profiles);
    const game = await loadGameProfile(this.ctx.config.paths.profiles, rec.gameId);
    pricingFor(this.ctx.config.claude.model);
    pricingFor(this.ctx.config.claude.triageModel);

    const config = {
      models: { triage: this.ctx.config.claude.triageModel, deep: this.ctx.config.claude.model },
      effort: this.cfg.effort,
      budgetUsd: this.cfg.maxCostUsd,
      maxOutputTokens: this.cfg.maxOutputTokens,
      triageMaxOutputTokens: this.cfg.triageMaxOutputTokens,
      triageScope: this.cfg.triageScope,
      triageChunkMs: this.cfg.triageChunkMs,
      contextBeforeMs: this.cfg.contextBeforeMs,
      contextAfterMs: this.cfg.contextAfterMs,
      farContextMs: this.cfg.farContextMs,
      localMinScore: this.cfg.localMinScore,
      framesPerWindow: this.cfg.framesPerWindow,
      frameWidth: this.cfg.frameWidth,
      clipDuration: effectiveClipDuration(creator, game),
      payloadVersion: PAYLOAD_VERSION,
      // Les requêtes préparées dépendent des prompts : un prompt modifié = nouvelle préparation.
      promptVersions: [TRIAGE_PROMPT_VERSION, DEEP_PROMPT_VERSION],
      triageEffort: this.cfg.triageEffort,
      signalProviders: DEFAULT_SIGNAL_PROVIDERS.map((p) => `${p.id}@${p.version}`),
    };
    const privacy = {
      discordTextAllowed: settings.discordTextAllowed,
      discordConsentAt: settings.discordConsentAt,
      facecamAllowed: settings.facecamAllowed,
      framing: {
        profileId: settings.framingProfileId,
        status: framingStatus,
        hash: settings.framingProfileHash,
      },
      pseudonymFile: {
        present: privacyFile.file !== null,
        entries: privacyFile.file?.pseudonyms.length ?? 0,
        hash: privacyFile.hash,
      },
    };
    const profiles = {
      creator: profileHash(creator),
      game: { id: game.id, hash: profileHash(game) },
      framing: framing ? { id: framing.id, hash: profileHash(framing) } : null,
    };
    const src = this.recordings.getSource(recordingId);
    const inputKey = stableHash({
      v: ANALYSIS_PIPELINE_VERSION,
      pricing: PRICING_VERSION,
      fp: src?.fingerprint,
      transcriptions: transcriptions.map((t) => ({
        id: t.id,
        n: t.segmentCount,
        at: t.completedAt,
      })),
      config,
      privacy,
      profiles,
    });
    return {
      rec,
      settings,
      framing,
      framingStatus,
      privacyFile: privacyFile.file,
      transcriptions,
      config,
      privacy,
      profiles,
      inputKey,
      creator,
      game,
    };
  }

  /* ------------------------------ Demande ------------------------------ */

  /** Clé d'une analyse avec Claude : entrées de la préparation + prompts + seuils. */
  claudeInputKey(inp: Inputs): string {
    return stableHash({
      base: inp.inputKey,
      mode: 'claude',
      prompts: [TRIAGE_PROMPT_VERSION, DEEP_PROMPT_VERSION],
      triageEffort: this.cfg.triageEffort,
      minRelevance: this.cfg.minRelevance,
      minReliability: this.cfg.minReliability,
    });
  }

  async request(
    recordingId: string,
    body: z.input<typeof AnalysisRequestSchema> = {},
  ): Promise<{
    status: 'ready' | 'pending';
    run: AnalysisRunDto;
    job: JobDto | null;
    reused: boolean;
  }> {
    const opts = AnalysisRequestSchema.parse(body);
    const inp = await this.inputs(recordingId);
    if (opts.mode === 'claude') return this.requestClaude(recordingId, inp, opts);
    const existing = this.repo.findReusable(inp.inputKey, 'dry_run');
    if (existing && (!opts.force || existing.status !== 'completed')) {
      if (existing.status === 'completed')
        return { status: 'ready', run: existing, job: null, reused: true };
      const { job } = this.enqueue(existing);
      return { status: 'pending', run: existing, job, reused: true };
    }
    const run = this.repo.createRun({
      id: randomUUID(),
      recordingId,
      mode: 'dry_run',
      pipelineVersion: ANALYSIS_PIPELINE_VERSION,
      pricingVersion: PRICING_VERSION,
      inputKey: inp.inputKey,
      transcriptionIds: inp.transcriptions.map((t) => t.id),
      config: inp.config,
      privacy: inp.privacy,
      profiles: inp.profiles,
      budgetUsd: this.cfg.maxCostUsd,
    });
    const { job } = this.enqueue(run);
    return { status: 'pending', run, job, reused: false };
  }

  /**
   * Analyse PAYANTE : exige une clé et l'accord explicite au plafond. Une analyse identique
   * interrompue est reprise (même budget) ; terminée, elle est renvoyée sauf `force` ou
   * `forceRecall` (nouvelle analyse ; avec `forceRecall`, aucune réponse d'une autre analyse
   * n'est relue).
   */
  private requestClaude(
    recordingId: string,
    inp: Inputs,
    opts: z.output<typeof AnalysisRequestSchema>,
  ) {
    if (!this.modelProvider()) {
      throw new AppError(
        'CLAUDE_NOT_CONFIGURED',
        'ANTHROPIC_API_KEY absente : seule la préparation locale (--dry-run) est possible',
      );
    }
    if (
      opts.acceptBudgetUsd === undefined ||
      Math.abs(opts.acceptBudgetUsd - this.cfg.maxCostUsd) > 1e-9
    ) {
      throw new AppError(
        'BUDGET_NOT_CONFIRMED',
        `Confirmez le plafond de ${this.cfg.maxCostUsd} $ avant toute analyse payante (acceptBudgetUsd)`,
      );
    }
    const key = this.claudeInputKey(inp);
    // `force` et `forceRecall` demandent tous deux une NOUVELLE analyse ; `forceRecall` y ajoute
    // l'interdiction de relire une réponse obtenue par une autre analyse (payant).
    //
    // Avec `force` / `forceRecall`, selon l'analyse identique la plus récente :
    //  - terminée ou arrêtée par le budget → nouvelle analyse ;
    //  - en pause de relecture (rien n'est en vol, rien n'est réservé) → elle est REMPLACÉE :
    //    fermée (`cancelled`, code SUPERSEDED, plus approuvable) et une nouvelle analyse est créée ;
    //  - en file ou en cours (appels possiblement en vol) → REFUS explicite : jamais deux
    //    analyses identiques payantes en même temps ; il faut attendre sa fin ou l'annuler.
    const fresh = opts.force || opts.forceRecall;
    const active = this.repo.findReusable(key, 'claude');
    const finished = active?.status === 'completed' || active?.status === 'budget_exhausted';
    let superseded: AnalysisRunDto | null = null;
    if (active && isAwaitingReview(active)) {
      // En pause de relecture : rien ne part sans l'accord explicite (approveReview).
      if (!fresh) return { status: 'pending' as const, run: active, job: null, reused: true };
      superseded = active;
    } else if (active && !finished) {
      if (fresh) {
        const job = new JobRepository(this.ctx.db).findActiveByTarget(`run_analysis:${active.id}`);
        throw new AppError(
          'CONFLICT',
          `Une analyse identique est en cours (${active.id}) : attendez sa fin ou annulez-la` +
            (job ? ` (traitement ${job.id} : POST /api/jobs/${job.id}/cancel)` : '') +
            ' avant d’en lancer une nouvelle (--force / --force-recall)',
        );
      }
      return {
        status: 'pending' as const,
        run: active,
        job: this.enqueueClaude(active).job,
        reused: true,
      };
    } else if (active && !fresh) {
      return { status: 'ready' as const, run: active, job: null, reused: true };
    }
    // Reprise d'une analyse identique interrompue, lancée avec la même option `forceRecall`,
    // à condition qu'aucune analyse identique ne se soit terminée depuis.
    const resumable =
      opts.force || superseded ? null : this.repo.findResumable(key, 'claude', opts.forceRecall);
    if (resumable && (!active || resumable.createdAt > active.createdAt)) {
      return {
        status: 'pending' as const,
        run: resumable,
        job: this.enqueueClaude(resumable).job,
        reused: true,
      };
    }
    // Création et remplacement éventuel d'une analyse en pause : une seule transaction.
    const run = this.ctx.db.transaction(() => {
      const created = this.repo.createRun({
        id: randomUUID(),
        recordingId,
        mode: 'claude',
        pipelineVersion: ANALYSIS_PIPELINE_VERSION,
        pricingVersion: PRICING_VERSION,
        inputKey: key,
        transcriptionIds: inp.transcriptions.map((t) => t.id),
        config: {
          ...inp.config,
          minRelevance: this.cfg.minRelevance,
          minReliability: this.cfg.minReliability,
          triageEffort: this.cfg.triageEffort,
          reviewBeforeDeep: opts.review,
        },
        privacy: inp.privacy,
        profiles: inp.profiles,
        budgetUsd: this.cfg.maxCostUsd,
        promptVersion: `${TRIAGE_PROMPT_VERSION}+${DEEP_PROMPT_VERSION}`,
        forceRecall: opts.forceRecall,
      });
      if (superseded) this.repo.supersede(superseded.id, created.id);
      return created;
    })();
    this.ctx.log.info(
      { runId: run.id, recordingId, budgetUsd: run.budgetUsd },
      'Analyse avec Claude demandée (plafond accepté)',
    );
    return { status: 'pending' as const, run, job: this.enqueueClaude(run).job, reused: false };
  }

  /**
   * Accord du créateur après relecture des requêtes Opus : l'analyse approfondie peut partir.
   * Exige à nouveau la confirmation du plafond.
   */
  approveReview(runId: string, acceptBudgetUsd: number | undefined) {
    const { run } = this.getRun(runId);
    if (!this.modelProvider()) {
      throw new AppError('CLAUDE_NOT_CONFIGURED', 'ANTHROPIC_API_KEY absente');
    }
    if (acceptBudgetUsd === undefined || Math.abs(acceptBudgetUsd - run.budgetUsd) > 1e-9) {
      throw new AppError(
        'BUDGET_NOT_CONFIRMED',
        `Confirmez le plafond de ${run.budgetUsd} $ avant l’analyse approfondie (acceptBudgetUsd)`,
      );
    }
    if (!isAwaitingReview(run) || !this.repo.approveReview(runId)) {
      throw new AppError('CONFLICT', 'Cette analyse n’attend pas de relecture');
    }
    const approved = this.repo.getRun(runId)!;
    this.ctx.log.info({ runId }, 'Requêtes Opus relues : analyse approfondie autorisée');
    return { status: 'pending' as const, run: approved, job: this.enqueueClaude(approved).job };
  }

  private enqueueClaude(run: AnalysisRunDto) {
    return this.runnerRef().enqueue({
      type: 'run_analysis',
      lane: 'analysis',
      targetKey: `run_analysis:${run.id}`,
      recordingId: run.recordingId,
      params: { runId: run.id },
    });
  }

  /** Préparation à blanc identique (terminée, fichiers présents), refaite si besoin. */
  async ensurePrepared(inp: Inputs, hctx: JobHandlerContext): Promise<AnalysisRunDto> {
    const existing = this.repo.findReusable(inp.inputKey, 'dry_run');
    if (
      existing?.status === 'completed' &&
      existing.outputRelDir &&
      existsSync(toAbs(this.ctx.config.paths.storage, `${existing.outputRelDir}/manifeste.json`))
    ) {
      return existing;
    }
    const run = this.repo.createRun({
      id: randomUUID(),
      recordingId: inp.rec.id,
      mode: 'dry_run',
      pipelineVersion: ANALYSIS_PIPELINE_VERSION,
      pricingVersion: PRICING_VERSION,
      inputKey: inp.inputKey,
      transcriptionIds: inp.transcriptions.map((t) => t.id),
      config: inp.config,
      privacy: inp.privacy,
      profiles: inp.profiles,
      budgetUsd: this.cfg.maxCostUsd,
    });
    this.repo.markRunning(run.id);
    await this.prepareRun(run, hctx);
    return this.repo.getRun(run.id)!;
  }

  /** Propositions d'une analyse (consolidées : les fusionnées sont masquées par défaut). */
  proposals(runId: string, includeMerged = false) {
    this.getRun(runId);
    return new ProposalRepository(this.ctx.db).listProposals(runId, { includeMerged });
  }

  triageMoments(runId: string) {
    this.getRun(runId);
    return new ProposalRepository(this.ctx.db).listTriageMoments(runId);
  }

  calls(runId: string) {
    this.getRun(runId);
    const repo = new LlmCallRepository(this.ctx.db);
    return { calls: repo.listForRun(runId), costs: repo.costs(runId) };
  }

  /**
   * Requêtes EXACTES d'une analyse (dossier requetes/) : pour le dry-run, ce qui serait envoyé ;
   * pour une analyse avec Claude, ce qui est ou sera réellement envoyé (écrit avant l'envoi),
   * avec les appels qui l'ont effectivement envoyée.
   */
  async runRequests(runId: string) {
    const { run } = this.getRun(runId);
    if (!run.outputRelDir) return { requests: [] };
    const dir = toAbs(this.ctx.config.paths.storage, `${run.outputRelDir}/requetes`);
    if (!existsSync(dir)) return { requests: [] };
    const calls = new LlmCallRepository(this.ctx.db).listForRun(runId);
    const names = (await readdir(dir)).filter((n) => REQUEST_FILE_RE.test(n)).sort();
    const requests = [];
    for (const name of names) {
      const hash = await recordedHash(path.join(dir, name));
      const sent = calls.filter((c) => c.requestHash === hash);
      requests.push({
        name,
        stage: name.startsWith('reperage') ? 'triage' : 'deep',
        requestHash: hash,
        calls: sent.map((c) => ({ id: c.id, status: c.status, attempt: c.attempt })),
        sentToClaude: sent.some((c) => c.status !== 'reused' && c.status !== 'reserved'),
      });
    }
    return { requests };
  }

  /** Contenu d'un fichier de requête (nom validé : aucun chemin arbitraire). */
  async runRequest(runId: string, name: string) {
    const { run } = this.getRun(runId);
    if (!REQUEST_FILE_RE.test(name) || !run.outputRelDir)
      throw new AppError('NOT_FOUND', 'Requête introuvable');
    const abs = toAbs(this.ctx.config.paths.storage, `${run.outputRelDir}/requetes/${name}`);
    if (!existsSync(abs)) throw new AppError('NOT_FOUND', 'Requête introuvable');
    return JSON.parse(await readFile(abs, 'utf8')) as unknown;
  }

  /** Requête ou réponse enregistrée d'un appel (JSON, sans la clé API). */
  async callFile(runId: string, callId: string, kind: 'request' | 'response') {
    const call = new LlmCallRepository(this.ctx.db).get(callId);
    if (!call || call.runId !== runId) throw new AppError('NOT_FOUND', 'Appel introuvable');
    const rel = kind === 'request' ? call.requestRelPath : call.responseRelPath;
    if (!rel) throw new AppError('NOT_FOUND', 'Fichier indisponible pour cet appel');
    const abs = toAbs(this.ctx.config.paths.storage, rel);
    if (!existsSync(abs)) throw new AppError('NOT_FOUND', 'Fichier supprimé');
    return JSON.parse(await readFile(abs, 'utf8')) as unknown;
  }

  /** Coût réel cumulé d'un enregistrement (toutes analyses). */
  recordingCosts(recordingId: string) {
    this.recording(recordingId);
    return new LlmCallRepository(this.ctx.db).recordingCost(recordingId);
  }

  private enqueue(run: AnalysisRunDto) {
    return this.runnerRef().enqueue({
      type: 'prepare_analysis',
      lane: 'analysis',
      targetKey: `prepare_analysis:${run.id}`,
      recordingId: run.recordingId,
      params: { runId: run.id },
    });
  }

  listRuns(recordingId: string): AnalysisRunDto[] {
    this.recording(recordingId);
    return this.repo.listRuns(recordingId);
  }

  getRun(runId: string): { run: AnalysisRunDto; windows: AnalysisWindowDto[] } {
    const run = this.repo.getRun(runId);
    if (!run) throw new AppError('NOT_FOUND', 'Analyse introuvable');
    return { run, windows: this.repo.listWindows(runId) };
  }

  private async readOutput(run: AnalysisRunDto, rel: string): Promise<string> {
    if (!run.outputRelDir) throw new AppError('NOT_FOUND', 'Contenu préparé indisponible');
    const p = toAbs(this.ctx.config.paths.storage, `${run.outputRelDir}/${rel}`);
    if (!existsSync(p)) throw new AppError('NOT_FOUND', 'Contenu préparé introuvable (supprimé ?)');
    return readFile(p, 'utf8');
  }

  /** Contenu exact qui serait transmis pour une fenêtre, et son manifeste. */
  async windowPayload(runId: string, rank: number) {
    const { run } = this.getRun(runId);
    const w = this.repo.getWindow(runId, rank);
    if (!w) throw new AppError('NOT_FOUND', 'Fenêtre introuvable');
    const base = `fenetres/fenetre-${pad(rank, 3)}`;
    return {
      text: await this.readOutput(run, `${base}.txt`),
      manifest: JSON.parse(await this.readOutput(run, `${base}.json`)) as unknown,
    };
  }

  async triageChunk(runId: string, index: number) {
    const { run } = this.getRun(runId);
    return { text: await this.readOutput(run, `reperage/tranche-${pad(index, 2)}.txt`) };
  }

  async manifest(runId: string) {
    const { run } = this.getRun(runId);
    return JSON.parse(await this.readOutput(run, 'manifeste.json')) as unknown;
  }

  /* ---------------------------- Préparation ---------------------------- */

  handlers(): { prepare_analysis: JobHandler; run_analysis: JobHandler } {
    return {
      prepare_analysis: (job, hctx) => this.runJob(job, hctx),
      run_analysis: (job, hctx) => this.runClaudeJob(job, hctx),
    };
  }

  private async runClaudeJob(job: JobDto, hctx: JobHandlerContext) {
    const { runId } = RunJobParams.parse(job.params);
    const run = this.repo.getRun(runId);
    if (!run || run.mode !== 'claude') throw new AppError('NOT_FOUND', 'Analyse introuvable');
    const model = this.modelProvider();
    if (!model) throw new AppError('CLAUDE_NOT_CONFIGURED', 'ANTHROPIC_API_KEY absente');
    this.repo.markRunning(runId);
    try {
      return await new ClaudeRunner(this.ctx, this, this.derivatives, model).run(run, hctx);
    } catch (err) {
      this.failRun(runId, err, hctx.signal);
      throw err;
    }
  }

  private failRun(runId: string, err: unknown, signal: AbortSignal) {
    const aborted = signal.aborted || (err instanceof AppError && err.code === 'CANCELLED');
    const shutdown = aborted && signal.reason === 'shutdown';
    this.repo.finish(runId, shutdown ? 'interrupted' : aborted ? 'cancelled' : 'failed', {
      code: aborted
        ? shutdown
          ? 'INTERRUPTED'
          : 'CANCELLED'
        : err instanceof AppError
          ? err.code
          : 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  private async runJob(job: JobDto, hctx: JobHandlerContext) {
    const { runId } = RunJobParams.parse(job.params);
    const run = this.repo.getRun(runId);
    if (!run) throw new AppError('NOT_FOUND', 'Analyse introuvable');
    this.repo.markRunning(runId);
    try {
      const res = await this.prepareRun(run, hctx);
      return res;
    } catch (err) {
      const aborted = hctx.signal.aborted;
      const shutdown = aborted && hctx.signal.reason === 'shutdown';
      this.repo.finish(runId, shutdown ? 'interrupted' : aborted ? 'cancelled' : 'failed', {
        code: aborted
          ? shutdown
            ? 'INTERRUPTED'
            : 'CANCELLED'
          : err instanceof AppError
            ? err.code
            : 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async loadEnergy(
    rec: RecordingDto,
    speakers: Map<number, Speaker>,
  ): Promise<{ energy: EnergyTrack[]; missing: number[] }> {
    const energy: EnergyTrack[] = [];
    const missing: number[] = [];
    const ders = this.derivatives.repo
      .listForRecording(rec.id)
      .filter(
        (d) =>
          d.kind === 'waveform' &&
          d.srcStartMs === null &&
          d.params['from'] === 'audio_transcription',
      );
    for (const [audioIndex, speaker] of speakers) {
      const d = ders.find(
        (x) => x.audioIndex === audioIndex && existsSync(this.derivatives.abs(x.relPath)),
      );
      if (!d) {
        missing.push(audioIndex);
        continue;
      }
      const wf = await readWaveform(this.derivatives.abs(d.relPath));
      energy.push({ speaker, audioIndex, pointsPerSecond: wf.pointsPerSecond, peaks: wf.data });
    }
    return { energy, missing };
  }

  /* ------------------------------ Contexte ------------------------------ */

  /** Jetons estimés des prompts système et schémas (repérage, analyse). */
  systemTokens(inp: Inputs): { triage: number; deep: number } {
    const t = this.triageRequestFor(inp, '');
    const d = this.deepRequestFor(inp, '', [], null);
    const size = (r: ModelRequest) =>
      estimateTextTokens(r.system) + estimateTextTokens(JSON.stringify(r.schema));
    return { triage: size(t), deep: size(d) };
  }

  /**
   * Contexte d'analyse d'un enregistrement (déterministe) : segments transcrits, énergie,
   * signaux et fenêtres à signaux. Partagé par la préparation et par les appels (4b).
   */
  async buildContext(inp: Inputs) {
    const { rec, settings } = inp;
    const policy = { discordTextAllowed: settings.discordTextAllowed };
    const pseudonymizer = createPseudonymizer(inp.privacyFile);
    const speakers = new Map<number, Speaker>();
    for (const t of rec.audioTracks) {
      const sp = SPEAKER_BY_ROLE[t.role];
      if (sp && inp.transcriptions.some((x) => x.audioIndex === t.audioIndex))
        speakers.set(t.audioIndex, sp);
    }
    const segments: AnalysisSegment[] = this.transcriptionRepo
      .segments({
        recordingId: rec.id,
        transcriptionIds: inp.transcriptions.map((t) => t.id),
        limit: 10_000_000,
      })
      .filter((s) => speakers.has(s.audioIndex))
      .map((s) => ({
        id: s.id,
        speaker: speakers.get(s.audioIndex)!,
        audioIndex: s.audioIndex,
        startMs: s.srcStartMs,
        endMs: s.srcEndMs,
        text: s.text,
        suspicionScore: s.suspicionScore,
        suspicionReasons: s.suspicionReasons,
        words: s.words,
      }));
    const { energy, missing: energyMissing } = await this.loadEnergy(rec, speakers);
    let durationMs = rec.durationSec ? Math.round(rec.durationSec * 1000) : 0;
    for (const s of segments) durationMs = Math.max(durationMs, s.endMs);
    const signals = computeSignals({
      durationMs,
      segments,
      energy,
      gameTerms: inp.game.vocabulary,
    });
    const clip = effectiveClipDuration(inp.creator, inp.game);
    const windows = rankWindows(
      buildCandidateWindows(segments, signals, {
        durationMs,
        minScore: this.cfg.localMinScore,
        contextBeforeMs: this.cfg.contextBeforeMs,
        contextAfterMs: this.cfg.contextAfterMs,
        farContextMs: this.cfg.farContextMs,
        maxCoreMs: clip.maxSeconds * 1000,
      }),
    );
    return {
      policy,
      pseudonymizer,
      speakers,
      segments,
      energy,
      energyMissing,
      durationMs,
      signals,
      clip,
      windows,
    };
  }

  /** Raison de l'absence d'images, ou null si des images peuvent être préparées. */
  noFramesReason(inp: Inputs): string | null {
    if (this.cfg.framesPerWindow === 0) return 'réglage ANALYSIS_FRAMES_PER_WINDOW=0';
    if (!inp.rec.video?.width) return 'aucune piste vidéo';
    if (inp.framingStatus === 'none') return 'aucun profil de cadrage choisi';
    if (inp.framingStatus === 'not_validated') return 'le profil de cadrage n’a pas été validé';
    if (inp.framingStatus === 'changed')
      return 'le profil de cadrage a été modifié depuis sa validation : revalidez-le';
    if (inp.framingStatus === 'missing') return 'le profil de cadrage est introuvable';
    return null;
  }

  /** Images des fenêtres (profil de cadrage validé uniquement), mises en cache comme dérivés. */
  async prepareFrames(
    inp: Inputs,
    windows: readonly { rank: number; coreStartMs: number; coreEndMs: number }[],
    signal: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<number, PreparedFrame[]>> {
    const out = new Map<number, PreparedFrame[]>();
    if (this.noFramesReason(inp) || !inp.framing) return out;
    const { rec, settings } = inp;
    const framing = inp.framing;
    const perWindow = windows.map((w) => {
      const n = this.cfg.framesPerWindow;
      const len = w.coreEndMs - w.coreStartMs;
      const times = Array.from({ length: n }, (_, k) =>
        Math.round(w.coreStartMs + ((k + 0.5) * len) / n),
      );
      return { w, reqs: times.flatMap((t) => this.frameRequests(framing, settings, t)) };
    });
    const total = perWindow.reduce((a, x) => a + x.reqs.length, 0);
    let done = 0;
    for (const { w, reqs } of perWindow) {
      const ders = await this.derivatives.ensureFrames(rec.id, reqs, {
        signal,
        onProgress: () => onProgress?.(++done, total),
      });
      out.set(
        w.rank,
        ders.map((d, i) => {
          const r = reqs[i]!;
          const size = outputSize(
            toPixelRect(r.crop, rec.video!.width!, rec.video!.height!),
            r.maxWidth,
          );
          return {
            label: `F${i + 1}`,
            derivativeId: d.id,
            atMs: r.atMs,
            region: r.region,
            ...size,
          };
        }),
      );
    }
    return out;
  }

  /** Images d'une requête : empreinte et taille des fichiers RÉELLEMENT présents. */
  async requestImages(frames: readonly PreparedFrame[]): Promise<RequestImage[]> {
    const out: RequestImage[] = [];
    for (const f of frames) {
      const d = this.derivatives.repo.get(f.derivativeId);
      if (!d)
        throw new AppError('NOT_FOUND', `Image ${f.label} introuvable : relancez la préparation`);
      const bytes = await readFile(this.derivatives.abs(d.relPath));
      out.push({
        label: f.label,
        derivativeId: f.derivativeId,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        mediaType: 'image/jpeg',
      });
    }
    return out;
  }

  /** Requête de repérage d'une tranche. */
  triageRequestFor(inp: Inputs, chunkText: string): ModelRequest {
    return triageRequest({
      model: this.ctx.config.claude.triageModel,
      effort: this.cfg.triageEffort,
      maxTokens: this.cfg.triageMaxOutputTokens,
      creator: inp.creator,
      game: inp.game,
      chunkText,
    });
  }

  /** Requête d'analyse approfondie d'une fenêtre. */
  deepRequestFor(
    inp: Inputs,
    payloadText: string,
    images: readonly RequestImage[],
    streamSummary: string | null,
  ): ModelRequest {
    return deepRequest({
      model: this.ctx.config.claude.model,
      effort: this.cfg.effort,
      maxTokens: this.cfg.maxOutputTokens,
      creator: inp.creator,
      game: inp.game,
      clip: effectiveClipDuration(inp.creator, inp.game),
      payloadText,
      images,
      streamSummary,
    });
  }

  async prepareRun(run: AnalysisRunDto, { signal, reportProgress }: JobHandlerContext) {
    const started = Date.now();
    const inp = await this.inputs(run.recordingId);
    if (inp.inputKey !== run.inputKey) {
      throw new AppError(
        'CONFLICT',
        'Les réglages, profils ou transcriptions ont changé depuis la demande : relancez la préparation',
      );
    }
    const { rec, settings } = inp;

    // 1. Transcription, énergie, signaux et fenêtres à signaux.
    this.repo.setStage(run.id, 'signals');
    const { policy, pseudonymizer, segments, energy, energyMissing, durationMs, signals, windows } =
      await this.buildContext(inp);
    reportProgress(0.15);
    if (signal.aborted) throw new AppError('CANCELLED', 'Préparation annulée');

    // 2. Images (seulement avec un profil de cadrage VALIDÉ et inchangé).
    this.repo.setStage(run.id, 'frames');
    const noFramesReason = this.noFramesReason(inp);
    const framesByRank = noFramesReason
      ? new Map<number, PreparedFrame[]>()
      : await this.prepareFrames(inp, windows, signal, (done, total) =>
          reportProgress(0.15 + (0.7 * done) / Math.max(1, total)),
        );
    reportProgress(0.85);

    // 3. Contenu préparé (exactement ce qui serait transmis) et estimation.
    this.repo.setStage(run.id, 'payload');
    const relDir = `analysis/${rec.id}/${run.id}`;
    const absDir = toAbs(this.ctx.config.paths.storage, relDir);
    await rm(absDir, { recursive: true, force: true });
    await mkdir(path.join(absDir, 'fenetres'), { recursive: true });
    await mkdir(path.join(absDir, 'reperage'), { recursive: true });
    await mkdir(path.join(absDir, 'requetes'), { recursive: true });
    const writeRequest = (name: string, req: ModelRequest) =>
      writeRequestFile(path.join(absDir, 'requetes', name), req);

    const chunks = buildTriageChunks({
      segments,
      durationMs,
      chunkMs: this.cfg.triageChunkMs,
      scope: this.cfg.triageScope,
      windows,
      policy,
      pseudonymizer,
    });
    const triageTokens: number[] = [];
    for (const c of chunks) {
      await writeFile(path.join(absDir, 'reperage', `tranche-${pad(c.index, 2)}.txt`), c.text);
      const req = this.triageRequestFor(inp, c.text);
      await writeRequest(triageRequestName(c.index), req);
      triageTokens.push(estimateTextTokens(req.userText));
    }
    // Le résumé du repérage n'existe qu'après les appels : il est remplacé par un repère.
    const summaryForReview = this.cfg.triageScope === 'off' ? null : SUMMARY_PLACEHOLDER;

    const newWindows: NewWindow[] = [];
    const windowStats: RenderStats[] = [];
    for (const w of windows) {
      const frames = framesByRank.get(w.rank) ?? [];
      const payload = buildWindowPayload({
        rank: w.rank,
        window: w,
        segments,
        policy,
        pseudonymizer,
        frames,
        noFramesReason,
      });
      const imgTokens = frames.reduce((a, f) => a + imageTokens(f.width, f.height), 0);
      const base = `fenetres/fenetre-${pad(w.rank, 3)}`;
      const deepReq = this.deepRequestFor(
        inp,
        payload.text,
        await this.requestImages(frames),
        summaryForReview,
      );
      await writeRequest(deepRequestName(w.rank), deepReq);
      const reqTokens = estimateTextTokens(deepReq.userText);
      const manifest = {
        rank: w.rank,
        times: {
          farStartMs: w.farStartMs,
          startMs: w.startMs,
          coreStartMs: w.coreStartMs,
          coreEndMs: w.coreEndMs,
          endMs: w.endMs,
        },
        localScore: w.score,
        transmitted: payload.stats,
        frames,
        estimatedTokens: { text: reqTokens, images: imgTokens },
      };
      await writeFile(path.join(absDir, `${base}.txt`), payload.text);
      await writeFile(path.join(absDir, `${base}.json`), JSON.stringify(manifest, null, 2));
      windowStats.push(payload.stats);
      newWindows.push({
        id: randomUUID(),
        rank: w.rank,
        origin: 'signals',
        farStartMs: w.farStartMs,
        startMs: w.startMs,
        coreStartMs: w.coreStartMs,
        coreEndMs: w.coreEndMs,
        endMs: w.endMs,
        localScore: w.score,
        signals: w.signals,
        frames,
        payloadRelPath: `${relDir}/${base}.txt`,
        estimate: { textTokens: reqTokens, imageTokens: imgTokens },
        status: 'prepared',
        cacheKey: stableHash({
          v: PAYLOAD_VERSION,
          text: payload.text,
          frames: frames.map((f) => f.derivativeId),
        }),
      });
    }

    const estimate = estimateAnalysis({
      triageModel: this.ctx.config.claude.triageModel,
      deepModel: this.ctx.config.claude.model,
      effort: this.cfg.effort,
      budgetUsd: run.budgetUsd,
      maxOutputTokens: this.cfg.maxOutputTokens,
      triageMaxOutputTokens: this.cfg.triageMaxOutputTokens,
      triageChunkTokens: triageTokens,
      systemTokens: this.systemTokens(inp),
      windows: newWindows.map((w) => {
        const e = w.estimate as { textTokens: number; imageTokens: number };
        return { rank: w.rank, textTokens: e.textTokens, imageTokens: e.imageTokens };
      }),
    });
    // Coût estimé de chaque fenêtre (affichage par fenêtre).
    for (const w of newWindows) {
      const e = estimate.windows.find((x) => x.rank === w.rank);
      w.estimate = { ...(w.estimate as object), typicalUsd: e?.typicalUsd, maxUsd: e?.maxUsd };
    }

    const tracks = rec.audioTracks.map((t) => {
      const sp = SPEAKER_BY_ROLE[t.role];
      const transcribed = inp.transcriptions.some((x) => x.audioIndex === t.audioIndex);
      return {
        audioIndex: t.audioIndex,
        role: t.role,
        textTransmitted: Boolean(
          sp && transcribed && (sp === 'creator' || policy.discordTextAllowed),
        ),
        reason: !sp
          ? 'piste sans voix'
          : !transcribed
            ? 'aucune transcription terminée'
            : sp === 'creator'
              ? 'micro du créateur'
              : policy.discordTextAllowed
                ? 'accord donné pour cet enregistrement'
                : 'voix d’autres personnes : accord requis (seuls les instants de parole sont indiqués)',
        energyMeasured: energy.some((e) => e.audioIndex === t.audioIndex),
      };
    });
    const totals = [...windowStats, ...chunks.map((c) => c.stats)];
    const manifest = {
      mode: 'dry_run',
      nothingSent: true,
      note: 'Préparation locale : AUCUN appel à Claude API n’a été effectué. Le dossier requetes/ contient les requêtes EXACTES qui seraient envoyées (prompts, données, schéma, paramètres) ; seules les images y sont remplacées par leur empreinte, et le résumé du repérage par un repère (il n’existe qu’après les appels de repérage).',
      runId: run.id,
      recordingId: rec.id,
      createdAt: new Date().toISOString(),
      durationMs,
      tracks,
      energyMissingForTracks: energyMissing,
      transcriptions: inp.transcriptions.map((t) => ({
        id: t.id,
        audioIndex: t.audioIndex,
        model: t.model,
      })),
      privacy: {
        discordTextAllowed: policy.discordTextAllowed,
        discordConsentAt: settings.discordConsentAt,
        facecamAllowed: settings.facecamAllowed,
        framing: { profileId: settings.framingProfileId, status: inp.framingStatus },
        imagesSent: framesByRank.size > 0,
        noImagesReason: noFramesReason,
        pseudonymFile: inp.privacy['pseudonymFile'],
        pseudonymLabelsUsed: [...new Set(totals.flatMap((s) => Object.keys(s.pseudonyms)))].sort(),
        masked: totals.reduce(
          (a, s) => ({
            email: a.email + s.masked.email,
            url: a.url + s.masked.url,
            phone: a.phone + s.masked.phone,
            mention: a.mention + s.masked.mention,
          }),
          { email: 0, url: 0, phone: 0, mention: 0 },
        ),
      },
      triage: {
        scope: this.cfg.triageScope,
        chunks: chunks.map((c) => ({
          index: c.index,
          startMs: c.startMs,
          endMs: c.endMs,
          estimatedTokens: c.estimatedTokens,
          transmittedSegments: c.stats.transmittedSegments,
          file: `reperage/tranche-${pad(c.index, 2)}.txt`,
        })),
      },
      windows: newWindows.map((w) => ({
        rank: w.rank,
        coreStartMs: w.coreStartMs,
        coreEndMs: w.coreEndMs,
        localScore: w.localScore,
        file: `fenetres/fenetre-${pad(w.rank, 3)}.txt`,
      })),
      signals: { total: signals.length, byKind: countBy(signals.map((s) => s.kind)) },
    };
    await writeFile(path.join(absDir, 'manifeste.json'), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(absDir, 'estimation.json'), JSON.stringify(estimate, null, 2));
    await writeFile(path.join(absDir, 'LISEZMOI.txt'), readme(manifest.note));

    this.repo.completePreparation(run.id, { windows: newWindows, estimate, outputRelDir: relDir });
    reportProgress(1);
    this.ctx.log.info(
      {
        runId: run.id,
        recordingId: rec.id,
        windows: newWindows.length,
        triageChunks: chunks.length,
        frames: [...framesByRank.values()].reduce((a, f) => a + f.length, 0),
        estimateTypicalUsd: estimate.totals.typicalUsd,
        estimateMaxUsd: estimate.totals.maxUsd,
        elapsedMs: Date.now() - started,
      },
      'Analyse préparée localement (aucun appel externe)',
    );
    return { runId: run.id, windowCount: newWindows.length, triageChunks: chunks.length };
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function readme(note: string): string {
  return [
    'AI Clip Studio — contenu préparé pour l’analyse éditoriale',
    '',
    note,
    '',
    'manifeste.json  : pistes transmises ou retenues (et pourquoi), confidentialité, liste des fichiers',
    'estimation.json : coût estimé (typique et pire cas) et fenêtres analysables sous le plafond',
    'reperage/       : tranches de transcription condensée pour le repérage global',
    'fenetres/       : une fenêtre candidate par fichier (.txt = texte transmis, .json = détail)',
    'requetes/       : requêtes exactes (prompt système, message, schéma de réponse, paramètres)',
    '',
  ].join('\n');
}
