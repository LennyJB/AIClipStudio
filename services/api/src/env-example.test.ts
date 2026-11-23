import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema, ROOT_DIR } from './config';

describe('.env.example', () => {
  const content = readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf8');
  const documented = new Set(
    content
      .split(/\r?\n/)
      .map((l) => /^([A-Z0-9_]+)=/.exec(l.trim())?.[1])
      .filter((k): k is string => Boolean(k)),
  );

  it('documente chaque variable de configuration', () => {
    const missing = Object.keys(EnvSchema.shape).filter(
      (k) => k !== 'NODE_ENV' && !documented.has(k),
    );
    expect(missing).toEqual([]);
  });

  it('ne contient aucune valeur de clé API', () => {
    expect(content).toMatch(/^ANTHROPIC_API_KEY=\s*$/m);
    expect(content).not.toMatch(/sk-ant-/);
  });
});
