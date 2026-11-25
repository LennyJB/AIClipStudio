/**
 * Projets de clip (étape 6a, docs/plan-etape-6.md §6.1–6.3).
 *
 *  - Un projet naît d'une proposition dont la décision EFFECTIVE est « acceptée » ; la décision
 *    est revérifiée dans chaque transaction d'écriture (BEGIN IMMEDIATE) et jamais copiée.
 *  - Un seul projet par moment : une proposition qui hérite d'une décision prise sur une autre
 *    proposition du moment renvoie au projet de cette dernière.
 *  - Le document est validé par un schéma strict ; chaque modification crée une révision immuable
 *    (concurrence optimiste par `baseRevision`, idempotence par `requestId`).
 *  - À la création, un manifeste d'intégrité de la fenêtre ajustable est calculé (§6.5).
 *  - Aucun rendu ici (étape 6b), aucun appel réseau.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { createPseudonymizer } from '@acs/editorial';
import { buildIntegrityManifest, fingerprintFile, verifyIntegrity } from '@acs/media';
import { type AudioDecision } from '@acs/render';
import {
  AppError,
  effectiveClipDuration,
  type FramingProfile,
  type PrivacyFile,
} from '@acs/shared';
import { loadCreatorProfile, loadGameProfile, profileHash } from '@acs/editorial';
import {
  adjustableWindow,
  applyRenderOptions,
  canonicalJson,
  displayCaptions,
  durationAccepted,
  migrateProject,
  PROJECT_SCHEMA_VERSION,
  ProjectError,
  projectDurationMs,
  projectFromProposal,
  projectSegments,
  projectWarnings,
  RenderOptionsPatchSchema,
  type CaptionRole,
  type ClipProject,
  type DisplayCaption,
  type ProjectWarning,
  type RoleWords,
  type WordSpan,
} from '@acs/timeline';
import type { AnalysisService } from '../analysis/service';
import { AnalysisRepository } from '../analysis/repository';
import { ProposalRepository, type ProposalDto } from '../analysis/proposals';
import type { AppContext } from '../context';
import { RecordingRepository, type RecordingDto } from '../recordings/repository';
import type { Source } from '../review/repository';
import type { ReviewService } from '../review/service';
import { parse } from '../routes/validation';
import { TranscriptionRepository } from '../transcriptions/repository';
import type { ExportAudioService } from './export-audio';
import { DecisionGuard, type EffectiveDecisionView } from './guard';
import { ClipRepository, type ProjectRow, type RevisionRow } from './repository';

export const CreateProjectBodySchema = z.object({ requestId: z.uuid() }).strict();

export const PatchProjectBodySchema = z
  .object({
    requestId: z.uuid(),
    baseRevision: z.number().int().min(1),
    changes: RenderOptionsPatchSchema,
  })
  .strict();

export interface ProjectView {
  project: ProjectRow;
  revision: number;
  documentHash: string;
  document: ClipProject;
  decision: EffectiveDecisionView;
  /** Faux si la décision effective n'est plus « acceptée » : lecture seule. */
  editable: boolean;
  warnings: ProjectWarning[];
  durationMs: number;
  durationAccepted: boolean;
  audio: AudioDecision;
  /** Sous-titres tels qu'ils seront affichés (corrigés, pseudonymisés), rôles autorisés seulement. */
  captions: DisplayCaption[] | null;
  captionsError: string | null;
  integrity: {
    method: string;
    protectedBytes: number;
    windowStartMs: number;
    windowEndMs: number;
  } | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ROLE_TO_CAPTION: Record<string, CaptionRole | undefined> = {
  mic: 'mic',
  discord: 'discord',
  mix: 'mix',
  unknown: 'mix',
};

function fromProjectError(err: unknown): never {
  if (err instanceof ProjectError) {
    throw new AppError(err.code, err.message, { details: err.details });
  }
  if (err instanceof z.ZodError) {
    throw new AppError('VALIDATION_FAILED', 'Document de projet invalide', {
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  throw err;
}

export class ClipProjectService {
  readonly repo: ClipRepository;
  readonly guard: DecisionGuard;
  private readonly proposals: ProposalRepository;
  private readonly runs: AnalysisRepository;
  private readonly recordings: RecordingRepository;
  private readonly transcripts: TranscriptionRepository;

  constructor(
    private readonly ctx: AppContext,
    private readonly review: ReviewService,
    private readonly analysis: AnalysisService,
    private readonly exportAudio: ExportAudioService,
  ) {
    this.repo = new ClipRepository(ctx.db);
    this.guard = new DecisionGuard(review);
    this.proposals = new ProposalRepository(ctx.db);
    this.runs = new AnalysisRepository(ctx.db);
    this.recordings = new RecordingRepository(ctx.db);
    this.transcripts = new TranscriptionRepository(ctx.db);
  }

  /* ------------------------------- Lecture ------------------------------- */

  private recording(id: string): RecordingDto {
    const rec = this.recordings.get(id);
    if (!rec) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return rec;
  }

  private proposal(id: string): ProposalDto {
    const p = this.proposals.getProposal(id);
    if (!p) throw new AppError('NOT_FOUND', 'Proposition introuvable');
    return p;
  }

  projectRow(id: string): ProjectRow {
    const p = this.repo.getProject(id);
    if (!p) throw new AppError('NOT_FOUND', 'Projet de clip introuvable');
    return p;
  }

  current(row: ProjectRow): { rev: RevisionRow; doc: ClipProject } {
    const rev = this.repo.revision(row.id, row.currentRevision)!;
    let doc: ClipProject;
    try {
      doc = migrateProject(rev.document);
    } catch (err) {
      fromProjectError(err);
    }
    return { rev, doc };
  }

  /** Mots horodatés de l'analyse de la proposition, dans [fromMs, toMs[, par locuteur. */
  private words(
    p: ProposalDto,
    fromMs: number,
    toMs: number,
  ): { byRole: RoleWords[]; spans: WordSpan[] } {
    const run = this.runs.getRun(p.runId);
    const segments = this.transcripts.segments({
      recordingId: p.recordingId,
      transcriptionIds: run?.transcriptionIds ?? [],
      fromMs,
      toMs,
      limit: 20_000,
    });
    const byRole = new Map<CaptionRole, RoleWords['words'][number][]>();
    const spans: WordSpan[] = [];
    for (const s of segments) {
      for (const w of s.words) {
        spans.push({ srcStartMs: w.startMs, srcEndMs: w.endMs });
        const role = ROLE_TO_CAPTION[s.role ?? 'unknown'];
        if (!role) continue;
        const list = byRole.get(role) ?? [];
        list.push({ text: w.word, srcStartMs: w.startMs, srcEndMs: w.endMs });
        byRole.set(role, list);
      }
    }
    return { byRole: [...byRole.entries()].map(([role, words]) => ({ role, words })), spans };
  }

  async pseudonymizer(): Promise<(t: string) => { text: string; replacements: number }> {
    const { file } = await this.analysis.privacy();
    const p = createPseudonymizer(file as PrivacyFile | null);
    return (t) => {
      const r = p.apply(t);
      const n =
        Object.values(r.pseudonyms).reduce((a, b) => a + b, 0) +
        Object.values(r.masked).reduce((a, b) => a + b, 0);
      return { text: r.text, replacements: n };
    };
  }

  async view(projectId: string): Promise<ProjectView> {
    const row = this.projectRow(projectId);
    const { rev, doc } = this.current(row);
    const decision = this.guard.effective(row.proposalId);
    const rec = this.recording(row.recordingId);
    const audio = this.exportAudio.decisionFor(rec);
    const roles = doc.captions.enabled
      ? doc.captions.sources.filter((r) => audio.captionRoles.includes(r))
      : [];
    let captions: DisplayCaption[] | null = null;
    let captionsError: string | null = null;
    try {
      captions = displayCaptions(
        projectSegments(doc),
        doc.captions.items,
        doc.captions.corrections,
        {
          roles,
          pseudonymize: await this.pseudonymizer(),
        },
      );
    } catch (err) {
      // Jamais de repli silencieux sans pseudonymisation.
      captionsError = err instanceof Error ? err.message : 'Sous-titres indisponibles';
    }
    const m = this.repo.manifest(doc.source.integrityManifestId);
    return {
      project: row,
      revision: rev.revision,
      documentHash: rev.documentHash,
      document: doc,
      decision,
      editable: decision.status === 'accepted' && !decision.merged,
      warnings: projectWarnings(doc, rev.revision),
      durationMs: projectDurationMs(doc),
      durationAccepted: durationAccepted(doc, rev.revision),
      audio,
      captions,
      captionsError,
      integrity: m
        ? {
            method: m.method,
            protectedBytes: m.protectedBytes,
            windowStartMs: m.windowStartMs,
            windowEndMs: m.windowEndMs,
          }
        : null,
    };
  }

  revisions(projectId: string) {
    this.projectRow(projectId);
    return this.repo.revisions(projectId).map((r) => {
      const doc = r.document as ClipProject;
      return {
        revision: r.revision,
        documentHash: r.documentHash,
        changeSummary: r.changeSummary,
        source: r.source,
        createdAt: r.createdAt,
        corrections: doc.captions?.corrections ?? [],
      };
    });
  }

  /** Propositions acceptées d'un enregistrement (une par moment) et leur projet éventuel. */
  listForRecording(recordingId: string) {
    this.recording(recordingId);
    const l = this.review.list(recordingId, { status: 'all' });
    const seen = new Set<string>();
    const items = l.items
      .filter((i) => i.effective.status === 'accepted' && i.state !== 'merged')
      .sort((a, b) => (a.state === 'accepted' ? -1 : 0) - (b.state === 'accepted' ? -1 : 0))
      .filter((i) => {
        const key = i.momentId ?? i.proposal.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((i) => {
        const target =
          i.effective.inherited && i.effective.sourceProposalId
            ? i.effective.sourceProposalId
            : i.proposal.id;
        const project = this.repo.projectForProposal(target);
        return {
          proposal: {
            id: i.proposal.id,
            title: i.proposal.title,
            tier: i.proposal.tier,
            srcStartMs: i.proposal.srcStartMs,
            srcEndMs: i.proposal.srcEndMs,
          },
          momentId: i.momentId,
          inherited: i.effective.inherited,
          project: project ? { id: project.id, currentRevision: project.currentRevision } : null,
        };
      });
    return { recordingId, run: l.run, items };
  }

  /* ------------------------------ Création ------------------------------ */

  async create(
    proposalId: string,
    body: unknown,
    source: Source,
  ): Promise<ProjectView & { created: boolean }> {
    const b = parse(CreateProjectBodySchema, body);
    const asked = this.proposal(proposalId);
    const eff = this.guard.assertAccepted(asked.id);
    // Décision héritée : un seul projet par moment, sur la proposition qui porte la décision.
    const p = eff.inherited && eff.sourceProposalId ? this.proposal(eff.sourceProposalId) : asked;
    const existing = this.repo.projectForProposal(p.id);
    if (existing) return { ...(await this.view(existing.id)), created: false };

    const rec = this.recording(p.recordingId);
    const src = this.recordings.getSource(rec.id)!;
    if (!existsSync(src.sourcePath)) {
      throw new AppError('MEDIA_NOT_FOUND', 'Original introuvable : vérifiez son emplacement');
    }
    if ((await fingerprintFile(src.sourcePath)).hash !== src.fingerprint) {
      throw new AppError(
        'MEDIA_SOURCE_CHANGED',
        'L’original a été modifié depuis l’import : ré-importez-le',
      );
    }
    const durationMs = rec.durationSec === null ? null : Math.round(rec.durationSec * 1000);
    const win = adjustableWindow({ srcStartMs: p.srcStartMs, srcEndMs: p.srcEndMs }, durationMs);
    const manifest = await buildIntegrityManifest({
      ffprobePath: this.ctx.config.tools.ffprobe,
      filePath: src.sourcePath,
      windowStartMs: win.startMs,
      windowEndMs: win.endMs,
      probeBytes: this.ctx.config.render.probeBytes,
    });
    // Le fichier n'a pas changé pendant le calcul (sinon le manifeste ne prouverait rien).
    if ((await fingerprintFile(src.sourcePath)).hash !== src.fingerprint) {
      throw new AppError('MEDIA_SOURCE_CHANGED', 'L’original a changé pendant la vérification');
    }

    const creator = await loadCreatorProfile(this.ctx.config.paths.profiles);
    const game = await loadGameProfile(this.ctx.config.paths.profiles, rec.gameId);
    const range = effectiveClipDuration(creator, game);
    const framing: FramingProfile | null = await this.analysis.validatedFraming(rec.id);
    const { byRole } = this.words(p, win.startMs, win.endMs);
    const hint = p.editingHint as { mode?: unknown } | null;
    const editingMode = hint?.mode === 'fidele' || hint?.mode === 'enrichi' ? hint.mode : null;
    const setup = this.repo.segmentBounds(p.setupSegmentId);
    const reaction = this.repo.segmentBounds(p.reactionEndSegmentId);
    const manifestId = randomUUID();
    const projectId = randomUUID();

    let built: ReturnType<typeof projectFromProposal>;
    try {
      built = projectFromProposal({
        proposal: {
          id: p.id,
          runId: p.runId,
          recordingId: p.recordingId,
          momentId: this.review.repo.membership(p.id)?.momentId ?? null,
          srcStartMs: p.srcStartMs,
          srcEndMs: p.srcEndMs,
          punchlineMs: p.punchlineMs,
          setupStartMs: Math.max(p.srcStartMs, setup?.srcStartMs ?? p.srcStartMs),
          reactionEndMs: Math.min(p.srcEndMs, reaction?.srcEndMs ?? p.srcEndMs),
          editingMode,
        },
        source: {
          fingerprint: src.fingerprint,
          durationMs,
          width: rec.video?.width ?? null,
          height: rec.video?.height ?? null,
          fps: rec.video?.fps ?? null,
          container: manifest.container,
          integrityManifestId: manifestId,
        },
        framing: framing
          ? {
              id: framing.id,
              hash: profileHash(framing),
              gameplay: framing.gameplay,
              facecam: framing.facecam,
              masks: framing.masks,
            }
          : null,
        words: byRole,
        audio: (() => {
          const d = this.exportAudio.decisionFor(rec);
          return { tracks: d.selected, captionRoles: d.captionRoles };
        })(),
        defaults: {
          mode: creator.editingStyle.defaultMode,
          minMs: range.minSeconds * 1000,
          maxMs: range.maxSeconds * 1000,
        },
        makeId: (kind, i) => `${kind}-${i}`,
      });
    } catch (err) {
      fromProjectError(err);
    }
    const json = canonicalJson(built.project);

    const created = this.ctx.db
      .transaction(() => {
        // Revérifié sous le verrou d'écriture : une décision ne peut pas changer entre-temps.
        this.guard.assertAccepted(p.id);
        const again = this.repo.projectForProposal(p.id);
        if (again) return again.id;
        this.repo.insertManifest(manifestId, rec.id, manifest);
        this.repo.insertProject({ id: projectId, proposalId: p.id, recordingId: rec.id });
        this.repo.insertRevision({
          projectId,
          revision: 1,
          schemaVersion: PROJECT_SCHEMA_VERSION,
          documentJson: json,
          documentHash: sha256(json),
          changeSummary: 'création depuis la proposition',
          requestId: b.requestId,
          source,
        });
        return projectId;
      })
      .immediate();
    return { ...(await this.view(created)), created: created === projectId };
  }

  /* ----------------------------- Modification ----------------------------- */

  async patch(
    projectId: string,
    body: unknown,
    source: Source,
  ): Promise<ProjectView & { replayed: boolean }> {
    const b = parse(PatchProjectBodySchema, body);
    const row = this.projectRow(projectId);
    const prior = this.repo.revisionByRequest(projectId, b.requestId);
    if (prior) return { ...(await this.view(projectId)), replayed: true };
    const p = this.proposal(row.proposalId);
    const { doc: base } = this.current(row);
    const words = b.changes.bounds
      ? this.words(
          p,
          Math.max(0, base.origin.proposalBounds.srcStartMs - 11_000),
          base.origin.proposalBounds.srcEndMs + 11_000,
        ).spans
      : [];

    this.ctx.db
      .transaction(() => {
        // Sous le verrou d'écriture : décision et révision courante relues.
        this.guard.assertAccepted(row.proposalId);
        const cur = this.repo.getProject(projectId)!;
        if (cur.currentRevision !== b.baseRevision) {
          throw new AppError(
            'VERSION_CONFLICT',
            'Le projet a été modifié entre-temps : rechargez-le',
            {
              details: { currentRevision: cur.currentRevision },
            },
          );
        }
        const { doc } = this.current(cur);
        const audio = this.exportAudio.decisionFor(this.recording(cur.recordingId));
        const next = cur.currentRevision + 1;
        let r: ReturnType<typeof applyRenderOptions>;
        try {
          r = applyRenderOptions(doc, b.changes, {
            nextRevision: next,
            now: new Date().toISOString(),
            words,
            allowedCaptionRoles: audio.captionRoles,
            allowedAudioTracks: audio.selected,
          });
        } catch (err) {
          fromProjectError(err);
        }
        const json = canonicalJson(r.project);
        this.repo.insertRevision({
          projectId,
          revision: next,
          schemaVersion: PROJECT_SCHEMA_VERSION,
          documentJson: json,
          documentHash: sha256(json),
          changeSummary: r.summary.join(' ; ').slice(0, 500) || null,
          requestId: b.requestId,
          source,
        });
        this.repo.setCurrentRevision(projectId, next);
      })
      .immediate();
    return { ...(await this.view(projectId)), replayed: false };
  }

  /**
   * Révision produite par le système (ex. effets proposés par le moteur de rendu) : mêmes
   * garanties qu'un réglage du créateur (décision revérifiée sous verrou, version attendue,
   * idempotence, document validé).
   */
  writeSystemRevision(
    projectId: string,
    req: { requestId: string; baseRevision: number },
    mutate: (doc: ClipProject) => { project: ClipProject; summary: string },
  ): { revision: number; replayed: boolean } {
    const prior = this.repo.revisionByRequest(projectId, req.requestId);
    if (prior) return { revision: prior.revision, replayed: true };
    return this.ctx.db
      .transaction(() => {
        const cur = this.projectRow(projectId);
        this.guard.assertAccepted(cur.proposalId);
        if (cur.currentRevision !== req.baseRevision) {
          throw new AppError(
            'VERSION_CONFLICT',
            'Le projet a été modifié entre-temps : rechargez-le',
            {
              details: { currentRevision: cur.currentRevision },
            },
          );
        }
        const { doc } = this.current(cur);
        let next: ClipProject;
        let summary: string;
        try {
          ({ project: next, summary } = mutate(doc));
          next = migrateProject(next);
        } catch (err) {
          fromProjectError(err);
        }
        const json = canonicalJson(next);
        const revision = cur.currentRevision + 1;
        this.repo.insertRevision({
          projectId,
          revision,
          schemaVersion: PROJECT_SCHEMA_VERSION,
          documentJson: json,
          documentHash: sha256(json),
          changeSummary: summary.slice(0, 500),
          requestId: req.requestId,
          source: 'system',
        });
        this.repo.setCurrentRevision(projectId, revision);
        return { revision, replayed: false };
      })
      .immediate();
  }

  /* ------------------------------ Intégrité ------------------------------ */

  /** Vérifie l'ensemble d'octets protégé de la source du projet (utilisé avant chaque rendu). */
  async verifySource(projectId: string) {
    const row = this.projectRow(projectId);
    const { doc } = this.current(row);
    const m = this.repo.manifest(doc.source.integrityManifestId);
    if (!m) throw new AppError('NOT_FOUND', 'Manifeste d’intégrité introuvable');
    const src = this.recordings.getSource(row.recordingId)!;
    const r = await verifyIntegrity(src.sourcePath, m);
    if (!r.ok) {
      throw new AppError(
        r.reason === 'missing' ? 'MEDIA_NOT_FOUND' : 'MEDIA_SOURCE_CHANGED',
        r.reason === 'missing'
          ? 'Original introuvable : vérifiez son emplacement'
          : 'L’original a été modifié dans la zone utilisée par ce clip',
        { details: { reason: r.reason } },
      );
    }
    return { ok: true as const, method: m.method, protectedBytes: m.protectedBytes };
  }
}
