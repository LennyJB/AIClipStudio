/**
 * Protocole entre Node et le worker Python (une ligne JSON par message).
 * Node → worker : commandes sur stdin. Worker → Node : messages sur stdout.
 * Chaque message reçu est validé : une sortie inattendue arrête le traitement.
 */
import { z } from 'zod';

export const DeviceSchema = z.enum(['cuda', 'cpu']);
export type Device = z.infer<typeof DeviceSchema>;

export interface VadOptions {
  enabled: boolean;
  threshold: number;
  minSilenceDurationMs: number;
  minSpeechDurationMs: number;
  speechPadMs: number;
}

export interface InitCommand {
  cmd: 'init';
  model: string;
  device: 'auto' | Device;
  computeType: string;
  /** Repli CPU autorisé si CUDA échoue. */
  cpuFallback: boolean;
  cpuComputeType: string;
  downloadRoot: string | null;
  beamSize: number;
  batchSize: number;
  wordTimestamps: boolean;
  vad: VadOptions;
  hotwords: string | null;
}

export interface TranscribeCommand {
  cmd: 'transcribe';
  requestId: number;
  wavPath: string;
  startMs: number;
  endMs: number;
  /** null = détection automatique. */
  language: string | null;
}

const ms = z.number().int().nonnegative();

const Word = z.object({
  word: z.string(),
  startMs: ms,
  endMs: ms,
  probability: z.number().min(0).max(1),
});

export const ReadyMessage = z.object({
  type: z.literal('ready'),
  engine: z.literal('faster-whisper'),
  engineVersion: z.string(),
  ctranslate2Version: z.string(),
  model: z.string(),
  device: DeviceSchema,
  computeType: z.string(),
  cudaDeviceCount: z.number().int().nonnegative(),
  loadMs: ms,
  /** Présent si CUDA a échoué au chargement et que le worker est passé sur CPU. */
  fallback: z.object({ from: DeviceSchema, error: z.string() }).nullable(),
});
export type ReadyMessage = z.infer<typeof ReadyMessage>;

export const SegmentMessage = z.object({
  type: z.literal('segment'),
  requestId: z.number().int(),
  startMs: ms,
  endMs: ms,
  text: z.string(),
  avgLogprob: z.number(),
  noSpeechProb: z.number().min(0).max(1),
  compressionRatio: z.number().nonnegative(),
  words: z.array(Word),
});

export const ProgressMessage = z.object({
  type: z.literal('progress'),
  requestId: z.number().int(),
  processedMs: ms,
});

export const FallbackMessage = z.object({
  type: z.literal('device_fallback'),
  requestId: z.number().int().nullable(),
  from: DeviceSchema,
  to: DeviceSchema,
  computeType: z.string(),
  error: z.string(),
});
export type FallbackMessage = z.infer<typeof FallbackMessage>;

export const BlockDoneMessage = z.object({
  type: z.literal('block_done'),
  requestId: z.number().int(),
  language: z.string().nullable(),
  languageProbability: z.number().min(0).max(1).nullable(),
  device: DeviceSchema,
  computeType: z.string(),
  elapsedMs: ms,
  audioMs: ms,
});

export const ErrorMessage = z.object({
  type: z.literal('error'),
  requestId: z.number().int().nullable(),
  code: z.string(),
  message: z.string(),
});

export const WorkerMessage = z.discriminatedUnion('type', [
  ReadyMessage,
  SegmentMessage,
  ProgressMessage,
  FallbackMessage,
  BlockDoneMessage,
  ErrorMessage,
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;
