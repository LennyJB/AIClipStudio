import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AUDIO_GENERATOR_VERSION,
  AUDIO_PROFILES,
  computeWaveform,
  DEFAULT_POINTS_PER_SECOND,
  extractAudioTracks,
  extractFrame,
  fingerprintFile,
  FRAME_GENERATOR_VERSION,
  generateProxy,
  generateThumbnails,
  PROXY_GENERATOR_VERSION,
  PROXY_PROFILE,
  THUMBNAIL_GENERATOR_VERSION,
  THUMBNAIL_PROFILE,
  thumbnailLayout,
  type NormalizedRect,
  selectEditorTracks,
  selectTranscriptionTracks,
  WAVEFORM_GENERATOR_VERSION,
  type AudioProfileId,
} from '@acs/media';
import { AppError, type JobType } from '@acs/shared';
import type { AppContext } from '../context';
import type { JobHandler, JobHandlerContext, JobRunner } from '../jobs/runner';
import {
  RecordingRepository,
  type JobDto,
  type JobFile,
  type RecordingDto,
} from '../recordings/repository';
import { toAbs } from '../storage/paths';
import { canonicalJson, derivativeCacheKey, sha256, type DerivativeKind } from './cache-key';
import { DerivativeRepository, type DerivativeDto } from './repository';
import { clipWindow } from './window';

type Range = { startMs: number; endMs: number } | null;

interface Spec {
  key: string;
  kind: DerivativeKind;
  /** null : dérivé sans piste audio (image). */
  audioIndex: number | null;
  range: Range;
  params: Record<string, unknown>;
  paramsJson: string;
  version: number;
  relPath: string;
}

export interface DerivativeRequestResult {
  /** « ready » : tout est disponible ; « pending » : des traitements sont en cours ou en attente. */
  status: 'ready' | 'pending';
  /** Fichiers audio disponibles (éventuellement plus larges que la plage demandée : voir srcStartMs). */
  audio: DerivativeDto[];
  waveforms: DerivativeDto[];
  jobs: JobDto[];
}

const KIND_DIRS: Record<DerivativeKind, string> = {
  audio_transcription: 'transcription',
  audio_stem: 'stems',
  waveform: 'waveforms',
  video_proxy: 'proxies',
  thumbnail: 'thumbnails',
  frame: 'frames',
};

const PROFILE_BY_KIND = { audio_transcription: 'transcription', audio_stem: 'editor' } as const;

/** Profils autorisés pour un type de dérivé audio. */
const PROFILES_FOR_KIND: Record<'audio_transcription' | 'audio_stem', readonly AudioProfileId[]> = {
  audio_transcription: ['transcription'],
  audio_stem: ['editor', 'preview'],
};

/** Durée maximale d'un extrait d'écoute (garde-fou ; un clip dure au plus 80 s). */
export const PREVIEW_MAX_MS = 180_000;

const AudioJobParams = z
  .object({
    recordingId: z.uuid(),
    audioIndexes: z.array(z.number().int().nonnegative()).min(1),
    profile: z.enum(['transcription', 'editor', 'preview']).optional(),
    range: z
      .object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })
      .nullable(),
  })
  .strict();
const WaveformJobParams = z.object({ derivativeId: z.string().min(1) }).strict();
const rangeSchema = z
  .object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })
  .strict()
  .refine((r) => r.startMs < r.endMs, 'plage vide');
const rectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .strict();
const ProxyJobParams = z.object({ recordingId: z.uuid(), range: rangeSchema }).strict();
const ThumbnailJobParams = z
  .object({ recordingId: z.uuid(), range: rangeSchema, masks: z.array(rectSchema).max(50) })
  .strict();

/** Médias de travail de l'éditeur demandés pour une fenêtre (étape 7d). */
export interface EditorMediaResult {
  status: 'ready' | 'pending';
  proxy: DerivativeDto | null;
  thumbnails: DerivativeDto | null;
  audio: DerivativeDto[];
  waveforms: DerivativeDto[];
  jobs: JobDto[];
}

/**
 * Production à la demande et cache des fichiers dérivés.
 * Ordre de recherche : clé exacte ou dérivé englobant (présent sur disque) →
 * traitement identique en cours → nouveau traitement.
 */
export class DerivativeService {
  private readonly recordings: RecordingRepository;
  readonly repo: DerivativeRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly runnerRef: () => JobRunner,
  ) {
    this.recordings = new RecordingRepository(ctx.db);
    this.repo = new DerivativeRepository(ctx.db);
  }

  private get storage() {
    return this.ctx.config.paths.storage;
  }

  abs(relPath: string) {
    return toAbs(this.storage, relPath);
  }

  /* ----------------------------- Spécifications ----------------------------- */

  private relPathFor(
    recordingId: string,
    kind: DerivativeKind,
    key: string,
    audioIndex: number,
    ext: string,
  ) {
    return `processing/${recordingId}/${KIND_DIRS[kind]}/${key.slice(0, 16)}-a${audioIndex + 1}.${ext}`;
  }

  private audioSpec(
    fp: string,
    recordingId: string,
    kind: 'audio_transcription' | 'audio_stem',
    audioIndex: number,
    range: Range,
    profile: AudioProfileId = PROFILE_BY_KIND[kind],
  ): Spec {
    if (!PROFILES_FOR_KIND[kind].includes(profile)) {
      throw new AppError('VALIDATION_FAILED', `Profil ${profile} incompatible avec ${kind}`);
    }
    // Le profil par défaut garde exactement ses anciens paramètres (clés de cache inchangées).
    const params =
      profile === PROFILE_BY_KIND[kind]
        ? { ...AUDIO_PROFILES[profile] }
        : { ...AUDIO_PROFILES[profile], profile };
    const key = derivativeCacheKey({
      sourceFingerprint: fp,
      kind,
      audioIndex,
      range,
      params,
      generatorVersion: AUDIO_GENERATOR_VERSION,
    });
    return {
      key,
      kind,
      audioIndex,
      range,
      params,
      paramsJson: canonicalJson(params),
      version: AUDIO_GENERATOR_VERSION,
      relPath: this.relPathFor(recordingId, kind, key, audioIndex, 'wav'),
    };
  }

  /** La forme d'onde dépend du contenu audio (usage, paramètres, plage), pas de la ligne précise. */
  private waveformSpec(audio: DerivativeDto): Spec {
    const params = {
      pointsPerSecond: DEFAULT_POINTS_PER_SECOND,
      from: audio.kind,
      fromParams: audio.params,
    };
    const range =
      audio.srcStartMs === null ? null : { startMs: audio.srcStartMs, endMs: audio.srcEndMs! };
    const key = derivativeCacheKey({
      sourceFingerprint: audio.sourceFingerprint,
      kind: 'waveform',
      audioIndex: audio.audioIndex,
      range,
      params,
      generatorVersion: WAVEFORM_GENERATOR_VERSION,
    });
    return {
      key,
      kind: 'waveform',
      audioIndex: audio.audioIndex ?? 0,
      range,
      params,
      paramsJson: canonicalJson(params),
      version: WAVEFORM_GENERATOR_VERSION,
      relPath: this.relPathFor(audio.recordingId, 'waveform', key, audio.audioIndex ?? 0, 'dat'),
    };
  }

  /* ------------------------------- Recherche -------------------------------- */

  /** Dérivé utilisable (fichier présent) ; une ligne dont le fichier a disparu est retirée. */
  private findUsable(recordingId: string, fp: string, spec: Spec): DerivativeDto | null {
    const exact = this.repo.findByKey(spec.key);
    const candidates = exact
      ? [exact]
      : this.repo.findCovering({
          recordingId,
          sourceFingerprint: fp,
          kind: spec.kind,
          audioIndex: spec.audioIndex,
          paramsJson: spec.paramsJson,
          generatorVersion: spec.version,
          range: spec.range,
        });
    for (const d of candidates) {
      if (existsSync(this.abs(d.relPath))) {
        this.repo.touch(d.id);
        return this.repo.get(d.id);
      }
      this.repo.delete(d.id);
      this.ctx.log.warn(
        { derivativeId: d.id, relPath: d.relPath },
        'Dérivé absent du disque : retiré du cache',
      );
    }
    return null;
  }

  private loadRecording(recordingId: string): {
    rec: RecordingDto;
    fp: string;
    sourcePath: string;
  } {
    const rec = this.recordings.get(recordingId);
    const src = this.recordings.getSource(recordingId);
    if (!rec || !src) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return { rec, fp: src.fingerprint, sourcePath: src.sourcePath };
  }

  /* -------------------------------- Demandes -------------------------------- */

  /** WAV 16 kHz mono de tout l'enregistrement, pistes de voix (Whisper). */
  requestTranscriptionAudio(recordingId: string): DerivativeRequestResult {
    const { rec } = this.loadRecording(recordingId);
    const tracks = selectTranscriptionTracks(rec.audioTracks);
    if (!tracks.length)
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste de voix ou de mix à transcrire');
    return this.requestAudio(
      recordingId,
      'audio_transcription',
      tracks.map((t) => t.audioIndex),
      null,
      'heavy',
    );
  }

  /** Pistes de montage 48 kHz stéréo pour une fenêtre autour d'un clip. */
  requestAudioStems(
    recordingId: string,
    srcStartMs: number,
    srcEndMs: number,
  ): DerivativeRequestResult & { window: { startMs: number; endMs: number } } {
    const { rec } = this.loadRecording(recordingId);
    if (!(
      Number.isInteger(srcStartMs) &&
      Number.isInteger(srcEndMs) &&
      srcStartMs >= 0 &&
      srcEndMs > srcStartMs
    )) {
      throw new AppError('VALIDATION_FAILED', 'Plage source invalide');
    }
    const durationMs = rec.durationSec === null ? null : Math.round(rec.durationSec * 1000);
    if (durationMs !== null && srcStartMs >= durationMs) {
      throw new AppError('VALIDATION_FAILED', 'La plage commence après la fin de l’enregistrement');
    }
    const window = clipWindow(srcStartMs, srcEndMs, { ...this.ctx.config.clipWindow, durationMs });
    const tracks = selectEditorTracks(rec.audioTracks);
    if (!tracks.length)
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste audio exploitable pour le montage');
    // Recherche avec la plage DEMANDÉE (un dérivé plus large convient), production avec la fenêtre.
    return {
      ...this.requestAudio(
        recordingId,
        'audio_stem',
        tracks.map((t) => t.audioIndex),
        window,
        'interactive',
        {
          startMs: srcStartMs,
          endMs: Math.min(srcEndMs, window.endMs),
        },
      ),
      window,
    };
  }

  /**
   * Extrait d'écoute d'un passage (revue, étape 5) : piste « tout » (rôle mix) uniquement, WAV mono
   * 48 kHz, sur la plage demandée. Aucune forme d'onde. Original en lecture seule, cache commun.
   */
  requestPreviewAudio(recordingId: string, range: { startMs: number; endMs: number }) {
    const { audioIndex } = this.previewTrack(recordingId, range);
    return this.requestAudio(recordingId, 'audio_stem', [audioIndex], range, 'interactive', range, {
      profile: 'preview',
      waveforms: false,
    });
  }

  /** Extrait d'écoute déjà disponible (fichier présent), sans rien produire. */
  findPreviewAudio(recordingId: string, range: { startMs: number; endMs: number }) {
    const { audioIndex, fp } = this.previewTrack(recordingId, range);
    return this.findUsable(
      recordingId,
      fp,
      this.audioSpec(fp, recordingId, 'audio_stem', audioIndex, range, 'preview'),
    );
  }

  private previewTrack(recordingId: string, range: { startMs: number; endMs: number }) {
    const { rec, fp } = this.loadRecording(recordingId);
    if (
      !Number.isInteger(range.startMs) ||
      !Number.isInteger(range.endMs) ||
      range.startMs < 0 ||
      range.endMs <= range.startMs ||
      range.endMs - range.startMs > PREVIEW_MAX_MS
    ) {
      throw new AppError('VALIDATION_FAILED', 'Plage d’écoute invalide ou trop longue');
    }
    const mix = rec.audioTracks.find((t) => t.role === 'mix');
    if (!mix) {
      throw new AppError(
        'AUDIO_TRACK_MISSING',
        'Écoute indisponible : cet enregistrement n’a pas de piste « tout »',
      );
    }
    return { audioIndex: mix.audioIndex, fp };
  }

  private requestAudio(
    recordingId: string,
    kind: 'audio_transcription' | 'audio_stem',
    audioIndexes: number[],
    produceRange: Range,
    lane: 'heavy' | 'interactive',
    lookupRange: Range = produceRange,
    opts: { profile?: AudioProfileId; waveforms?: boolean } = {},
  ): DerivativeRequestResult {
    const { fp } = this.loadRecording(recordingId);
    const profile = opts.profile ?? PROFILE_BY_KIND[kind];
    const withWaveforms = opts.waveforms ?? true;
    const audio: DerivativeDto[] = [];
    const waveforms: DerivativeDto[] = [];
    const jobs: JobDto[] = [];
    const missing: number[] = [];

    for (const idx of audioIndexes) {
      const found = this.findUsable(
        recordingId,
        fp,
        this.audioSpec(fp, recordingId, kind, idx, lookupRange, profile),
      );
      if (!found) {
        missing.push(idx);
        continue;
      }
      audio.push(found);
      if (!withWaveforms) continue;
      const wf = this.ensureWaveform(found);
      if ('derivative' in wf) waveforms.push(wf.derivative);
      else jobs.push(wf.job);
    }

    if (missing.length) {
      const specs = missing.map((i) =>
        this.audioSpec(fp, recordingId, kind, i, produceRange, profile),
      );
      const files: JobFile[] = specs.flatMap((s) => outputFiles(s.relPath));
      const type: JobType =
        kind === 'audio_transcription' ? 'extract_transcription_audio' : 'extract_audio_stems';
      const { job } = this.runnerRef().enqueue({
        type,
        lane,
        targetKey: `${type}:${sha256(canonicalJson({ fp, range: produceRange, idx: missing, v: AUDIO_GENERATOR_VERSION, profile }))}`,
        recordingId,
        params: {
          recordingId,
          audioIndexes: missing,
          range: produceRange,
          ...(profile !== PROFILE_BY_KIND[kind] ? { profile } : {}),
        },
        files,
      });
      jobs.push(job);
    }
    return { status: jobs.length ? 'pending' : 'ready', audio, waveforms, jobs };
  }

  /** Forme d'onde d'un dérivé audio : disponible, ou traitement créé. */
  requestWaveform(audioDerivativeId: string): DerivativeRequestResult {
    const audio = this.repo.get(audioDerivativeId);
    if (!audio || (audio.kind !== 'audio_transcription' && audio.kind !== 'audio_stem')) {
      throw new AppError('NOT_FOUND', 'Dérivé audio introuvable');
    }
    const wf = this.ensureWaveform(audio);
    return 'derivative' in wf
      ? { status: 'ready', audio: [audio], waveforms: [wf.derivative], jobs: [] }
      : { status: 'pending', audio: [audio], waveforms: [], jobs: [wf.job] };
  }

  private ensureWaveform(audio: DerivativeDto): { derivative: DerivativeDto } | { job: JobDto } {
    const spec = this.waveformSpec(audio);
    const found = this.findUsable(audio.recordingId, audio.sourceFingerprint, spec);
    if (found) return { derivative: found };
    const { job } = this.runnerRef().enqueue({
      type: 'compute_waveform',
      lane: 'interactive',
      targetKey: `compute_waveform:${spec.key}`,
      recordingId: audio.recordingId,
      params: { derivativeId: audio.id },
      files: [{ relPath: audio.relPath, usage: 'input' }, ...outputFiles(spec.relPath)],
    });
    return { job };
  }

  /* ------------------------- Médias de travail (7d) ------------------------- */

  /** Proxy et vignettes : UNIQUEMENT dans `processing/editor/` (donnée sensible, §5.2). */
  private editorRelPath(recordingId: string, prefix: string, key: string, ext: string) {
    return `processing/editor/${recordingId}/${prefix}-${key.slice(0, 16)}.${ext}`;
  }

  private proxySpec(
    fp: string,
    recordingId: string,
    range: { startMs: number; endMs: number },
  ): Spec {
    const params = { ...PROXY_PROFILE };
    const key = derivativeCacheKey({
      sourceFingerprint: fp,
      kind: 'video_proxy',
      audioIndex: null,
      range,
      params,
      generatorVersion: PROXY_GENERATOR_VERSION,
    });
    return {
      key,
      kind: 'video_proxy',
      audioIndex: null,
      range,
      params,
      paramsJson: canonicalJson(params),
      version: PROXY_GENERATOR_VERSION,
      relPath: this.editorRelPath(recordingId, 'proxy', key, 'mp4'),
    };
  }

  /** Les masques entrent dans la clé : un masque ajouté ou modifié produit une nouvelle planche. */
  private thumbnailSpec(
    fp: string,
    recordingId: string,
    range: { startMs: number; endMs: number },
    masks: readonly NormalizedRect[],
  ): Spec {
    const params = { ...THUMBNAIL_PROFILE, masks: masks.map((m) => ({ ...m })) };
    const key = derivativeCacheKey({
      sourceFingerprint: fp,
      kind: 'thumbnail',
      audioIndex: null,
      range,
      params,
      generatorVersion: THUMBNAIL_GENERATOR_VERSION,
    });
    return {
      key,
      kind: 'thumbnail',
      audioIndex: null,
      range,
      params,
      paramsJson: canonicalJson(params),
      version: THUMBNAIL_GENERATOR_VERSION,
      relPath: this.editorRelPath(recordingId, 'vignettes', key, 'jpg'),
    };
  }

  /**
   * Médias de travail d'une fenêtre éditable : proxy (sans masque), planche de vignettes MASQUÉE,
   * pistes de montage des seules pistes demandées (autorisées et activées : choix de l'appelant)
   * et leurs formes d'onde. Disponibles, ou traitements créés (file interactive).
   */
  requestEditorMedia(
    recordingId: string,
    range: { startMs: number; endMs: number },
    masks: readonly NormalizedRect[],
    audioIndexes: readonly number[],
  ): EditorMediaResult {
    const { rec, fp } = this.loadRecording(recordingId);
    if (!rec.video?.width || !rec.video.height) {
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste vidéo exploitable');
    }
    const jobs: JobDto[] = [];
    const ensure = (
      spec: Spec,
      type: 'video_proxy' | 'thumbnail_sprite',
      params: Record<string, unknown>,
    ) => {
      const found = this.findUsable(recordingId, fp, spec);
      if (found) return found;
      const { job } = this.runnerRef().enqueue({
        type,
        lane: 'interactive',
        targetKey: `${type}:${spec.key}`,
        recordingId,
        params,
        files: outputFiles(spec.relPath),
      });
      jobs.push(job);
      return null;
    };
    const proxy = ensure(this.proxySpec(fp, recordingId, range), 'video_proxy', {
      recordingId,
      range,
    });
    const thumbnails = ensure(
      this.thumbnailSpec(fp, recordingId, range, masks),
      'thumbnail_sprite',
      {
        recordingId,
        range,
        masks: masks.map((m) => ({ ...m })),
      },
    );
    const audio = audioIndexes.length
      ? this.requestAudio(recordingId, 'audio_stem', [...audioIndexes], range, 'interactive')
      : { audio: [], waveforms: [], jobs: [] };
    jobs.push(...audio.jobs);
    return {
      status: jobs.length ? 'pending' : 'ready',
      proxy,
      thumbnails,
      audio: audio.audio,
      waveforms: audio.waveforms,
      jobs,
    };
  }

  private async runProxyJob(job: JobDto, { signal, reportProgress }: JobHandlerContext) {
    const p = ProxyJobParams.parse(job.params);
    const { rec, fp, sourcePath } = this.loadRecording(p.recordingId);
    const spec = this.proxySpec(fp, rec.id, p.range);
    const existing = this.findUsable(rec.id, fp, spec);
    if (existing) return { derivativeIds: [existing.id] };
    await this.assertSourceUnchanged(sourcePath, fp);
    const res = await generateProxy({
      ffmpegPath: this.ctx.config.tools.ffmpeg,
      inputPath: sourcePath,
      outputPath: this.abs(spec.relPath),
      allowedDir: path.join(this.ctx.config.paths.processing, 'editor'),
      windowStartMs: p.range.startMs,
      windowEndMs: p.range.endMs,
      sourceFps: rec.video?.fps ?? null,
      probeBytes: this.ctx.config.render.probeBytes,
      signal,
      onProgress: reportProgress,
    });
    const d = this.repo.upsert({
      id: randomUUID(),
      cacheKey: spec.key,
      recordingId: rec.id,
      sourceFingerprint: fp,
      kind: 'video_proxy',
      audioIndex: null,
      range: spec.range,
      paramsJson: spec.paramsJson,
      generatorVersion: spec.version,
      inputDerivativeId: null,
      relPath: spec.relPath,
      sizeBytes: res.sizeBytes,
      durationMs: res.durationMs,
    });
    return { derivativeIds: [d.id] };
  }

  private async runThumbnailJob(job: JobDto, { signal }: JobHandlerContext) {
    const p = ThumbnailJobParams.parse(job.params);
    const { rec, fp, sourcePath } = this.loadRecording(p.recordingId);
    const spec = this.thumbnailSpec(fp, rec.id, p.range, p.masks);
    const existing = this.findUsable(rec.id, fp, spec);
    if (existing) return { derivativeIds: [existing.id] };
    if (!rec.video?.width || !rec.video.height) {
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste vidéo exploitable');
    }
    await this.assertSourceUnchanged(sourcePath, fp);
    const res = await generateThumbnails({
      ffmpegPath: this.ctx.config.tools.ffmpeg,
      inputPath: sourcePath,
      outputPath: this.abs(spec.relPath),
      allowedDir: path.join(this.ctx.config.paths.processing, 'editor'),
      windowStartMs: p.range.startMs,
      windowEndMs: p.range.endMs,
      videoWidth: rec.video.width,
      videoHeight: rec.video.height,
      masks: p.masks,
      probeBytes: this.ctx.config.render.probeBytes,
      signal,
    });
    const d = this.repo.upsert({
      id: randomUUID(),
      cacheKey: spec.key,
      recordingId: rec.id,
      sourceFingerprint: fp,
      kind: 'thumbnail',
      audioIndex: null,
      range: spec.range,
      paramsJson: spec.paramsJson,
      generatorVersion: spec.version,
      inputDerivativeId: null,
      relPath: spec.relPath,
      sizeBytes: res.sizeBytes,
      durationMs: null,
    });
    return { derivativeIds: [d.id] };
  }

  /** Disposition de la planche de vignettes (déduite de la fenêtre et des dimensions source). */
  thumbnailLayoutFor(d: DerivativeDto) {
    const rec = this.recordings.get(d.recordingId);
    if (d.srcStartMs === null || !rec?.video?.width || !rec.video.height) return null;
    return thumbnailLayout(d.srcStartMs, d.srcEndMs!, rec.video.width, rec.video.height);
  }

  /* --------------------------------- Images --------------------------------- */

  /**
   * Images à des instants précis (SourceMs), recadrées et masquées, mises en cache comme
   * dérivés « frame ». L'original est vérifié UNE fois (présence et empreinte).
   */
  async ensureFrames(
    recordingId: string,
    requests: readonly FrameRequest[],
    opts: { signal: AbortSignal; onProgress?: (done: number) => void },
  ): Promise<DerivativeDto[]> {
    const { rec, fp, sourcePath } = this.loadRecording(recordingId);
    const width = rec.video?.width ?? null;
    const height = rec.video?.height ?? null;
    if (!width || !height)
      throw new AppError('MEDIA_UNSUPPORTED', 'Aucune piste vidéo exploitable');
    const specs = requests.map((r) => this.frameSpec(fp, recordingId, r));
    const out: DerivativeDto[] = [];
    let sourceChecked = false;
    for (const [i, spec] of specs.entries()) {
      if (opts.signal.aborted) throw new AppError('CANCELLED', 'Préparation annulée');
      const found = this.findUsable(recordingId, fp, spec);
      if (found) {
        out.push(found);
        opts.onProgress?.(i + 1);
        continue;
      }
      if (!sourceChecked) {
        await this.assertSourceUnchanged(sourcePath, fp);
        sourceChecked = true;
      }
      const r = requests[i]!;
      const res = await extractFrame({
        ffmpegPath: this.ctx.config.tools.ffmpeg,
        inputPath: sourcePath,
        outputPath: this.abs(spec.relPath),
        allowedDir: this.ctx.config.paths.processing,
        atMs: r.atMs,
        videoWidth: width,
        videoHeight: height,
        crop: r.crop,
        masks: r.masks,
        maxWidth: r.maxWidth,
        signal: opts.signal,
      });
      out.push(
        this.repo.upsert({
          id: randomUUID(),
          cacheKey: spec.key,
          recordingId,
          sourceFingerprint: fp,
          kind: 'frame',
          audioIndex: null,
          range: spec.range,
          paramsJson: spec.paramsJson,
          generatorVersion: spec.version,
          inputDerivativeId: null,
          relPath: spec.relPath,
          sizeBytes: res.sizeBytes,
          durationMs: null,
        }),
      );
      opts.onProgress?.(i + 1);
    }
    return out;
  }

  private frameSpec(fp: string, recordingId: string, r: FrameRequest): Spec {
    const params = { region: r.region, crop: r.crop, masks: r.masks, maxWidth: r.maxWidth };
    const range = { startMs: r.atMs, endMs: r.atMs + 1 };
    const key = derivativeCacheKey({
      sourceFingerprint: fp,
      kind: 'frame',
      audioIndex: null,
      range,
      params,
      generatorVersion: FRAME_GENERATOR_VERSION,
    });
    return {
      key,
      kind: 'frame',
      audioIndex: null,
      range,
      params,
      paramsJson: canonicalJson(params),
      version: FRAME_GENERATOR_VERSION,
      relPath: `processing/${recordingId}/${KIND_DIRS.frame}/${key.slice(0, 16)}.jpg`,
    };
  }

  /** L'original a-t-il été déplacé ou modifié depuis l'import ? */
  async assertSourceUnchanged(sourcePath: string, fp: string): Promise<void> {
    if (!existsSync(sourcePath))
      throw new AppError('MEDIA_NOT_FOUND', `Original introuvable : ${sourcePath}`);
    if ((await fingerprintFile(sourcePath)).hash !== fp) {
      throw new AppError(
        'MEDIA_SOURCE_CHANGED',
        'L’original a été modifié depuis l’import : ré-importez-le',
      );
    }
  }

  /** Chemin de l'original et dimensions vidéo (aperçu de cadrage). */
  sourceInfo(recordingId: string) {
    const { rec, fp, sourcePath } = this.loadRecording(recordingId);
    return { fp, sourcePath, width: rec.video?.width ?? null, height: rec.video?.height ?? null };
  }

  /* -------------------------------- Handlers -------------------------------- */

  handlers(): Record<
    Exclude<JobType, 'transcribe_recording' | 'prepare_analysis' | 'run_analysis' | 'render_clip'>,
    JobHandler
  > {
    return {
      extract_transcription_audio: (job, hctx) =>
        this.runAudioJob(job, hctx, 'audio_transcription'),
      extract_audio_stems: (job, hctx) => this.runAudioJob(job, hctx, 'audio_stem'),
      compute_waveform: (job, hctx) => this.runWaveformJob(job, hctx),
      video_proxy: (job, hctx) => this.runProxyJob(job, hctx),
      thumbnail_sprite: (job, hctx) => this.runThumbnailJob(job, hctx),
    };
  }

  private async runAudioJob(
    job: JobDto,
    { signal, reportProgress }: JobHandlerContext,
    kind: 'audio_transcription' | 'audio_stem',
  ) {
    const p = AudioJobParams.parse(job.params);
    const ready = await this.ensureAudio(p.recordingId, kind, p.audioIndexes, p.range, {
      signal,
      reportProgress,
      logContext: { jobId: job.id },
      ...(p.profile ? { profile: p.profile, waveforms: p.profile !== 'preview' } : {}),
    });
    return { derivativeIds: ready.map((d) => d.id) };
  }

  /** Clé de cache du WAV de transcription d'une piste (entrée de la transcription). */
  transcriptionAudioKey(recordingId: string, audioIndex: number): string {
    const { fp } = this.loadRecording(recordingId);
    return this.audioSpec(fp, recordingId, 'audio_transcription', audioIndex, null).key;
  }

  /**
   * Garantit la présence des fichiers audio demandés (cache, sinon extraction en un seul
   * passage + formes d'onde). Utilisable depuis un autre traitement (ex. transcription).
   * Renvoie les dérivés dans l'ordre des pistes demandées.
   */
  async ensureAudio(
    recordingId: string,
    kind: 'audio_transcription' | 'audio_stem',
    audioIndexes: readonly number[],
    range: Range,
    opts: {
      signal: AbortSignal;
      reportProgress: (ratio: number) => void;
      logContext?: object;
      profile?: AudioProfileId;
      waveforms?: boolean;
    },
  ): Promise<DerivativeDto[]> {
    const { signal, reportProgress } = opts;
    const profile = opts.profile ?? PROFILE_BY_KIND[kind];
    const p = { audioIndexes, range };
    const { rec, fp, sourcePath } = this.loadRecording(recordingId);

    // L'original a-t-il été déplacé ou modifié depuis l'import ?
    if (!existsSync(sourcePath))
      throw new AppError('MEDIA_NOT_FOUND', `Original introuvable : ${sourcePath}`);
    if ((await fingerprintFile(sourcePath)).hash !== fp) {
      throw new AppError(
        'MEDIA_SOURCE_CHANGED',
        'L’original a été modifié depuis l’import : ré-importez-le',
      );
    }

    const specs = p.audioIndexes.map((i) => this.audioSpec(fp, rec.id, kind, i, p.range, profile));
    const ready: DerivativeDto[] = [];
    const todo: typeof specs = [];
    for (const s of specs) {
      const found = this.findUsable(rec.id, fp, s); // produit entre-temps par un autre traitement ?
      if (found) ready.push(found);
      else todo.push(s);
    }

    if (todo.length) {
      const started = Date.now();
      const results = await extractAudioTracks({
        ffmpegPath: this.ctx.config.tools.ffmpeg,
        inputPath: sourcePath,
        targets: todo.map((s) => ({ audioIndex: s.audioIndex!, outputPath: this.abs(s.relPath) })),
        allowedDir: this.ctx.config.paths.processing,
        profile,
        range: p.range,
        expectedDurationSec: rec.durationSec,
        signal,
        onProgress: (r) => reportProgress(r * 0.85),
      });
      for (const res of results) {
        const s = todo.find((x) => x.audioIndex === res.audioIndex)!;
        ready.push(
          this.repo.upsert({
            id: randomUUID(),
            cacheKey: s.key,
            recordingId: rec.id,
            sourceFingerprint: fp,
            kind,
            audioIndex: s.audioIndex,
            range: s.range,
            paramsJson: s.paramsJson,
            generatorVersion: s.version,
            inputDerivativeId: null,
            relPath: s.relPath,
            sizeBytes: (await stat(res.outputPath)).size,
            durationMs: Math.round(res.durationSec * 1000),
          }),
        );
      }
      this.ctx.log.info(
        {
          ...opts.logContext,
          kind,
          range: p.range,
          tracks: results.map((r) => ({
            audioIndex: r.audioIndex,
            durationSec: Math.round(r.durationSec * 10) / 10,
          })),
          elapsedMs: Date.now() - started,
        },
        'Audio extrait',
      );
    }

    // Formes d'onde : calculées dans la foulée, à partir des WAV (pas de relecture de l'original).
    for (const [i, audio] of (opts.waveforms === false ? [] : ready).entries()) {
      await this.produceWaveform(audio, signal);
      reportProgress(0.85 + (0.15 * (i + 1)) / ready.length);
    }

    const longestMs = Math.max(0, ...ready.map((d) => d.durationMs ?? 0));
    if (kind === 'audio_transcription' && longestMs > 0) {
      this.recordings.setDurationFromAudioIfUnknown(rec.id, longestMs / 1000);
    }
    return audioIndexes.map((i) => ready.find((d) => d.audioIndex === i)!);
  }

  private async runWaveformJob(job: JobDto, { signal }: JobHandlerContext) {
    const { derivativeId } = WaveformJobParams.parse(job.params);
    const audio = this.repo.get(derivativeId);
    if (!audio || !existsSync(this.abs(audio.relPath))) {
      throw new AppError(
        'NOT_FOUND',
        'Le fichier audio source n’est plus disponible : redemandez-le',
      );
    }
    const wf = await this.produceWaveform(audio, signal);
    return { derivativeIds: [wf.id] };
  }

  private async produceWaveform(audio: DerivativeDto, signal: AbortSignal): Promise<DerivativeDto> {
    const spec = this.waveformSpec(audio);
    const existing = this.findUsable(audio.recordingId, audio.sourceFingerprint, spec);
    if (existing) return existing;
    const res = await computeWaveform({
      wavPath: this.abs(audio.relPath),
      outputPath: this.abs(spec.relPath),
      allowedDir: this.ctx.config.paths.processing,
      signal,
    });
    return this.repo.upsert({
      id: randomUUID(),
      cacheKey: spec.key,
      recordingId: audio.recordingId,
      sourceFingerprint: audio.sourceFingerprint,
      kind: 'waveform',
      audioIndex: audio.audioIndex,
      range: spec.range,
      paramsJson: spec.paramsJson,
      generatorVersion: spec.version,
      inputDerivativeId: audio.id,
      relPath: spec.relPath,
      sizeBytes: res.sizeBytes,
      durationMs: Math.round((res.length / res.pointsPerSecond) * 1000),
    });
  }
}

export interface FrameRequest {
  atMs: number;
  region: 'gameplay' | 'facecam';
  crop: NormalizedRect;
  masks: readonly NormalizedRect[];
  maxWidth: number;
}

/** Un fichier de sortie et son temporaire sont protégés pendant le traitement. */
function outputFiles(relPath: string): JobFile[] {
  return [
    { relPath, usage: 'output' },
    { relPath: `${relPath}.part`, usage: 'output' },
  ];
}
