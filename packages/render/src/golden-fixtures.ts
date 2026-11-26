/**
 * Projets de référence de l'étape 6 (tests uniquement) : variété de dispositions, masques,
 * sous-titres, effets et audio. Leurs empreintes de plan ont été CAPTURÉES avec le moteur de
 * l'étape 6b (main avant la PR 7c) : le moteur multi-segments doit les reproduire exactement
 * (docs/plan-etape-7.md §8.2, PR 7c : « projet de la 6b rendu à l'identique »).
 */
import {
  applyRenderOptions,
  displayCaptions,
  projectFromProposal,
  projectSegments,
  type ClipProject,
  type CreateProjectInput,
} from '@acs/timeline';
import { allowedAudio, EMPTY_AUDIO_STATE, type ExportAudioState, type TrackIn } from './audio';
import type { RenderKind } from './presets';

const words = (from: number, to: number, prefix: string) => {
  const out = [];
  for (let t = from, i = 0; t + 300 <= to; t += 400, i++)
    out.push({ text: `${prefix}${i}`, srcStartMs: t, srcEndMs: t + 300 });
  return out;
};

function input(): CreateProjectInput {
  return {
    proposal: {
      id: 'p1',
      runId: 'run',
      recordingId: 'rec',
      momentId: 'm1',
      srcStartMs: 110_000,
      srcEndMs: 140_000,
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
      id: 'f',
      hash: 'h',
      gameplay: { x: 0, y: 0, w: 1, h: 1 },
      facecam: { x: 0.74, y: 0.7, w: 0.25, h: 0.28 },
      masks: [{ label: 'Fil', x: 0.72, y: 0.04, w: 0.27, h: 0.2 }],
    },
    words: [
      { role: 'mic', words: words(100_000, 150_000, 'mot') },
      { role: 'discord', words: words(100_000, 150_000, 'dsc') },
    ],
    audio: {
      tracks: [{ audioIndex: 1, role: 'mic' }],
      captionRoles: ['mic'],
    },
    defaults: { mode: 'fidele', minMs: 20_000, maxMs: 80_000 },
    makeId: (k, i) => `${k}-${i}`,
  };
}

export const GOLDEN_TRACKS: TrackIn[] = [
  { audioIndex: 0, role: 'mix' },
  { audioIndex: 1, role: 'mic' },
  { audioIndex: 2, role: 'discord' },
];

const MIC: ExportAudioState = {
  ...EMPTY_AUDIO_STATE,
  micComposition: { creatorVoice: 'present', otherVoices: 'absent' },
};
const MIC_DISCORD: ExportAudioState = {
  ...MIC,
  consents: { discord_voices: true, game_voice_chat: false, other_voices: false },
};
const MIX: ExportAudioState = {
  ...EMPTY_AUDIO_STATE,
  mixComposition: { discord: 'absent', gameVoiceChat: 'absent', otherVoices: 'absent' },
};

const ctx = (rev: number, tracks = [{ audioIndex: 1, role: 'mic' as const }]) => ({
  nextRevision: rev,
  now: '2026-11-25T10:00:00.000Z',
  words: [],
  allowedCaptionRoles: ['mic' as const, 'discord' as const],
  allowedAudioTracks: tracks,
});

export interface GoldenCase {
  name: string;
  project: ClipProject;
  revision: number;
  kind: RenderKind;
  state: ExportAudioState;
  /** Sources de sous-titres affichées (identiques à celles du document). */
  roles: ClipProject['captions']['sources'];
}

/** Effets de la chute (identiques à ceux que propose `suggestEffects` en mode enrichi). */
const punch: ClipProject['effects'] = [
  {
    id: 'auto-caption_emphasis',
    type: 'caption_emphasis',
    params: {},
    timing: { anchor: 'source', srcStartMs: 125_000, srcEndMs: 125_001 },
    enabled: true,
    origin: 'auto',
    reason: 'test',
    signals: {},
  },
  {
    id: 'auto-punch_zoom',
    type: 'punch_zoom',
    params: { factor: 1.12 },
    timing: { anchor: 'source', srcStartMs: 124_800, srcEndMs: 126_300 },
    enabled: true,
    origin: 'auto',
    reason: 'test',
    signals: {},
  },
];

export function goldenCases(): GoldenCase[] {
  const base = projectFromProposal(input()).project;
  const opt = (p: ClipProject, patch: Parameters<typeof applyRenderOptions>[1], rev = 2) =>
    applyRenderOptions(p, patch, ctx(rev)).project;
  const item = base.captions.items.find((i) => i.speakerRole === 'mic' && i.srcStartMs >= 110_000)!;
  const enrichi = { ...opt(base, { mode: 'enrichi' }), effects: punch };
  const cases: GoldenCase[] = [
    {
      name: 'défaut, final',
      project: base,
      revision: 1,
      kind: 'final',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'défaut, aperçu',
      project: base,
      revision: 1,
      kind: 'preview',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'fond flouté',
      project: opt(base, { layout: { preset: 'blurred_fit' } }),
      revision: 2,
      kind: 'final',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'recadrage gameplay, focus 0,2',
      project: opt(base, { layout: { preset: 'gameplay_crop', focusX: 0.2 } }),
      revision: 2,
      kind: 'preview',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'masque désactivé',
      project: opt(base, {
        masks: { modes: [{ index: 0, mode: 'off' }], acknowledgeMaskRisk: true },
      }),
      revision: 2,
      kind: 'final',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'sans sous-titres, sans normalisation',
      project: opt(base, { captions: { enabled: false }, audio: { loudnorm: false } }),
      revision: 2,
      kind: 'final',
      state: MIC,
      roles: [],
    },
    {
      name: 'texte corrigé, style',
      project: opt(base, {
        corrections: [{ itemId: item.id, text: 'Texte corrigé' }],
        captions: { style: { karaoke: false, uppercase: false, position: 'top' } },
      }),
      revision: 2,
      kind: 'final',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'enrichi : chute mise en évidence et zoom',
      project: enrichi,
      revision: 2,
      kind: 'final',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'facecam en haut, zoom sur la facecam',
      project: {
        ...opt(base, { mode: 'enrichi', layout: { preset: 'facecam_top', facecamShare: 0.4 } }),
        effects: [
          {
            id: 'auto-reaction_hold',
            type: 'reaction_hold',
            params: { factor: 1.08 },
            timing: { anchor: 'source', srcStartMs: 126_000, srcEndMs: 128_000 },
            enabled: true,
            origin: 'auto',
            reason: 'test',
            signals: {},
          },
        ],
      },
      revision: 2,
      kind: 'final',
      state: MIC,
      roles: ['mic'],
    },
    {
      name: 'micro et Discord, gains, sous-titres des deux',
      project: applyRenderOptions(
        base,
        {
          audio: {
            tracks: [
              { audioIndex: 1, gainDb: -3 },
              { audioIndex: 2, gainDb: 2 },
            ],
          },
          captions: { sources: ['mic', 'discord'] },
        },
        ctx(2, [
          { audioIndex: 1, role: 'mic' },
          { audioIndex: 2, role: 'discord' as never },
        ]),
      ).project,
      revision: 2,
      kind: 'final',
      state: MIC_DISCORD,
      roles: ['mic', 'discord'],
    },
    {
      name: 'export muet explicite',
      project: opt(
        opt(base, { audio: { tracks: [{ audioIndex: 1, enabled: false }] } }),
        {
          audio: { silent: true },
        },
        3,
      ),
      revision: 3,
      kind: 'preview',
      state: MIC,
      roles: ['mic'],
    },
  ];
  // Piste unique « Tout » (enregistrement à piste unique, étape 8 hors périmètre).
  const single = projectFromProposal({
    ...input(),
    words: [{ role: 'mix', words: words(100_000, 150_000, 'tout') }],
    audio: { tracks: [{ audioIndex: 0, role: 'mix' }], captionRoles: ['mix'] },
  }).project;
  cases.push({
    name: 'piste unique « Tout »',
    project: single,
    revision: 1,
    kind: 'final',
    state: MIX,
    roles: single.captions.sources,
  });
  return cases;
}

export const goldenAudio = (c: GoldenCase) => allowedAudio(GOLDEN_TRACKS, c.state);

export const goldenCaptions = (c: GoldenCase) =>
  displayCaptions(
    projectSegments(c.project),
    c.project.captions.items,
    c.project.captions.corrections,
    {
      roles: c.roles,
      pseudonymize: (t) => ({ text: t, replacements: 0 }),
    },
  );
