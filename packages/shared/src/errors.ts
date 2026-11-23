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
