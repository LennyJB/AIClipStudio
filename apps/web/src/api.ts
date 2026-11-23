export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
  database: 'ok';
  claudeConfigured: boolean;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch('/api/health', signal ? { signal } : {});
  if (!res.ok) throw new Error(`API indisponible (HTTP ${res.status})`);
  return (await res.json()) as HealthResponse;
}

/* ------------------------------------------------------------------ */
/* Enregistrements et transcriptions (types limités à l'affichage)     */
/* ------------------------------------------------------------------ */

export interface AudioTrack {
  audioIndex: number;
  role: string;
  title: string | null;
}

export interface Recording {
  id: string;
  fileName: string;
  durationSec: number | null;
  gameId: string;
  audioTracks: AudioTrack[];
}

export interface Transcription {
  id: string;
  audioIndex: number;
  model: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  devicesUsed: ('cuda' | 'cpu')[];
  fallbackError: string | null;
  language: string | null;
  languageSource: 'detected' | 'forced' | null;
  audioDurationMs: number | null;
  checkpointMs: number;
  segmentCount: number;
  processingMs: number;
  realtimeFactor: number | null;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export interface Segment {
  id: number;
  transcriptionId: string;
  audioIndex: number;
  role: string | null;
  srcStartMs: number;
  srcEndMs: number;
  text: string;
  suspicionScore: number;
  suspicionReasons: string[];
}

export interface ComparisonGroup {
  audioIndex: number;
  role: string | null;
  transcriptions: Transcription[];
}

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
  progress: number;
  error: { code: string; message: string } | null;
}

export interface TranscriptionConfig {
  defaultModel: string;
  modelChoices: string[];
  device: string;
  language: string;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as
    (T & { error?: { message?: string } }) | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `Erreur HTTP ${res.status}`);
  return body as T;
}

export const api = {
  recordings: () => getJson<{ recordings: Recording[] }>('/api/recordings'),
  transcriptionConfig: () => getJson<TranscriptionConfig>('/api/transcription/config'),
  transcriptions: (recordingId: string) =>
    getJson<{ transcriptions: Transcription[]; comparisons: ComparisonGroup[] }>(
      `/api/recordings/${recordingId}/transcriptions`,
    ),
  transcript: (recordingId: string, q: { model?: string; transcriptionIds?: string[] }) => {
    const params = new URLSearchParams();
    if (q.transcriptionIds?.length) params.set('transcriptionIds', q.transcriptionIds.join(','));
    else if (q.model) params.set('model', q.model);
    return getJson<{ transcriptions: Transcription[]; segments: Segment[] }>(
      `/api/recordings/${recordingId}/transcript?${params.toString()}`,
    );
  },
  startTranscription: (recordingId: string, model: string) =>
    getJson<{ status: 'ready' | 'pending'; job: Job | null }>(
      `/api/recordings/${recordingId}/transcriptions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      },
    ),
  job: (jobId: string) => getJson<{ job: Job }>(`/api/jobs/${jobId}`),
};
