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
import { loadConfig, loadEnvFile, ROOT_DIR } from '../services/api/src/config';

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
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
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

  const smi = await tryRun(
    'nvidia-smi',
    ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
    10_000,
  );
  add('GPU NVIDIA', smi.ok ? 'ok' : 'warn', smi.ok ? smi.out : 'nvidia-smi indisponible', false);

  add(
    'Clé Claude API',
    config.claude.apiKey ? 'ok' : 'warn',
    config.claude.apiKey
      ? `configurée (modèle ${config.claude.model})`
      : 'absente (requise à l’étape 4)',
    false,
  );
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
