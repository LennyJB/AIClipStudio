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
  applyRenderOptions,
  byStartThenId,
  canonicalJson,
  displayCaptions,
  durationAccepted,
  groupWords,
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
  type ClipProjectV2,
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
import { EditService } from './edits';
import { ClipRepository, type ProjectRow, type StoredManifest } from './repository';

export const CreateProjectBodySchema = z.object({ requestId: z.uuid() }).strict();

export const PatchProjectBodySchema = z
  .object({
    requestId: z.uuid(),
    baseRevision: z.number().int().min(1),
    changes: RenderOptionsPatchSchema,
  })
  .strict();

const ms = z.number().int().nonnegative();
/** Élargissement de la fenêtre éditable (nouveau manifeste construit par le serveur). */
export const ExtendWindowBodySchema = z
  .object({
    requestId: z.uuid(),
    baseRevision: z.number().int().min(1),
    srcStartMs: ms,
    srcEndMs: ms,
  })
  .strict()
  .refine((b) => b.srcStartMs < b.srcEndMs, 'fenêtre vide');

/** Largeur maximale d'une fenêtre éditable (coût du manifeste d'intégrité, du proxy, etc.). */
export const MAX_EDIT_WINDOW_MS = 20 * 60_000;

/** Fenêtre éditable d'un NOUVEAU projet : proposition ± marge, bornée à l'enregistrement. */
export function editorWindow(
  proposal: { srcStartMs: number; srcEndMs: number },
  durationMs: number | null,
  marginMs: number,
): { startMs: number; endMs: number } {
  const end = proposal.srcEndMs + marginMs;
  return {
    startMs: Math.max(0, proposal.srcStartMs - marginMs),
    endMs: durationMs === null ? end : Math.min(durationMs, end),
  };
}

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
  /** Journal d'édition (étape 7b) : source de la version courante de chaque projet. */
  readonly edits: EditService;
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
    this.edits = new EditService(ctx.db, this.repo, this.guard, (recordingId) => {
      const d = this.exportAudio.decisionFor(this.recording(recordingId));
      return {
        allowedAudioIndexes: d.selected.map((t) => t.audioIndex),
        allowedCaptionRoles: [...d.captionRoles],
      };
    });
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

  /**
   * Document courant, en projection v1 EXACTE (interface 6c, moteur de l'étape 6) : version =
   * numéro de la dernière entrée du journal. Refus explicite (EDITOR_REQUIRED) si le document
   * utilise une fonction de l'éditeur (étape 7).
   */
  current(row: ProjectRow): { rev: { revision: number; documentHash: string }; doc: ClipProject } {
    const h = this.edits.headV1(row.id);
    return { rev: { revision: h.version, documentHash: h.hash }, doc: h.doc };
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

  /**
   * Versions du projet : révisions d'origine (étape 6) puis entrées du journal (étape 7b). Les
   * points de contrôle ne sont pas des versions supplémentaires (même contenu qu'une entrée).
   */
  revisions(projectId: string) {
    this.projectRow(projectId);
    const base = this.repo
      .revisions(projectId)
      .filter((r) => !r.requestId.startsWith('checkpoint-'))
      .map((r) => {
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
    const journal = this.edits.repo.range(projectId, 0).map((e) => ({
      revision: e.seq,
      documentHash: e.hashAfter,
      changeSummary: e.summary,
      source: e.kind === 'system' && e.source === 'system' ? 'system' : e.source,
      createdAt: e.createdAt,
      corrections: this.edits.docAt(projectId, e.seq).doc.captions.corrections,
    }));
    return [...base, ...journal].sort((a, b) => a.revision - b.revision);
  }

  /** Propositions acceptées d'un enregistrement (une par moment) et leur projet éventuel. */
  /**
   * Propositions acceptées (une par moment) et leur projet, puis les projets dont la décision
   * effective n'est plus « acceptée » (lecture seule : rendus consultables, aucune modification).
   */
  listForRecording(recordingId: string) {
    this.recording(recordingId);
    const l = this.review.list(recordingId, { status: 'all' });
    const seen = new Set<string>();
    const listed = new Set<string>();
    const summary = (id: string) => {
      const r = this.repo.getProject(id)!;
      return {
        id: r.id,
        currentRevision: this.edits.headVersion(r.id),
        lastRender: this.repo.lastRender(r.id),
      };
    };
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
        if (project) listed.add(project.id);
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
          readOnly: false,
          decision: 'accepted' as EffectiveDecisionView['status'],
          project: project ? summary(project.id) : null,
        };
      });
    // Projets existants dont la décision a changé : jamais modifiables, jamais retirés de la vue.
    for (const pr of this.repo.projectsOfRecording(recordingId)) {
      if (listed.has(pr.id)) continue;
      const p = this.proposal(pr.proposalId);
      const eff = this.guard.effective(p.id);
      items.push({
        proposal: {
          id: p.id,
          title: p.title,
          tier: p.tier,
          srcStartMs: p.srcStartMs,
          srcEndMs: p.srcEndMs,
        },
        momentId: null,
        inherited: eff.inherited,
        readOnly: true,
        decision: eff.status,
        project: summary(pr.id),
      });
    }
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
    // Fenêtre éditable de l'éditeur (étape 7) : proposition ± EDITOR_WINDOW_MARGIN_SEC (au moins
    // les ±10 s de l'ajustement des bornes de l'étape 6), couverte par le manifeste.
    const win = editorWindow(
      { srcStartMs: p.srcStartMs, srcEndMs: p.srcEndMs },
      durationMs,
      this.ctx.config.editor.windowMarginMs,
    );
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
        captionsWindow: win,
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
        this.edits.initHead(projectId);
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

    let replayed = false;
    this.ctx.db
      .transaction(() => {
        // Sous le verrou d'écriture : décision relue, version attendue, entrée « system » du
        // journal (projection v1 exacte, transformée par les règles de l'étape 6).
        this.guard.assertAccepted(row.proposalId);
        const audio = this.exportAudio.decisionFor(this.recording(row.recordingId));
        replayed = this.edits.appendSystemLocked(
          projectId,
          row.recordingId,
          {
            requestId: b.requestId,
            baseVersion: b.baseRevision,
            ...(b.changes.masks?.acknowledgeMaskRisk ? { acknowledgeMaskRisk: true } : {}),
          },
          source,
          (doc, next) => {
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
            return { project: r.project, summary: r.summary.join(' ; ') || null };
          },
        ).replayed;
      })
      .immediate();
    return { ...(await this.view(projectId)), replayed };
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
    return this.ctx.db
      .transaction(() => {
        const cur = this.projectRow(projectId);
        this.guard.assertAccepted(cur.proposalId);
        const r = this.edits.appendSystemLocked(
          projectId,
          cur.recordingId,
          { requestId: req.requestId, baseVersion: req.baseRevision },
          'system',
          (doc) => {
            try {
              const out = mutate(doc);
              return { project: migrateProject(out.project), summary: out.summary };
            } catch (err) {
              fromProjectError(err);
            }
          },
        );
        return { revision: r.version, replayed: r.replayed };
      })
      .immediate();
  }

  /* ------------------------- Journal d'édition (7b) ------------------------ */

  /** Lot, annulation ou rétablissement (API de l'éditeur). */
  submitEdit(projectId: string, body: unknown, source: Source) {
    const row = this.projectRow(projectId);
    return this.edits.submit(projectId, row.recordingId, row.proposalId, body, source);
  }

  /** Document v2 courant, sa version, son empreinte et l'état de l'historique. */
  editorDocument(projectId: string) {
    const row = this.projectRow(projectId);
    const h = this.edits.head(projectId);
    const decision = this.guard.effective(row.proposalId);
    const history = this.edits.history(projectId);
    return {
      projectId,
      version: h.version,
      hash: h.hash,
      document: h.doc,
      editable: decision.status === 'accepted' && !decision.merged,
      decision,
      history: { undo: history.undoable.at(-1) ?? null, redo: history.redoable.at(-1) ?? null },
      checkpointRevision: this.edits.repo.head(projectId)!.checkpointRevision,
    };
  }

  /** Entrées du journal après une version (synchronisation entre onglets). */
  editsSince(projectId: string, since: number) {
    this.projectRow(projectId);
    const head = this.edits.head(projectId);
    const history = this.edits.history(projectId);
    return {
      head: { version: head.version, hash: head.hash },
      history: { undo: history.undoable.at(-1) ?? null, redo: history.redoable.at(-1) ?? null },
      entries: this.edits.entries(projectId, since).map((e) => ({
        seq: e.seq,
        kind: e.kind,
        targetSeq: e.targetSeq,
        ops: e.ops,
        hashAfter: e.hashAfter,
        baseSeq: e.baseSeq,
        clientId: e.clientId,
        summary: e.summary,
        source: e.source,
        createdAt: e.createdAt,
      })),
    };
  }

  /* ------------------------------ Intégrité ------------------------------ */

  /* --------------------------- Fenêtre éditable --------------------------- */

  /**
   * Élargit la fenêtre éditable (docs/plan-etape-7.md §3.2) : le serveur construit un NOUVEAU
   * manifeste d'intégrité sur la nouvelle fenêtre (les manifestes restent figés), puis enregistre
   * dans le journal, sous le verrou d'écriture, la nouvelle fenêtre et les sous-titres de la
   * transcription pour la zone ajoutée. Annulable comme toute entrée (refusée si un segment est
   * désormais hors de l'ancienne fenêtre). Idempotent par `requestId`.
   */
  async extendWindow(projectId: string, body: unknown, source: Source) {
    const b = parse(ExtendWindowBodySchema, body);
    const row = this.projectRow(projectId);
    this.guard.assertAccepted(row.proposalId);
    const requestHash = sha256(
      canonicalJson({ window: { srcStartMs: b.srcStartMs, srcEndMs: b.srcEndMs } }),
    );
    const prior = this.edits.entryForRequest(projectId, b.requestId);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new AppError('IDEMPOTENCY_MISMATCH', 'Même requestId, contenu différent');
      }
      return {
        version: prior.seq,
        replayed: true,
        window: this.edits.head(projectId).doc.source.editWindow,
      };
    }
    const head = this.edits.head(projectId);
    if (head.version !== b.baseRevision) {
      throw new AppError('VERSION_CONFLICT', 'Le projet a été modifié entre-temps : rechargez-le', {
        details: { currentRevision: head.version },
      });
    }
    const cur = head.doc.source.editWindow;
    const rec = this.recording(row.recordingId);
    const durationMs = rec.durationSec === null ? null : Math.round(rec.durationSec * 1000);
    if (b.srcStartMs > cur.srcStartMs || b.srcEndMs < cur.srcEndMs) {
      throw new AppError('VALIDATION_FAILED', 'La nouvelle fenêtre doit contenir l’actuelle');
    }
    if (b.srcStartMs === cur.srcStartMs && b.srcEndMs === cur.srcEndMs) {
      throw new AppError('VALIDATION_FAILED', 'La fenêtre demandée est déjà la fenêtre actuelle');
    }
    if (durationMs !== null && b.srcEndMs > durationMs) {
      throw new AppError('VALIDATION_FAILED', 'La fenêtre dépasse la fin de l’enregistrement');
    }
    if (b.srcEndMs - b.srcStartMs > MAX_EDIT_WINDOW_MS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Fenêtre éditable limitée à ${MAX_EDIT_WINDOW_MS / 60_000} minutes`,
      );
    }
    const src = this.recordings.getSource(rec.id)!;
    if (!existsSync(src.sourcePath)) {
      throw new AppError('MEDIA_NOT_FOUND', 'Original introuvable : vérifiez son emplacement');
    }
    if ((await fingerprintFile(src.sourcePath)).hash !== src.fingerprint) {
      throw new AppError('MEDIA_SOURCE_CHANGED', 'L’original a été modifié depuis l’import');
    }
    const manifest = await buildIntegrityManifest({
      ffprobePath: this.ctx.config.tools.ffprobe,
      filePath: src.sourcePath,
      windowStartMs: b.srcStartMs,
      windowEndMs: b.srcEndMs,
      probeBytes: this.ctx.config.render.probeBytes,
    });
    if ((await fingerprintFile(src.sourcePath)).hash !== src.fingerprint) {
      throw new AppError('MEDIA_SOURCE_CHANGED', 'L’original a changé pendant la vérification');
    }
    // Sous-titres de la zone ajoutée (mêmes règles de découpage qu'à la création).
    const proposal = this.proposal(row.proposalId);
    const added = [
      [b.srcStartMs, cur.srcStartMs],
      [cur.srcEndMs, b.srcEndMs],
    ].filter(([a, z]) => a! < z!) as [number, number][];
    const manifestId = randomUUID();
    const r = this.ctx.db
      .transaction(() => {
        this.guard.assertAccepted(row.proposalId);
        const again = this.edits.entryForRequest(projectId, b.requestId);
        if (again) {
          if (again.requestHash !== requestHash) {
            throw new AppError('IDEMPOTENCY_MISMATCH', 'Même requestId, contenu différent');
          }
          return { version: again.seq, replayed: true };
        }
        this.repo.insertManifest(manifestId, rec.id, manifest);
        return this.edits.appendSystemV2Locked(
          projectId,
          rec.id,
          { requestId: b.requestId, baseVersion: b.baseRevision, requestHash },
          source,
          (doc, nextVersion) => {
            const items = [...doc.captions.items];
            // Identifiants propres à cette version et à chaque zone ajoutée (avant, après).
            added.forEach(([from, to], zone) => {
              for (const rw of this.words(proposal, from, to).byRole) {
                items.push(
                  ...groupWords(
                    rw,
                    from,
                    to,
                    (role, i) => `cap-${role}-v${nextVersion}-${zone}-${i}`,
                  ),
                );
              }
            });
            return {
              doc: {
                ...doc,
                source: {
                  ...doc.source,
                  editWindow: {
                    srcStartMs: b.srcStartMs,
                    srcEndMs: b.srcEndMs,
                    integrityManifestId: manifestId,
                  },
                },
                captions: { ...doc.captions, items: items.sort(byStartThenId) },
              },
              summary: `fenêtre éditable élargie : ${b.srcStartMs}–${b.srcEndMs} ms`,
            };
          },
        );
      })
      .immediate();
    return { ...r, window: this.edits.head(projectId).doc.source.editWindow };
  }

  /**
   * Manifeste d'intégrité de la fenêtre éditable du document : il doit appartenir au MÊME
   * enregistrement et couvrir la fenêtre, donc tous les segments (vérifié avant chaque rendu et
   * chaque image exacte).
   */
  windowManifest(row: ProjectRow, doc: ClipProjectV2): StoredManifest {
    const w = doc.source.editWindow;
    const m = this.repo.manifest(w.integrityManifestId);
    if (!m) throw new AppError('NOT_FOUND', 'Manifeste d’intégrité introuvable');
    const outside = doc.segments.some((s) =>
      s.kind === 'source'
        ? s.srcStartMs < m.windowStartMs || s.srcEndMs > m.windowEndMs
        : s.kind === 'freeze' && (s.srcAtMs < m.windowStartMs || s.srcAtMs >= m.windowEndMs),
    );
    if (
      m.recordingId !== row.recordingId ||
      w.srcStartMs < m.windowStartMs ||
      w.srcEndMs > m.windowEndMs ||
      outside
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'La fenêtre éditable n’est pas couverte par le manifeste d’intégrité de cet enregistrement',
      );
    }
    return m;
  }

  /** Vérifie l'ensemble d'octets protégé de la source du projet (utilisé avant chaque rendu). */
  async verifySource(projectId: string) {
    const row = this.projectRow(projectId);
    const m = this.windowManifest(row, this.edits.head(projectId).doc);
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
