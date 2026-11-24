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
  /** Faux : périphériques différents, durées non comparables. */
  sameDevices: boolean;
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

/* ------------------------------------------------------------------ */
/* Analyse éditoriale — étape 4a : préparation locale, aucun appel API */
/* ------------------------------------------------------------------ */

export type FramingStatus = 'none' | 'not_validated' | 'changed' | 'missing' | 'validated';

export interface AnalysisSettings {
  discordTextAllowed: boolean;
  discordConsentNote: string | null;
  discordConsentAt: string | null;
  facecamAllowed: boolean;
  framingProfileId: string | null;
  framingValidatedAt: string | null;
  framingStatus: FramingStatus;
}

export interface FramingProfile {
  id: string;
  displayName: string;
  description?: string;
  facecam: unknown;
  masks: { label: string }[];
}

export interface FramingPreview {
  atMs: number;
  files: {
    kind: 'annotated' | 'gameplay' | 'facecam';
    name: string;
    url: string;
    width: number;
    height: number;
  }[];
}

export interface AnalysisSignal {
  kind: string;
  source: string;
  startMs: number;
  endMs: number;
  speaker?: string;
  value: number;
}

export interface AnalysisWindow {
  id: string;
  rank: number;
  coreStartMs: number;
  coreEndMs: number;
  startMs: number;
  endMs: number;
  localScore: number;
  signals: AnalysisSignal[];
  frames: { label: string; derivativeId: string; atMs: number; region: string }[];
  estimate: {
    textTokens: number;
    imageTokens: number;
    typicalUsd?: number;
    maxUsd?: number;
  } | null;
}

export interface AnalysisEstimate {
  pricingVersion: string;
  models: { triage: string; deep: string };
  effort: string;
  budgetUsd: number;
  assumptions: string[];
  triage: { typicalUsd: number; maxUsd: number; chunks: unknown[] };
  totals: { typicalUsd: number; maxUsd: number };
  fit: { windowCount: number; typicalWindows: number; worstCaseWindows: number };
}

export interface AnalysisRun {
  id: string;
  status: string;
  mode: string;
  windowCount: number;
  budgetUsd: number;
  spentUsd: number;
  estimate: AnalysisEstimate | null;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export interface AnalysisManifest {
  nothingSent: boolean;
  tracks: { audioIndex: number; role: string; textTransmitted: boolean; reason: string }[];
  privacy: { imagesSent: boolean; noImagesReason: string | null; pseudonymLabelsUsed: string[] };
  triage: { scope: string; chunks: { index: number; startMs: number; endMs: number }[] };
}

const send = (method: 'POST' | 'PUT', body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const analysisApi = {
  settings: (recordingId: string) =>
    getJson<{ settings: AnalysisSettings }>(`/api/recordings/${recordingId}/analysis-settings`),
  updateSettings: (recordingId: string, patch: Record<string, unknown>) =>
    getJson<{ settings: AnalysisSettings }>(
      `/api/recordings/${recordingId}/analysis-settings`,
      send('PUT', patch),
    ),
  framingProfiles: () => getJson<{ profiles: FramingProfile[] }>('/api/framing-profiles'),
  preview: (recordingId: string, profileId: string, atMs?: number) =>
    getJson<FramingPreview>(
      `/api/recordings/${recordingId}/framing-preview`,
      send('POST', atMs === undefined ? { profileId } : { profileId, atMs }),
    ),
  validateFraming: (recordingId: string, profileId: string) =>
    getJson<{ settings: AnalysisSettings }>(
      `/api/recordings/${recordingId}/framing-validation`,
      send('POST', { profileId }),
    ),
  prepare: (recordingId: string, force = false) =>
    getJson<{ status: 'ready' | 'pending'; run: AnalysisRun; job: Job | null }>(
      `/api/recordings/${recordingId}/analyses`,
      send('POST', { dryRun: true, force }),
    ),
  runs: (recordingId: string) =>
    getJson<{ runs: AnalysisRun[] }>(`/api/recordings/${recordingId}/analyses`),
  run: (runId: string) =>
    getJson<{ run: AnalysisRun; windows: AnalysisWindow[] }>(`/api/analyses/${runId}`),
  manifest: (runId: string) =>
    getJson<{ manifest: AnalysisManifest }>(`/api/analyses/${runId}/manifest`),
  windowPayload: (runId: string, rank: number) =>
    getJson<{ text: string }>(`/api/analyses/${runId}/windows/${rank}/payload`),
  triageChunk: (runId: string, index: number) =>
    getJson<{ text: string }>(`/api/analyses/${runId}/triage/${index}`),
};

/* ------------------------------------------------------------------ */
/* Analyse avec Claude (étape 4b) : payante, plafond de réservation    */
/* ------------------------------------------------------------------ */

export interface AnalysisPublicConfig {
  mode: string;
  claudeConfigured: boolean;
  models: { triage: string; deep: string };
  effort: string;
  budgetUsd: number;
  minRelevance: number;
  minReliability: number;
}

export interface ClaudeRun {
  id: string;
  status: string;
  stage: string | null;
  /** Plafond de réservation (garanti avant chaque envoi). */
  budgetUsd: number;
  spentUsd: number;
  reservedUsd: number;
  /** Coût réel calculé au-delà du plafond (0 normalement). */
  overrunUsd: number;
  /** Coût réel calculé total ; peut dépasser `budgetUsd` si `overrunUsd` > 0. */
  totalCostUsd: number;
  windowCount: number;
  error: { code: string; message: string } | null;
  createdAt: string;
  mode: string;
}

export interface Proposal {
  id: string;
  tier: 'clip' | 'secondary';
  title: string;
  explanation: string;
  categories: string[];
  relevance: number;
  reliability: number;
  reliabilityDetail: { reasons?: string[] };
  flags: string[];
  srcStartMs: number;
  srcEndMs: number;
  uncertainty: string | null;
  evidence: { kind: string; segmentId: number | null; quote: string | null; verified: boolean }[];
}

export interface CallsSummary {
  calls: {
    id: string;
    stage: string;
    status: string;
    costUsd: number;
    windowId: string | null;
    refusalCategory: string | null;
  }[];
  costs: {
    realCostUsd: number;
    budgetUsd: number;
    overrunUsd: number;
    budgetExceeded: boolean;
    aboveReservationCalls: number;
    aboveReservationUsd: number;
    calls: number;
    reusedCalls: number;
    unknownCostCalls: number;
  };
}

export const claudeApi = {
  config: () => getJson<AnalysisPublicConfig>('/api/analysis/config'),
  start: (recordingId: string, acceptBudgetUsd: number) =>
    getJson<{ status: 'ready' | 'pending'; run: ClaudeRun; job: Job | null }>(
      `/api/recordings/${recordingId}/analyses`,
      send('POST', { mode: 'claude', acceptBudgetUsd }),
    ),
  runs: (recordingId: string) =>
    getJson<{ runs: ClaudeRun[] }>(`/api/recordings/${recordingId}/analyses`),
  run: (runId: string) =>
    getJson<{
      run: ClaudeRun;
      windows: { id: string; status: string; origin: string; costUsd: number }[];
    }>(`/api/analyses/${runId}`),
  proposals: (runId: string) =>
    getJson<{ proposals: Proposal[] }>(`/api/analyses/${runId}/proposals`),
  calls: (runId: string) => getJson<CallsSummary>(`/api/analyses/${runId}/calls`),
};
