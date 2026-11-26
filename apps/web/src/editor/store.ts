/**
 * État de l'éditeur (zustand) : document du serveur, file de lots, brouillon, historique,
 * synchronisation entre onglets et conflits (docs/plan-etape-7.md §6.2–6.4).
 *
 *  - Le document affiché = document du serveur + lots en attente, appliqués par le MÊME réducteur
 *    que le serveur (`applyBatch` de @acs/timeline), avec la décision d'audio du serveur.
 *  - Un geste = un lot = une entrée d'historique. Chaque lot est écrit dans le brouillon AVANT son
 *    envoi ; la file est envoyée en série ; l'empreinte attendue est toujours jointe (le serveur
 *    refuse un lot dont le résultat diffère : jamais de réapplication silencieuse).
 *  - Annuler un lot pas encore envoyé le retire de la file ; pendant un envoi, l'annulation attend
 *    la confirmation puis passe par le serveur (`undo` du haut de pile, `HISTORY_CHANGED` sinon).
 *  - Conflit : la file est conservée (brouillon compris), l'interface propose « Recharger » puis
 *    « Réappliquer » geste par geste, chacun revalidé par le serveur.
 *  - Lecture seule (décision effective non acceptée) : aucune modification n'est proposée ni
 *    envoyée.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  applyBatch,
  canonicalJson,
  OpError,
  type ApplyContext,
  type ClipProjectV2,
  type Operation,
} from '@acs/timeline';
import {
  ApiError,
  type EditorApi,
  type EditorDocument,
  type EditorTexts,
  type JournalEntry,
} from './api';
import type { DraftStore, PendingBatch } from './drafts';

export type { PendingBatch };

/** Nombre d'entrées du journal affichées (le journal reste complet côté serveur). */
export const HISTORY_DISPLAY_LIMIT = 200;
/** Relecture de la tête en secours de la diffusion entre onglets. */
export const POLL_MS = 5000;

export interface BroadcastLike {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export interface EditorDeps {
  api: Pick<EditorApi, 'document' | 'editsSince' | 'submit' | 'texts'>;
  drafts: DraftStore;
  /** Canal de diffusion entre onglets (null : indisponible). */
  channel: (name: string) => BroadcastLike | null;
  uuid: () => string;
  sha256: (text: string) => Promise<string>;
  now: () => Date;
  /** Planification (injectable pour les tests). */
  setInterval: (f: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}

export interface ConflictState {
  message: string;
  /** Gestes en attente, dans l'ordre ; aucun n'est perdu. */
  batches: PendingBatch[];
}

export interface MaskPrompt {
  kind: 'undo' | 'redo';
  targetSeq: number;
  message: string;
}

export interface EditorState {
  projectId: string;
  clientId: string;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  server: EditorDocument | null;
  /** Document affiché (serveur + lots en attente). */
  doc: ClipProjectV2 | null;
  pending: PendingBatch[];
  sending: boolean;
  /** Restauration du brouillon après rechargement : édition suspendue jusqu'à la fin. */
  restoring: boolean;
  conflict: ConflictState | null;
  maskPrompt: MaskPrompt | null;
  /** Message d'information ou de refus (affiché, jamais silencieux). */
  notice: string | null;
  offline: boolean;
  draftsPersistent: boolean;
  texts: EditorTexts | null;
  textsError: string | null;
  entries: JournalEntry[];

  load(): Promise<void>;
  /** Un geste : applique localement, enregistre le brouillon, envoie. Faux si refusé. */
  dispatch(ops: Operation[], summary: string): Promise<boolean>;
  undo(acknowledgeMaskRisk?: boolean): Promise<void>;
  redo(acknowledgeMaskRisk?: boolean): Promise<void>;
  confirmMaskPrompt(): Promise<void>;
  cancelMaskPrompt(): void;
  refresh(): Promise<void>;
  reloadAfterConflict(): Promise<void>;
  reapply(requestId: string): Promise<boolean>;
  discard(requestId: string): Promise<void>;
  dismissNotice(): void;
  dispose(): void;
}

export const isEditable = (s: Pick<EditorState, 'server' | 'conflict' | 'restoring'>) =>
  Boolean(s.server?.editable) && !s.conflict && !s.restoring;

export const applyContext = (server: EditorDocument): ApplyContext => ({
  allowedAudioIndexes: server.audio.selected.map((t) => t.audioIndex),
  allowedCaptionRoles: [...server.audio.captionRoles],
});

const message = (err: unknown) =>
  err instanceof ApiError || err instanceof OpError || err instanceof Error
    ? err.message
    : String(err);

/** Libellé d'une entrée du journal (source et onglet indiqués). */
export function entryLabel(
  entries: readonly JournalEntry[],
  seq: number,
  clientId: string,
): string {
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  let e = bySeq.get(seq);
  // Un rétablissement reprend le libellé de l'entrée rétablie.
  for (let guard = 0; e?.kind === 'redo' && e.targetSeq !== null && guard < 50; guard++) {
    e = bySeq.get(e.targetSeq) ?? e;
    if (e.kind !== 'redo') break;
  }
  if (!e) return `modification n° ${seq}`;
  const what =
    e.summary ?? (e.kind === 'system' ? 'modification automatique' : `modification n° ${seq}`);
  const origin =
    e.source === 'cli'
      ? ' (ligne de commande)'
      : e.kind === 'system' || e.source === 'system'
        ? ' (système)'
        : e.clientId && e.clientId !== clientId
          ? ' (autre onglet)'
          : '';
  return `${what}${origin}`;
}

export function createEditorStore(projectId: string, deps: EditorDeps): StoreApi<EditorState> {
  const clientId = deps.uuid();
  // Canal et relecture créés à chaque chargement, fermés par `dispose` (montage double de React).
  let channel: BroadcastLike | null = null;
  let poll: unknown = null;
  let undoAfterSend = false;
  let disposed = false;

  const store = createStore<EditorState>()((set, get) => {
    /** Document affiché : serveur + lots en attente (tout ou rien ; un échec ⇒ conflit). */
    const recompute = (server: EditorDocument, pending: readonly PendingBatch[]) => {
      let doc = server.document;
      for (const b of pending) doc = applyBatch(doc, b.ops, applyContext(server)).doc;
      return doc;
    };

    const persist = async (pending: readonly PendingBatch[]) => {
      await deps.drafts.save(projectId, pending);
    };

    const loadEntries = async (version: number) => {
      try {
        const since = Math.max(0, version - HISTORY_DISPLAY_LIMIT);
        const r = await deps.api.editsSince(projectId, since);
        set({ entries: r.entries.slice(-HISTORY_DISPLAY_LIMIT) });
      } catch {
        // Historique d'affichage seulement : l'annulation reste exacte (serveur).
      }
    };

    const loadTexts = async () => {
      try {
        set({ texts: await deps.api.texts(projectId), textsError: null });
      } catch (err) {
        // Jamais de texte non pseudonymisé : les sous-titres ne sont pas affichés.
        set({ texts: null, textsError: message(err) });
      }
    };

    /** Relit le document du serveur (sans toucher à la file). */
    const fetchServer = async () => {
      const server = await deps.api.document(projectId);
      if (disposed) return server;
      set({ server, offline: false });
      void loadEntries(server.version);
      void loadTexts();
      return server;
    };

    const broadcast = (version: number) => channel?.postMessage({ type: 'head', version });

    const toConflict = async (msg: string) => {
      const { pending } = get();
      set({ conflict: { message: msg, batches: pending }, sending: false });
    };

    /** Envoi en série de la file. */
    const flush = async (): Promise<void> => {
      const s = get();
      if (s.sending || s.conflict || !s.pending.length || !s.server || disposed) return;
      set({ sending: true });
      let lastVersion = s.server.version;
      try {
        while (get().pending.length && !get().conflict && !disposed) {
          const b = get().pending[0]!;
          const base = b.base ?? lastVersion;
          let r;
          try {
            r = await deps.api.submit(projectId, {
              requestId: b.requestId,
              clientId,
              base: { version: base },
              kind: 'do',
              ops: b.ops,
              expectedHash: b.expectedHash,
              summary: b.summary,
            });
          } catch (err) {
            if (!(err instanceof ApiError)) {
              set({ offline: true, sending: false });
              setTimeout(() => void flush(), 2000);
              return;
            }
            if (
              ['VERSION_CONFLICT', 'DOCUMENT_DIVERGED', 'PRECONDITION_FAILED'].includes(
                err.code ?? '',
              )
            ) {
              await toConflict(
                'Le projet a été modifié ailleurs : vos gestes en attente sont conservés. Rechargez puis réappliquez-les un par un.',
              );
              return;
            }
            // Refus définitif (autorisation, validation, décision) : le geste est retiré, expliqué.
            const rest = get().pending.slice(1);
            await persist(rest);
            set({
              pending: rest,
              notice: `Modification refusée par le serveur : ${err.message}`,
            });
            const server = await fetchServer();
            set({ doc: safeRecompute(server, rest) });
            continue;
          }
          set({ offline: false });
          const rest = get().pending.slice(1);
          await persist(rest);
          lastVersion = r.version;
          const server = get().server!;
          if (r.rebased || r.hash !== b.expectedHash) {
            // Réappliqué sur une version plus récente : document relu ; les gestes suivants,
            // calculés sur l'ancien état, doivent être revalidés un par un.
            set({ pending: rest });
            const fresh = await fetchServer();
            broadcast(fresh.version);
            if (rest.length) {
              await toConflict(
                'Votre geste a été réappliqué sur une version plus récente : réappliquez les suivants un par un.',
              );
              return;
            }
            set({ doc: fresh.document });
            continue;
          }
          const doc = applyBatch(server.document, b.ops, applyContext(server)).doc;
          set({
            pending: rest,
            server: {
              ...server,
              version: r.version,
              hash: r.hash,
              document: doc,
              history: r.history,
            },
          });
          broadcast(r.version);
          void loadEntries(r.version);
          void loadTexts();
        }
      } finally {
        set({ sending: false });
      }
      if (undoAfterSend && !get().pending.length) {
        undoAfterSend = false;
        await get().undo();
      }
    };

    const safeRecompute = (server: EditorDocument, pending: readonly PendingBatch[]) => {
      try {
        return recompute(server, pending);
      } catch {
        return server.document;
      }
    };

    const history = async (kind: 'undo' | 'redo', acknowledgeMaskRisk?: boolean) => {
      const s = get();
      if (!s.server || !s.server.editable || s.conflict || s.restoring) return;
      const target = kind === 'undo' ? s.server.history.undo : s.server.history.redo;
      if (target === null) return;
      try {
        await deps.api.submit(projectId, {
          requestId: deps.uuid(),
          clientId,
          base: { version: s.server.version },
          kind,
          targetSeq: target,
          ...(acknowledgeMaskRisk ? { acknowledgeMaskRisk: true } : {}),
        });
        set({ maskPrompt: null });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'MASK_RISK_NOT_ACKNOWLEDGED') {
          set({ maskPrompt: { kind, targetSeq: target, message: err.message } });
          return;
        }
        if (err instanceof ApiError && err.code === 'HISTORY_CHANGED') {
          set({
            notice:
              'L’historique a changé (autre onglet ou ligne de commande) : rien n’a été annulé. Vérifiez le libellé puis réessayez.',
          });
        } else {
          set({
            notice: `${kind === 'undo' ? 'Annulation' : 'Rétablissement'} refusé : ${message(err)}`,
          });
        }
      }
      const server = await fetchServer();
      set({ doc: server.document });
      broadcast(server.version);
    };

    return {
      projectId,
      clientId,
      status: 'loading',
      error: null,
      server: null,
      doc: null,
      pending: [],
      sending: false,
      restoring: false,
      conflict: null,
      maskPrompt: null,
      notice: null,
      offline: false,
      draftsPersistent: deps.drafts.persistent,
      texts: null,
      textsError: null,
      entries: [],

      async load() {
        disposed = false;
        channel?.close();
        channel = deps.channel(`acs-editor-${projectId}`);
        if (poll !== null) deps.clearInterval(poll);
        poll = null;
        try {
          const server = await fetchServer();
          const drafts = await deps.drafts.load(projectId);
          set({
            status: 'ready',
            doc: server.document,
            pending: drafts,
            restoring: drafts.length > 0,
          });
          if (drafts.length) {
            // Brouillon restauré : renvoyé avec les MÊMES requestId (aucun doublon) ; une tête
            // différente passe par la règle de réapplication du serveur (§6.3).
            await flush();
            set({ restoring: false });
            if (!get().conflict) {
              const fresh = await fetchServer();
              set({ doc: fresh.document });
            }
          }
        } catch (err) {
          set({ status: 'error', error: message(err) });
          return;
        }
        if (disposed) return;
        if (channel) {
          channel.onmessage = (e) => {
            const m = e.data as { type?: string; version?: number } | null;
            if (m?.type === 'head' && typeof m.version === 'number') void get().refresh();
          };
        }
        poll = deps.setInterval(() => {
          const s = get();
          if (!s.server || s.pending.length || s.sending) return;
          deps.api
            .editsSince(projectId, s.server.version)
            .then((r) => {
              if (r.head.version !== get().server?.version) void get().refresh();
            })
            .catch(() => set({ offline: true }));
        }, POLL_MS);
      },

      async dispatch(ops, summary) {
        const s = get();
        if (!s.server || !s.doc) return false;
        if (!isEditable(s)) {
          set({
            notice: s.server.editable
              ? 'Modification suspendue (conflit ou restauration en cours).'
              : 'Projet en lecture seule : aucune modification possible.',
          });
          return false;
        }
        let next: ClipProjectV2;
        try {
          next = applyBatch(s.doc, ops, applyContext(s.server)).doc;
        } catch (err) {
          set({ notice: `Modification impossible : ${message(err)}` });
          return false;
        }
        const batch: PendingBatch = {
          requestId: deps.uuid(),
          ops,
          summary,
          base: s.pending.length ? null : s.server.version,
          expectedHash: await deps.sha256(canonicalJson(next)),
          createdAt: deps.now().toISOString(),
        };
        const pending = [...get().pending, batch];
        // Brouillon écrit AVANT l'envoi.
        await persist(pending);
        set({ pending, doc: next });
        void flush();
        return true;
      },

      async undo(acknowledgeMaskRisk) {
        const s = get();
        if (!s.server?.editable || s.conflict || s.restoring) return;
        if (s.pending.length) {
          // Pendant un envoi, le premier lot de la file est en cours : seul un lot suivant
          // (jamais envoyé) peut être retiré localement.
          const lastIsSending = s.sending && s.pending.length === 1;
          if (!lastIsSending) {
            const pending = s.pending.slice(0, -1);
            await persist(pending);
            set({ pending, doc: safeRecompute(s.server, pending) });
            return;
          }
          undoAfterSend = true;
          return;
        }
        if (s.sending) {
          undoAfterSend = true;
          return;
        }
        await history('undo', acknowledgeMaskRisk);
      },

      async redo(acknowledgeMaskRisk) {
        const s = get();
        if (s.pending.length || s.sending) return;
        await history('redo', acknowledgeMaskRisk);
      },

      async confirmMaskPrompt() {
        const p = get().maskPrompt;
        if (!p) return;
        set({ maskPrompt: null });
        await history(p.kind, true);
      },

      cancelMaskPrompt() {
        set({ maskPrompt: null });
      },

      async refresh() {
        const s = get();
        if (s.pending.length || s.sending || s.conflict) return;
        try {
          const server = await fetchServer();
          if (!get().pending.length) set({ doc: server.document });
        } catch {
          set({ offline: true });
        }
      },

      async reloadAfterConflict() {
        const server = await fetchServer();
        set({ doc: server.document, pending: [] });
        // Les gestes restent dans le conflit (et le brouillon) jusqu'à réapplication ou abandon.
      },

      async reapply(requestId) {
        const s = get();
        const c = s.conflict;
        const b = c?.batches.find((x) => x.requestId === requestId);
        if (!c || !b || !s.server) return false;
        try {
          const next = applyBatch(s.server.document, b.ops, applyContext(s.server)).doc;
          const r = await deps.api.submit(projectId, {
            requestId: deps.uuid(),
            clientId,
            base: { version: s.server.version },
            kind: 'do',
            ops: b.ops,
            expectedHash: await deps.sha256(canonicalJson(next)),
            summary: b.summary,
          });
          void r;
        } catch (err) {
          set({ notice: `Ce geste ne peut pas être réappliqué : ${message(err)}` });
          return false;
        }
        const rest = c.batches.filter((x) => x.requestId !== requestId);
        await persist(rest);
        const server = await fetchServer();
        broadcast(server.version);
        set({
          doc: server.document,
          conflict: rest.length ? { ...c, batches: rest } : null,
        });
        return true;
      },

      async discard(requestId) {
        const c = get().conflict;
        if (!c) return;
        const rest = c.batches.filter((x) => x.requestId !== requestId);
        await persist(rest);
        set({ conflict: rest.length ? { ...c, batches: rest } : null });
      },

      dismissNotice() {
        set({ notice: null });
      },

      dispose() {
        disposed = true;
        if (poll !== null) deps.clearInterval(poll);
        poll = null;
        channel?.close();
        channel = null;
      },
    };
  });
  return store;
}

/** Dépendances du navigateur. */
export function browserDeps(api: EditorDeps['api'], drafts: DraftStore): EditorDeps {
  return {
    api,
    drafts,
    channel: (name) =>
      typeof BroadcastChannel === 'undefined'
        ? null
        : (new BroadcastChannel(name) as unknown as BroadcastLike),
    uuid: () => crypto.randomUUID(),
    sha256: async (text) => {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    now: () => new Date(),
    setInterval: (f, ms) => setInterval(f, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
}
