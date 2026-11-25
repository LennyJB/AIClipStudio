/**
 * Image fixe de la disposition. Trois mécanismes DISTINCTS (docs/plan-etape-6.md §19) :
 *  1. annulation côté client : debounce, puis abandon de la requête précédente (AbortController).
 *     Le navigateur n'attend plus l'ancienne réponse ; cela ne garantit PAS à lui seul l'arrêt de
 *     FFmpeg ;
 *  2. annulation effective côté serveur : la déconnexion ou une demande plus récente sur le même
 *     projet arrête FFmpeg (au plus 2 générations d'image à la fois sur le serveur) ;
 *  3. réponses obsolètes ignorées : un numéro de séquence écarte toute réponse qui n'est pas celle
 *     de la dernière demande, même si les deux mécanismes précédents ont échoué.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, clipsApi, fetchFrame } from '../../api';
import { errorMessage } from './messages';

export const FRAME_DEBOUNCE_MS = 600;

export interface FrameState {
  url: string | null;
  loading: boolean;
  error: string | null;
  /** Demande immédiate (bouton « Actualiser »). */
  refresh: () => void;
}

/**
 * @param trigger clé du cadrage confirmé par le serveur : chaque changement programme une
 *                actualisation après FRAME_DEBOUNCE_MS d'inactivité. null : aucune demande.
 */
export function useFrame(projectId: string, trigger: string | null): FrameState {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef<string | null>(null);

  const request = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const mine = ++seq.current;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError(null);
    fetchFrame(clipsApi.frameUrl(projectId), c.signal)
      .then((blob) => {
        if (mine !== seq.current) return; // réponse obsolète : ignorée
        const next = URL.createObjectURL(blob);
        if (shown.current) URL.revokeObjectURL(shown.current);
        shown.current = next;
        setUrl(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return; // obsolète (y compris CANCELLED du serveur)
        setLoading(false);
        if (c.signal.aborted) return;
        setError(
          err instanceof ApiError && err.code === 'CONFLICT'
            ? 'Génération d’image déjà en cours pour d’autres clips : réessayez dans un instant.'
            : errorMessage(err),
        );
      });
  }, [projectId]);

  useEffect(() => {
    if (trigger === null) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(request, FRAME_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [trigger, request]);

  useEffect(
    () => () => {
      seq.current++;
      ctrl.current?.abort();
      if (shown.current) URL.revokeObjectURL(shown.current);
    },
    [],
  );

  return { url, loading, error, refresh: request };
}
