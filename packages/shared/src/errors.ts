/**
 * Erreur applicative typée. Le `code` est stable et exploitable
 * (logs, API, tests) ; le message est destiné aux humains.
 */
export type AppErrorCode =
  | 'CONFIG_INVALID'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PROFILE_INVALID'
  | 'PROFILE_NOT_FOUND'
  | 'TOOL_MISSING'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_UNSUPPORTED'
  | 'MEDIA_PROBE_FAILED'
  | 'MEDIA_EXTRACT_FAILED'
  | 'MEDIA_SOURCE_CHANGED'
  | 'UNSAFE_OUTPUT_PATH'
  | 'CANCELLED'
  | 'TRANSCRIPTION_FAILED'
  | 'TRANSCRIPTION_WORKER_CRASHED'
  | 'TRANSCRIPTION_GPU_UNAVAILABLE'
  | 'TRANSCRIPTION_PROTOCOL'
  | 'ANALYSIS_NOT_READY'
  | 'PRICING_UNKNOWN'
  | 'PRIVACY_CONFIG_INVALID'
  | 'CLAUDE_NOT_CONFIGURED'
  | 'CLAUDE_AUTH_FAILED'
  | 'CLAUDE_API_ERROR'
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_OVERRUN'
  | 'BUDGET_NOT_CONFIRMED'
  | 'ALREADY_REVIEWED'
  | 'DECISION_ELSEWHERE'
  | 'IDEMPOTENCY_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'PROPOSAL_NOT_REVIEWABLE'
  | 'AUDIO_TRACK_MISSING'
  | 'NOT_READY'
  | 'PROPOSAL_NOT_ACCEPTED'
  | 'EXPORT_CONSENT_REQUIRED'
  | 'DURATION_OUT_OF_RANGE'
  | 'RENDER_FAILED'
  | 'DISK_SPACE_LOW'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: unknown;

  constructor(
    code: AppErrorCode,
    message: string,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.details = options?.details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
