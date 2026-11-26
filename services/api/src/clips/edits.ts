/**
 * Journal d'édition des projets de clip (étape 7b, docs/plan-etape-7.md §6).
 *
 *  - Version d'un projet = numéro de sa dernière entrée (ou de sa révision d'origine).
 *  - Document à une version = dernier point de contrôle ≤ version (révision immuable v1 ou v2,
 *    migrée à la lecture) + REJEU des entrées suivantes, chaque empreinte étant vérifiée. Un écart
 *    rend le projet inutilisable avec une erreur explicite (JOURNAL_CORRUPTED), jamais corrigé.
 *  - Écriture d'un lot, d'une annulation ou d'un rétablissement : sous `BEGIN IMMEDIATE`, décision
 *    effective, tête, préconditions, invariants, audio autorisé AUJOURD'HUI, empreinte, puis ajout
 *    d'une entrée (jamais de modification). Idempotence par `requestId`.
 *  - Lot construit sur une ancienne version : réapplication seulement si `decideReapply` démontre
 *    l'indépendance (règle symétrique, §6.3) ; sinon VERSION_CONFLICT, rien n'est écrit.
 *  - Points de contrôle : révision immuable complète (v2) à la version courante ; créés avant un
 *    rendu et tous les CHECKPOINT_EVERY lots.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@acs/shared';
import {
  applyBatch,
  assertHistoryTarget,
  canonicalJson,
  ClipProjectV2Schema,
  decideReapply,
  diffToRestore,
  historyState,
  HistoryError,
  inverseOfBatch,
  migrateProject,
  migrateV1ToV2,
  OpError,
  projectToV1,
  PROJECT_SCHEMA_VERSION_V2,
  ProjectError,
  type AppliedOp,
  type ApplyContext,
  type ClipProject,
  type ClipProjectV2,
  type HistoryState,
} from '@acs/timeline';
import type { Db } from '../db';
import { parse } from '../routes/validation';
import { EditRepository, type EditEntry } from './edits-repository';
import type { DecisionGuard } from './guard';
import type { ClipRepository, RevisionSource } from './repository';

/** Un point de contrôle tous les N lots (chargement borné). */
export const CHECKPOINT_EVERY = 200;
const CACHE_SIZE = 64;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const documentHashV2 = (d: ClipProjectV2) => sha256(canonicalJson(d));

const version = z.number().int().min(1);
export const EditRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      requestId: z.uuid(),
      clientId: z.string().min(1).max(64).optional(),
      base: z.object({ version }).strict(),
      kind: z.literal('do'),
      ops: z.array(z.unknown()).min(1).max(200),
      /** Empreinte attendue après application (calculée par l'interface sur la même base). */
      expectedHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
      summary: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      clientId: z.string().min(1).max(64).optional(),
      base: z.object({ version }).strict(),
      kind: z.enum(['undo', 'redo']),
      targetSeq: z.number().int().min(2),
      /** Exigé si l'annulation retire ou désactive un masque opaque. */
      acknowledgeMaskRisk: z.boolean().optional(),
    })
    .strict(),
]);
export type EditRequest = z.infer<typeof EditRequestSchema>;

export interface EditResult {
  version: number;
  hash: string;
  replayed: boolean;
  /** Vrai si le lot a été réappliqué sur une version plus récente que sa base. */
  rebased: boolean;
  history: { undo: number | null; redo: number | null };
}

/** Contexte d'autorisation AUJOURD'HUI (décision du serveur) pour un enregistrement. */
export type AudioContextProvider = (recordingId: string) => ApplyContext & {
  allowedAudioIndexes: number[];
  allowedCaptionRoles: string[];
};

/** Erreur de modèle → erreur applicative (message et détails conservés). */
export function fromOpError(err: unknown): never {
  if (err instanceof OpError) {
    const code =
      err.code === 'INVARIANT_VIOLATED'
        ? 'VALIDATION_FAILED'
        : err.code === 'NOT_FOUND'
          ? 'VALIDATION_FAILED'
          : err.code;
    throw new AppError(code, err.message, { details: err.details });
  }
  if (err instanceof ProjectError)
    throw new AppError(err.code, err.message, { details: err.details });
  if (err instanceof HistoryError) {
    throw new AppError(
      err.code === 'HISTORY_CHANGED' ? 'HISTORY_CHANGED' : 'JOURNAL_CORRUPTED',
      err.message,
    );
  }
  throw err;
}

export class EditService {
  readonly repo: EditRepository;
  private readonly cache = new Map<string, { doc: ClipProjectV2; hash: string }>();

  constructor(
    private readonly db: Db,
    private readonly clips: ClipRepository,
    private readonly guard: DecisionGuard,
    private readonly audioContext: AudioContextProvider,
  ) {
    this.repo = new EditRepository(db);
  }

  /* ------------------------------ Lecture ------------------------------ */

  /** Version courante d'un projet. */
  headVersion(projectId: string): number {
    const h = this.repo.head(projectId);
    if (!h) throw new AppError('NOT_FOUND', 'Projet de clip introuvable');
    return h.headSeq;
  }

  /** Document d'une révision immuable (v1 migrée à la lecture, ou v2). */
  private revisionDoc(projectId: string, revision: number): ClipProjectV2 {
    const rev = this.clips.revision(projectId, revision);
    if (!rev) throw new AppError('JOURNAL_CORRUPTED', `Point de contrôle ${revision} introuvable`);
    try {
      if (rev.schemaVersion === PROJECT_SCHEMA_VERSION_V2)
        return ClipProjectV2Schema.parse(rev.document);
      const v1 = migrateProject(rev.document);
      const m = this.clips.manifest(v1.source.integrityManifestId);
      if (!m) throw new AppError('NOT_FOUND', 'Manifeste d’intégrité introuvable');
      return migrateV1ToV2(v1, {
        manifestWindow: { srcStartMs: m.windowStartMs, srcEndMs: m.windowEndMs },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('JOURNAL_CORRUPTED', `Point de contrôle ${revision} illisible`, {
        cause: err,
      });
    }
  }

  /** Document à une version donnée : point de contrôle + rejeu vérifié. */
  docAt(projectId: string, at: number): { doc: ClipProjectV2; hash: string } {
    const key = `${projectId}:${at}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const cp = this.repo.checkpointAtOrBefore(projectId, at);
    if (cp === null) throw new AppError('JOURNAL_CORRUPTED', `Aucun point de contrôle avant ${at}`);
    let doc = this.revisionDoc(projectId, cp);
    let hash = documentHashV2(doc);
    for (const e of this.repo.range(projectId, cp, at)) {
      try {
        doc = applyBatch(doc, e.ops).doc;
      } catch (err) {
        throw new AppError('JOURNAL_CORRUPTED', `Rejeu impossible à l’entrée ${e.seq}`, {
          cause: err,
        });
      }
      hash = documentHashV2(doc);
      if (hash !== e.hashAfter) {
        throw new AppError('JOURNAL_CORRUPTED', `Empreinte inattendue à l’entrée ${e.seq}`);
      }
    }
    const out = { doc, hash };
    this.cache.set(key, out);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  /** Document courant (v2) et sa version. */
  head(projectId: string): { version: number; doc: ClipProjectV2; hash: string } {
    const v = this.headVersion(projectId);
    return { version: v, ...this.docAt(projectId, v) };
  }

  /**
   * Projection v1 EXACTE du document courant (interface 6c, PATCH v1, moteur de l'étape 6). Refus
   * explicite si le document utilise une fonction de l'éditeur (étape 7).
   */
  headV1(projectId: string): { version: number; hash: string; doc: ClipProject } {
    const h = this.head(projectId);
    const doc = projectToV1(h.doc);
    if (!doc) {
      throw new AppError(
        'EDITOR_REQUIRED',
        'Ce projet utilise des fonctions de l’éditeur avec timeline (étape 7) : il ne peut pas être ouvert ni rendu ici',
      );
    }
    return { version: h.version, hash: h.hash, doc };
  }

  history(projectId: string): HistoryState {
    const entries = this.repo.range(projectId, 0);
    try {
      return historyState(
        entries.map((e) => ({ seq: e.seq, kind: e.kind, targetSeq: e.targetSeq })),
      );
    } catch (err) {
      fromOpError(err);
    }
  }

  entries(projectId: string, since: number): EditEntry[] {
    return this.repo.range(projectId, since).slice(0, 500);
  }

  /* ------------------------------ Écriture ------------------------------ */

  /** Crée la tête d'un nouveau projet (révision 1). Appelé dans la transaction de création. */
  initHead(projectId: string) {
    this.repo.insertHead(projectId, 1);
  }

  /**
   * Point de contrôle à la version courante (révision immuable complète). Idempotent. Renvoie la
   * version. Utilisé avant chaque rendu (clé étrangère clip_renders → révision).
   */
  checkpoint(projectId: string): number {
    return this.db
      .transaction(() => {
        const h = this.repo.head(projectId);
        if (!h) throw new AppError('NOT_FOUND', 'Projet de clip introuvable');
        this.checkpointLocked(projectId, h.headSeq);
        return h.headSeq;
      })
      .immediate();
  }

  private checkpointLocked(projectId: string, at: number) {
    if (this.clips.revision(projectId, at)) {
      this.repo.setCheckpoint(projectId, at);
      return;
    }
    const { doc, hash } = this.docAt(projectId, at);
    this.clips.insertRevision({
      projectId,
      revision: at,
      schemaVersion: PROJECT_SCHEMA_VERSION_V2,
      documentJson: canonicalJson(doc),
      documentHash: hash,
      changeSummary: 'point de contrôle',
      requestId: `checkpoint-${at}`,
      source: 'system',
    });
    this.repo.setCheckpoint(projectId, at);
  }

  private append(
    projectId: string,
    p: {
      head: number;
      checkpoint: number;
      kind: EditEntry['kind'];
      targetSeq: number | null;
      applied: AppliedOp[];
      doc: ClipProjectV2;
      baseSeq: number;
      clientId: string | null;
      requestId: string;
      requestHash: string;
      summary: string | null;
      source: RevisionSource;
    },
  ): { version: number; hash: string } {
    const seq = p.head + 1;
    const hash = documentHashV2(p.doc);
    // Préconditions externes : clés lues avant toute écriture du lot, avec leur valeur initiale.
    const preconditions: Record<string, string | null> = {};
    const written = new Set<string>();
    for (const a of p.applied) {
      for (const k of a.reads)
        if (!written.has(k) && !(k in preconditions)) preconditions[k] = a.preconditions[k] ?? null;
      for (const k of a.writes) written.add(k);
    }
    this.repo.insert({
      projectId,
      seq,
      kind: p.kind,
      targetSeq: p.targetSeq,
      ops: p.applied.map((a) => a.op),
      inverse: inverseOfBatch(p.applied),
      preconditions,
      hashAfter: hash,
      baseRevision: p.checkpoint,
      baseSeq: p.baseSeq,
      clientId: p.clientId,
      requestId: p.requestId,
      requestHash: p.requestHash,
      summary: p.summary,
      source: p.source,
    });
    this.repo.advanceHead(projectId, p.head, seq);
    this.cache.set(`${projectId}:${seq}`, { doc: p.doc, hash });
    if (seq - p.checkpoint >= CHECKPOINT_EVERY) this.checkpointLocked(projectId, seq);
    return { version: seq, hash };
  }

  private historyTops(projectId: string) {
    const s = this.history(projectId);
    return { undo: s.undoable.at(-1) ?? null, redo: s.redoable.at(-1) ?? null };
  }

  /** Lot, annulation ou rétablissement (API de l'éditeur). */
  submit(
    projectId: string,
    recordingId: string,
    proposalId: string,
    body: unknown,
    source: RevisionSource,
  ): EditResult {
    const b = parse(EditRequestSchema, body);
    const requestHash = sha256(canonicalJson(b));
    return this.db
      .transaction((): EditResult => {
        const prior = this.repo.byRequest(projectId, b.requestId);
        if (prior) {
          if (prior.requestHash !== requestHash) {
            throw new AppError('IDEMPOTENCY_MISMATCH', 'Même requestId, contenu différent');
          }
          return {
            version: prior.seq,
            hash: prior.hashAfter,
            replayed: true,
            rebased: prior.baseSeq !== prior.seq - 1,
            history: this.historyTops(projectId),
          };
        }
        this.guard.assertAccepted(proposalId);
        const h = this.repo.head(projectId);
        if (!h) throw new AppError('NOT_FOUND', 'Projet de clip introuvable');
        if (b.base.version > h.headSeq) {
          throw new AppError('VERSION_CONFLICT', 'Version de base inconnue', {
            details: { currentRevision: h.headSeq },
          });
        }
        const ctx = this.audioContext(recordingId);
        const headDoc = this.docAt(projectId, h.headSeq).doc;
        let applied: AppliedOp[];
        let doc: ClipProjectV2;
        let rebased = false;
        let targetSeq: number | null = null;

        if (b.kind === 'do') {
          if (b.base.version === h.headSeq) {
            try {
              ({ doc, applied } = applyBatch(headDoc, b.ops, ctx));
            } catch (err) {
              fromOpError(err);
            }
            if (b.expectedHash && b.expectedHash !== documentHashV2(doc)) {
              throw new AppError(
                'DOCUMENT_DIVERGED',
                'Le document calculé par le serveur diffère de celui de l’interface : rechargez',
              );
            }
          } else {
            // Base ancienne : réapplication seulement si l'indépendance est démontrée (§6.3).
            const baseDoc = this.docAt(projectId, b.base.version).doc;
            const remote = this.repo
              .range(projectId, b.base.version, h.headSeq)
              .map((e) => ({ kind: e.kind === 'system' ? ('do' as const) : e.kind, ops: e.ops }));
            const r = decideReapply(baseDoc, remote, b.ops, ctx);
            if (!r.ok) {
              throw new AppError(
                'VERSION_CONFLICT',
                'Le projet a été modifié ailleurs : rechargez puis réappliquez',
                {
                  details: { currentRevision: h.headSeq, reason: r.reason, keys: r.keys },
                },
              );
            }
            ({ doc, applied } = r);
            rebased = true;
          }
        } else {
          try {
            assertHistoryTarget(this.history(projectId), b.kind, b.targetSeq);
          } catch (err) {
            if (err instanceof HistoryError) {
              throw new AppError('HISTORY_CHANGED', err.message, {
                details: { currentRevision: h.headSeq, ...this.historyTops(projectId) },
              });
            }
            throw err;
          }
          const target = this.repo.get(projectId, b.targetSeq)!;
          const ops =
            b.kind === 'undo'
              ? target.inverse.map((op) =>
                  b.acknowledgeMaskRisk ? { ...(op as object), acknowledgeMaskRisk: true } : op,
                )
              : target.ops;
          try {
            ({ doc, applied } = applyBatch(headDoc, ops, ctx));
          } catch (err) {
            fromOpError(err);
          }
          targetSeq = b.targetSeq;
        }
        const r = this.append(projectId, {
          head: h.headSeq,
          checkpoint: h.checkpointRevision,
          kind: b.kind,
          targetSeq,
          applied,
          doc,
          baseSeq: b.base.version,
          clientId: b.clientId ?? null,
          requestId: b.requestId,
          requestHash,
          summary: b.kind === 'do' ? (b.summary ?? null) : null,
          source,
        });
        return { ...r, replayed: false, rebased, history: this.historyTops(projectId) };
      })
      .immediate();
  }

  /**
   * Entrée « system » à partir d'une transformation du document v1 (PATCH de l'étape 6,
   * proposition d'effets). À appeler DANS une transaction `BEGIN IMMEDIATE` ; la décision a déjà
   * été vérifiée par l'appelant.
   */
  appendSystemLocked(
    projectId: string,
    recordingId: string,
    req: { requestId: string; baseVersion: number; acknowledgeMaskRisk?: boolean },
    source: RevisionSource,
    mutate: (
      doc: ClipProject,
      nextVersion: number,
    ) => { project: ClipProject; summary: string | null },
  ): { version: number; replayed: boolean } {
    const prior = this.repo.byRequest(projectId, req.requestId);
    if (prior) return { version: prior.seq, replayed: true };
    const h = this.repo.head(projectId);
    if (!h) throw new AppError('NOT_FOUND', 'Projet de clip introuvable');
    if (h.headSeq !== req.baseVersion) {
      throw new AppError('VERSION_CONFLICT', 'Le projet a été modifié entre-temps : rechargez-le', {
        details: { currentRevision: h.headSeq },
      });
    }
    const headDoc = this.docAt(projectId, h.headSeq).doc;
    const v1 = projectToV1(headDoc);
    if (!v1) {
      throw new AppError(
        'EDITOR_REQUIRED',
        'Ce projet utilise des fonctions de l’éditeur avec timeline (étape 7) : modifiez-le dans l’éditeur',
      );
    }
    const { project, summary } = mutate(v1, h.headSeq + 1);
    let applied: AppliedOp[] = [];
    let doc = headDoc;
    try {
      const target = migrateV1ToV2(project, {
        manifestWindow: {
          srcStartMs: headDoc.source.editWindow.srcStartMs,
          srcEndMs: headDoc.source.editWindow.srcEndMs,
        },
      });
      const ops = diffToRestore(headDoc, target, {
        ...(req.acknowledgeMaskRisk ? { acknowledgeMaskRisk: true } : {}),
        ctx: this.audioContext(recordingId),
      });
      ({ doc, applied } = applyBatch(headDoc, ops, this.audioContext(recordingId)));
    } catch (err) {
      fromOpError(err);
    }
    const r = this.append(projectId, {
      head: h.headSeq,
      checkpoint: h.checkpointRevision,
      kind: 'system',
      targetSeq: null,
      applied,
      doc,
      baseSeq: h.headSeq,
      clientId: null,
      requestId: req.requestId,
      requestHash: sha256(canonicalJson({ system: req.requestId })),
      summary: summary?.slice(0, 500) ?? null,
      source,
    });
    return { version: r.version, replayed: false };
  }
}
