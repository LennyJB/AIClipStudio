/**
 * FAUX worker Whisper pour les tests : même protocole que packages/transcription/python/worker.py,
 * sans modèle. Comportement décrit par la variable FAKE_WHISPER_SCENARIO (JSON) :
 * {
 *   "tracks": { "<audioIndex>": [{ "startMs", "endMs", "text", "avgLogprob"?, "noSpeechProb"?, "compressionRatio"? }] },
 *   "language": "fr", "cuda": true,
 *   "jitterMs": 0,                         // décalage pseudo-aléatoire par bloc (±)
 *   "delayMs": 0,                          // durée simulée d'un bloc
 *   "loadFailsOnCuda": "message" | null,   // échec CUDA au chargement (exception)
 *   "crashOnCudaLoad": false,              // le processus s'arrête net au chargement CUDA
 *   "inferenceFailsOnCudaAtRequest": n,    // échec CUDA pendant le bloc n (repli CPU interne)
 *   "crashAtRequest": n, "crashMarker": "fichier"  // arrêt brutal au bloc n (une seule fois)
 *   "logFile": "fichier"                   // journal des commandes reçues (JSON par ligne)
 * }
 * La piste est déduite du nom du WAV dérivé (…-a<N>.wav, N = index + 1).
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = JSON.parse(process.env.FAKE_WHISPER_SCENARIO ?? '{}');
const emit = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = (m) => scenario.logFile && appendFileSync(scenario.logFile, `${JSON.stringify(m)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let opts = null;
let device = 'cpu';
let computeType = 'int8';
let requests = 0;

const resolveCt = (dev, requested) =>
  requested !== 'auto' ? requested : dev === 'cuda' ? 'float16' : 'int8';

function fallback(requestId, error) {
  if (!opts.cpuFallback) {
    emit({ type: 'error', requestId, code: 'GPU_UNAVAILABLE', message: error });
    return false;
  }
  device = 'cpu';
  computeType = resolveCt('cpu', opts.cpuComputeType);
  emit({ type: 'device_fallback', requestId, from: 'cuda', to: 'cpu', computeType, error });
  return true;
}

function init(cmd) {
  opts = cmd;
  const cudaCount = scenario.cuda ? 1 : 0;
  let wanted = cmd.device === 'auto' ? (cudaCount ? 'cuda' : 'cpu') : cmd.device;
  let fb = null;
  if (wanted === 'cuda' && scenario.crashOnCudaLoad) {
    process.stderr.write('Could not load library cudnn_ops64_9.dll. Error code 126\n');
    process.exit(3);
  }
  if (wanted === 'cuda' && (scenario.loadFailsOnCuda || !cudaCount)) {
    const error = `RuntimeError: ${scenario.loadFailsOnCuda ?? 'CUDA failed with error no CUDA-capable device is detected'}`;
    if (!fallback(null, error)) return;
    fb = { from: 'cuda', error };
    wanted = 'cpu';
  }
  device = wanted;
  computeType = resolveCt(device, device === 'cpu' && fb ? cmd.cpuComputeType : cmd.computeType);
  emit({
    type: 'ready',
    engine: 'faster-whisper',
    engineVersion: 'fake-1.0',
    ctranslate2Version: 'fake',
    model: cmd.model,
    device,
    computeType,
    cudaDeviceCount: cudaCount,
    loadMs: 12,
    fallback: fb,
  });
}

async function transcribe(cmd) {
  requests += 1;
  if (
    scenario.crashAtRequest === requests &&
    !(scenario.crashMarker && existsSync(scenario.crashMarker))
  ) {
    if (scenario.crashMarker) writeFileSync(scenario.crashMarker, 'crash');
    process.stderr.write('Segmentation fault (simulé)\n');
    process.exit(139);
  }
  if (device === 'cuda' && scenario.inferenceFailsOnCudaAtRequest === requests) {
    if (!fallback(cmd.requestId, 'RuntimeError: Could not load library cudnn_ops64_9.dll')) return;
  }
  const m = /-a(\d+)\.wav$/.exec(cmd.wavPath);
  const audioIndex = m ? Number(m[1]) - 1 : 0;
  const phrases = scenario.tracks?.[String(audioIndex)] ?? [];
  const j = scenario.jitterMs ?? 0;
  const jitter = j ? ((requests * 37) % (2 * j + 1)) - j : 0;
  if (scenario.delayMs) await sleep(scenario.delayMs);
  const segments = [];
  for (const p of phrases) {
    const a = Math.max(p.startMs, cmd.startMs);
    const b = Math.min(p.endMs, cmd.endMs);
    if (b <= a) continue;
    const truncated = a !== p.startMs || b !== p.endMs;
    const startMs = Math.max(cmd.startMs, a + jitter);
    const endMs = Math.min(cmd.endMs, Math.max(startMs + 1, b + jitter));
    const tokens = (truncated ? `${p.text.split(' ')[0]} (coupé)` : p.text).split(' ');
    const step = (endMs - startMs) / tokens.length;
    segments.push({
      type: 'segment',
      requestId: cmd.requestId,
      startMs,
      endMs,
      text: tokens.join(' '),
      avgLogprob: p.avgLogprob ?? -0.25,
      noSpeechProb: p.noSpeechProb ?? 0.02,
      compressionRatio: p.compressionRatio ?? 1.3,
      words: tokens.map((t, i) => ({
        word: ` ${t}`,
        startMs: Math.round(startMs + i * step),
        endMs: Math.round(startMs + (i + 1) * step),
        probability: 0.9,
      })),
    });
  }
  for (const s of segments) {
    emit({ type: 'progress', requestId: cmd.requestId, processedMs: s.endMs });
    emit(s);
  }
  emit({
    type: 'block_done',
    requestId: cmd.requestId,
    language: cmd.language ?? scenario.language ?? 'fr',
    languageProbability: cmd.language ? 1 : 0.97,
    device,
    computeType,
    elapsedMs: scenario.delayMs || 10,
    audioMs: cmd.endMs - cmd.startMs,
  });
}

let queue = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line);
  log(cmd);
  queue = queue.then(async () => {
    if (cmd.cmd === 'init') init(cmd);
    else if (cmd.cmd === 'transcribe') await transcribe(cmd);
    else if (cmd.cmd === 'shutdown') process.exit(0);
  });
});
