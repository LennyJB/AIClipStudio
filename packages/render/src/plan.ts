/**
 * Plan de rendu (docs/plan-etape-6.md §4) : représentation intermédiaire PURE et sérialisable,
 * construite uniquement à partir du document `ClipProject`. Elle revérifie, quel que soit le
 * contenu du document :
 *  - la durée (bornes absolues, confirmation hors plage liée à la révision) ;
 *  - l'audio exporté et les sous-titres (règle `allowedAudio`, jamais contournée) ;
 *  - la disposition (facecam disponible) et la structure (un seul segment à l'étape 6).
 * Le temps montage n'est obtenu que via les segments (`@acs/timeline`).
 */
import { describeMissing, type AudioDecision } from './audio';
import { buildVideoGraph, type ZoomWindow } from './layout';
import {
  outputFps,
  presetFor,
  RENDER_ENGINE_VERSION,
  type PresetConfig,
  type RenderKind,
  type RenderPreset,
} from './presets';
import { activeEffects, EFFECT_PARAMS } from './effects';
import { buildAss, buildSrt, type SubtitleLine } from './subtitles';
import {
  durationAccepted,
  projectDurationMs,
  projectSegments,
  resolveTiming,
  sourceToEdit,
  type CaptionRole,
  type ClipProject,
  type Segment,
  type SourceMs,
} from '@acs/timeline';

/** Sous-titre affiché (voir `displayCaptions` de @acs/timeline). */
export interface DisplayCaptionLike {
  itemId: string;
  speakerRole: CaptionRole;
  text: string;
  corrected: boolean;
  replacements: number;
  editRanges: { editStartMs: number; editEndMs: number }[];
}

interface PlannedEffect {
  id: string;
  type: string;
  startS: number;
  endS: number;
  factor: number;
}

/** Effets actifs résolus en temps montage (première occurrence). */
function activeEffectsForPlan(p: ClipProject, segments: readonly Segment[]): PlannedEffect[] {
  const out: PlannedEffect[] = [];
  for (const e of activeEffects(p)) {
    const r = resolveTiming(segments, e.timing as never, 'first').ranges[0];
    if (!r) continue;
    const defaults =
      e.type in EFFECT_PARAMS ? EFFECT_PARAMS[e.type as keyof typeof EFFECT_PARAMS].factor : 1;
    const factor = Math.min(1.3, Math.max(1, e.params.factor ?? defaults));
    out.push({
      id: e.id,
      type: e.type,
      startS: r.editStartMs / 1000,
      endS: r.editEndMs / 1000,
      factor,
    });
  }
  return out;
}

export type RenderPlanErrorCode =
  'VALIDATION_FAILED' | 'EXPORT_CONSENT_REQUIRED' | 'DURATION_OUT_OF_RANGE' | 'MEDIA_UNSUPPORTED';

export class RenderPlanError extends Error {
  constructor(
    readonly code: RenderPlanErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RenderPlanError';
  }
}

export interface RenderPlanInput {
  project: ClipProject;
  revision: number;
  kind: RenderKind;
  presetConfig?: PresetConfig;
  source: { width: number | null; height: number | null; fps: number | null };
  /** Décision d'audio exporté AU MOMENT du rendu (pistes réelles × accords et déclarations). */
  audio: AudioDecision;
  /** Sous-titres affichés (corrigés, pseudonymisés), calculés pour les sources du document. */
  captions: readonly DisplayCaptionLike[];
  probeBytes: number;
}

export interface RenderPlan {
  engineVersion: number;
  kind: RenderKind;
  preset: RenderPreset;
  fps: number;
  srcStartMs: number;
  durationMs: number;
  probeBytes: number;
  filterComplex: string;
  /** Graphe pour une image fixe (sans sous-titres ni zoom). */
  frameGraph: string;
  hasAudio: boolean;
  audio: {
    tracks: { audioIndex: number; role: string; gainDb: number }[];
    loudnorm: boolean;
    silent: boolean;
  };
  ass: string | null;
  srt: string | null;
  effects: { id: string; type: string; startS: number; endS: number }[];
  captionLines: number;
}

const MIX_LIKE = new Set(['mix', 'unknown']);

function audioGraph(tracks: RenderPlan['audio']['tracks'], loudnorm: boolean): string {
  const parts = tracks.map(
    (t, k) =>
      `[0:a:${t.audioIndex}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${Number(t.gainDb.toFixed(2))}dB[a${k}]`,
  );
  const mixed = tracks.length > 1;
  if (mixed) {
    parts.push(
      `${tracks.map((_, k) => `[a${k}]`).join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0[amix]`,
    );
  }
  const last = mixed ? '[amix]' : '[a0]';
  const tail = loudnorm ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000' : 'anull';
  parts.push(`${last}${tail}[a]`);
  return parts.join(';');
}

export function buildRenderPlan(i: RenderPlanInput): RenderPlan {
  const p = i.project;
  const preset = presetFor(i.kind, i.presetConfig);

  // Durée : bornes absolues et confirmation liée à CETTE révision.
  if (!durationAccepted(p, i.revision)) {
    throw new RenderPlanError(
      'DURATION_OUT_OF_RANGE',
      'Durée hors plage : confirmez-la explicitement pour cette révision (ou ajustez les bornes)',
      {
        durationMs: projectDurationMs(p),
        minMs: p.durationPolicy.minMs,
        maxMs: p.durationPolicy.maxMs,
      },
    );
  }
  const segments = projectSegments(p);
  const seg = segments[0];
  if (segments.length !== 1 || !seg || seg.kind !== 'source' || seg.speed !== 1) {
    throw new RenderPlanError(
      'VALIDATION_FAILED',
      'Le moteur de l’étape 6 rend un seul segment à vitesse normale (montage complet : étape 7)',
    );
  }
  if (!i.source.width || !i.source.height) {
    throw new RenderPlanError(
      'MEDIA_UNSUPPORTED',
      'Aucun flux vidéo exploitable dans l’enregistrement',
    );
  }
  if (p.layout.preset === 'facecam_top' && !p.layout.facecamRect) {
    throw new RenderPlanError(
      'VALIDATION_FAILED',
      'Disposition facecam sans facecam dans le cadrage',
    );
  }

  // Audio : uniquement des pistes que la règle autorise AUJOURD'HUI.
  const allowed = new Map(i.audio.selected.map((t) => [t.audioIndex, t]));
  const enabled = p.audio.tracks.filter((t) => t.enabled);
  const refused = enabled.filter((t) => !allowed.has(t.audioIndex));
  if (!p.audio.silent && refused.length) {
    throw new RenderPlanError(
      'EXPORT_CONSENT_REQUIRED',
      `Piste(s) non autorisée(s) à l’export : ${refused.map((t) => `${t.audioIndex} (${t.role})`).join(', ')}. ${describeMissing(
        i.audio.tracks
          .filter((v) => refused.some((r) => r.audioIndex === v.audioIndex))
          .flatMap((v) => v.missing),
      )}`.trim(),
      { tracks: refused.map((t) => t.audioIndex) },
    );
  }
  if (!p.audio.silent && !enabled.length) {
    throw new RenderPlanError(
      'EXPORT_CONSENT_REQUIRED',
      `Aucune piste audio active. ${i.audio.missing.length ? describeMissing(i.audio.missing) : 'Activez une piste autorisée ou choisissez explicitement un export sans son.'}`,
      { missing: i.audio.missing },
    );
  }
  const tracks = p.audio.silent
    ? []
    : enabled.map((t) => ({ audioIndex: t.audioIndex, role: t.role, gainDb: t.gainDb }));
  if (tracks.some((t) => MIX_LIKE.has(t.role)) && tracks.some((t) => !MIX_LIKE.has(t.role))) {
    throw new RenderPlanError(
      'VALIDATION_FAILED',
      'La piste « tout » ne peut pas être superposée à des pistes séparées (voix doublées)',
    );
  }

  // Sous-titres : mêmes règles que l'audio.
  const roles = p.captions.enabled ? p.captions.sources : [];
  const refusedRoles = roles.filter((r) => !i.audio.captionRoles.includes(r));
  if (refusedRoles.length) {
    throw new RenderPlanError(
      'EXPORT_CONSENT_REQUIRED',
      `Sous-titres non autorisés à l’export : ${refusedRoles.join(', ')}. Retirez-les ou donnez les accords nécessaires.`,
      { roles: refusedRoles },
    );
  }

  const durationMs = seg.srcEndMs - seg.srcStartMs;
  const effects = activeEffectsForPlan(p, segments);
  const items = new Map(p.captions.items.map((it) => [it.id, it]));
  const punch = p.anchors.punchlineMs;
  const emphasis =
    effects.some((e) => e.type === 'caption_emphasis') && p.captions.style.emphasizePunchline;
  const lines: SubtitleLine[] = [];
  for (const c of i.captions) {
    if (!roles.includes(c.speakerRole)) continue;
    const item = items.get(c.itemId);
    if (!item) continue;
    const exact = !c.corrected && c.replacements === 0 && c.editRanges.length === 1;
    for (const r of c.editRanges) {
      const words = exact
        ? item.words
            .map((w) => {
              const pos = sourceToEdit(segments, w.srcStartMs as SourceMs)[0];
              if (!pos) return null;
              const startMs = Math.max(r.editStartMs, pos.editMs);
              const endMs = Math.min(r.editEndMs, startMs + (w.srcEndMs - w.srcStartMs));
              return { text: w.text, startMs, endMs: Math.max(endMs, startMs + 10) };
            })
            .filter((w): w is { text: string; startMs: number; endMs: number } => w !== null)
        : null;
      lines.push({
        startMs: r.editStartMs,
        endMs: Math.min(r.editEndMs, durationMs),
        text: c.text,
        words: words && words.length === item.words.length ? words : null,
        emphasize: emphasis && item.srcStartMs <= punch && punch < item.srcEndMs,
      });
    }
  }
  const hasSubs = lines.length > 0;
  const fps = outputFps(i.source.fps);
  const toWindows = (type: string): ZoomWindow[] =>
    effects
      .filter((e) => e.type === type)
      .map((e) => ({ startS: e.startS, endS: e.endS, factor: e.factor }));
  const graphInput = {
    srcWidth: i.source.width,
    srcHeight: i.source.height,
    outWidth: preset.width,
    outHeight: preset.height,
    fps,
    layout: p.layout,
    zooms: toWindows('punch_zoom'),
    facecamZooms: p.layout.preset === 'facecam_top' ? toWindows('reaction_hold') : [],
    subtitlesFile: hasSubs ? 'subs.ass' : null,
    fontsDir: 'fonts',
  };
  const video = buildVideoGraph(graphInput);
  const frameGraph = buildVideoGraph({
    ...graphInput,
    zooms: [],
    facecamZooms: [],
    subtitlesFile: null,
  });
  const audio = tracks.length ? audioGraph(tracks, p.audio.loudnorm.enabled) : null;

  return {
    engineVersion: RENDER_ENGINE_VERSION,
    kind: i.kind,
    preset,
    fps,
    srcStartMs: seg.srcStartMs,
    durationMs,
    probeBytes: i.probeBytes,
    filterComplex: audio ? `${video};${audio}` : video,
    frameGraph,
    hasAudio: tracks.length > 0,
    audio: {
      tracks,
      loudnorm: p.audio.loudnorm.enabled && tracks.length > 0,
      silent: p.audio.silent,
    },
    ass: hasSubs ? buildAss(lines, p.captions.style) : null,
    srt: hasSubs ? buildSrt(lines, p.captions.style) : null,
    effects: effects.map((e) => ({ id: e.id, type: e.type, startS: e.startS, endS: e.endS })),
    captionLines: lines.length,
  };
}
