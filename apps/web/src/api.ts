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

/** Erreur renvoyée par l'API : code stable et détails éventuels (conflits de la revue…). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: unknown,
  ) {
    super(message);
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as
    (T & { error?: { message?: string; code?: string; details?: unknown } }) | null;
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message ?? `Erreur HTTP ${res.status}`,
      res.status,
      body?.error?.code ?? null,
      body?.error?.details,
    );
  }
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
  /** Pause de relecture : `review` est renseigné à la pause, `reviewApprovedAt` à l'accord. */
  config?: {
    review?: { deepRequests: number; deepMaxUsd: number; remainingUsd: number };
    reviewApprovedAt?: string;
  };
}

export interface RunRequest {
  name: string;
  stage: 'triage' | 'deep';
  requestHash: string | null;
  sentToClaude: boolean;
}

/** Pause de relecture : requêtes Opus écrites, rien n'est envoyé avant l'accord. */
export const isAwaitingReview = (run: ClaudeRun) =>
  run.status === 'pending' && run.stage === 'awaiting_review' && !run.config?.reviewApprovedAt;

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
  requests: (runId: string) =>
    getJson<{ requests: RunRequest[] }>(`/api/analyses/${runId}/requests`),
  approveReview: (runId: string, acceptBudgetUsd: number) =>
    getJson<{ status: 'pending'; run: ClaudeRun; job: Job | null }>(
      `/api/analyses/${runId}/approve-review`,
      send('POST', { acceptBudgetUsd }),
    ),
};

/* -------------------------------------------------------------------------- */
/* Revue des propositions (étape 5)                                            */
/* -------------------------------------------------------------------------- */

/** Motifs de refus (identiques à @acs/memory, vérifié par un test). */
export const REJECT_REASONS = [
  'pas_drole',
  'manque_de_contexte',
  'chute_coupee',
  'trop_long',
  'trop_court',
  'deja_vu',
  'gameplay_sans_interet',
  'audio_inaudible',
  'contenu_a_eviter',
  'autre',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  pas_drole: 'Pas drôle',
  manque_de_contexte: 'Manque de contexte',
  chute_coupee: 'Chute coupée',
  trop_long: 'Trop long',
  trop_court: 'Trop court',
  deja_vu: 'Déjà vu',
  gameplay_sans_interet: 'Gameplay sans intérêt',
  audio_inaudible: 'Audio inaudible',
  contenu_a_eviter: 'Contenu à éviter',
  autre: 'Autre',
};

export type ReviewStatus = 'pending' | 'accepted' | 'rejected';
export type ReviewState = 'to_review' | 'accepted' | 'rejected' | 'already_reviewed' | 'merged';

export interface ReviewDecision {
  status: ReviewStatus;
  reasons: RejectReason[];
  comment: string | null;
  decidedAt?: string | null;
  version?: number;
}

export interface EffectiveDecision {
  status: ReviewStatus;
  reasons: RejectReason[];
  comment: string | null;
  sourceProposalId: string | null;
  eventId: string | null;
  inherited: boolean;
  source: { proposalId: string; runId: string; title: string; decidedAt: string | null } | null;
}

export interface ReviewProposal extends Proposal {
  runId: string;
  recordingId: string;
  punchlineMs: number;
  mergedIntoId: string | null;
  explanation: string;
  editingHint: { mode?: string; ideas?: string[] } | null;
}

export interface ReviewItem {
  proposal: ReviewProposal;
  momentId: string | null;
  review: ReviewDecision | null;
  supersededReview: ReviewDecision | null;
  effective: EffectiveDecision;
  state: ReviewState;
  version: number;
}

export interface ReviewList {
  run: { id: string; status: string; createdAt: string } | null;
  runs: { id: string; status: string; createdAt: string }[];
  items: ReviewItem[];
  counts: Record<ReviewState | 'all', number>;
}

export interface ReviewDetail extends ReviewItem {
  moment: {
    id: string;
    members: { proposalId: string; runId: string; title: string; isSource: boolean }[];
  } | null;
  run: {
    id: string;
    createdAt: string;
    promptVersion: string | null;
    models: { triage: string | null; deep: string | null };
  } | null;
}

export interface ContextSegment {
  id: number;
  role: string | null;
  srcStartMs: number;
  srcEndMs: number;
  text: string;
  inClip: boolean;
  marker: 'setup' | 'punchline' | 'reaction_end' | null;
  sentToClaude: boolean;
}

export interface FeedbackEventView {
  seq: number;
  id: string;
  type: 'proposal_accepted' | 'proposal_rejected' | 'proposal_reset';
  occurredAt: string;
  proposalId: string;
  runId: string;
  newStatus: ReviewStatus;
  reasons: RejectReason[];
  comment: string | null;
  reevaluatesEventId: string | null;
  current: boolean;
}

export interface DecisionRequest {
  requestId: string;
  decision: ReviewStatus;
  reasons?: RejectReason[];
  comment?: string;
  expectedVersion?: number;
  reevaluate?: boolean;
}

export type AudioPreparation =
  | {
      status: 'ready';
      derivativeId: string;
      durationMs: number | null;
      windowStartMs: number;
      windowEndMs: number;
    }
  | { status: 'pending'; job: Job | null; windowStartMs: number; windowEndMs: number };

export const reviewApi = {
  list: (
    recordingId: string,
    q: { runId?: string; tier?: 'clip' | 'secondary'; status?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (q.runId) params.set('runId', q.runId);
    if (q.tier) params.set('tier', q.tier);
    if (q.status) params.set('status', q.status);
    const qs = params.toString();
    return getJson<ReviewList>(`/api/recordings/${recordingId}/proposals${qs ? `?${qs}` : ''}`);
  },
  detail: (id: string) => getJson<ReviewDetail>(`/api/proposals/${id}`),
  context: (id: string) =>
    getJson<{ segments: ContextSegment[]; clip: { srcStartMs: number; srcEndMs: number } }>(
      `/api/proposals/${id}/context`,
    ),
  history: (id: string) => getJson<{ events: FeedbackEventView[] }>(`/api/proposals/${id}/events`),
  decide: (id: string, body: DecisionRequest) =>
    getJson<ReviewItem & { outcome: 'applied' | 'noop'; replayed: boolean }>(
      `/api/proposals/${id}/decision`,
      send('POST', body),
    ),
  detach: (id: string, body: { requestId: string; comment?: string }) =>
    getJson<{ outcome: string }>(`/api/proposals/${id}/detach`, send('POST', body)),
  prepareAudio: (id: string) =>
    getJson<AudioPreparation>(`/api/proposals/${id}/audio`, send('POST', {})),
  audioUrl: (id: string, derivativeId: string) =>
    `/api/proposals/${id}/audio?v=${encodeURIComponent(derivativeId)}`,
};
