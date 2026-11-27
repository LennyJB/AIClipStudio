/**
 * Serveur d'API RÉEL pour les tests Playwright de l'éditeur (étape 7) : stockage temporaire,
 * vidéo synthétique lavfi, transcription simulée, faux modèle (AUCUN appel à Claude), proposition
 * acceptée, micro déclaré, projet de clip créé. Écoute sur 127.0.0.1:E2E_API_PORT ; l'interface
 * est servie par Vite (même configuration que le développement), dont le proxy pointe ici.
 *
 * Écrit l'état utile aux tests (identifiants) dans E2E_STATE.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeModel } from '@acs/editorial';
import { buildApp } from '../../services/api/src/app';
import { loadConfig, ROOT_DIR } from '../../services/api/src/config';
import { openDatabase } from '../../services/api/src/db';
import { SCENARIO_DISCORD, SCENARIO_MIC, scenarioScript } from '../helpers/claude-scenario';
import { FFMPEG, FFPROBE } from '../helpers/media-fixtures';
import { E2E } from './constants';

const FAKE_WORKER = fileURLToPath(new URL('../helpers/fake-whisper-worker.mjs', import.meta.url));

/**
 * Vidéo 320×180, 10 i/s, 180 s : gauche ROUGE, droite BLEUE, zone sensible BLANCHE en haut à
 * droite (E2E.sensitive) ; pistes Micro (440 Hz) et Discord (660 Hz).
 */
function createVideo(dir: string): string {
  const out = path.join(dir, 'e2e.mkv');
  const z = E2E.sensitive;
  execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-y',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x180:r=10:d=180',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=180',
      '-f',
      'lavfi',
      '-i',
      'sine=f=660:d=180',
      '-filter_complex',
      `[0:v]drawbox=x=0:y=0:w=160:h=180:color=red:t=fill,drawbox=x=${z.x}:y=${z.y}:w=${z.w}:h=${z.h}:color=white:t=fill[v]`,
      '-map',
      '[v]',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-metadata:s:a:0',
      'title=Micro',
      '-metadata:s:a:1',
      'title=Discord',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '5',
      '-c:a',
      'aac',
      out,
    ],
    { stdio: 'ignore' },
  );
  return out;
}

async function main() {
  const storage = mkdtempSync(path.join(tmpdir(), 'acs-e2e-'));
  mkdirSync(path.join(storage, 'config'), { recursive: true });
  const privacy = path.join(storage, 'config', 'privacy.json');
  writeFileSync(
    privacy,
    JSON.stringify({ schemaVersion: 1, pseudonyms: [{ names: ['Théo'], label: 'Coéquipier 1' }] }),
  );
  process.env.FAKE_WHISPER_SCENARIO = JSON.stringify({
    language: 'fr',
    tracks: { '0': SCENARIO_MIC, '1': SCENARIO_DISCORD },
  });
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      STORAGE_DIR: storage,
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
      WHISPER_WORKER_COMMAND: JSON.stringify([process.execPath, FAKE_WORKER]),
      ANALYSIS_PRIVACY_FILE: privacy,
      RENDER_X264_PRESET: 'ultrafast',
      // Image exacte à la taille du canvas (540×960) : comparaison au pixel près (parité, 7f).
      RENDER_PREVIEW_HEIGHT: '960',
      API_HOST: '127.0.0.1',
      API_PORT: String(E2E.apiPort),
      EDITOR_ALLOWED_ORIGINS: E2E.origin,
      LOG_LEVEL: 'warn',
    },
    ROOT_DIR,
  );
  const db = openDatabase(path.join(storage, 'base.sqlite'));
  const { app, services } = buildApp({ config, db, model: new FakeModel(scenarioScript) });
  const call = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<T> => {
    const res = await app.inject(
      payload === undefined ? { method, url } : { method, url, payload: payload as object },
    );
    if (res.statusCode >= 400) throw new Error(`${method} ${url} : ${res.statusCode} ${res.body}`);
    return res.json<T>();
  };
  const video = createVideo(storage);
  const rec = (
    await call<{ recording: { id: string } }>('POST', '/api/recordings', { path: video })
  ).recording;
  await call('POST', `/api/recordings/${rec.id}/transcriptions`, {});
  await services.runner.idle();
  await call('POST', `/api/recordings/${rec.id}/analyses`, {
    mode: 'claude',
    acceptBudgetUsd: config.analysis.maxCostUsd,
    review: false,
  });
  await services.runner.idle();
  const list = await call<{ items: { proposal: { id: string; tier: string } }[] }>(
    'GET',
    `/api/recordings/${rec.id}/proposals`,
  );
  const proposal = list.items.find((i) => i.proposal.tier === 'clip')!.proposal;
  await call('POST', `/api/proposals/${proposal.id}/decision`, {
    requestId: randomUUID(),
    decision: 'accepted',
  });
  await call('POST', `/api/recordings/${rec.id}/export-audio`, {
    requestId: randomUUID(),
    kind: 'declaration',
    subject: 'mic_composition',
    payload: { creatorVoice: 'present', otherVoices: 'absent' },
  });
  const project = (
    await call<{ project: { id: string } }>('POST', `/api/proposals/${proposal.id}/clip-project`, {
      requestId: randomUUID(),
    })
  ).project.id;
  // Médias de travail préparés d'avance (proxy, vignettes, pistes) : les tests n'attendent pas.
  await call('POST', `/api/clip-projects/${project}/editor-media`, { sessionId: randomUUID() });
  await services.runner.idle();
  writeFileSync(
    process.env.E2E_STATE ?? E2E.stateFile,
    JSON.stringify({ projectId: project, recordingId: rec.id, proposalId: proposal.id }),
  );
  await app.listen({ host: '127.0.0.1', port: E2E.apiPort });
  console.warn(`API e2e prête sur ${E2E.apiPort} (projet ${project})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
