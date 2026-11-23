/**
 * Bout en bout Node ↔ VRAI worker Python (Faster-Whisper, modèle tiny, CPU).
 * Exécuté uniquement avec ACS_WHISPER_REAL=1 (job « Worker Python » de la CI) :
 * nécessite Python + faster-whisper, le téléchargement du modèle et FFmpeg avec flite.
 * Ce test ne valide PAS le GPU.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WhisperWorker, WORKER_SCRIPT } from './index';

const REAL = process.env.ACS_WHISPER_REAL === '1';
const PYTHON = process.env.ACS_PYTHON ?? 'python3';

describe.skipIf(!REAL)('worker Python réel (tiny, CPU)', () => {
  it('protocole validé, langue détectée, temps source corrects', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acs-real-'));
    const wav = path.join(dir, 'speech-a2.wav');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      "flite=text='hello world, this is a test of the transcription system':voice=slt",
      '-af',
      'adelay=3000|3000,apad=pad_dur=2,aresample=16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wav,
    ]);
    const logs: string[] = [];
    const log = { info() {}, warn: (_: object, m: string) => logs.push(m), error() {}, debug() {} };
    const worker = await WhisperWorker.start({
      command: [PYTHON, '-u', WORKER_SCRIPT],
      log,
      init: {
        cmd: 'init',
        model: 'tiny',
        device: 'auto',
        computeType: 'auto',
        cpuFallback: true,
        cpuComputeType: 'int8',
        downloadRoot: process.env.ACS_WHISPER_MODEL_DIR ?? null,
        beamSize: 1,
        batchSize: 0,
        wordTimestamps: true,
        hotwords: null,
        vad: {
          enabled: true,
          threshold: 0.5,
          minSilenceDurationMs: 500,
          minSpeechDurationMs: 250,
          speechPadMs: 200,
        },
      },
    });
    try {
      // Le runner CI n'a pas de GPU : auto doit choisir le CPU, sans prétendre le contraire.
      expect(worker.ready).toMatchObject({
        engine: 'faster-whisper',
        device: 'cpu',
        computeType: 'int8',
        fallback: null,
      });
      const progress: number[] = [];
      const r = await worker.transcribe(
        { wavPath: wav, startMs: 1_000, endMs: 20_000, language: null },
        { onProgress: (ms) => progress.push(ms) },
      );
      expect(r.language).toBe('en');
      expect(r.device).toBe('cpu');
      expect(r.segments.length).toBeGreaterThan(0);
      const text = r.segments
        .map((s) => s.text)
        .join(' ')
        .toLowerCase();
      expect(text).toMatch(/test|hello/);
      // Parole à 3 s dans le fichier ; lue à partir de 1 s : temps SOURCE autour de 3 s.
      expect(r.segments[0]!.startMs).toBeGreaterThanOrEqual(2_000);
      expect(r.segments[0]!.startMs).toBeLessThanOrEqual(4_000);
      for (const s of r.segments) {
        expect(s.startMs).toBeGreaterThanOrEqual(1_000);
        expect(s.endMs).toBeLessThanOrEqual(20_000);
        for (const w of s.words) expect(w.probability).toBeGreaterThanOrEqual(0);
      }
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      await worker.close();
    }
  }, 300_000);
});
