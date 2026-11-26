/**
 * Plan de rendu (docs/plan-etape-6.md §4, docs/plan-etape-7.md §5.4) : représentation
 * intermédiaire PURE et sérialisable, construite uniquement à partir du document. Elle
 * revérifie, quel que soit le contenu du document :
 *  - la durée (bornes absolues, confirmation hors plage liée à la version) ;
 *  - l'audio exporté et les sous-titres (règle `allowedAudio`, jamais contournée) ;
 *  - la disposition (facecam disponible) ;
 *  - les fonctions de l'éditeur pas encore rendues : refus EXPLICITE, jamais ignorées (une zone
 *    masquée, un calque ou un réglage omis serait un défaut silencieux).
 *
 * Montage (étape 7, PR 7c) : N segments `source`, arrêts sur image (image figée + silence) et
 * vides (fond + silence), raccords audio de 8 ms. Un clip d'UN segment source garde EXACTEMENT
 * le graphe de l'étape 6 (même empreinte de plan). Le temps montage n'est obtenu que via les
 * segments (`@acs/timeline`).
 */
import { describeMissing, type AudioDecision } from './audio';
import { EFFECT_PARAMS } from './effects';
import {
  buildVideoGraph,
  compositionTail,
  layoutParts,
  num,
  sourcePrelude,
  type VideoGraphInput,
  type ZoomWindow,
} from './layout';
import {
  outputFps,
  presetFor,
  RENDER_ENGINE_VERSION,
  type PresetConfig,
  type RenderKind,
  type RenderPreset,
} from './presets';
import { buildAss, buildSrt, type SubtitleLine } from './subtitles';
import {
  durationAccepted,
  durationAcceptedV2,
  migrateV1ToV2,
  MOTION_EFFECTS,
  placeSegments,
  projectDurationMs,
  RACCORD_FADE_MS,
  resolveTiming,
  segmentsV2,
  sourceToEdit,
  totalEditDuration,
  type CaptionRole,
  type ClipProject,
  type ClipProjectV2,
  type EffectTypeV2,
  type Segment,
  type SourceMs,
  type Timing,
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

export type RenderPlanErrorCode =
  | 'VALIDATION_FAILED'
  | 'EXPORT_CONSENT_REQUIRED'
  | 'DURATION_OUT_OF_RANGE'
  | 'MEDIA_UNSUPPORTED'
  | 'RENDER_FEATURE_UNSUPPORTED';

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

interface CommonInput {
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

/** Entrée de l'étape 6 (document v1, un segment). */
export interface RenderPlanInput extends CommonInput {
  project: ClipProject;
}

/** Entrée de l'étape 7 (document v2 de l'éditeur). `revision` = version du journal. */
export interface RenderPlanV2Input extends CommonInput {
  project: ClipProjectV2;
}

/** Entrée FFmpeg d'un segment (même fichier source, une recherche précise par segment). */
export interface PlanInput {
  srcStartMs: number;
  /** Durée utile (0 pour un arrêt sur image : une seule image est lue). */
  durationMs: number;
}

/** Segment placé (temps montage, images de sortie), pour l'exécution et l'image exacte. */
export interface PlanSegment {
  id: string;
  kind: 'source' | 'freeze' | 'gap';
  editStartMs: number;
  editEndMs: number;
  /** Indice de la première image de sortie et nombre d'images du segment. */
  firstFrame: number;
  frames: number;
  /** Entrée FFmpeg (null pour un vide). */
  input: number | null;
  /** Instant source de la première image (début du segment, ou image figée). */
  srcMs: number | null;
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
  /** Graphe de la disposition seule (sans zoom ni sous-titres), conservé pour l'empreinte 6b. */
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
  /** Clip de plusieurs segments (étape 7) : entrées FFmpeg, dans l'ordre. Absent sinon. */
  inputs?: PlanInput[];
  /** Clip de plusieurs segments : segments placés. Absent sinon. */
  segments?: PlanSegment[];
}

const MIX_LIKE = new Set(['mix', 'unknown']);
/** Effets que le moteur sait rendre (catalogue de l'étape 6) ; les autres arrivent en PR 7i. */
const RENDERED_EFFECTS: readonly EffectTypeV2[] = [
  'caption_emphasis',
  'punch_zoom',
  'reaction_hold',
];
const SAMPLE_RATE = 48_000;

/* ------------------------------------------------------------------ */
/* Fonctions de l'éditeur pas encore rendues                           */
/* ------------------------------------------------------------------ */

/** Activée et appliquée (mode du projet) : règle commune avec la scène (`sceneAt`). */
const isActive = (d: ClipProjectV2, type: EffectTypeV2) =>
  d.mode === 'enrichi' || !MOTION_EFFECTS.includes(type);

export function unsupportedRenderFeatures(d: ClipProjectV2): string[] {
  const out: string[] = [];
  if (d.layout.preset === 'custom' || d.layout.overrides.length) {
    out.push('disposition personnalisée (PR 7h)');
  }
  if (d.masks.some((m) => m.srcRange !== null)) out.push('masques temporels (PR 7h)');
  if (d.captions.enabled && (d.captions.overrides.length || d.captions.manual.length)) {
    out.push('réglages par sous-titre et sous-titres manuels (PR 7g)');
  }
  const fx = d.effects.filter(
    (e) => e.enabled && isActive(d, e.type) && !RENDERED_EFFECTS.includes(e.type),
  );
  if (fx.length) out.push(`effets ${[...new Set(fx.map((e) => e.type))].join(', ')} (PR 7i)`);
  if (d.audio.tracks.some((t) => t.automation.length)) out.push('automatisation du gain (PR 7i)');
  if (d.overlays.length) out.push('calques graphiques (PR 7j)');
  if (d.audio.sfx.length) out.push('effets sonores (PR 7j)');
  return out;
}

/* ------------------------------------------------------------------ */
/* Compilation commune (plan et image exacte)                          */
/* ------------------------------------------------------------------ */

interface PlannedEffect {
  id: string;
  type: string;
  startS: number;
  endS: number;
  factor: number;
}

/** Effets actifs résolus en temps montage ; plages contiguës fusionnées (pas de creux au raccord). */
function plannedEffects(d: ClipProjectV2, segments: readonly Segment[]): PlannedEffect[] {
  const out: PlannedEffect[] = [];
  for (const e of d.effects) {
    if (!e.enabled || !isActive(d, e.type)) continue;
    const ranges = resolveTiming(segments, e.timing as unknown as Timing).ranges;
    const merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (last && last.end === r.editStartMs) last.end = r.editEndMs;
      else merged.push({ start: r.editStartMs, end: r.editEndMs });
    }
    const defaults =
      e.type in EFFECT_PARAMS ? EFFECT_PARAMS[e.type as keyof typeof EFFECT_PARAMS].factor : 1;
    const factor = Math.min(1.3, Math.max(1, e.params.factor ?? defaults));
    for (const r of merged) {
      out.push({ id: e.id, type: e.type, startS: r.start / 1000, endS: r.end / 1000, factor });
    }
  }
  return out;
}

interface Compiled {
  d: ClipProjectV2;
  preset: RenderPreset;
  fps: number;
  segments: Segment[];
  placed: PlanSegment[];
  inputs: PlanInput[];
  durationMs: number;
  totalFrames: number;
  tracks: RenderPlan['audio']['tracks'];
  effects: PlannedEffect[];
  lines: SubtitleLine[];
  graph: VideoGraphInput;
  single: boolean;
}

function compile(i: RenderPlanV2Input): Compiled {
  const d = i.project;
  const preset = presetFor(i.kind, i.presetConfig);
  const segments = segmentsV2(d.segments);
  const durationMs = totalEditDuration(segments);

  // Durée : bornes absolues et confirmation liée à CETTE version.
  if (!durationAcceptedV2(d, i.revision)) {
    throw new RenderPlanError(
      'DURATION_OUT_OF_RANGE',
      'Durée hors plage : confirmez-la explicitement pour cette révision (ou ajustez les bornes)',
      { durationMs, minMs: d.durationPolicy.minMs, maxMs: d.durationPolicy.maxMs },
    );
  }
  const missing = unsupportedRenderFeatures(d);
  if (missing.length) {
    throw new RenderPlanError(
      'RENDER_FEATURE_UNSUPPORTED',
      `Le moteur de rendu ne prend pas encore en charge : ${missing.join(' ; ')}. Retirez-les pour rendre ce clip.`,
      { features: missing },
    );
  }
  if (!i.source.width || !i.source.height) {
    throw new RenderPlanError(
      'MEDIA_UNSUPPORTED',
      'Aucun flux vidéo exploitable dans l’enregistrement',
    );
  }
  if (d.layout.preset === 'facecam_top' && !d.layout.facecamRect) {
    throw new RenderPlanError(
      'VALIDATION_FAILED',
      'Disposition facecam sans facecam dans le cadrage',
    );
  }

  // Audio : uniquement des pistes que la règle autorise AUJOURD'HUI.
  const allowed = new Map(i.audio.selected.map((t) => [t.audioIndex, t]));
  const enabled = d.audio.tracks.filter((t) => t.enabled);
  const refused = enabled.filter((t) => !allowed.has(t.audioIndex));
  if (!d.audio.silent && refused.length) {
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
  if (!d.audio.silent && !enabled.length) {
    throw new RenderPlanError(
      'EXPORT_CONSENT_REQUIRED',
      `Aucune piste audio active. ${i.audio.missing.length ? describeMissing(i.audio.missing) : 'Activez une piste autorisée ou choisissez explicitement un export sans son.'}`,
      { missing: i.audio.missing },
    );
  }
  const tracks = d.audio.silent
    ? []
    : enabled.map((t) => ({ audioIndex: t.audioIndex, role: t.role, gainDb: t.gainDb }));
  if (tracks.some((t) => MIX_LIKE.has(t.role)) && tracks.some((t) => !MIX_LIKE.has(t.role))) {
    throw new RenderPlanError(
      'VALIDATION_FAILED',
      'La piste « tout » ne peut pas être superposée à des pistes séparées (voix doublées)',
    );
  }

  // Sous-titres : mêmes règles que l'audio.
  const roles = d.captions.enabled ? d.captions.sources : [];
  const refusedRoles = roles.filter((r) => !i.audio.captionRoles.includes(r));
  if (refusedRoles.length) {
    throw new RenderPlanError(
      'EXPORT_CONSENT_REQUIRED',
      `Sous-titres non autorisés à l’export : ${refusedRoles.join(', ')}. Retirez-les ou donnez les accords nécessaires.`,
      { roles: refusedRoles },
    );
  }

  const effects = plannedEffects(d, segments);
  const items = new Map(d.captions.items.map((it) => [it.id, it]));
  const punch = d.anchors.punchlineMs;
  const emphasis =
    effects.some((e) => e.type === 'caption_emphasis') && d.captions.style.emphasizePunchline;
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

  const fps = outputFps(i.source.fps);
  const toWindows = (type: string): ZoomWindow[] =>
    effects
      .filter((e) => e.type === type)
      .map((e) => ({ startS: e.startS, endS: e.endS, factor: e.factor }));
  const graph: VideoGraphInput = {
    srcWidth: i.source.width,
    srcHeight: i.source.height,
    outWidth: preset.width,
    outHeight: preset.height,
    fps,
    // Disposition de l'étape 6 (préréglage) ; masques permanents (les temporels sont refusés).
    layout: {
      preset: d.layout.preset as ClipProject['layout']['preset'],
      gameplayRect: d.layout.gameplayRect,
      facecamRect: d.layout.facecamRect,
      framingProfile: d.layout.framingProfile,
      focusX: d.layout.focusX,
      facecamShare: d.layout.facecamShare,
      masks: d.masks.map((m) => ({ rect: m.rect, label: m.label, mode: m.mode })),
    },
    zooms: toWindows('punch_zoom'),
    facecamZooms: d.layout.preset === 'facecam_top' ? toWindows('reaction_hold') : [],
    subtitlesFile: lines.length ? 'subs.ass' : null,
    fontsDir: 'fonts',
  };

  // Placement : coupes calées sur la grille d'images de sortie (indice de la première image dont
  // l'instant est ≥ début du segment) ⇒ aucune dérive cumulée, quel que soit le nombre de coupes.
  const frameIndex = (ms: number) => Math.max(0, Math.ceil((ms * fps) / 1000 - 1e-6));
  const inputs: PlanInput[] = [];
  const placed: PlanSegment[] = placeSegments(segments).map((p) => {
    const s = p.segment;
    const first = frameIndex(p.editStartMs);
    const base = {
      id: s.id,
      kind: s.kind,
      editStartMs: p.editStartMs,
      editEndMs: p.editEndMs,
      firstFrame: first,
      frames: frameIndex(p.editEndMs) - first,
    };
    if (s.kind === 'gap') return { ...base, input: null, srcMs: null };
    const srcMs = s.kind === 'source' ? s.srcStartMs : s.srcAtMs;
    inputs.push({
      srcStartMs: srcMs,
      durationMs: s.kind === 'source' ? p.editEndMs - p.editStartMs : 0,
    });
    return { ...base, input: inputs.length - 1, srcMs };
  });

  return {
    d,
    preset,
    fps,
    segments,
    placed,
    inputs,
    durationMs,
    totalFrames: frameIndex(durationMs),
    tracks,
    effects,
    lines,
    graph,
    single: segments.length === 1 && segments[0]!.kind === 'source',
  };
}

/* ------------------------------------------------------------------ */
/* Graphe                                                              */
/* ------------------------------------------------------------------ */

const gainFilter = (gainDb: number) => `volume=${Number(gainDb.toFixed(2))}dB`;
const audioFormat = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
const loudnormTail = (on: boolean) =>
  on ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000' : 'anull';

/** Graphe audio de l'étape 6 (un segment) : inchangé. */
function singleAudioGraph(tracks: RenderPlan['audio']['tracks'], loudnorm: boolean): string {
  const parts = tracks.map(
    (t, k) => `[0:a:${t.audioIndex}]${audioFormat},${gainFilter(t.gainDb)}[a${k}]`,
  );
  const mixed = tracks.length > 1;
  if (mixed) {
    parts.push(
      `${tracks.map((_, k) => `[a${k}]`).join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0[amix]`,
    );
  }
  parts.push(`${mixed ? '[amix]' : '[a0]'}${loudnormTail(loudnorm)}[a]`);
  return parts.join(';');
}

const color = (hex: string) => `0x${hex.slice(1).toUpperCase()}`;

/**
 * Graphe de plusieurs segments : une branche par segment (image source → aplats → nombre exact
 * d'images → disposition), concaténation, zoom, sous-titres. Audio : une branche par segment et
 * par piste (extrait exact, ou SILENCE numérique pendant un arrêt sur image et un vide), fondus de
 * raccord, concaténation par piste, gain, mixage, normalisation.
 */
function multiGraph(c: Compiled, loudnorm: boolean): string {
  const g = c.graph;
  const W = g.outWidth;
  const H = g.outHeight;
  const F = num(g.fps);
  const prelude = sourcePrelude(g).join(',');
  const parts: string[] = [];
  const videoLabels: string[] = [];
  const n = c.placed.length;
  c.placed.forEach((s, k) => {
    if (s.frames > 0) {
      const t0 = s.firstFrame / g.fps;
      const t1 = (s.firstFrame + s.frames) / g.fps;
      // Zooms de la facecam dans le temps de la branche (son flux part de 0).
      const camZooms = g.facecamZooms
        .filter((w) => w.endS > t0 && w.startS < t1)
        .map((w) => ({ ...w, startS: w.startS - t0, endS: w.endS - t0 }));
      if (s.kind === 'gap') {
        parts.push(
          `color=c=${color(c.d.layout.background)}:s=${W}x${H}:r=${F},trim=end_frame=${s.frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v${k}]`,
        );
      } else {
        const frames =
          s.kind === 'source'
            ? `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${s.frames},setpts=PTS-STARTPTS`
            : `trim=end_frame=1,loop=loop=${s.frames - 1}:size=1:start=0,setpts=N/(${F}*TB)`;
        parts.push(`[${s.input}:v]${prelude},setpts=PTS-STARTPTS,${frames}[s${k}]`);
        parts.push(
          ...layoutParts(
            { ...g, facecamZooms: camZooms },
            { input: `[s${k}]`, pre: '', output: `[v${k}]`, sfx: `_${k}` },
          ),
        );
      }
      videoLabels.push(`[v${k}]`);
    }
  });
  parts.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[cat]`);
  parts.push(`[cat]${compositionTail(g).join(',')}[v]`);

  if (c.tracks.length) {
    c.tracks.forEach((t, ti) => {
      const labels = c.placed.map((s, k) => {
        const durMs = s.editEndMs - s.editStartMs;
        const samples = (durMs * SAMPLE_RATE) / 1000;
        const label = `[a${k}_${ti}]`;
        if (s.kind !== 'source') {
          parts.push(
            `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${samples},${audioFormat}${label}`,
          );
          return label;
        }
        const fade = Math.min(RACCORD_FADE_MS, durMs / 2) / 1000;
        const fades = [
          ...(k > 0 ? [`afade=t=in:st=0:d=${num(fade)}`] : []),
          ...(k < n - 1 ? [`afade=t=out:st=${num(durMs / 1000 - fade)}:d=${num(fade)}`] : []),
        ];
        parts.push(
          `[${s.input}:a:${t.audioIndex}]${audioFormat},asetpts=PTS-STARTPTS,apad,atrim=end_sample=${samples}${fades.map((f) => `,${f}`).join('')}${label}`,
        );
        return label;
      });
      parts.push(`${labels.join('')}concat=n=${n}:v=0:a=1,${gainFilter(t.gainDb)}[t${ti}]`);
    });
    const mixed = c.tracks.length > 1;
    if (mixed) {
      parts.push(
        `${c.tracks.map((_, k) => `[t${k}]`).join('')}amix=inputs=${c.tracks.length}:duration=longest:normalize=0[amix]`,
      );
    }
    parts.push(`${mixed ? '[amix]' : '[t0]'}${loudnormTail(loudnorm)}[a]`);
  }
  return parts.join(';');
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export function buildRenderPlanV2(i: RenderPlanV2Input): RenderPlan {
  const c = compile(i);
  const loudnorm = c.d.audio.loudnorm.enabled && c.tracks.length > 0;
  const video = buildVideoGraph(c.graph);
  const frameGraph = buildVideoGraph({
    ...c.graph,
    zooms: [],
    facecamZooms: [],
    subtitlesFile: null,
  });
  const filterComplex = c.single
    ? c.tracks.length
      ? `${video};${singleAudioGraph(c.tracks, c.d.audio.loudnorm.enabled)}`
      : video
    : multiGraph(c, c.d.audio.loudnorm.enabled);
  const hasSubs = c.lines.length > 0;
  const firstSrc = c.inputs[0]?.srcStartMs ?? 0;
  return {
    engineVersion: RENDER_ENGINE_VERSION,
    kind: i.kind,
    preset: c.preset,
    fps: c.fps,
    srcStartMs: firstSrc,
    durationMs: c.durationMs,
    probeBytes: i.probeBytes,
    filterComplex,
    frameGraph,
    hasAudio: c.tracks.length > 0,
    audio: { tracks: c.tracks, loudnorm, silent: c.d.audio.silent },
    ass: hasSubs ? buildAss(c.lines, c.d.captions.style) : null,
    srt: hasSubs ? buildSrt(c.lines, c.d.captions.style) : null,
    effects: c.effects.map((e) => ({ id: e.id, type: e.type, startS: e.startS, endS: e.endS })),
    captionLines: c.lines.length,
    ...(c.single ? {} : { inputs: c.inputs, segments: c.placed }),
  };
}

/**
 * Entrée de l'étape 6 (document v1) : même plan que le document v2 migré. Fenêtre éditable
 * déduite des segments (le contrôle de la fenêtre du manifeste est fait par l'appelant).
 */
export function buildRenderPlan(i: RenderPlanInput): RenderPlan {
  const p = i.project;
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
  const bounds = p.segments.map((s) =>
    s.kind === 'source' ? [s.srcStartMs, s.srcEndMs] : [s.srcAtMs, s.srcAtMs + 1],
  );
  const project = migrateV1ToV2(p, {
    manifestWindow: {
      srcStartMs: Math.min(...bounds.map((b) => b[0]!)),
      srcEndMs: Math.max(...bounds.map((b) => b[1]!)),
    },
  });
  return buildRenderPlanV2({ ...i, project });
}

/* ------------------------------------------------------------------ */
/* Image exacte                                                        */
/* ------------------------------------------------------------------ */

export interface FramePlan {
  /** Instant demandé (borné au clip) et instant de l'image de sortie correspondante. */
  atEditMs: number;
  frameTimeMs: number;
  /** Lecture de la source (null pendant un vide). */
  input: { srcMs: number } | null;
  probeBytes: number;
  graph: string;
  ass: string | null;
  preset: RenderPreset;
}

const exactSec = (s: number) => Number(s.toFixed(6)).toString();

/**
 * Image EXACTE de l'export à un instant du montage : même source, mêmes aplats, même disposition,
 * mêmes zooms, mêmes sous-titres (horodatage de l'image = instant de sortie). Pendant un arrêt sur
 * image : l'image figée ; pendant un vide : le fond.
 */
export function buildFramePlan(i: RenderPlanV2Input, atEditMs: number): FramePlan {
  const c = compile(i);
  const g = c.graph;
  const t = Math.max(0, Math.min(c.durationMs - 1, Math.floor(atEditMs)));
  const j = Math.min(c.totalFrames - 1, Math.floor((t * c.fps) / 1000 + 1e-6));
  const seg =
    c.placed.find((s) => s.frames > 0 && s.firstFrame <= j && j < s.firstFrame + s.frames) ??
    c.placed.find((s) => s.frames > 0)!;
  const T = j / c.fps;
  const at = `setpts=${exactSec(T)}/TB`;
  const parts: string[] = [];
  let input: FramePlan['input'] = null;
  if (seg.kind === 'gap') {
    parts.push(
      `color=c=${color(c.d.layout.background)}:s=${g.outWidth}x${g.outHeight}:r=${num(g.fps)},trim=end_frame=1,${at},format=yuv420p,setsar=1[comp]`,
    );
  } else {
    const offsetMs = seg.kind === 'source' ? ((j - seg.firstFrame) * 1000) / c.fps : 0;
    input = { srcMs: seg.srcMs! + offsetMs };
    const pre = [...sourcePrelude(g), 'setpts=PTS-STARTPTS', 'trim=end_frame=1', at].join(',');
    parts.push(...layoutParts(g, { input: '[0:v]', pre, output: '[comp]', sfx: '' }));
  }
  parts.push(`[comp]${compositionTail(g, { beforeSubtitles: at }).join(',')}[v]`);
  return {
    atEditMs: t,
    frameTimeMs: T * 1000,
    input,
    probeBytes: i.probeBytes,
    graph: parts.join(';'),
    ass: c.lines.length ? buildAss(c.lines, c.d.captions.style) : null,
    preset: c.preset,
  };
}
