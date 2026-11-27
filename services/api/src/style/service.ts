/**
 * Apprentissage du style de montage (étape 10).
 *
 * Trois sources, toutes LOCALES (aucun envoi à un service externe, aucun appel payant) :
 *  - vidéos de référence montées (même d'autres créateurs) : mesures FFmpeg agrégées ;
 *  - paires brut + montage : en plus, alignement sonore des plans ;
 *  - décisions du créateur dans l'éditeur (document de montage exact).
 *
 * Règles :
 *  - on n'apprend QUE des caractéristiques stylistiques mesurables (catalogue) ; aucun contenu,
 *    dialogue, image ni événement d'une référence n'est conservé ;
 *  - apprendre crée un BROUILLON (nouvelle version) ; une version validée n'est jamais modifiée et
 *    seule une version validée par le créateur est appliquée ;
 *  - une valeur réglée à la main n'est jamais remplacée par l'apprentissage.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  FEATURE_KEYS,
  STYLE_FEATURES,
  STYLE_GROUP_LABELS,
  StyleFeaturesSchema,
  alignShots,
  dominantContentType,
  editFeatures,
  editorObservation,
  learnFeatures,
  pairObservation,
  pairStructure,
  projectDefaults,
  referenceObservation,
  selectProfile,
  shotsFromCuts,
  suggestFeatures,
  type FeatureKey,
  type ProjectStyleDefaults,
  type StyleFeatures,
  type StyleHints,
  type StyleObservation,
  type ValidatedProfileRef,
} from '@acs/style';
import { stableHash } from '@acs/editorial';
import {
  audioEnvelope,
  fingerprintFile,
  probeMedia,
  scanAudioStyle,
  scanVideoStyle,
} from '@acs/media';
import { AppError } from '@acs/shared';
import type { AnalysisService } from '../analysis/service';
import type { EditService } from '../clips/edits';
import type { AppContext } from '../context';
import type { JobHandler, JobHandlerContext, JobRunner } from '../jobs/runner';
import { validateSourcePath } from '../recordings/import';
import type { JobDto } from '../recordings/repository';
import {
  StyleRepository,
  type StyleProfileRow,
  type StyleReferenceRow,
  type StyleTargetType,
  type StyleVersionRow,
} from './repository';

export const STYLE_ANALYZER_VERSION = 'style-v1';

const TARGETS = ['gaming', 'just_chatting', 'reaction', 'podcast', 'irl', 'mixed'] as const;
const RequestId = z.string().min(8).max(100);

export const CreateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    contentTypes: z.array(z.enum(TARGETS)).max(6).default([]),
  })
  .strict();
export const UpdateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    contentTypes: z.array(z.enum(TARGETS)).max(6).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export const LearnSchema = z.object({ requestId: RequestId }).strict();
export const EditDraftSchema = z
  .object({
    requestId: RequestId,
    /** Version sur laquelle l'édition a été faite (concurrence optimiste). */
    baseVersion: z.number().int().min(0),
    set: z.record(z.string(), z.union([z.number(), z.boolean(), z.string().max(40)])).default({}),
    clear: z.array(z.string()).max(64).default([]),
  })
  .strict();
export const ValidateSchema = z
  .object({
    requestId: RequestId,
    version: z.number().int().min(1),
    /** Empreinte des valeurs AFFICHÉES : on valide exactement ce que le créateur a vu. */
    featuresHash: z.string().length(64),
  })
  .strict();
export const ImportReferenceSchema = z
  .object({
    kind: z.enum(['edited', 'pair']),
    /** Vidéo montée (chemin absolu local). */
    path: z.string().min(1).max(4096),
    /** Paire : vidéo brute correspondante. */
    rawPath: z.string().min(1).max(4096).optional(),
    label: z.string().trim().min(1).max(120).optional(),
    profileId: z.string().min(1).max(64).nullable().optional(),
    contentType: z.enum(TARGETS).nullable().optional(),
  })
  .strict()
  .refine((b) => (b.kind === 'pair') === (b.rawPath !== undefined), {
    message: 'une paire exige la vidéo brute (rawPath), une référence seule n’en a pas',
  });
export const UpdateReferenceSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    profileId: z.string().min(1).max(64).nullable().optional(),
    contentType: z.enum(TARGETS).nullable().optional(),
  })
  .strict();

const JobParams = z.object({ referenceId: z.uuid() }).strict();

const parse = <T extends z.ZodType>(schema: T, data: unknown): z.output<T> => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 'Requête invalide', {
      details: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
};

export const featuresHash = (f: StyleFeatures) => stableHash(f);

/** Vue publique d'une référence : jamais de chemin complet (seulement le nom du fichier). */
export function publicReference(r: StyleReferenceRow) {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    fileName: r.fileName,
    rawFileName: r.rawFileName,
    contentType: r.contentType,
    profileId: r.profileId,
    status: r.status,
    analyzerVersion: r.analyzerVersion,
    analysis: r.analysis,
    error: r.errorCode ? { code: r.errorCode, message: r.errorMessage } : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class StyleService {
  readonly repo: StyleRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly runnerRef: () => JobRunner,
    private readonly analysis: AnalysisService,
    private readonly edits: () => EditService,
  ) {
    this.repo = new StyleRepository(ctx.db);
  }

  recover(): number {
    return this.repo.recoverStale();
  }

  /* ------------------------------ Catalogue ------------------------------ */

  catalog() {
    return {
      groups: STYLE_GROUP_LABELS,
      features: FEATURE_KEYS.map((key) => ({ key, ...STYLE_FEATURES[key] })),
    };
  }

  /* ------------------------------ Profils ------------------------------ */

  private profileRow(id: string): StyleProfileRow {
    const p = this.repo.profile(id);
    if (!p) throw new AppError('NOT_FOUND', 'Profil de style introuvable');
    return p;
  }

  /** Version validée active (dernière validation), ou null. */
  private active(profileId: string): StyleVersionRow | null {
    const v = this.repo.latestValidation(profileId);
    return v ? this.repo.version(profileId, v.version) : null;
  }

  private summary(p: StyleProfileRow) {
    const active = this.active(p.id);
    const latest = this.repo.latestVersion(p.id);
    const validation = this.repo.latestValidation(p.id);
    return {
      ...p,
      activeVersion: active?.version ?? null,
      validatedAt: validation?.createdAt ?? null,
      latestVersion: latest?.version ?? null,
      /** Un brouillon attend une validation (plus récent que la version validée). */
      draftPending: latest !== null && latest.version !== (active?.version ?? null),
      references: this.repo.listReferences().filter((r) => r.profileId === p.id).length,
      applications: this.repo.applicationCount(p.id),
    };
  }

  listProfiles() {
    return this.repo.listProfiles().map((p) => this.summary(p));
  }

  profile(id: string) {
    const p = this.profileRow(id);
    const active = this.active(id);
    const latest = this.repo.latestVersion(id);
    const draft = latest && latest.version !== active?.version ? latest : null;
    const changes = draft
      ? FEATURE_KEYS.filter(
          (k) =>
            JSON.stringify(draft.features[k] ?? null) !==
            JSON.stringify(active?.features[k] ?? null),
        )
      : [];
    return {
      profile: this.summary(p),
      active: active ? { ...active, hash: active.featuresHash } : null,
      draft: draft ? { ...draft, hash: draft.featuresHash } : null,
      /** Caractéristiques que le brouillon change par rapport à la version validée. */
      changes,
      versions: this.repo.versions(id).map((v) => ({
        version: v.version,
        origin: v.origin,
        basedOnVersion: v.basedOnVersion,
        createdAt: v.createdAt,
        validated: this.repo.validations(id).some((x) => x.version === v.version),
      })),
      references: this.repo
        .listReferences()
        .filter((r) => r.profileId === id)
        .map(publicReference),
    };
  }

  createProfile(body: unknown) {
    const b = parse(CreateProfileSchema, body);
    const id = randomUUID();
    this.repo.insertProfile({ id, name: b.name, contentTypes: b.contentTypes });
    return this.profile(id);
  }

  updateProfile(id: string, body: unknown) {
    const b = parse(UpdateProfileSchema, body);
    const p = this.profileRow(id);
    if (
      p.builtin &&
      b.contentTypes &&
      JSON.stringify(b.contentTypes) !== JSON.stringify(p.contentTypes)
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Les types d’un profil fourni ne changent pas : créez un profil personnalisé',
      );
    }
    this.repo.updateProfile(id, {
      name: b.name ?? p.name,
      contentTypes: b.contentTypes ?? p.contentTypes,
      archived: b.archived ?? p.archived,
    });
    return this.profile(id);
  }

  private nextVersion(profileId: string) {
    return (this.repo.latestVersion(profileId)?.version ?? 0) + 1;
  }

  /** Observations utilisables pour un profil : références associées + projets du même format. */
  async observations(profileId: string): Promise<{
    observations: StyleObservation[];
    evidence: {
      references: string[];
      projects: string[];
      changedByCreator: Partial<Record<FeatureKey, number>>;
    };
  }> {
    const p = this.profileRow(profileId);
    const observations: StyleObservation[] = [];
    const references: string[] = [];
    for (const r of this.repo.referencesForProfile(profileId)) {
      const o = r.analysis?.['observation'] as StyleObservation | undefined;
      if (o) {
        observations.push(o);
        references.push(r.id);
      }
    }
    const projects: string[] = [];
    const changedByCreator: Partial<Record<FeatureKey, number>> = {};
    for (const pr of this.repo.editedProjects()) {
      let head;
      let initial;
      try {
        head = this.edits().head(pr.projectId).doc;
        initial = this.edits().docAt(pr.projectId, 1).doc;
      } catch {
        continue; // journal illisible : ignoré, jamais inventé
      }
      const type = await this.contentTypeOf(pr.recordingId, head.origin.proposalBounds);
      const matches =
        p.contentTypes.includes('mixed') || p.contentTypes.includes(type as StyleTargetType);
      if (!matches) continue;
      const o = editorObservation(pr.projectId, head, initial);
      observations.push({ source: o.source, sourceId: o.sourceId, values: o.values });
      projects.push(pr.projectId);
      for (const k of o.changed) changedByCreator[k] = (changedByCreator[k] ?? 0) + 1;
    }
    return { observations, evidence: { references, projects, changedByCreator } };
  }

  /**
   * Apprend un nouveau BROUILLON depuis les observations. La version validée reste intacte ; les
   * valeurs manuelles du dernier état sont conservées. Rien de nouveau : aucune version créée.
   */
  async learn(profileId: string, body: unknown) {
    const b = parse(LearnSchema, body);
    this.profileRow(profileId);
    const replay = this.repo.versionByRequest(b.requestId);
    if (replay) {
      if (replay.profileId !== profileId)
        throw new AppError('IDEMPOTENCY_MISMATCH', 'Identifiant déjà utilisé');
      return { created: false, ...this.profile(profileId) };
    }
    const { observations, evidence } = await this.observations(profileId);
    if (!observations.length) {
      throw new AppError(
        'NOT_READY',
        'Rien à apprendre : associez une référence analysée à ce profil, ou modifiez des clips de ce format dans l’éditeur',
      );
    }
    const latest = this.repo.latestVersion(profileId);
    const { features } = suggestFeatures(latest?.features ?? null, learnFeatures(observations));
    StyleFeaturesSchema.parse(features);
    const hash = featuresHash(features);
    if (latest && latest.featuresHash === hash)
      return { created: false, ...this.profile(profileId) };
    this.repo.insertVersion({
      profileId,
      version: this.nextVersion(profileId),
      features,
      featuresHash: hash,
      origin: 'learned',
      basedOnVersion: latest?.version ?? null,
      evidence: { ...evidence, observations: observations.length },
      requestId: b.requestId,
    });
    return { created: true, ...this.profile(profileId) };
  }

  /** Modification manuelle : nouvelle version (brouillon), sur la dernière version connue. */
  editDraft(profileId: string, body: unknown) {
    const b = parse(EditDraftSchema, body);
    this.profileRow(profileId);
    const replay = this.repo.versionByRequest(b.requestId);
    if (replay) {
      if (replay.profileId !== profileId)
        throw new AppError('IDEMPOTENCY_MISMATCH', 'Identifiant déjà utilisé');
      return this.profile(profileId);
    }
    const latest = this.repo.latestVersion(profileId);
    if ((latest?.version ?? 0) !== b.baseVersion) {
      throw new AppError('VERSION_CONFLICT', 'Le profil a changé entre-temps : rechargez-le', {
        details: { latestVersion: latest?.version ?? 0 },
      });
    }
    let features: StyleFeatures;
    try {
      features = editFeatures(latest?.features ?? {}, { set: b.set, clear: b.clear });
    } catch (err) {
      throw new AppError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
    }
    StyleFeaturesSchema.parse(features);
    this.repo.insertVersion({
      profileId,
      version: this.nextVersion(profileId),
      features,
      featuresHash: featuresHash(features),
      origin: 'manual',
      basedOnVersion: latest?.version ?? null,
      evidence: { set: Object.keys(b.set), clear: b.clear },
      requestId: b.requestId,
    });
    return this.profile(profileId);
  }

  /** Validation explicite d'une version, telle qu'affichée (empreinte vérifiée). */
  validate(profileId: string, body: unknown) {
    const b = parse(ValidateSchema, body);
    this.profileRow(profileId);
    const replay = this.repo.validationByRequest(b.requestId);
    if (replay) {
      if (replay.profileId !== profileId || replay.version !== b.version) {
        throw new AppError(
          'IDEMPOTENCY_MISMATCH',
          'Identifiant déjà utilisé pour une autre validation',
        );
      }
      return this.profile(profileId);
    }
    const v = this.repo.version(profileId, b.version);
    if (!v) throw new AppError('NOT_FOUND', 'Version introuvable');
    if (v.featuresHash !== b.featuresHash) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Les valeurs affichées ne sont pas celles de cette version : rechargez le profil',
      );
    }
    if (Object.keys(v.features).length === 0) {
      throw new AppError('VALIDATION_FAILED', 'Un profil vide ne peut pas être validé');
    }
    this.repo.insertValidation({
      profileId,
      version: v.version,
      featuresHash: v.featuresHash,
      requestId: b.requestId,
    });
    this.ctx.log.info({ profileId, version: v.version }, 'Profil de style validé');
    return this.profile(profileId);
  }

  /* ------------------------------ Application ------------------------------ */

  private async contentTypeOf(
    recordingId: string,
    range: { srcStartMs: number; srcEndMs: number },
  ) {
    // Sans transcription ni segmentation : hypothèse historique (gaming).
    const segments = await this.analysis
      .inputs(recordingId)
      .then((i) => i.validContentSegments)
      .catch(() => null);
    return dominantContentType(segments, range);
  }

  validatedProfiles(): ValidatedProfileRef[] {
    const out: ValidatedProfileRef[] = [];
    for (const p of this.repo.listProfiles()) {
      if (p.archived) continue;
      const val = this.repo.latestValidation(p.id);
      const v = val ? this.repo.version(p.id, val.version) : null;
      if (val && v) {
        out.push({
          profileId: p.id,
          version: v.version,
          contentTypes: p.contentTypes,
          validatedAt: val.createdAt,
          features: v.features,
        });
      }
    }
    return out;
  }

  /**
   * Style à appliquer à un nouveau projet : profil VALIDÉ du format de l'extrait (sinon Mixte).
   * Aucun profil validé : null (création strictement identique à celle d'avant l'étape 10).
   */
  async styleFor(
    recordingId: string,
    range: { srcStartMs: number; srcEndMs: number },
  ): Promise<{
    profileId: string;
    version: number;
    contentType: string;
    defaults: ProjectStyleDefaults;
    hints: StyleHints;
  } | null> {
    const profiles = this.validatedProfiles();
    if (!profiles.length) return null;
    const type = await this.contentTypeOf(recordingId, range);
    const chosen = selectProfile(profiles, type);
    if (!chosen) return null;
    return {
      profileId: chosen.profileId,
      version: chosen.version,
      contentType: type,
      ...projectDefaults(chosen.features),
    };
  }

  recordApplication(
    projectId: string,
    s: {
      profileId: string;
      version: number;
      contentType: string;
      defaults: ProjectStyleDefaults;
      hints: StyleHints;
    },
  ) {
    this.repo.insertApplication({
      projectId,
      profileId: s.profileId,
      version: s.version,
      contentType: s.contentType,
      applied: { defaults: s.defaults, hints: s.hints },
    });
  }

  projectStyle(projectId: string) {
    const a = this.repo.application(projectId);
    if (!a) return { applied: false as const };
    const p = this.repo.profile(a.profileId);
    const { applied: values, ...rest } = a;
    return { applied: true as const, profileName: p?.name ?? a.profileId, ...rest, values };
  }

  /* ------------------------------ Références ------------------------------ */

  private referenceRow(id: string): StyleReferenceRow {
    const r = this.repo.reference(id);
    if (!r) throw new AppError('NOT_FOUND', 'Référence introuvable');
    return r;
  }

  listReferences() {
    return this.repo.listReferences().map(publicReference);
  }

  reference(id: string) {
    return publicReference(this.referenceRow(id));
  }

  /** Importe une référence : fichiers seulement RÉFÉRENCÉS (jamais copiés ni modifiés). */
  async importReference(body: unknown) {
    const b = parse(ImportReferenceSchema, body);
    if (b.profileId) this.profileRow(b.profileId);
    const edited = await validateSourcePath(b.path);
    const raw = b.rawPath ? await validateSourcePath(b.rawPath) : null;
    if (raw && raw.path === edited.path) {
      throw new AppError(
        'VALIDATION_FAILED',
        'La vidéo brute et la vidéo montée doivent être deux fichiers différents',
      );
    }
    const info = await probeMedia(this.ctx.config.tools.ffprobe, edited.path);
    if (!info.video)
      throw new AppError('MEDIA_UNSUPPORTED', 'La vidéo de référence n’a pas de piste vidéo');
    if (raw) {
      const rawInfo = await probeMedia(this.ctx.config.tools.ffprobe, raw.path);
      if (!rawInfo.audioTracks.length || !info.audioTracks.length) {
        throw new AppError(
          'MEDIA_UNSUPPORTED',
          'Une paire exige du son dans les deux vidéos (l’alignement se fait sur le son)',
        );
      }
    }
    const fp = (await fingerprintFile(edited.path)).hash;
    const rawFp = raw ? (await fingerprintFile(raw.path)).hash : null;
    const existing = this.repo.referenceByFiles(fp, rawFp);
    if (existing) return { created: false, reference: publicReference(existing) };
    const id = randomUUID();
    this.repo.insertReference({
      id,
      kind: b.kind,
      label: b.label ?? path.basename(edited.path),
      sourcePath: edited.path,
      fileName: path.basename(edited.path),
      fingerprint: fp,
      rawPath: raw?.path ?? null,
      rawFileName: raw ? path.basename(raw.path) : null,
      rawFingerprint: rawFp,
      contentType: b.contentType ?? null,
      profileId: b.profileId ?? null,
    });
    return { created: true, reference: this.reference(id) };
  }

  updateReference(id: string, body: unknown) {
    const b = parse(UpdateReferenceSchema, body);
    const r = this.referenceRow(id);
    if (b.profileId) this.profileRow(b.profileId);
    this.repo.updateReference(id, {
      label: b.label ?? r.label,
      profileId: b.profileId === undefined ? r.profileId : b.profileId,
      contentType: b.contentType === undefined ? r.contentType : b.contentType,
    });
    return this.reference(id);
  }

  /** Retire la référence de la bibliothèque (le fichier n'est jamais touché). */
  deleteReference(id: string) {
    this.referenceRow(id);
    this.repo.deleteReference(id);
  }

  analyzeReference(id: string): { job: JobDto; reference: ReturnType<typeof publicReference> } {
    const r = this.referenceRow(id);
    if (r.status === 'analyzing') {
      throw new AppError('CONFLICT', 'Analyse déjà en cours');
    }
    const { job } = this.runnerRef().enqueue({
      type: 'analyze_style_reference',
      lane: 'heavy',
      targetKey: `style_reference:${id}`,
      recordingId: null,
      params: { referenceId: id },
    });
    this.repo.setReferenceStatus(id, { status: 'analyzing' });
    return { job, reference: this.reference(id) };
  }

  handlers(): { analyze_style_reference: JobHandler } {
    return { analyze_style_reference: (job, hctx) => this.runJob(job, hctx) };
  }

  private async assertUnchanged(file: string, fp: string) {
    try {
      if ((await fingerprintFile(file)).hash !== fp) {
        throw new AppError(
          'MEDIA_SOURCE_CHANGED',
          'Le fichier a été modifié depuis son import : ré-importez-le',
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('MEDIA_NOT_FOUND', 'Fichier de référence introuvable');
    }
  }

  private async runJob(job: JobDto, { signal, reportProgress }: JobHandlerContext) {
    const { referenceId } = JobParams.parse(job.params);
    const r = this.referenceRow(referenceId);
    try {
      await this.assertUnchanged(r.sourcePath, r.fingerprint);
      if (r.rawPath && r.rawFingerprint) await this.assertUnchanged(r.rawPath, r.rawFingerprint);
      const ff = this.ctx.config.tools.ffmpeg;
      const info = await probeMedia(this.ctx.config.tools.ffprobe, r.sourcePath);
      const durationMs = Math.round((info.durationSec ?? 0) * 1000);
      if (durationMs < 1000)
        throw new AppError('MEDIA_UNSUPPORTED', 'Vidéo trop courte ou durée inconnue');
      const limits: string[] = [];
      const video = await scanVideoStyle(ff, r.sourcePath, durationMs, { signal });
      reportProgress(0.4);
      const audio = info.audioTracks.length
        ? await scanAudioStyle(ff, r.sourcePath, durationMs, { signal })
        : null;
      if (!audio) limits.push('Aucune piste audio : aucune caractéristique sonore mesurée.');
      reportProgress(0.6);
      const measures = {
        durationMs,
        width: info.video?.width ?? null,
        height: info.video?.height ?? null,
        cutsMs: video.cutsMs,
        blacks: video.blacks,
        freezes: video.freezes,
        loudness: audio?.loudness ?? null,
        silences: audio?.silences ?? [],
      };
      let observation: StyleObservation = referenceObservation(r.id, measures);
      let pair: Record<string, unknown> | null = null;
      if (r.kind === 'pair' && r.rawPath) {
        const editedEnv = await audioEnvelope(ff, r.sourcePath, { signal });
        reportProgress(0.75);
        const rawEnv = await audioEnvelope(ff, r.rawPath, { signal });
        reportProgress(0.9);
        // Plans du montage (les passages par le noir ne sont pas des plans).
        const bounds = [0, ...video.cutsMs.filter((t) => t > 0 && t < durationMs), durationMs];
        const shots: { startMs: number; endMs: number }[] = [];
        for (let i = 1; i < bounds.length; i++) {
          const s = bounds[i - 1]!;
          const e = bounds[i]!;
          if (e - s >= 100 && !video.blacks.some(([bs, be]) => s >= bs - 40 && e <= be + 40)) {
            shots.push({ startMs: s, endMs: e });
          }
        }
        const structure = pairStructure(alignShots(editedEnv, rawEnv, shots));
        const po = pairObservation(r.id, measures, structure);
        observation = { source: po.source, sourceId: po.sourceId, values: po.values };
        pair = { ...structure, reliable: po.structureReliable };
        if (!po.structureReliable) {
          limits.push(
            `Alignement insuffisant (${structure.alignedShots}/${structure.totalShots} plans retrouvés dans le brut) : structure du montage non déduite.`,
          );
        }
      }
      limits.push(
        'Non mesurable dans une vidéo : sous-titres, facecam, zooms, effets visuels et sonores, musique.',
      );
      this.repo.setReferenceStatus(r.id, {
        status: 'analyzed',
        analyzerVersion: STYLE_ANALYZER_VERSION,
        analysis: {
          observation,
          // Seulement des comptes et des durées agrégées : aucun instant, aucune image, aucun texte.
          summary: {
            durationMs,
            shots: shotsFromCuts(measures).length,
            fadesToBlack: video.blacks.length,
            freezes: video.freezes.length,
          },
          pair,
          limits,
        },
      });
      return { referenceId: r.id };
    } catch (err) {
      const aborted = signal.aborted || (err instanceof AppError && err.code === 'CANCELLED');
      this.repo.setReferenceStatus(
        r.id,
        aborted
          ? { status: 'pending' }
          : {
              status: 'failed',
              code: err instanceof AppError ? err.code : 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
            },
      );
      throw err;
    }
  }
}
