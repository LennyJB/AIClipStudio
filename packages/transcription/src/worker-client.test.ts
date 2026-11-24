import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WhisperWorker } from './worker-client';

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined };

/**
 * Worker minimal : répond « ready », puis FERME son entrée standard tout en restant vivant
 * un instant. Toute écriture du client pendant ce temps échoue (EPIPE) avant l'événement
 * « close » du processus : c'est la course observée après une annulation.
 */
function closingWorker(): string {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'acs-worker-')), 'worker.mjs');
  writeFileSync(
    f,
    `import { closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.once('line', () => {
  process.stdout.write(JSON.stringify({ type: 'ready', engine: 'faster-whisper', engineVersion: '0',
    ctranslate2Version: '0', model: 'tiny', device: 'cpu', computeType: 'int8', cudaDeviceCount: 0,
    loadMs: 0, fallback: null }) + '\\n');
  rl.close();
  process.stdin.destroy();
  try { closeSync(0); } catch { /* déjà fermé */ }
  setTimeout(() => process.exit(0), 300);
});
`,
  );
  return f;
}

describe('WhisperWorker', () => {
  it('fermeture d’un worker qui ne lit plus son entrée : aucune erreur EPIPE non interceptée', async () => {
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const w = await WhisperWorker.start({
        command: [process.execPath, closingWorker()],
        init: {
          cmd: 'init',
          model: 'tiny',
          device: 'cpu',
          computeType: 'int8',
          cpuComputeType: 'int8',
          cpuFallback: true,
          modelDir: null,
        } as never,
        log: silent as never,
      });
      await new Promise((r) => setTimeout(r, 50)); // l'entrée du worker est désormais fermée
      await w.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
