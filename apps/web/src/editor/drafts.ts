/**
 * Brouillon de l'éditeur (docs/plan-etape-7.md §6.4) : chaque lot non confirmé est écrit dans
 * IndexedDB AVANT son envoi, avec sa tête de base et son `requestId`. Il n'est supprimé qu'après
 * la confirmation du serveur. IndexedDB indisponible (navigation privée) : repli en mémoire et
 * avertissement visible ; l'édition reste possible, protégée seulement par la file en mémoire.
 */
import type { Operation } from '@acs/timeline';

export interface PendingBatch {
  requestId: string;
  ops: Operation[];
  summary: string;
  /**
   * Version du serveur sur laquelle le lot a été construit ; null : construit après le lot
   * précédent de la file (sa base est la version que le serveur aura donnée à ce lot).
   */
  base: number | null;
  /** Empreinte attendue après application (calculée localement). */
  expectedHash: string;
  createdAt: string;
}

export interface DraftStore {
  /** Faux : brouillon en mémoire seulement (fermeture brutale ⇒ perte). */
  readonly persistent: boolean;
  load(projectId: string): Promise<PendingBatch[]>;
  save(projectId: string, batches: readonly PendingBatch[]): Promise<void>;
}

export function memoryDrafts(): DraftStore {
  const m = new Map<string, PendingBatch[]>();
  return {
    persistent: false,
    load: async (id) => structuredClone(m.get(id) ?? []),
    save: async (id, b) => {
      if (b.length) m.set(id, structuredClone([...b]));
      else m.delete(id);
    },
  };
}

const DB = 'acs-editor';
const STORE = 'drafts';

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponible'));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error ?? new Error('IndexedDB : écriture refusée'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB : transaction annulée'));
  });
}

/** Brouillon IndexedDB ; repli en mémoire si IndexedDB est absent ou refuse de s'ouvrir. */
export async function openDrafts(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<DraftStore> {
  if (!factory) return memoryDrafts();
  let db: IDBDatabase;
  try {
    db = await openDb(factory);
  } catch {
    return memoryDrafts();
  }
  return {
    persistent: true,
    load: async (id) =>
      ((await tx(db, 'readonly', (s) => s.get(id))) as PendingBatch[] | undefined) ?? [],
    save: async (id, b) => {
      await tx<unknown>(db, 'readwrite', (s) =>
        b.length
          ? (s.put([...b], id) as IDBRequest<unknown>)
          : (s.delete(id) as IDBRequest<unknown>),
      );
    },
  };
}
