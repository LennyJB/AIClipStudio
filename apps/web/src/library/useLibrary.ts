import { useCallback, useEffect, useState } from 'react';
import { LIBRARY_CHANNEL, libraryApi, libraryError, type AssetDto, type LibraryApi } from './api';

export interface LibraryState {
  /** null tant que la bibliothèque n'a pas été lue (ou si la lecture a échoué). */
  assets: AssetDto[] | null;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Liste de la bibliothèque, relue au montage, après chaque modification (dans cet onglet ou un
 * autre) et à la demande. Une lecture en échec est signalée (`error`) et l'état des médias devient
 * INCONNU (`assets: null`) : l'éditeur ne charge alors aucun effet sonore (jamais d'état ancien
 * réutilisé en silence).
 */
export function useLibrary(api: LibraryApi = libraryApi): LibraryState {
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      api.list().then(
        (r) => {
          setAssets(r.assets);
          setError(null);
        },
        (err: unknown) => {
          setAssets(null);
          setError(libraryError(err));
        },
      ),
    [api],
  );
  useEffect(() => {
    let alive = true;
    const on = () =>
      void api.list().then(
        (r) => {
          if (!alive) return;
          setAssets(r.assets);
          setError(null);
        },
        (err: unknown) => {
          if (!alive) return;
          setAssets(null);
          setError(libraryError(err));
        },
      );
    on();
    window.addEventListener(LIBRARY_CHANNEL, on);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(LIBRARY_CHANNEL);
      channel.onmessage = on;
    } catch {
      channel = null;
    }
    return () => {
      alive = false;
      window.removeEventListener(LIBRARY_CHANNEL, on);
      channel?.close();
    };
  }, [api]);
  return { assets, error, reload };
}
