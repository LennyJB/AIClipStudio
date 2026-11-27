/**
 * Bibliothèque de médias (étape 7, PR 7f) : images fixes et effets sonores importés par le
 * créateur. Toute validation est faite par le SERVEUR (signature, structure, ré-encodage) ;
 * l'interface ne fait qu'envoyer les octets et afficher le résultat. Aucun chemin n'est jamais
 * reçu ni envoyé : un média est désigné par son identifiant (empreinte).
 */
import { ApiError, getJson } from '../api';

export type AssetRights = 'own' | 'licensed' | 'public_domain';

export interface AssetDto {
  id: string;
  kind: 'image' | 'audio';
  sourceFormat: string;
  displayName: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  peaks: number[] | null;
  rights: AssetRights;
  rightsNote: string | null;
  createdAt: string;
  status: 'ok' | 'missing';
}

export const RIGHTS_LABELS: Record<AssetRights, string> = {
  own: 'Création personnelle',
  licensed: 'Sous licence (usage autorisé)',
  public_domain: 'Domaine public',
};

/** Types proposés par le sélecteur de fichiers (le serveur revérifie le CONTENU). */
export const ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/mp4,.png,.jpg,.jpeg,.webp,.gif,.wav,.mp3,.ogg,.oga,.opus,.flac,.m4a,.aac';

/** Canal entre onglets : une bibliothèque modifiée ailleurs est relue. */
export const LIBRARY_CHANNEL = 'acs-library';

export function notifyLibraryChanged() {
  try {
    const c = new BroadcastChannel(LIBRARY_CHANNEL);
    c.postMessage({ type: 'changed' });
    c.close();
  } catch {
    // BroadcastChannel indisponible : les autres onglets relisent à leur prochain chargement.
  }
  window.dispatchEvent(new Event(LIBRARY_CHANNEL));
}

export const libraryApi = {
  list: (kind?: 'image' | 'audio') =>
    getJson<{ assets: AssetDto[] }>(`/api/media-assets${kind ? `?kind=${kind}` : ''}`),
  /** Envoie les octets du fichier tels quels (`application/octet-stream`). */
  upload: async (
    file: Blob,
    o: { name: string; rights: AssetRights; rightsNote?: string },
  ): Promise<{ asset: AssetDto; duplicate: boolean }> => {
    const q = new URLSearchParams({ name: o.name, rights: o.rights });
    if (o.rightsNote?.trim()) q.set('rightsNote', o.rightsNote.trim());
    return getJson(`/api/media-assets?${q.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
  },
  remove: (id: string) =>
    getJson<{ deleted: true }>(`/api/media-assets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  fileUrl: (id: string) => `/api/media-assets/${encodeURIComponent(id)}/file`,
  previewUrl: (id: string) => `/api/media-assets/${encodeURIComponent(id)}/preview`,
};

export type LibraryApi = typeof libraryApi;

/** Message lisible d'un refus du serveur (raison de l'import refusé, média utilisé…). */
export function libraryError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export const formatBytes = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} Ko`
    : `${(n / 1024 / 1024).toFixed(1)} Mo`;
