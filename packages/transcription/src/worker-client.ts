import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AppError } from '@acs/shared';
import type { RawSegment } from './chunking';
import {
  WorkerMessage,
  type Device,
  type FallbackMessage,
  type InitCommand,
  type ReadyMessage,
  type TranscribeCommand,
} from './protocol';

export interface WorkerLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
  debug: (obj: object, msg: string) => void;
}

export interface BlockResult {
  segments: RawSegment[];
  language: string | null;
  languageProbability: number | null;
  device: Device;
  computeType: string;
  elapsedMs: number;
  audioMs: number;
  /** Bascules GPU → CPU survenues pendant ce bloc. */
  fallbacks: FallbackMessage[];
}

interface Pending {
  requestId: number;
  segments: RawSegment[];
  fallbacks: FallbackMessage[];
  onProgress?: ((processedMs: number) => void) | undefined;
  resolve: (r: BlockResult) => void;
  reject: (e: Error) => void;
}

const STDERR_TAIL = 8 * 1024;

/**
 * Pilote un worker Python faster-whisper : le modèle est chargé une seule fois,
 * puis les blocs sont transcrits un par un. Lancé sans shell.
 */
export class WhisperWorker {
  private child: ChildProcessWithoutNullStreams;
  private pending: Pending | null = null;
  private readyWaiter: { resolve: (m: ReadyMessage) => void; reject: (e: Error) => void } | null =
    null;
  private stderrTail = '';
  private exited = false;
  private nextId = 1;
  ready: ReadyMessage | null = null;
  /** Bascules survenues au chargement (avant tout bloc). */
  readonly initFallbacks: FallbackMessage[] = [];

  private constructor(
    command: readonly string[],
    private readonly log: WorkerLogger,
    env: NodeJS.ProcessEnv,
  ) {
    const [exe, ...args] = command;
    if (!exe) throw new AppError('CONFIG_INVALID', 'Commande du worker de transcription vide');
    this.child = spawn(exe, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
      for (const line of chunk.split(/\r?\n/).filter(Boolean))
        this.log.debug({ worker: line }, 'worker');
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('close', (code) => {
      this.exited = true;
      this.failAll(
        new AppError(
          'TRANSCRIPTION_WORKER_CRASHED',
          `Le worker de transcription s'est arrêté (code ${code})`,
          {
            details: { stderr: this.stderrTail.slice(-2000) },
          },
        ),
      );
    });
  }

  /** Démarre le worker et charge le modèle. */
  static async start(opts: {
    command: readonly string[];
    init: InitCommand;
    log: WorkerLogger;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }): Promise<WhisperWorker> {
    const w = new WhisperWorker(opts.command, opts.log, opts.env ?? process.env);
    const onAbort = () => w.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const ready = await new Promise<ReadyMessage>((resolve, reject) => {
        w.readyWaiter = { resolve, reject };
        w.send(opts.init);
      });
      w.ready = ready;
      return w;
    } catch (err) {
      w.kill();
      if (opts.signal?.aborted) throw new AppError('CANCELLED', 'Transcription annulée');
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Transcrit [startMs, endMs[ du WAV. Les temps renvoyés sont en temps source. */
  transcribe(
    req: Omit<TranscribeCommand, 'cmd' | 'requestId'>,
    opts: { onProgress?: (processedMs: number) => void; signal?: AbortSignal } = {},
  ): Promise<BlockResult> {
    if (this.pending) throw new Error('Un bloc est déjà en cours');
    if (this.exited) throw new AppError('TRANSCRIPTION_WORKER_CRASHED', 'Worker arrêté');
    const requestId = this.nextId++;
    return new Promise<BlockResult>((resolve, reject) => {
      const onAbort = () => {
        this.kill();
        reject(new AppError('CANCELLED', 'Transcription annulée'));
      };
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const done =
        <T>(fn: (v: T) => void) =>
        (v: T) => {
          opts.signal?.removeEventListener('abort', onAbort);
          this.pending = null;
          fn(v);
        };
      this.pending = {
        requestId,
        segments: [],
        fallbacks: [],
        onProgress: opts.onProgress,
        resolve: done(resolve),
        reject: done(reject),
      };
      this.send({ cmd: 'transcribe', requestId, ...req } satisfies TranscribeCommand);
    });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const closed = new Promise<void>((r) => this.child.once('close', () => r()));
    try {
      this.send({ cmd: 'shutdown' });
    } catch {
      /* déjà fermé */
    }
    const timer = setTimeout(() => this.kill(), 5000);
    await closed;
    clearTimeout(timer);
  }

  kill() {
    if (!this.exited) this.child.kill();
  }

  private send(obj: object) {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private failAll(err: Error) {
    this.readyWaiter?.reject(err);
    this.readyWaiter = null;
    this.pending?.reject(err);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: WorkerMessage;
    try {
      msg = WorkerMessage.parse(JSON.parse(line));
    } catch (cause) {
      this.failAll(
        new AppError('TRANSCRIPTION_PROTOCOL', 'Message invalide du worker de transcription', {
          cause,
          details: { line: line.slice(0, 500) },
        }),
      );
      this.kill();
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.readyWaiter?.resolve(msg);
        this.readyWaiter = null;
        return;
      case 'device_fallback':
        // Erreur CUDA détaillée : toujours journalisée.
        this.log.warn(
          { from: msg.from, to: msg.to, computeType: msg.computeType, cudaError: msg.error },
          'Échec CUDA : bascule sur CPU',
        );
        if (this.pending && msg.requestId === this.pending.requestId)
          this.pending.fallbacks.push(msg);
        else this.initFallbacks.push(msg);
        return;
      case 'error': {
        const err = new AppError(
          msg.code === 'GPU_UNAVAILABLE' ? 'TRANSCRIPTION_GPU_UNAVAILABLE' : 'TRANSCRIPTION_FAILED',
          msg.message,
          { details: { workerCode: msg.code } },
        );
        if (this.readyWaiter) {
          this.readyWaiter.reject(err);
          this.readyWaiter = null;
        } else this.pending?.reject(err);
        return;
      }
      default:
        break;
    }
    const p = this.pending;
    if (!p || msg.requestId !== p.requestId) return;
    if (msg.type === 'progress') p.onProgress?.(msg.processedMs);
    else if (msg.type === 'segment') {
      p.segments.push({
        startMs: msg.startMs,
        endMs: msg.endMs,
        text: msg.text,
        avgLogprob: msg.avgLogprob,
        noSpeechProb: msg.noSpeechProb,
        compressionRatio: msg.compressionRatio,
        words: msg.words,
      });
    } else if (msg.type === 'block_done') {
      p.resolve({
        segments: p.segments,
        language: msg.language,
        languageProbability: msg.languageProbability,
        device: msg.device,
        computeType: msg.computeType,
        elapsedMs: msg.elapsedMs,
        audioMs: msg.audioMs,
        fallbacks: p.fallbacks,
      });
    }
  }
}
