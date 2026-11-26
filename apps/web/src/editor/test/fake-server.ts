/**
 * Faux serveur d'édition (tests uniquement) : mêmes règles que `services/api/src/clips/edits.ts`,
 * avec le MÊME réducteur (`applyBatch`), le même historique (`historyState`) et la même règle de
 * réapplication (`decideReapply`) : idempotence par `requestId`, `VERSION_CONFLICT`,
 * `DOCUMENT_DIVERGED`, `HISTORY_CHANGED`, `MASK_RISK_NOT_ACKNOWLEDGED`, autorisation audio.
 * Plusieurs « onglets » (stores) peuvent partager la même instance.
 */
import {
  applyBatch,
  assertHistoryTarget,
  canonicalJson,
  decideReapply,
  historyState,
  HistoryError,
  inverseOfBatch,
  OpError,
  type ApplyContext,
  type ClipProjectV2,
  type Operation,
} from '@acs/timeline';
import { ApiError } from '../../api';
import type { EditorDocument, EditorTexts, EditRequest, EditResult, JournalEntry } from '../api';
import type { EditorDeps } from '../store';

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Entry extends JournalEntry {
  inverse: Operation[];
  doc: ClipProjectV2;
  requestId: string;
  requestHash: string;
}

export class FakeEditServer {
  entries: Entry[] = [];
  editable = true;
  calls: { kind: string; requestId: string }[] = [];
  /** Échecs réseau simulés (nombre de prochains envois refusés). */
  failNext = 0;
  readonly startVersion: number;

  constructor(
    readonly base: ClipProjectV2,
    readonly ctx: Required<ApplyContext>,
    startVersion = 1,
  ) {
    this.startVersion = startVersion;
  }

  get version() {
    return this.entries.at(-1)?.seq ?? this.startVersion;
  }
  get doc() {
    return this.entries.at(-1)?.doc ?? this.base;
  }
  docAt(v: number) {
    return v === this.startVersion ? this.base : this.entries.find((e) => e.seq === v)!.doc;
  }
  history() {
    const s = historyState(this.entries);
    return { undo: s.undoable.at(-1) ?? null, redo: s.redoable.at(-1) ?? null };
  }

  async document(): Promise<EditorDocument> {
    return {
      projectId: 'p',
      version: this.version,
      hash: await sha256Hex(canonicalJson(this.doc)),
      document: structuredClone(this.doc),
      editable: this.editable,
      decision: { status: this.editable ? 'accepted' : 'rejected' },
      history: this.history(),
      checkpointRevision: this.startVersion,
      audio: {
        tracks: [],
        mode: 'individual',
        selected: this.ctx.allowedAudioIndexes.map((i) => ({ audioIndex: i, role: 'mic' })),
        captionRoles: this.ctx.allowedCaptionRoles as ('mic' | 'discord' | 'mix')[],
        missing: [],
      },
      recording: { width: 1920, height: 1080, fps: 30, durationMs: 600_000, audioTracks: [] },
    };
  }

  async editsSince(since: number) {
    return {
      head: { version: this.version, hash: await sha256Hex(canonicalJson(this.doc)) },
      history: this.history(),
      entries: this.entries.filter((e) => e.seq > since).map((e) => ({ ...e })),
    };
  }

  async texts(): Promise<EditorTexts> {
    return { version: this.version, items: [], manual: {}, overlays: {} };
  }

  /** Lot écrit par un autre client (onglet, ligne de commande). */
  async remote(ops: Operation[], summary = 'geste distant', source = 'ui', clientId = 'autre') {
    return this.submit(
      {
        requestId: crypto.randomUUID(),
        clientId,
        base: { version: this.version },
        kind: 'do',
        ops,
        summary,
      },
      source,
    );
  }

  async submit(b: EditRequest, source = 'ui'): Promise<EditResult> {
    this.calls.push({ kind: b.kind, requestId: b.requestId });
    if (this.failNext > 0) {
      this.failNext--;
      throw new TypeError('Failed to fetch');
    }
    const requestHash = canonicalJson(b);
    const prior = this.entries.find((e) => e.requestId === b.requestId);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new ApiError('Même requestId, contenu différent', 409, 'IDEMPOTENCY_MISMATCH', null);
      }
      return {
        version: prior.seq,
        hash: prior.hashAfter,
        replayed: true,
        rebased: prior.baseSeq !== prior.seq - 1,
        history: this.history(),
      };
    }
    if (!this.editable) {
      throw new ApiError('Proposition non acceptée', 409, 'PROPOSAL_NOT_ACCEPTED', null);
    }
    const head = this.version;
    if (b.base.version > head)
      throw new ApiError('Version inconnue', 409, 'VERSION_CONFLICT', null);
    const wrap = (f: () => ReturnType<typeof applyBatch>) => {
      try {
        return f();
      } catch (err) {
        if (err instanceof OpError) {
          const code =
            err.code === 'INVARIANT_VIOLATED' || err.code === 'NOT_FOUND'
              ? 'VALIDATION_FAILED'
              : err.code;
          throw new ApiError(err.message, 409, code, err.details);
        }
        throw err;
      }
    };
    let result: ReturnType<typeof applyBatch>;
    let rebased = false;
    let targetSeq: number | null = null;
    let ops: Operation[];
    if (b.kind === 'do') {
      ops = b.ops;
      if (b.base.version === head) {
        result = wrap(() => applyBatch(this.doc, b.ops, this.ctx));
        if (b.expectedHash && b.expectedHash !== (await sha256Hex(canonicalJson(result.doc)))) {
          throw new ApiError('Document divergent', 409, 'DOCUMENT_DIVERGED', null);
        }
      } else {
        const remote = this.entries
          .filter((e) => e.seq > b.base.version)
          .map((e) => ({ kind: e.kind === 'system' ? ('do' as const) : e.kind, ops: e.ops }));
        const r = decideReapply(this.docAt(b.base.version), remote, b.ops, this.ctx);
        if (!r.ok) throw new ApiError('Modifié ailleurs', 409, 'VERSION_CONFLICT', r);
        result = r;
        rebased = true;
      }
    } else {
      try {
        assertHistoryTarget(historyState(this.entries), b.kind, b.targetSeq);
      } catch (err) {
        if (err instanceof HistoryError)
          throw new ApiError(err.message, 409, 'HISTORY_CHANGED', null);
        throw err;
      }
      const target = this.entries.find((e) => e.seq === b.targetSeq)!;
      ops =
        b.kind === 'undo'
          ? target.inverse.map((op) =>
              b.acknowledgeMaskRisk ? ({ ...op, acknowledgeMaskRisk: true } as Operation) : op,
            )
          : target.ops;
      result = wrap(() => applyBatch(this.doc, ops, this.ctx));
      targetSeq = b.targetSeq;
    }
    const seq = head + 1;
    const hashAfter = await sha256Hex(canonicalJson(result.doc));
    this.entries.push({
      seq,
      kind: b.kind,
      targetSeq,
      ops: result.applied.map((a) => a.op),
      inverse: inverseOfBatch(result.applied),
      hashAfter,
      baseSeq: b.base.version,
      clientId: b.clientId,
      summary: b.kind === 'do' ? (b.summary ?? null) : null,
      source,
      createdAt: new Date(0).toISOString(),
      doc: result.doc,
      requestId: b.requestId,
      requestHash,
    });
    return { version: seq, hash: hashAfter, replayed: false, rebased, history: this.history() };
  }

  /** API de l'éditeur branchée sur ce serveur. */
  api(): EditorDeps['api'] {
    return {
      document: () => this.document(),
      editsSince: (_p, since) => this.editsSince(since),
      submit: (_p, body) => this.submit(body),
      texts: () => this.texts(),
    };
  }
}

/** Canaux de diffusion partagés entre « onglets » d'un même test. */
export function fakeChannels() {
  const subs = new Map<string, Set<{ onmessage: ((e: { data: unknown }) => void) | null }>>();
  return (name: string) => {
    const set = subs.get(name) ?? new Set();
    subs.set(name, set);
    const ch = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(m: unknown) {
        for (const o of set) if (o !== ch) o.onmessage?.({ data: structuredClone(m) });
      },
      close() {
        set.delete(ch);
      },
    };
    set.add(ch);
    return ch;
  };
}
