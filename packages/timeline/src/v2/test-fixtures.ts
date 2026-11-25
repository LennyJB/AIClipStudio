/**
 * Documents de test v2 (tests uniquement ; non exporté par le paquet). Construits par le vrai
 * chemin de l'étape 6 (`projectFromProposal`) puis migrés, comme les projets existants.
 */
import type { CaptionWord, RoleWords } from '../captions';
import { projectFromProposal, type CreateProjectInput } from '../project';
import { migrateV1ToV2 } from './migrate';
import type { ClipProjectV2 } from './schema';

export function fixtureWords(from: number, to: number, prefix = 'mot'): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (let t = from, i = 0; t + 300 <= to; t += 400, i++) {
    out.push({ text: ` ${prefix}${i}`, srcStartMs: t, srcEndMs: t + 300 });
  }
  return out;
}

export function fixtureV1Input(over: Partial<CreateProjectInput> = {}): CreateProjectInput {
  const mic: RoleWords = { role: 'mic', words: fixtureWords(90_000, 150_000) };
  const dsc: RoleWords = { role: 'discord', words: fixtureWords(100_000, 140_000, 'coéquipier') };
  return {
    proposal: {
      id: 'p1',
      runId: 'run',
      recordingId: 'rec',
      momentId: 'm1',
      srcStartMs: 110_000,
      srcEndMs: 133_800,
      punchlineMs: 125_000,
      setupStartMs: 110_400,
      reactionEndMs: 133_000,
      editingMode: null,
    },
    source: {
      fingerprint: 'fp',
      durationMs: 600_000,
      width: 1920,
      height: 1080,
      fps: 60,
      container: 'matroska',
      integrityManifestId: 'man',
    },
    framing: {
      id: 'facecam',
      hash: 'h',
      gameplay: { x: 0, y: 0, w: 1, h: 1 },
      facecam: { x: 0.74, y: 0.7, w: 0.25, h: 0.28 },
      masks: [{ label: 'Fil', x: 0.72, y: 0.04, w: 0.27, h: 0.2 }],
    },
    words: [mic, dsc],
    audio: { tracks: [{ audioIndex: 1, role: 'mic' }], captionRoles: ['mic'] },
    defaults: { mode: 'fidele', minMs: 20_000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
    ...over,
  };
}

/** Projet v2 : proposition 110,0–133,8 s, fenêtre ±60 s (nouveau projet). */
export function fixtureV2(
  window = { srcStartMs: 50_000, srcEndMs: 193_800 },
  over: Partial<CreateProjectInput> = {},
): ClipProjectV2 {
  const { project } = projectFromProposal(fixtureV1Input(over));
  return migrateV1ToV2(project, { manifestWindow: window });
}
