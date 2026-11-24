import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AppError,
  TrackRoleSchema,
  TriageScopeSchema,
  type TrackRole,
  type TriageScope,
} from '@acs/shared';

/** Racine du dépôt (services/api/src → ../../..). */
export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** Modèle de l'analyse approfondie (étape 4b). */
  CLAUDE_MODEL: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .default('claude-opus-5-5'),
  /** Modèle du repérage global, économique (étape 4b). */
  CLAUDE_TRIAGE_MODEL: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .default('claude-haiku-5-5'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  STORAGE_DIR: z.string().min(1).default('./storage'),
  DATABASE_PATH: z.string().min(1).default('./storage/db/ai-clip-studio.sqlite'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  PYTHON_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  WHISPER_MODEL: z.string().min(1).default('large-v3-turbo'),
  WHISPER_MODEL_CHOICES: z
    .string()
    .default('large-v3-turbo,large-v3')
    .transform((v) =>
      v
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[\w.\-/]+$/)).min(1)),
  WHISPER_DEVICE: z.enum(['auto', 'cuda', 'cpu']).default('auto'),
  WHISPER_CPU_FALLBACK: bool(true),
  WHISPER_COMPUTE_TYPE: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .default('auto'),
  WHISPER_CPU_COMPUTE_TYPE: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .default('int8'),
  WHISPER_LANGUAGE: z
    .string()
    .regex(/^(auto|[a-z]{2,3})$/)
    .default('auto'),
  WHISPER_BEAM_SIZE: z.coerce.number().int().min(1).max(10).default(5),
  WHISPER_BATCH_SIZE: z.coerce.number().int().min(0).max(64).default(0),
  WHISPER_WORD_TIMESTAMPS: bool(true),
  WHISPER_VAD: bool(true),
  WHISPER_VAD_THRESHOLD: z.coerce.number().min(0.05).max(0.95).default(0.5),
  WHISPER_VAD_MIN_SILENCE_MS: z.coerce.number().int().min(50).max(10_000).default(500),
  WHISPER_VAD_MIN_SPEECH_MS: z.coerce.number().int().min(0).max(5_000).default(250),
  WHISPER_VAD_SPEECH_PAD_MS: z.coerce.number().int().min(0).max(2_000).default(400),
  WHISPER_CHUNK_SEC: z.coerce.number().int().min(10).max(7_200).default(1_200),
  WHISPER_CHUNK_OVERLAP_SEC: z.coerce.number().int().min(0).max(300).default(30),
  WHISPER_BOUNDARY_TOLERANCE_MS: z.coerce.number().int().min(0).max(10_000).default(1_000),
  WHISPER_MODEL_DIR: z.string().min(1).default('./storage/models'),
  /** Avancé (tests) : commande du worker en JSON, ex. ["node","fake.mjs"]. Vide = Python + worker.py. */
  WHISPER_WORKER_COMMAND: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .transform((v, ctx) => {
        try {
          return JSON.parse(v) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'JSON invalide' });
          return z.NEVER;
        }
      })
      .pipe(z.array(z.string().min(1)).min(1))
      .optional(),
  ),
  /** Rôle des pistes audio OBS dans l'ordre du fichier (utilisé si les pistes ne sont pas nommées). */
  AUDIO_TRACK_ROLES: z
    .string()
    .default('mix,mic,discord')
    .transform((v) =>
      v
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(TrackRoleSchema).min(1)),
  CACHE_MAX_GB: z.coerce.number().positive().max(10_000).default(30),
  CLIP_WINDOW_MARGIN_SEC: z.coerce.number().int().min(0).max(600).default(30),
  CLIP_WINDOW_GRID_SEC: z.coerce.number().int().min(1).max(600).default(30),
  /* ---------------------------- Analyse éditoriale ---------------------------- */
  ANALYSIS_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  /** Plafond STRICT de dépense par analyse, en dollars (jetons de réflexion et cache compris). */
  ANALYSIS_MAX_COST_USD: z.coerce.number().positive().max(1000).default(5),
  /** Jetons de sortie maximum par appel d'analyse approfondie (réflexion comprise). */
  ANALYSIS_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1000).max(128_000).default(12_000),
  /** Jetons de sortie maximum par tranche de repérage (réflexion comprise). */
  ANALYSIS_TRIAGE_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(500).max(64_000).default(4_000),
  /** off : aucun repérage global ; signals : autour des signaux locaux ; full : tout le texte autorisé. */
  ANALYSIS_TRIAGE_SCOPE: TriageScopeSchema.default('full'),
  ANALYSIS_TRIAGE_CHUNK_SEC: z.coerce.number().int().min(60).max(3_600).default(1_200),
  ANALYSIS_CONTEXT_BEFORE_SEC: z.coerce.number().int().min(0).max(600).default(45),
  ANALYSIS_CONTEXT_AFTER_SEC: z.coerce.number().int().min(0).max(600).default(20),
  ANALYSIS_FAR_CONTEXT_SEC: z.coerce.number().int().min(0).max(1_800).default(180),
  /** Score local minimal (0..1) pour qu'une zone devienne une fenêtre candidate. */
  ANALYSIS_LOCAL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.35),
  ANALYSIS_FRAMES_PER_WINDOW: z.coerce.number().int().min(0).max(12).default(4),
  ANALYSIS_FRAME_WIDTH: z.coerce.number().int().min(256).max(2_048).default(1_024),
  /** Fichier des pseudonymes (contient des noms réels : hors dépôt). */
  ANALYSIS_PRIVACY_FILE: z.string().min(1).default('./storage/config/privacy.json'),
});

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  rootDir: string;
  server: { host: string; port: number };
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  /** La clé n'est exposée que via ce champ côté serveur ; jamais renvoyée par l'API. */
  claude: { apiKey: string | undefined; model: string; triageModel: string };
  paths: {
    storage: string;
    originals: string;
    processing: string;
    exports: string;
    database: string;
    profiles: string;
  };
  tools: { ffmpeg: string; ffprobe: string; python: string };
  whisper: {
    model: string;
    modelChoices: string[];
    device: 'auto' | 'cuda' | 'cpu';
    cpuFallback: boolean;
    computeType: string;
    cpuComputeType: string;
    /** 'auto' = détection automatique. */
    language: string;
    beamSize: number;
    batchSize: number;
    wordTimestamps: boolean;
    vad: {
      enabled: boolean;
      threshold: number;
      minSilenceDurationMs: number;
      minSpeechDurationMs: number;
      speechPadMs: number;
    };
    chunking: { coreMs: number; overlapMs: number; boundaryToleranceMs: number };
    modelDir: string;
    /** Commande du worker (null = Python du venv + worker.py). */
    workerCommand: string[] | null;
  };
  audioTrackRoles: TrackRole[];
  cache: { maxBytes: number };
  clipWindow: { marginMs: number; gridMs: number };
  analysis: {
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    maxCostUsd: number;
    maxOutputTokens: number;
    triageMaxOutputTokens: number;
    triageScope: TriageScope;
    triageChunkMs: number;
    contextBeforeMs: number;
    contextAfterMs: number;
    farContextMs: number;
    localMinScore: number;
    framesPerWindow: number;
    frameWidth: number;
    privacyFile: string;
    /** Contenu préparé et aperçus (hors processing/ : jamais supprimé par le nettoyage du cache). */
    outputDir: string;
  };
}

export function defaultPythonPath(rootDir: string, platform: NodeJS.Platform = process.platform) {
  return platform === 'win32'
    ? path.join(rootDir, '.venv', 'Scripts', 'python.exe')
    : path.join(rootDir, '.venv', 'bin', 'python');
}

/** Construit la configuration à partir d'un objet d'environnement (pur, testable). */
export function loadConfig(env: NodeJS.ProcessEnv, rootDir: string = ROOT_DIR): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', 'Configuration invalide (.env)', {
      // On ne recopie jamais les valeurs : seulement les noms de variables fautives.
      details: parsed.error.issues.map((i) => ({ variable: i.path.join('.'), message: i.message })),
    });
  }
  const e = parsed.data;
  const resolve = (p: string) => path.resolve(rootDir, p);
  const storage = resolve(e.STORAGE_DIR);

  return {
    env: e.NODE_ENV,
    rootDir,
    server: { host: e.API_HOST, port: e.API_PORT },
    logLevel: e.LOG_LEVEL,
    claude: {
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.CLAUDE_MODEL,
      triageModel: e.CLAUDE_TRIAGE_MODEL,
    },
    paths: {
      storage,
      originals: path.join(storage, 'originals'),
      processing: path.join(storage, 'processing'),
      exports: path.join(storage, 'exports'),
      database: resolve(e.DATABASE_PATH),
      profiles: path.join(rootDir, 'profiles'),
    },
    tools: {
      ffmpeg: e.FFMPEG_PATH,
      ffprobe: e.FFPROBE_PATH,
      python: e.PYTHON_PATH ? resolve(e.PYTHON_PATH) : defaultPythonPath(rootDir),
    },
    whisper: {
      model: e.WHISPER_MODEL,
      modelChoices: [...new Set([e.WHISPER_MODEL, ...e.WHISPER_MODEL_CHOICES])],
      device: e.WHISPER_DEVICE,
      cpuFallback: e.WHISPER_CPU_FALLBACK,
      computeType: e.WHISPER_COMPUTE_TYPE,
      cpuComputeType: e.WHISPER_CPU_COMPUTE_TYPE,
      language: e.WHISPER_LANGUAGE,
      beamSize: e.WHISPER_BEAM_SIZE,
      batchSize: e.WHISPER_BATCH_SIZE,
      wordTimestamps: e.WHISPER_WORD_TIMESTAMPS,
      vad: {
        enabled: e.WHISPER_VAD,
        threshold: e.WHISPER_VAD_THRESHOLD,
        minSilenceDurationMs: e.WHISPER_VAD_MIN_SILENCE_MS,
        minSpeechDurationMs: e.WHISPER_VAD_MIN_SPEECH_MS,
        speechPadMs: e.WHISPER_VAD_SPEECH_PAD_MS,
      },
      chunking: {
        coreMs: e.WHISPER_CHUNK_SEC * 1000,
        overlapMs: e.WHISPER_CHUNK_OVERLAP_SEC * 1000,
        boundaryToleranceMs: e.WHISPER_BOUNDARY_TOLERANCE_MS,
      },
      modelDir: resolve(e.WHISPER_MODEL_DIR),
      workerCommand: e.WHISPER_WORKER_COMMAND ?? null,
    },
    audioTrackRoles: e.AUDIO_TRACK_ROLES,
    cache: { maxBytes: Math.round(e.CACHE_MAX_GB * 1024 ** 3) },
    clipWindow: {
      marginMs: e.CLIP_WINDOW_MARGIN_SEC * 1000,
      gridMs: e.CLIP_WINDOW_GRID_SEC * 1000,
    },
    analysis: {
      effort: e.ANALYSIS_EFFORT,
      maxCostUsd: e.ANALYSIS_MAX_COST_USD,
      maxOutputTokens: e.ANALYSIS_MAX_OUTPUT_TOKENS,
      triageMaxOutputTokens: e.ANALYSIS_TRIAGE_MAX_OUTPUT_TOKENS,
      triageScope: e.ANALYSIS_TRIAGE_SCOPE,
      triageChunkMs: e.ANALYSIS_TRIAGE_CHUNK_SEC * 1000,
      contextBeforeMs: e.ANALYSIS_CONTEXT_BEFORE_SEC * 1000,
      contextAfterMs: e.ANALYSIS_CONTEXT_AFTER_SEC * 1000,
      farContextMs: e.ANALYSIS_FAR_CONTEXT_SEC * 1000,
      localMinScore: e.ANALYSIS_LOCAL_MIN_SCORE,
      framesPerWindow: e.ANALYSIS_FRAMES_PER_WINDOW,
      frameWidth: e.ANALYSIS_FRAME_WIDTH,
      privacyFile: resolve(e.ANALYSIS_PRIVACY_FILE),
      outputDir: path.join(storage, 'analysis'),
    },
  };
}

/** Charge le fichier .env racine s'il existe (sans écraser les variables déjà définies). */
export function loadEnvFile(rootDir: string = ROOT_DIR): boolean {
  const envPath = path.join(rootDir, '.env');
  if (!existsSync(envPath)) return false;
  process.loadEnvFile(envPath);
  return true;
}
