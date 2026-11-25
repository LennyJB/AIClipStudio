import { spawn } from 'node:child_process';

export interface RunOptions {
  signal?: AbortSignal;
  /** Appelé pour chaque ligne complète de stdout (ex. progression FFmpeg). */
  onStdoutLine?: (line: string) => void;
  /** Conserver stdout en mémoire (désactiver pour les sorties volumineuses). */
  captureStdout?: boolean;
  /** Répertoire de travail du processus (ex. noms relatifs dans un graphe de filtres FFmpeg). */
  cwd?: string;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  /** Fin de stderr uniquement (limite mémoire). */
  stderrTail: string;
  aborted: boolean;
}

const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * Lance un exécutable SANS shell, avec des arguments sous forme de tableau.
 * Aucune interpolation de chaîne : impossible d'injecter une commande.
 */
export function runProcess(command: string, args: readonly string[], opts: RunOptions = {}) {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderrTail: '', aborted: true });
      return;
    }
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    let stdout = '';
    let pending = '';
    let stderr = '';
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (opts.captureStdout !== false) stdout += chunk;
      if (opts.onStdoutLine) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) opts.onStdoutLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (exitCode) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending);
      resolve({ exitCode, stdout, stderrTail: stderr.trim(), aborted });
    });
  });
}

export function isSpawnNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
