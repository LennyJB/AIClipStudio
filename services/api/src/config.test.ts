import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '@acs/shared';
import { defaultPythonPath, loadConfig } from './config';

const ROOT = path.resolve('/tmp/acs-root');

describe('loadConfig', () => {
  it('applique des valeurs par défaut sûres', () => {
    const c = loadConfig({}, ROOT);
    expect(c.server).toEqual({ host: '127.0.0.1', port: 4000 });
    expect(c.claude.apiKey).toBeUndefined();
    expect(c.claude.model).toBe('claude-opus-5-5');
    expect(c.paths.originals).toBe(path.join(ROOT, 'storage', 'originals'));
    expect(c.paths.database).toBe(path.join(ROOT, 'storage', 'db', 'ai-clip-studio.sqlite'));
    expect(c.tools.python).toBe(defaultPythonPath(ROOT));
  });

  it('analyse : valeurs par défaut conformes aux décisions du créateur (étape 4)', () => {
    const c = loadConfig({}, ROOT);
    expect(c.claude).toMatchObject({ model: 'claude-opus-5-5', triageModel: 'claude-haiku-5-5' });
    expect(c.analysis).toMatchObject({
      effort: 'high',
      maxCostUsd: 5,
      triageScope: 'full',
      contextBeforeMs: 45_000,
      contextAfterMs: 20_000,
      farContextMs: 180_000,
      privacyFile: path.join(ROOT, 'storage', 'config', 'privacy.json'),
      outputDir: path.join(ROOT, 'storage', 'analysis'),
    });
    expect(() => loadConfig({ ANALYSIS_TRIAGE_SCOPE: 'tout' }, ROOT)).toThrow(AppError);
    expect(() => loadConfig({ ANALYSIS_MAX_COST_USD: '0' }, ROOT)).toThrow(AppError);
    expect(() => loadConfig({ CLAUDE_MODEL: 'claude opus; rm' }, ROOT)).toThrow(AppError);
  });

  it('valeurs par défaut de Whisper conformes aux décisions du créateur', () => {
    const w = loadConfig({}, ROOT).whisper;
    expect(w).toMatchObject({
      model: 'large-v3-turbo',
      modelChoices: ['large-v3-turbo', 'large-v3'],
      device: 'auto',
      cpuFallback: true,
      language: 'auto',
      wordTimestamps: true,
      chunking: { coreMs: 1_200_000, overlapMs: 30_000, boundaryToleranceMs: 1_000 },
      workerCommand: null,
    });
  });

  it('options Whisper : booléens, commande du worker, valeurs invalides', () => {
    const w = loadConfig(
      { WHISPER_WORD_TIMESTAMPS: 'false', WHISPER_WORKER_COMMAND: '["node","fake.mjs"]' },
      ROOT,
    ).whisper;
    expect(w.wordTimestamps).toBe(false);
    expect(w.workerCommand).toEqual(['node', 'fake.mjs']);
    expect(() => loadConfig({ WHISPER_WORKER_COMMAND: 'node fake.mjs' }, ROOT)).toThrow(AppError);
    expect(() => loadConfig({ WHISPER_DEVICE: 'tpu' }, ROOT)).toThrow(AppError);
    expect(() => loadConfig({ WHISPER_LANGUAGE: 'français' }, ROOT)).toThrow(AppError);
  });

  it('traite une clé API vide comme absente', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: '  ' }, ROOT).claude.apiKey).toBeUndefined();
  });

  it('convertit et valide le port', () => {
    expect(loadConfig({ API_PORT: '5000' }, ROOT).server.port).toBe(5000);
  });

  it('rejette une configuration invalide sans divulguer les valeurs', () => {
    try {
      loadConfig({ API_PORT: 'abc', WHISPER_DEVICE: 'tpu', ANTHROPIC_API_KEY: 'sk-secret' }, ROOT);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe('CONFIG_INVALID');
      const vars = (e.details as { variable: string }[]).map((d) => d.variable).sort();
      expect(vars).toEqual(['API_PORT', 'WHISPER_DEVICE']);
      expect(JSON.stringify(e.details)).not.toContain('sk-secret');
    }
  });

  it('choisit le bon chemin Python selon la plateforme', () => {
    expect(defaultPythonPath(ROOT, 'win32')).toBe(
      path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    );
    expect(defaultPythonPath(ROOT, 'linux')).toBe(path.join(ROOT, '.venv', 'bin', 'python'));
  });
});
