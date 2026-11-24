/**
 * CLI `npm run render` (étape 6a), lancée dans des processus séparés sur une base temporaire.
 * La décision est prise par un AUTRE processus (`npm run review`) : la garde la relit en base.
 * Aucune clé Claude, aucun appel réseau, aucun rendu.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { fingerprintFile, probeMedia } from '../packages/media/src';
import { ROOT_DIR } from '../services/api/src/config';
import { openDatabase } from '../services/api/src/db';
import { createTalkVideo, FFMPEG, FFPROBE, ffmpegAvailable } from './helpers/media-fixtures';

const run = promisify(execFile);
const REC = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const enabled = ffmpegAvailable();

let env: NodeJS.ProcessEnv;

async function cli(script: string, args: string[]) {
  try {
    const r = await run(process.execPath, ['--import', 'tsx', `scripts/${script}.ts`, ...args], {
      cwd: ROOT_DIR,
      env,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

describe.skipIf(!enabled)('CLI npm run render (étape 6a)', () => {
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'acs-render-cli-'));
    const video = createTalkVideo(dir, 60);
    const info = await probeMedia(FFPROBE, video);
    const fp = await fingerprintFile(video);
    const dbPath = path.join(dir, 'db.sqlite');
    const db = openDatabase(dbPath);
    db.prepare(
      `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
         game_id, media_info_json) VALUES (?, ?, 'v.mkv', ?, ?, ?, 'mkv', 'valorant', ?)`,
    ).run(REC, video, fp.sizeBytes, fp.mtimeMs, fp.hash, JSON.stringify(info));
    const tr = db.prepare(
      `INSERT INTO audio_tracks (recording_id, audio_index, stream_index, role, role_source, title)
       VALUES (?, ?, ?, ?, 'title', ?)`,
    );
    tr.run(REC, 0, 1, 'mic', 'Micro');
    tr.run(REC, 1, 2, 'game', 'Jeu');
    db.prepare(
      `INSERT INTO analysis_runs (id, recording_id, mode, status, pipeline_version, pricing_version, input_key,
         transcription_ids_json, config_json, privacy_json, profiles_json, budget_usd, prompt_version)
       VALUES (?, ?, 'claude', 'completed', 2, 'p', 'k', '[]', '{}', '{}', '{}', 5, 'triage-v1+deep-v1')`,
    ).run(RUN, REC);
    db.prepare(
      `INSERT INTO clip_proposals (id, run_id, recording_id, tier, title, explanation, categories_json,
         relevance, reliability, reliability_json, src_start_ms, src_end_ms, setup_segment_id,
         punchline_segment_id, reaction_end_segment_id, punchline_ms, standalone)
       VALUES (?, ?, ?, 'clip', 'Le plan infaillible', 'e', '["humour"]', 80, 70, '{}', 20000, 45000, 1, 2, 3, 35000, 1)`,
    ).run(P1, RUN, REC);
    db.close();
    env = {
      ...process.env,
      NODE_ENV: 'test',
      STORAGE_DIR: path.join(dir, 'storage'),
      DATABASE_PATH: dbPath,
      FFMPEG_PATH: FFMPEG,
      FFPROBE_PATH: FFPROBE,
      ANTHROPIC_API_KEY: '',
      LOG_LEVEL: 'error',
    };
  }, 120_000);

  it('création refusée avant acceptation ; acceptée par un autre processus ; liste ; audio ; accords', async () => {
    const refused = await cli('render', [P1, '--create']);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/PROPOSAL_NOT_ACCEPTED/);

    expect((await cli('review', ['--accept', P1])).code).toBe(0);
    const created = await cli('render', [P1, '--create', '--layout', 'gameplay_crop']);
    expect(created.code, created.err).toBe(0);
    expect(created.out).toMatch(/Projet créé/);
    expect(created.out).toMatch(/révision 2/);
    expect(created.out).toMatch(/disposition gameplay_crop/);
    expect(created.out).toMatch(/audio mic/);
    expect((await cli('render', [P1, '--create'])).out).toMatch(/Projet existant/);
    expect((await cli('render', ['--list', REC])).out).toMatch(
      /« Le plan infaillible ».*révision 2/,
    );

    // Piste jeu : exclue tant que sa composition n'est pas déclarée.
    expect((await cli('render', ['--audio', REC])).out).toMatch(
      /piste 1 \(game\) : NON exportable/,
    );
    const declared = await cli('render', ['--declare-game', REC, '--game-voice-chat', 'present']);
    expect(declared.out).toMatch(/accord requis : chat vocal du jeu/);
    const granted = await cli('render', [
      '--consent',
      REC,
      '--grant',
      'game_voice_chat',
      '--note',
      'test',
    ]);
    expect(granted.out).toMatch(/Export : mic \+ game/);

    // Refus par un autre processus : la création ne renvoie plus qu'un refus, rien n'est modifié.
    expect((await cli('review', ['--reject', P1, '--reason', 'trop_long'])).code).toBe(0);
    const after = await cli('render', [P1, '--create', '--layout', 'blurred_fit']);
    expect(after.code).toBe(1);
    expect(after.err).toMatch(/PROPOSAL_NOT_ACCEPTED/);
  }, 180_000);

  it('erreurs d’usage : code 2', async () => {
    expect((await cli('render', [])).code).toBe(2);
    expect((await cli('render', ['--consent', REC])).code).toBe(2);
    expect((await cli('render', [P1, '--create', '--layout', 'zoom'])).code).toBe(2);
  }, 60_000);
});
