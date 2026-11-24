/**
 * Test de démarrage réel de l'API : lance le serveur (comme en production, via tsx),
 * avec un stockage temporaire, attend /api/health puis l'arrête proprement.
 * Détecte les erreurs que la vérification de types ne voit pas (chargement des
 * modules, migrations sur une base neuve, configuration).
 *
 *   npm run smoke
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.SMOKE_PORT ?? 4999);
const storage = mkdtempSync(path.join(tmpdir(), 'acs-smoke-'));
const TIMEOUT_MS = 60_000;

const child = spawn(process.execPath, ['--import', 'tsx', 'services/api/src/server.ts'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    API_PORT: String(PORT),
    API_HOST: '127.0.0.1',
    STORAGE_DIR: storage,
    DATABASE_PATH: path.join(storage, 'db', 'smoke.sqlite'),
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let exited = false;
child.on('exit', (code) => {
  exited = true;
  if (code !== 0 && code !== null) console.error(`Le serveur s'est arrêté (code ${code})`);
});

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string; database?: string };
        if (body.status !== 'ok' || body.database !== 'ok')
          throw new Error(`Réponse inattendue : ${JSON.stringify(body)}`);
        const storageRes = await fetch(`http://127.0.0.1:${PORT}/api/storage`);
        if (!storageRes.ok) throw new Error(`/api/storage a répondu ${storageRes.status}`);
        // Analyse : configuration et profils de cadrage lisibles (aucun appel à Claude ici).
        const an = (await (await fetch(`http://127.0.0.1:${PORT}/api/analysis/config`)).json()) as {
          mode?: string;
        };
        if (an.mode !== 'dry_run_and_claude')
          throw new Error(`Réponse inattendue : /api/analysis/config ${JSON.stringify(an)}`);
        const fr = await fetch(`http://127.0.0.1:${PORT}/api/framing-profiles`);
        if (!fr.ok) throw new Error(`/api/framing-profiles a répondu ${fr.status}`);
        console.log(`Démarrage OK : ${JSON.stringify(body)}`);
        return 0;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Réponse')) throw err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(
    exited
      ? 'Le serveur s’est arrêté avant de répondre'
      : 'Délai dépassé : /api/health ne répond pas',
  );
  return 1;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!exited) child.kill();
  });
