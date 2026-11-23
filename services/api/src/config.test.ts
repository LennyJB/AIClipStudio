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
