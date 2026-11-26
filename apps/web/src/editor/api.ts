/**
 * API de l'éditeur (étape 7) : document v2 et journal d'édition, textes affichés, médias de
 * travail protégés (§5.2), image exacte, rendus. L'interface n'applique AUCUNE règle de
 * consentement : la décision d'audio exporté vient du serveur, qui revérifie tout.
 */
import type { ClipProjectV2, DisplayCaption, Operation } from '@acs/timeline';
import { ApiError, getJson, send, type AudioDecision } from '../api';

export { ApiError };

export interface RecordingInfo {
  width: number | null;
  height: number | null;
  fps: number | null;
  durationMs: number | null;
  audioTracks: { audioIndex: number; role: string }[];
}

export interface HistoryTops {
  undo: number | null;
  redo: number | null;
}

export interface EditorDocument {
  projectId: string;
  version: number;
  hash: string;
  document: ClipProjectV2;
  editable: boolean;
  decision: { status: string; merged?: boolean };
  history: HistoryTops;
  checkpointRevision: number;
  audio: AudioDecision;
  recording: RecordingInfo;
}

export interface JournalEntry {
  seq: number;
  kind: 'do' | 'undo' | 'redo' | 'system';
  targetSeq: number | null;
  ops: Operation[];
  hashAfter: string;
  baseSeq: number;
  clientId: string | null;
  summary: string | null;
  source: string;
  createdAt: string;
}

export interface EditsSince {
  head: { version: number; hash: string };
  history: HistoryTops;
  entries: JournalEntry[];
}

export interface EditResult {
  version: number;
  hash: string;
  replayed: boolean;
  rebased: boolean;
  history: HistoryTops;
}

export type EditRequest =
  | {
      requestId: string;
      clientId: string;
      base: { version: number };
      kind: 'do';
      ops: Operation[];
      expectedHash?: string;
      summary?: string;
    }
  | {
      requestId: string;
      clientId: string;
      base: { version: number };
      kind: 'undo' | 'redo';
      targetSeq: number;
      acknowledgeMaskRisk?: boolean;
    };

export interface EditorTexts {
  version: number;
  items: DisplayCaption[];
  manual: Record<string, string>;
  overlays: Record<string, string>;
}

export interface ThumbnailLayout {
  windowStartMs: number;
  intervalMs: number;
  count: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

export interface EditorMedia {
  status: 'ready' | 'pending';
  window: { srcStartMs: number; srcEndMs: number };
  lease: { expiresAt: string };
  proxy: { id: string; srcStartMs: number | null; durationMs: number | null } | null;
  thumbnails: { id: string; layout: ThumbnailLayout | null } | null;
  audio: { id: string; audioIndex: number; role: string; srcStartMs: number | null }[];
  waveforms: { id: string; audioIndex: number }[];
  jobs: { id: string; type: string; status: string }[];
}

const json = (body: unknown): RequestInit => send('POST', body);

export const editorApi = {
  document: (projectId: string) =>
    getJson<EditorDocument>(`/api/clip-projects/${projectId}/document`),
  editsSince: (projectId: string, since: number) =>
    getJson<EditsSince>(`/api/clip-projects/${projectId}/edits?since=${since}`),
  submit: (projectId: string, body: EditRequest) =>
    getJson<EditResult>(`/api/clip-projects/${projectId}/edits`, json(body)),
  texts: (projectId: string) => getJson<EditorTexts>(`/api/clip-projects/${projectId}/texts`),
  checkpoint: (projectId: string) =>
    getJson<{ revision: number }>(`/api/clip-projects/${projectId}/checkpoint`, json({})),
  prepareMedia: (projectId: string, sessionId: string) =>
    getJson<EditorMedia>(`/api/clip-projects/${projectId}/editor-media`, json({ sessionId })),
  releaseMedia: (projectId: string, sessionId: string) =>
    getJson<{ released: number }>(
      `/api/clip-projects/${projectId}/editor-media/release`,
      json({ sessionId }),
    ),
  /** Jeton éphémère (10 min) lié au projet, au dérivé et au bail de la session. */
  mediaToken: (projectId: string, sessionId: string, derivativeId: string) =>
    getJson<{ token: string; expiresAt: string }>(
      `/api/clip-projects/${projectId}/media-token`,
      json({ sessionId, derivativeId }),
    ),
  mediaUrl: (derivativeId: string, token: string) =>
    `/api/editor-media/${encodeURIComponent(derivativeId)}?token=${encodeURIComponent(token)}`,
  fontUrl: (file: string) => `/api/editor/fonts/${encodeURIComponent(file)}`,
  frameUrl: (projectId: string, atEditMs: number) =>
    `/api/clip-projects/${projectId}/frame?atEditMs=${Math.max(0, Math.round(atEditMs))}`,
};

export type EditorApi = typeof editorApi;
