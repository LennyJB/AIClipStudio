/**
 * Diagnostic de l'environnement : `npm run doctor`.
 * Vérifie les outils nécessaires au MVP sans rien modifier.
 * Les commandes sont lancées avec execFile (sans shell) et des arguments fixes.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { WhisperWorker, WORKER_SCRIPT } from '@acs/transcription';
import { isLoopbackHost, loadConfig, loadEnvFile, ROOT_DIR } from '../services/api/src/config';

const { values: cli } = parseArgs({
  options: {
    /** Test d'inférence réel sur GPU (télécharge le modèle si nécessaire). */
    gpu: { type: 'boolean', default: false },
    'gpu-model': { type: 'string', default: 'tiny' },
    /** Vérifie la clé et les modèles Claude (Models API : aucune génération, aucun coût). */
    claude: { type: 'boolean', default: false },
    /**
     * Rejoue la preuve de suffisance du manifeste d'intégrité (étape 6) avec le FFmpeg installé :
     * octets hors de l'ensemble protégé mis à zéro ⇒ décodage identique.
     */
    render: { type: 'boolean', default: false },
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
        ? `manquants : ${missing.join(', ')} (requis pour le rendu des clips)`
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

  // Rendu des clips (étape 6) : filtres FFmpeg utilisés par le moteur et polices fournies.
  const filters = await tryRun(config.tools.ffmpeg, ['-hide_banner', '-filters']);
  if (filters.ok) {
    const needed = [
      'subtitles',
      'drawbox',
      'zoompan',
      'gblur',
      'loudnorm',
      'amix',
      'vstack',
      'overlay',
    ];
    const missing = needed.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters.out));
    add(
      'Filtres de rendu (libass…)',
      missing.length ? 'fail' : 'ok',
      missing.length
        ? `manquants : ${missing.join(', ')} (rendu des clips impossible)`
        : needed.join(', '),
      false,
    );
  }
  const fontsDir = path.join(ROOT_DIR, 'assets', 'fonts');
  const expectedFonts: Record<string, string> = {
    'Montserrat-ExtraBold.ttf': 'd3ac6a843d3ba6d5cafd44cf39e437055c8aed7e261010f595f57d3c7b3e2c1b',
    'Inter-Bold.ttf': '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
  };
  const fontProblems: string[] = [];
  for (const [file, hash] of Object.entries(expectedFonts)) {
    try {
      const got = createHash('sha256')
        .update(await readFile(path.join(fontsDir, file)))
        .digest('hex');
      if (got !== hash) fontProblems.push(`${file} modifiée`);
    } catch {
      fontProblems.push(`${file} illisible`);
    }
  }
  add(
    'Polices des sous-titres',
    fontProblems.length ? 'fail' : 'ok',
    fontProblems.length ? fontProblems.join(', ') : 'Montserrat ExtraBold, Inter Bold (OFL)',
    false,
  );
  if (cli.render) await integritySelfTest(config);

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

  // Écoute de l'API (étape 7d) : le proxy non masqué de l'éditeur n'est servi qu'à une connexion
  // locale, mais une écoute sur le réseau expose toutes les autres routes.
  add(
    'Adresse d’écoute de l’API',
    isLoopbackHost(config.server.host) ? 'ok' : 'warn',
    isLoopbackHost(config.server.host)
      ? `${config.server.host} (boucle locale)`
      : `${config.server.host} n’est pas une adresse de bouclage : l’API est joignable depuis le réseau. Les médias de l’éditeur restent refusés à toute connexion non locale ; préférez API_HOST=127.0.0.1`,
    false,
  );

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

/**
 * Preuve de suffisance du manifeste d'intégrité avec CE FFmpeg : sur un MKV généré, tous les
 * octets hors de l'ensemble protégé sont mis à zéro, puis la fenêtre est décodée et comparée.
 */
async function integritySelfTest(config: ReturnType<typeof loadConfig>) {
  const { buildIntegrityManifest } = await import('@acs/media');
  const dir = await mkdtemp(path.join(tmpdir(), 'acs-doctor-'));
  try {
    const src = path.join(dir, 'source.mkv');
    const gen = await tryRun(
      config.tools.ffmpeg,
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=f=440:sample_rate=48000',
        '-t',
        '20',
        '-map',
        '0',
        '-map',
        '1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '60',
        '-c:a',
        'aac',
        src,
      ],
      60_000,
    );
    if (!gen.ok) {
      add(
        'Intégrité (preuve de suffisance)',
        'fail',
        'génération de la vidéo de test impossible',
        false,
      );
      return;
    }
    const probe = 150_000;
    const m = await buildIntegrityManifest({
      ffprobePath: config.tools.ffprobe,
      filePath: src,
      windowStartMs: 6_300,
      windowEndMs: 14_000,
      probeBytes: probe,
    });
    const data = await readFile(src);
    const zero = Buffer.alloc(data.length);
    for (const [s, e] of m.ranges) data.copy(zero, s, s, e);
    const zeroed = path.join(dir, 'zero.mkv');
    await writeFile(zeroed, zero);
    const decode = async (f: string) =>
      (
        await tryRun(
          config.tools.ffmpeg,
          [
            '-v',
            'error',
            '-probesize',
            String(probe),
            '-ss',
            '6.300',
            '-i',
            f,
            '-t',
            '7.7',
            '-map',
            '0',
            '-f',
            'framemd5',
            '-',
          ],
          60_000,
        )
      ).out
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .join('\n');
    const same = m.method === 'byte_ranges' && (await decode(src)) === (await decode(zeroed));
    add(
      'Intégrité (preuve de suffisance)',
      same ? 'ok' : 'fail',
      same
        ? `décodage identique avec ${((100 * m.protectedBytes) / data.length).toFixed(0)} % des octets protégés`
        : 'le décodage diffère : la vérification d’intégrité n’est pas fiable avec ce FFmpeg',
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
