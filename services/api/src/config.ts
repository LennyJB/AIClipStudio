import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError, TrackRoleSchema, type TrackRole } from '@acs/shared';

/** Racine du dépôt (services/api/src → ../../..). */
export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  CLAUDE_MODEL: z.string().min(1).default('claude-opus-5-5'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  STORAGE_DIR: z.string().min(1).default('./storage'),
  DATABASE_PATH: z.string().min(1).default('./storage/db/ai-clip-studio.sqlite'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  PYTHON_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  WHISPER_MODEL: z.string().min(1).default('large-v3'),
  WHISPER_DEVICE: z.enum(['cuda', 'cpu']).default('cuda'),
  WHISPER_COMPUTE_TYPE: z.string().min(1).default('float16'),
  WHISPER_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default('fr'),
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
});

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  rootDir: string;
  server: { host: string; port: number };
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  /** La clé n'est exposée que via ce champ côté serveur ; jamais renvoyée par l'API. */
  claude: { apiKey: string | undefined; model: string };
  paths: {
    storage: string;
    originals: string;
    processing: string;
    exports: string;
    database: string;
    profiles: string;
  };
  tools: { ffmpeg: string; ffprobe: string; python: string };
  whisper: { model: string; device: 'cuda' | 'cpu'; computeType: string; language: string };
  audioTrackRoles: TrackRole[];
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
    claude: { apiKey: e.ANTHROPIC_API_KEY, model: e.CLAUDE_MODEL },
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
      device: e.WHISPER_DEVICE,
      computeType: e.WHISPER_COMPUTE_TYPE,
      language: e.WHISPER_LANGUAGE,
    },
    audioTrackRoles: e.AUDIO_TRACK_ROLES,
  };
}

/** Charge le fichier .env racine s'il existe (sans écraser les variables déjà définies). */
export function loadEnvFile(rootDir: string = ROOT_DIR): boolean {
  const envPath = path.join(rootDir, '.env');
  if (!existsSync(envPath)) return false;
  process.loadEnvFile(envPath);
  return true;
}
