/**
 * Médias de travail de l'éditeur (étape 7d, docs/plan-etape-7.md §5.1–5.2) :
 *  - préparation, pour la fenêtre éditable du projet : proxy vidéo (sans masque), planche de
 *    vignettes MASQUÉE, pistes de montage des seules pistes AUTORISÉES ET ACTIVÉES (décision 5)
 *    et leurs formes d'onde ;
 *  - baux : chaque session de l'éditeur tient un bail sur ses médias (renouvelé à chaque
 *    préparation, rendu à la fermeture, expiré sinon) ; le nettoyage ne touche jamais un dérivé
 *    sous bail actif ;
 *  - accès : jeton éphémère lié au projet, au dérivé et au bail ; lecture revérifiée à chaque
 *    requête (bail toujours actif, piste toujours autorisée et activée, dérivé du bon
 *    enregistrement) ; fichier résolu en base, jamais par un chemin du client.
 */
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@acs/shared';
import type { ClipProjectV2 } from '@acs/timeline';
import type { AppContext } from '../context';
import type { LeaseRepository } from '../derivatives/leases';
import type { DerivativeDto } from '../derivatives/repository';
import type { DerivativeService } from '../derivatives/service';
import { openServableFile, type OpenedFile } from '../review/servable-file';
import { parse } from '../routes/validation';
import { toAbs } from '../storage/paths';
import type { ExportAudioService } from './export-audio';
import type { MediaAccess } from './media-access';
import type { ProjectRow } from './repository';
import type { ClipProjectService } from './service';

/** Durée d'un bail de session (renouvelé par l'éditeur tant qu'il est ouvert). */
export const EDITOR_LEASE_TTL_MS = 15 * 60_000;

export const EditorSessionBodySchema = z.object({ sessionId: z.uuid() }).strict();
export const MediaTokenBodySchema = z
  .object({ sessionId: z.uuid(), derivativeId: z.string().min(1).max(100) })
  .strict();

/** Types servis, leur dossier autorisé (sous processing/), extension et type de contenu. */
const SERVABLE: Record<
  string,
  { dir: 'editor' | 'any'; ext: string; contentType: string } | undefined
> = {
  video_proxy: { dir: 'editor', ext: '.mp4', contentType: 'video/mp4' },
  thumbnail: { dir: 'editor', ext: '.jpg', contentType: 'image/jpeg' },
  audio_stem: { dir: 'any', ext: '.wav', contentType: 'audio/wav' },
  waveform: { dir: 'any', ext: '.dat', contentType: 'application/octet-stream' },
};

export class EditorMediaService {
  constructor(
    private readonly ctx: AppContext,
    private readonly clips: ClipProjectService,
    private readonly derivatives: DerivativeService,
    private readonly exportAudio: ExportAudioService,
    readonly access: MediaAccess,
    readonly leases: LeaseRepository,
  ) {}

  holder(projectId: string, sessionId: string) {
    return `editor:${projectId}:${sessionId}`;
  }

  /** Pistes audibles dans l'éditeur : autorisées AUJOURD'HUI et activées dans le document. */
  private audibleTracks(row: ProjectRow, doc: ClipProjectV2): number[] {
    const rec = this.clips.recordingOf(row);
    const allowed = new Set(this.exportAudio.decisionFor(rec).selected.map((t) => t.audioIndex));
    return doc.audio.tracks
      .filter((t) => t.enabled && allowed.has(t.audioIndex))
      .map((t) => t.audioIndex);
  }

  /** Prépare (ou retrouve) les médias de la fenêtre éditable et prend ou prolonge le bail. */
  prepare(projectId: string, body: unknown) {
    const { sessionId } = parse(EditorSessionBodySchema, body);
    const row = this.clips.projectRow(projectId);
    const { doc } = this.clips.edits.head(projectId);
    const w = doc.source.editWindow;
    // Vignettes : tout aplat OPAQUE, permanent ou temporel (appliqué partout : jamais moins masqué).
    const masks = doc.masks.filter((m) => m.mode === 'opaque').map((m) => m.rect);
    const tracks = this.audibleTracks(row, doc);
    const r = this.derivatives.requestEditorMedia(
      row.recordingId,
      { startMs: w.srcStartMs, endMs: w.srcEndMs },
      masks,
      tracks,
    );
    const holder = this.holder(projectId, sessionId);
    const ready = [r.proxy, r.thumbnails, ...r.audio, ...r.waveforms].filter(
      (d): d is DerivativeDto => d !== null,
    );
    const expiresAt = this.leases.acquire(
      ready.map((d) => d.id),
      holder,
      EDITOR_LEASE_TTL_MS,
    );
    const roles = new Map(
      this.clips.recordingOf(row).audioTracks.map((t) => [t.audioIndex, t.role]),
    );
    return {
      status: r.status,
      window: { srcStartMs: w.srcStartMs, srcEndMs: w.srcEndMs },
      lease: { expiresAt },
      proxy: r.proxy && {
        id: r.proxy.id,
        srcStartMs: r.proxy.srcStartMs,
        durationMs: r.proxy.durationMs,
      },
      thumbnails: r.thumbnails && {
        id: r.thumbnails.id,
        layout: this.derivatives.thumbnailLayoutFor(r.thumbnails),
      },
      audio: r.audio.map((d) => ({
        id: d.id,
        audioIndex: d.audioIndex,
        role: roles.get(d.audioIndex!) ?? 'unknown',
        srcStartMs: d.srcStartMs,
      })),
      waveforms: r.waveforms.map((d) => ({ id: d.id, audioIndex: d.audioIndex })),
      jobs: r.jobs.map((j) => ({ id: j.id, type: j.type, status: j.status })),
    };
  }

  /** Fermeture de l'éditeur : baux rendus (les médias redeviennent un cache évinçable). */
  release(projectId: string, body: unknown) {
    const { sessionId } = parse(EditorSessionBodySchema, body);
    this.clips.projectRow(projectId);
    return { released: this.leases.release(this.holder(projectId, sessionId)) };
  }

  /**
   * Le dérivé peut-il être servi à ce titulaire, MAINTENANT ? Même enregistrement, type servi,
   * bail actif, et pour l'audio : piste autorisée et activée aujourd'hui.
   */
  private assertServable(row: ProjectRow, d: DerivativeDto | null, holder: string): DerivativeDto {
    const refuse = (reason: string) =>
      new AppError('FORBIDDEN', 'Accès refusé', { details: { reason } });
    if (!d || d.recordingId !== row.recordingId || !SERVABLE[d.kind]) throw refuse('derivative');
    if (!this.leases.active(d.id, holder)) throw refuse('lease');
    if (d.kind === 'audio_stem' || d.kind === 'waveform') {
      const { doc } = this.clips.edits.head(row.id);
      if (d.audioIndex === null || !this.audibleTracks(row, doc).includes(d.audioIndex)) {
        throw refuse('track');
      }
    }
    return d;
  }

  /** Demande de jeton (contrôles §5.2 de la demande, puis droits sur le dérivé). */
  issueToken(req: FastifyRequest, projectId: string) {
    this.access.checkTokenRequest(req);
    const b = parse(MediaTokenBodySchema, req.body ?? {});
    const row = this.clips.projectRow(projectId);
    const holder = this.holder(projectId, b.sessionId);
    const d = this.assertServable(row, this.derivatives.repo.get(b.derivativeId), holder);
    return this.access.issue({ projectId, derivativeId: d.id, holder });
  }

  /** Lecture d'un média : contrôles §5.2, jeton, droits revérifiés, fichier résolu en base. */
  async open(
    req: FastifyRequest,
    derivativeId: string,
    token: string | undefined,
  ): Promise<{ file: OpenedFile; contentType: string }> {
    this.access.checkMediaRequest(req);
    const p = this.access.verify(token, derivativeId);
    const row = this.clips.projectRow(p.projectId);
    const d = this.assertServable(row, this.derivatives.repo.get(derivativeId), p.holder);
    const kind = SERVABLE[d.kind]!;
    const processing = this.ctx.config.paths.processing;
    const allowedDir = kind.dir === 'editor' ? path.join(processing, 'editor') : processing;
    const file = await openServableFile(
      toAbs(this.ctx.config.paths.storage, d.relPath),
      allowedDir,
      kind.ext,
    );
    return { file, contentType: kind.contentType };
  }
}
