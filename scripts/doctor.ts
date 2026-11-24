/**
 * Diagnostic de l'environnement : `npm run doctor`.
 * Vérifie les outils nécessaires au MVP sans rien modifier.
 * Les commandes sont lancées avec execFile (sans shell) et des arguments fixes.
 */
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { WhisperWorker, WORKER_SCRIPT } from '@acs/transcription';
import { loadConfig, loadEnvFile, ROOT_DIR } from '../services/api/src/config';

const { values: cli } = parseArgs({
  options: {
    /** Test d'inférence réel sur GPU (télécharge le modèle si nécessaire). */
    gpu: { type: 'boolean', default: false },
    'gpu-model': { type: 'string', default: 'tiny' },
    /** Vérifie la clé et les modèles Claude (Models API : aucune génération, aucun coût). */
    claude: { type: 'boolean', default: false },
  },
});

const run = promisify(execFile);

type Level = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  level: Level;
  detail: string;
  required: boolean;
}

const checks: Check[] = [];
const add = (name: string, level: Level, detail: string, required = true) =>
  checks.push({ name, level, detail, required });

async function tryRun(cmd: string, args: string[], timeout = 30_000) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout, windowsHide: true });
    return { ok: true as const, out: `${stdout}${stderr}`.trim() };
  } catch (err) {
    return { ok: false as const, out: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const envLoaded = loadEnvFile();
  add(
    'Fichier .env',
    envLoaded ? 'ok' : 'warn',
    envLoaded ? 'trouvé' : 'absent — copier .env.example vers .env',
    false,
  );

  let config;
  try {
    config = loadConfig(process.env);
    add('Configuration', 'ok', 'variables valides');
  } catch (err) {
    add('Configuration', 'fail', err instanceof Error ? err.message : String(err));
    return;
  }

  // Node.js
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 12);
  add('Node.js', nodeOk ? 'ok' : 'fail', `v${process.versions.node} (requis ≥ 22.12)`);

  // FFmpeg / ffprobe
  for (const [label, bin] of [
    ['FFmpeg', config.tools.ffmpeg],
    ['ffprobe', config.tools.ffprobe],
  ] as const) {
    const r = await tryRun(bin, ['-version']);
    add(label, r.ok ? 'ok' : 'fail', r.ok ? (r.out.split('\n')[0] ?? '') : `introuvable (${bin})`);
  }
  const enc = await tryRun(config.tools.ffmpeg, ['-hide_banner', '-encoders']);
  if (enc.ok) {
    const has = (name: string) => new RegExp(`\\s${name}\\s`).test(enc.out);
    const missing = ['libx264', 'aac'].filter((e) => !has(e));
    add(
      'Encodeurs H.264/AAC',
      missing.length ? 'warn' : 'ok',
      missing.length
        ? `manquants : ${missing.join(', ')} (requis pour le rendu, plus tard)`
        : 'libx264, aac',
      false,
    );
    add(
      'Encodeur NVENC',
      has('h264_nvenc') ? 'ok' : 'warn',
      has('h264_nvenc')
        ? 'h264_nvenc compilé dans FFmpeg (nécessite un GPU NVIDIA)'
        : 'absent (optionnel)',
      false,
    );
  }

  // SQLite natif
  try {
    // Via le module de l'API : même résolution de dépendance que le serveur.
    const { openDatabase } = await import('../services/api/src/db');
    const db = openDatabase(':memory:');
    const v = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    db.close();
    add('SQLite (better-sqlite3)', 'ok', `SQLite ${v.v}`);
  } catch (err) {
    add('SQLite (better-sqlite3)', 'fail', err instanceof Error ? err.message : String(err));
  }

  // Stockage
  try {
    await access(config.paths.storage, constants.W_OK);
    add('Dossier storage/', 'ok', path.relative(ROOT_DIR, config.paths.storage) || '.');
  } catch {
    add('Dossier storage/', 'fail', `non accessible en écriture : ${config.paths.storage}`);
  }

  // Espace disque libre (les WAV de transcription : ≈ 115 Mo / h / piste)
  try {
    const { statfs } = await import('node:fs/promises');
    const st = await statfs(config.paths.storage);
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    add(
      'Espace disque (storage/)',
      freeGb < 10 ? 'warn' : 'ok',
      `${freeGb.toFixed(1)} Go libres${freeGb < 10 ? ' — prévoir au moins 10 Go' : ''}`,
      false,
    );
  } catch {
    add('Espace disque (storage/)', 'warn', 'impossible à déterminer', false);
  }

  // Python + Faster-Whisper (requis à l'étape 3)
  if (!existsSync(config.tools.python)) {
    add(
      'Python (venv)',
      'warn',
      `introuvable : ${config.tools.python} — voir README, section Python`,
      false,
    );
  } else {
    const py = await tryRun(config.tools.python, [
      '-c',
      'import sys, faster_whisper, ctranslate2; print(sys.version.split()[0], faster_whisper.__version__, ctranslate2.__version__, ctranslate2.get_cuda_device_count())',
    ]);
    if (!py.ok) {
      add(
        'Faster-Whisper',
        'warn',
        'non installé dans le venv (pip install -r packages/transcription/python/requirements.txt)',
        false,
      );
    } else {
      const [pyV, fwV, ct2V, cuda] = py.out.split(/\s+/);
      add('Python (venv)', 'ok', `Python ${pyV}`, false);
      add('Faster-Whisper', 'ok', `faster-whisper ${fwV}, CTranslate2 ${ct2V}`, false);
      const gpus = Number(cuda);
      const wantsCuda = config.whisper.device === 'cuda';
      add(
        'CUDA (CTranslate2)',
        gpus > 0 ? 'ok' : wantsCuda ? 'warn' : 'ok',
        gpus > 0
          ? `${gpus} GPU détecté(s)`
          : wantsCuda
            ? 'aucun GPU visible alors que WHISPER_DEVICE=cuda'
            : 'mode CPU',
        false,
      );
    }
  }

  if (cli.gpu) await gpuInferenceTest(config);

  const smi = await tryRun(
    'nvidia-smi',
    ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
    10_000,
  );
  add('GPU NVIDIA', smi.ok ? 'ok' : 'warn', smi.ok ? smi.out : 'nvidia-smi indisponible', false);

  add(
    'Clé Claude API',
    config.claude.apiKey ? 'ok' : cli.claude ? 'fail' : 'warn',
    config.claude.apiKey
      ? `configurée (analyse ${config.claude.model}, repérage ${config.claude.triageModel})`
      : 'absente : seule la préparation locale (--dry-run) est possible',
    cli.claude,
  );
  if (cli.claude && config.claude.apiKey) await claudeCheck(config);
}

/** Clé valide et modèles accessibles (aucune génération : rien n'est facturé). */
async function claudeCheck(config: ReturnType<typeof loadConfig>) {
  const { ClaudeModel } = await import('@acs/editorial');
  const model = new ClaudeModel({ apiKey: config.claude.apiKey! });
  for (const id of [config.claude.model, config.claude.triageModel]) {
    const r = await model.checkModel(id);
    add(`Modèle ${id}`, r.ok ? 'ok' : 'fail', r.ok ? `accessible (${r.displayName})` : r.error);
  }
}

/**
 * Inférence RÉELLE sur GPU : charge un modèle sur CUDA (sans repli CPU) et transcrit
 * 3 s de bruit, VAD désactivée pour forcer l'encodeur (c'est là que cuBLAS/cuDNN sont chargés).
 */
async function gpuInferenceTest(config: ReturnType<typeof loadConfig>) {
  const dir = path.join(config.paths.processing, 'doctor');
  await mkdir(dir, { recursive: true });
  const wav = path.join(dir, 'gpu-test.wav');
  const gen = await tryRun(config.tools.ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=d=3:c=pink:r=16000:a=0.05',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    wav,
  ]);
  if (!gen.ok) {
    add('Inférence GPU', 'fail', `génération de l'audio de test impossible : ${gen.out}`);
    return;
  }
  const model = cli['gpu-model'] ?? 'tiny';
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  let worker: WhisperWorker | undefined;
  try {
    worker = await WhisperWorker.start({
      command: config.whisper.workerCommand ?? [config.tools.python, '-u', WORKER_SCRIPT],
      log: quiet,
      init: {
        cmd: 'init',
        model,
        device: 'cuda',
        computeType: config.whisper.computeType,
        cpuFallback: false,
        cpuComputeType: config.whisper.cpuComputeType,
        downloadRoot: config.whisper.modelDir,
        beamSize: 1,
        batchSize: 0,
        wordTimestamps: false,
        hotwords: null,
        vad: { ...config.whisper.vad, enabled: false },
      },
    });
    const r = await worker.transcribe({ wavPath: wav, startMs: 0, endMs: 3000, language: 'fr' });
    add(
      'Inférence GPU',
      r.device === 'cuda' ? 'ok' : 'fail',
      r.device === 'cuda'
        ? `réussie sur CUDA (${model}, ${r.computeType}, ${r.elapsedMs} ms pour 3 s, chargement ${worker.ready?.loadMs} ms)`
        : `le calcul a tourné sur ${r.device}`,
    );
  } catch (err) {
    add(
      'Inférence GPU',
      'fail',
      `échec CUDA : ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await worker?.close();
  }
}

await main();

const icon: Record<Level, string> = { ok: '✔', warn: '!', fail: '✘' };
const width = Math.max(...checks.map((c) => c.name.length));
console.log('\nAI Clip Studio — diagnostic\n');
for (const c of checks) {
  console.log(
    ` ${icon[c.level]}  ${c.name.padEnd(width)}  ${c.detail}${c.required ? '' : '  (optionnel à ce stade)'}`,
  );
}
const failed = checks.filter((c) => c.level === 'fail' && c.required);
console.log(
  failed.length
    ? `\n${failed.length} vérification(s) bloquante(s).\n`
    : '\nAucun problème bloquant.\n',
);
process.exitCode = failed.length ? 1 : 0;
