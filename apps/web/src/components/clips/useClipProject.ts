/**
 * Sauvegarde sûre des réglages d'un projet de clip (docs/plan-etape-6.md §19) :
 *  - une seule requête à la fois, chacune sur la DERNIÈRE révision confirmée par le serveur ;
 *  - chaque modification reste en brouillon local jusqu'à confirmation ;
 *  - erreur réseau : la file s'arrête ; « Réessayer » renvoie le MÊME requestId (aucun doublon :
 *    le serveur rejoue une requête déjà appliquée) ;
 *  - conflit de version (409) : la file s'arrête ; « Recharger » relit le serveur SANS effacer les
 *    brouillons ; « Réappliquer » les renvoie explicitement. Jamais d'écrasement automatique ;
 *  - refus du serveur (accord, durée, décision…) : rien n'est appliqué, le brouillon reste listé
 *    avec le message, jusqu'à « Réessayer » ou « Abandonner ».
 * L'interface n'applique aucune règle métier : le serveur valide chaque réglage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, clipsApi, type ProjectChanges, type ProjectView } from '../../api';
import { errorMessage, isNetworkError } from './messages';

export interface Draft {
  /** Clé de regroupement : deux brouillons en attente de même clé fusionnent (curseurs). */
  key: string;
  label: string;
  op: { kind: 'patch'; changes: ProjectChanges } | { kind: 'suggest' };
  requestId: string;
  status: 'pending' | 'sending' | 'network' | 'refused' | 'conflict';
  message: string | null;
}

export interface ClipProjectState {
  view: ProjectView | null;
  loadError: string | null;
  drafts: Draft[];
  /** Révision connue du serveur lors d'un conflit (null sinon). */
  conflict: { currentRevision: number | null; reloaded: boolean } | null;
  saving: boolean;
  /** Ajoute une modification à la file (ignorée en lecture seule). */
  update: (key: string, label: string, changes: ProjectChanges) => void;
  suggestEffects: () => void;
  retry: () => void;
  discard: (requestId: string) => void;
  reload: () => Promise<void>;
  reapply: () => void;
}

const newId = () => crypto.randomUUID();

export function useClipProject(projectId: string): ClipProjectState {
  const [view, setView] = useState<ProjectView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [conflict, setConflict] = useState<ClipProjectState['conflict']>(null);
  // Références : la file est traitée hors du cycle de rendu (une seule boucle active).
  const viewRef = useRef<ProjectView | null>(null);
  const draftsRef = useRef<Draft[]>([]);
  const running = useRef(false);
  const alive = useRef(true);

  const setDraftsBoth = useCallback((fn: (d: Draft[]) => Draft[]) => {
    draftsRef.current = fn(draftsRef.current);
    if (alive.current) setDrafts(draftsRef.current);
  }, []);
  const setViewBoth = useCallback((v: ProjectView) => {
    viewRef.current = v;
    if (alive.current) setView(v);
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = draftsRef.current[0];
        const base = viewRef.current;
        if (!next || !base || next.status !== 'pending') return;
        setDraftsBoth((d) => d.map((x) => (x === next ? { ...x, status: 'sending' } : x)));
        try {
          if (next.op.kind === 'patch') {
            const v = await clipsApi.patch(projectId, {
              requestId: next.requestId,
              baseRevision: base.revision,
              changes: next.op.changes,
            });
            setViewBoth(v);
          } else {
            await clipsApi.suggestEffects(projectId, {
              requestId: next.requestId,
              baseRevision: base.revision,
            });
            setViewBoth(await clipsApi.view(projectId));
          }
          setDraftsBoth((d) => d.filter((x) => x.requestId !== next.requestId));
        } catch (err) {
          const status: Draft['status'] = isNetworkError(err)
            ? 'network'
            : err instanceof ApiError && err.code === 'VERSION_CONFLICT'
              ? 'conflict'
              : 'refused';
          if (status === 'conflict') {
            const details = (err as ApiError).details as { currentRevision?: number } | undefined;
            if (alive.current)
              setConflict({ currentRevision: details?.currentRevision ?? null, reloaded: false });
          }
          setDraftsBoth((d) =>
            d.map((x) =>
              x.requestId === next.requestId ? { ...x, status, message: errorMessage(err) } : x,
            ),
          );
          if (err instanceof ApiError && err.code === 'PROPOSAL_NOT_ACCEPTED' && viewRef.current) {
            // Décision changée ailleurs : relire le projet (il passe en lecture seule).
            setViewBoth(await clipsApi.view(projectId).catch(() => viewRef.current!));
          }
          return;
        }
      }
    } finally {
      running.current = false;
    }
  }, [projectId, setDraftsBoth, setViewBoth]);

  useEffect(() => {
    alive.current = true;
    clipsApi
      .view(projectId)
      .then((v) => {
        setViewBoth(v);
        void pump();
      })
      .catch((err: unknown) => alive.current && setLoadError(errorMessage(err)));
    return () => {
      alive.current = false;
    };
  }, [projectId, pump, setViewBoth]);

  const enqueue = useCallback(
    (key: string, label: string, op: Draft['op']) => {
      if (!viewRef.current?.editable) return;
      setDraftsBoth((d) => {
        const last = d.at(-1);
        // Curseurs : un brouillon pas encore envoyé de même clé est remplacé (pas de rafale).
        if (last && last.key === key && last.status === 'pending' && op.kind === 'patch') {
          return [...d.slice(0, -1), { ...last, label, op, requestId: newId() }];
        }
        return [...d, { key, label, op, requestId: newId(), status: 'pending', message: null }];
      });
      void pump();
    },
    [pump, setDraftsBoth],
  );

  const update = useCallback(
    (key: string, label: string, changes: ProjectChanges) =>
      enqueue(key, label, { kind: 'patch', changes }),
    [enqueue],
  );
  const suggestEffects = useCallback(
    () => enqueue('suggest', 'Proposer des effets', { kind: 'suggest' }),
    [enqueue],
  );

  /** Erreur réseau ou refus : même requestId (rejeu sûr côté serveur). */
  const retry = useCallback(() => {
    setDraftsBoth((d) =>
      d.map((x, i) =>
        i === 0 && (x.status === 'network' || x.status === 'refused')
          ? { ...x, status: 'pending', message: null }
          : x,
      ),
    );
    void pump();
  }, [pump, setDraftsBoth]);

  const discard = useCallback(
    (requestId: string) => {
      setDraftsBoth((d) => d.filter((x) => x.requestId !== requestId));
      if (!draftsRef.current.some((x) => x.status === 'conflict')) setConflict(null);
      void pump();
    },
    [pump, setDraftsBoth],
  );

  /** Relit le serveur ; les brouillons restent intacts (rien n'est renvoyé automatiquement). */
  const reload = useCallback(async () => {
    try {
      setViewBoth(await clipsApi.view(projectId));
      setConflict((c) => (c ? { ...c, reloaded: true } : c));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [projectId, setViewBoth]);

  /** Après rechargement : renvoie explicitement chaque brouillon, sur la nouvelle révision. */
  const reapply = useCallback(() => {
    setDraftsBoth((d) =>
      d.map((x) =>
        x.status === 'conflict'
          ? { ...x, status: 'pending', message: null, requestId: newId() }
          : x,
      ),
    );
    setConflict(null);
    void pump();
  }, [pump, setDraftsBoth]);

  return {
    view,
    loadError,
    drafts,
    conflict,
    saving: drafts.some((d) => d.status === 'sending' || d.status === 'pending'),
    update,
    suggestEffects,
    retry,
    discard,
    reload,
    reapply,
  };
}
