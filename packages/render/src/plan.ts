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
import {
  automationFilter,
  bleepToneParts,
  blurParts,
  compositeEffectParts,
  customLayoutParts,
  maskFilters,
  masterFadeFilter,
  sourceEffectsFilter,
  type BlurWindow,
  type CompositeEffects,
  type ZoomPiece,
} from './editor-graph';
import {
  buildVideoGraph,
  compositionTail,
  layoutParts,
  num,
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
  captionLinesV2,
  durationAccepted,
  imageOverlayPlacements,
  overlayPixelRect,
  sfxPlacements,
  durationAcceptedV2,
  EFFECT_CATALOG,
  migrateV1ToV2,
  placeSegments,
  projectDurationMs,
  RACCORD_FADE_MS,
  regionCenterOnOutput,
  resolvedEffects,
  segmentLayers,
  segmentsV2,
  TextLayerError,
  textOverlayLines,
  toPixelRect,
  totalEditDuration,
  type CaptionRole,
  type ClipProject,
  type ClipProjectV2,
  type ImageOverlayPlacement,
  type PlacedLayer,
  type SfxPlacement,
  type ResolvedEffect,
  type Segment,
  type TextOverlayLine,
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
  | 'RENDER_FEATURE_UNSUPPORTED'
  | 'ASSET_MISSING';

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
  /** Texte affiché (pseudonymisé) de chaque sous-titre manuel (obligatoire s'il y en a). */
  manualCaptions?: Readonly<Record<string, string>>;
  /** Texte affiché (pseudonymisé) de chaque calque texte (obligatoire s'il y en a). */
  overlayTexts?: Readonly<Record<string, string>>;
  /**
   * Médias de la bibliothèque utilisés (étape 7f), copiés et VÉRIFIÉS par l'appelant dans le
   * dossier de travail : nom de fichier relatif, empreinte, durée d'un son. Obligatoires pour
   * chaque média référencé : un média absent est un refus (`ASSET_MISSING`), jamais ignoré.
   */
  assets?: Readonly<Record<string, PlanAssetInput>>;
  probeBytes: number;
}

export interface PlanAssetInput {
  kind: 'image' | 'audio';
  /** Nom relatif au dossier de travail (`asset-<id>.png|wav`). */
  file: string;
  sha256: string;
  durationMs: number | null;
}

/** Entrée FFmpeg d'un média de la bibliothèque (après les entrées de la source). */
export interface PlanAsset {
  id: string;
  kind: 'image' | 'audio';
  file: string;
  sha256: string;
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
  /** Médias de la bibliothèque (entrées FFmpeg après celles de la source). Absent sinon. */
  assets?: PlanAsset[];
  /** Calques image et effets sonores placés (temps montage). Absent sinon. */
  media?: { overlays: ImageOverlayPlacement[]; sfx: SfxPlacement[] };
}

const MIX_LIKE = new Set(['mix', 'unknown']);
const SAMPLE_RATE = 48_000;

/* ------------------------------------------------------------------ */
/* Fonctions de l'éditeur pas encore rendues                           */
/* ------------------------------------------------------------------ */

/**
 * Fonctions du document v2 que le moteur ne rend pas : AUCUNE depuis la PR 7f (calques image et
 * mèmes, effets sonores rendus). Conservé pour un refus EXPLICITE si le modèle s'enrichit avant
 * le moteur : une fonction ignorée serait un défaut silencieux.
 */
export function unsupportedRenderFeatures(_d: ClipProjectV2): string[] {
  return [];
}

/** Effets du catalogue de l'étape 6 : rendus par le graphe de l'étape 6 (un segment). */
const STEP6_EFFECTS = new Set(['caption_emphasis', 'punch_zoom', 'reaction_hold']);

/**
 * Le document utilise-t-il une fonction de l'éditeur qui exige le graphe de l'éditeur (une
 * branche par segment) ? Sinon, un clip d'un segment garde EXACTEMENT le graphe de l'étape 6.
 * Les textes (réglages par sous-titre, sous-titres manuels, calques texte) passent par l'ASS et
 * n'exigent aucun changement de graphe.
 */
export function needsEditorGraph(d: ClipProjectV2, effects: readonly ResolvedEffect[]): boolean {
  return (
    d.layout.preset === 'custom' ||
    d.layout.overrides.length > 0 ||
    d.masks.some((m) => m.srcRange !== null && m.mode === 'opaque') ||
    effects.some((e) => !STEP6_EFFECTS.has(e.type)) ||
    d.audio.tracks.some((t) => t.enabled && t.automation.length > 0) ||
    d.overlays.some((o) => o.kind !== 'text') ||
    d.audio.sfx.length > 0
  );
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

/** Bornes des facteurs de zoom (schéma) : zooms de l'étape 6 ≤ 1,3 ; zoom localisé ≤ 3. */
const zoomFactor = (e: ResolvedEffect) =>
  Math.min(e.type === 'zoom' ? 3 : 1.3, Math.max(1, e.params['factor'] ?? 1));

interface Compiled {
  d: ClipProjectV2;
  /** Effets actifs résolus (temps montage), fonctions de l'éditeur comprises. */
  resolved: ResolvedEffect[];
  overlays: TextOverlayLine[];
  editor: boolean;
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
  /** Zooms de la facecam (`reaction_hold`), pour les calques facecam d'une disposition libre. */
  camZooms: ZoomWindow[];
  /** Médias de la bibliothèque : entrées, calques image placés, effets sonores placés. */
  assets: PlanAsset[];
  imageOverlays: ImageOverlayPlacement[];
  sfx: SfxPlacement[];
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

  const resolved = resolvedEffects(d);
  const effects: PlannedEffect[] = resolved.map((e) => ({
    id: e.id,
    type: e.type,
    startS: e.startS,
    endS: e.endS,
    factor: zoomFactor(e),
  }));
  let lines: SubtitleLine[];
  let overlays: TextOverlayLine[];
  try {
    lines = captionLinesV2(d, i.captions, i.manualCaptions ?? {}, {
      roles,
      emphasis: effects.some((e) => e.type === 'caption_emphasis'),
    });
    overlays = textOverlayLines(d, i.overlayTexts ?? {});
  } catch (err) {
    if (err instanceof TextLayerError) throw new RenderPlanError('VALIDATION_FAILED', err.message);
    throw err;
  }

  // Médias de la bibliothèque : chacun fourni (copié et vérifié) avec le bon type, sinon refus.
  const media = i.assets ?? {};
  const wanted = new Map<string, 'image' | 'audio'>();
  for (const o of d.overlays) if (o.kind !== 'text' && o.assetId) wanted.set(o.assetId, 'image');
  if (!d.audio.silent) for (const s of d.audio.sfx) wanted.set(s.assetId, 'audio');
  const absent = [...wanted].filter(([id, kind]) => media[id]?.kind !== kind).map(([id]) => id);
  if (absent.length) {
    throw new RenderPlanError(
      'ASSET_MISSING',
      `Média(s) de la bibliothèque manquant(s) : ${absent.length}. Réimportez-les ou retirez-les du clip.`,
      { assetIds: absent.sort() },
    );
  }
  const imageOverlays = imageOverlayPlacements(d);
  const durations: Record<string, number> = {};
  for (const [id, a] of Object.entries(media)) {
    if (a.kind === 'audio' && a.durationMs) durations[id] = a.durationMs;
  }
  const sfx = tracks.length ? sfxPlacements(d, durations) : [];
  const usedIds = [
    ...new Set([...imageOverlays.map((o) => o.assetId), ...sfx.map((s) => s.assetId)]),
  ].sort();
  const assets: PlanAsset[] = usedIds.map((id) => ({
    id,
    kind: media[id]!.kind,
    file: safeAssetName(media[id]!.file),
    sha256: media[id]!.sha256,
  }));

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
    zooms: [...toWindows('punch_zoom'), ...toWindows('zoom')],
    facecamZooms: d.layout.preset === 'facecam_top' ? toWindows('reaction_hold') : [],
    subtitlesFile: lines.length || overlays.length ? 'subs.ass' : null,
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

  const editor = needsEditorGraph(d, resolved);
  return {
    d,
    resolved,
    overlays,
    editor,
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
    single: segments.length === 1 && segments[0]!.kind === 'source' && !editor,
    camZooms: toWindows('reaction_hold'),
    assets,
    imageOverlays,
    sfx,
  };
}

/** Nom d'un média dans le dossier de travail : forme fixe, aucun caractère interprétable. */
function safeAssetName(name: string): string {
  if (!/^asset-[0-9a-f]{64}\.(png|wav)$/u.test(name)) {
    throw new RangeError(`nom de média refusé : ${name}`);
  }
  return name;
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

const dims = (c: Compiled) => ({
  src: { width: c.graph.srcWidth, height: c.graph.srcHeight },
  out: { width: c.graph.outWidth, height: c.graph.outHeight },
});

/** Calques d'une disposition libre (surcharge du segment ou `custom`) ; null : préréglage. */
function customLayers(c: Compiled, segmentId: string): PlacedLayer[] | null {
  const d = c.d;
  const custom = d.layout.preset === 'custom' || d.layout.overrides.some((o) => o.id === segmentId);
  return custom ? segmentLayers(d, segmentId, dims(c)) : null;
}

/**
 * Flous créatifs d'une branche (après les aplats). `localStart` : instant montage (s) du début de
 * la branche ; `staticAt` : image exacte (instant montage), flou statique.
 */
function blursFor(
  c: Compiled,
  seg: { editStartMs: number; editEndMs: number },
  localStart: number,
  staticAt: number | null,
): BlurWindow[] {
  const out: BlurWindow[] = [];
  const a = seg.editStartMs / 1000;
  const b = seg.editEndMs / 1000;
  for (const e of c.resolved) {
    if (e.type !== 'blur_region' || !e.region) continue;
    const region = toPixelRect(e.region, c.graph.srcWidth, c.graph.srcHeight);
    const sigma = Math.min(60, Math.max(1, e.params['sigma'] ?? 20));
    if (staticAt !== null) {
      if (e.startS <= staticAt && staticAt < e.endS) out.push({ region, sigma, local: null });
      continue;
    }
    if (e.endS <= a || e.startS >= b) continue;
    out.push({
      region,
      sigma,
      local:
        e.startS <= a && e.endS >= b ? null : { s: e.startS - localStart, e: e.endS - localStart },
    });
  }
  return out;
}

/** Effets de l'image composée (temps montage) : zooms localisés découpés par segment, secousses, éclairs. */
function compositeFx(c: Compiled): CompositeEffects {
  const pieces: ZoomPiece[] = [];
  for (const e of c.resolved) {
    if (e.type !== 'zoom' || !e.region) continue;
    const region = toPixelRect(e.region, c.graph.srcWidth, c.graph.srcHeight);
    for (const s of c.placed) {
      if (s.kind === 'gap') continue;
      const a = Math.max(e.startS, s.editStartMs / 1000);
      const b = Math.min(e.endS, s.editEndMs / 1000);
      if (b <= a) continue;
      const center = regionCenterOnOutput(segmentLayers(c.d, s.id, dims(c)), region, dims(c).out);
      pieces.push({ startS: a, endS: b, ...center });
    }
  }
  return {
    zooms: c.graph.zooms,
    zoomPieces: pieces,
    shakes: c.resolved
      .filter((e) => e.type === 'shake')
      .map((e) => ({
        startS: e.startS,
        endS: e.endS,
        amplitude: Math.min(0.05, Math.max(0, e.params['amplitude'] ?? 0.01)),
      })),
    flashes: c.resolved
      .filter((e) => e.type === 'flash')
      .map((e) => ({
        startS: e.startS,
        endS: e.endS,
        intensity: Math.min(1, Math.max(0, e.params['intensity'] ?? 0.8)),
      })),
  };
}

/**
 * Calques image (bibliothèque) posés sur l'image COMPOSÉE, dans l'ordre d'empilement : chacun est
 * étiré à son cadre (pixels arrondis comme le canvas), opacité appliquée au canal alpha, visible
 * sur [début, fin[ du temps montage. Ils ne touchent jamais l'image source : les aplats de
 * confidentialité, posés avant, ne peuvent pas être découverts. `retime` : image exacte.
 */
function overlayParts(
  c: Compiled,
  input: string,
  placements: readonly ImageOverlayPlacement[],
  inputOf: (assetId: string) => number,
  retime: string | null,
): { parts: string[]; output: string } {
  const g = c.graph;
  const parts: string[] = [];
  const uses = new Map<string, number>();
  for (const p of placements) uses.set(p.assetId, (uses.get(p.assetId) ?? 0) + 1);
  const labels = new Map<string, string[]>();
  for (const [id, n] of uses) {
    const idx = inputOf(id);
    const outs = Array.from({ length: n }, (_, j) => `[im${idx}_${j}]`);
    parts.push(
      `[${idx}:v]format=rgba${retime ? `,${retime}` : ''}${n > 1 ? `,split=${n}` : ''}${outs.join('')}`,
    );
    labels.set(id, outs);
  }
  let cur = input;
  placements.forEach((p, k) => {
    const r = overlayPixelRect(p.frame, g.outWidth, g.outHeight);
    const src = labels.get(p.assetId)!.shift()!;
    const alpha = p.opacity < 1 ? `,colorchannelmixer=aa=${num(p.opacity)}` : '';
    parts.push(`${src}scale=${r.w}:${r.h}:flags=lanczos${alpha}[ovi${k}]`);
    parts.push(
      `${cur}[ovi${k}]overlay=x=${r.x}:y=${r.y}:format=auto:eof_action=repeat:enable='gte(t,${num(p.startMs / 1000)})*lt(t,${num(p.endMs / 1000)})'[ov${k}]`,
    );
    cur = `[ov${k}]`;
  });
  return { parts, output: cur };
}

/**
 * Fin du graphe vidéo : effets de l'image composée, calques image, puis textes et format final.
 * Sans zoom localisé, secousse, éclair ni calque image : chaîne de l'étape 7c inchangée.
 */
function videoTail(
  c: Compiled,
  input: string,
  at: string | null,
  overlays: readonly ImageOverlayPlacement[] = [],
  inputOf: (assetId: string) => number = () => -1,
): string[] {
  const g = c.graph;
  const fx = compositeFx(c);
  const extra = at ? { beforeSubtitles: at } : {};
  const hasFx = fx.zoomPieces.length > 0 || fx.shakes.length > 0 || fx.flashes.length > 0;
  if (!overlays.length) {
    if (!hasFx) return [`${input}${compositionTail(g, extra).join(',')}[v]`];
    const { parts, output } = compositeEffectParts(input, fx, {
      width: g.outWidth,
      height: g.outHeight,
      fps: g.fps,
      ...(at ? { retime: at } : {}),
    });
    return [...parts, `${output}${compositionTail({ ...g, zooms: [] }, extra).join(',')}[v]`];
  }
  const parts: string[] = [];
  let cur = input;
  let zooms = g.zooms;
  if (hasFx) {
    const r = compositeEffectParts(input, fx, {
      width: g.outWidth,
      height: g.outHeight,
      fps: g.fps,
      ...(at ? { retime: at } : {}),
    });
    parts.push(...r.parts);
    cur = r.output;
    zooms = [];
  }
  parts.push(
    `${cur}${compositionTail({ ...g, zooms, subtitlesFile: null }, extra).join(',')}[ovbase]`,
  );
  const ov = overlayParts(c, '[ovbase]', overlays, inputOf, at);
  parts.push(...ov.parts);
  parts.push(`${ov.output}${compositionTail({ ...g, zooms: [] }).join(',')}[v]`);
  return parts;
}

/** Disposition d'une branche : préréglage de l'étape 6 ou calques libres. */
function branchLayout(
  c: Compiled,
  segmentId: string,
  o: { input: string; pre: string; output: string; sfx: string },
  camZooms: readonly ZoomWindow[],
): string[] {
  const g = c.graph;
  const layers = customLayers(c, segmentId);
  if (!layers) return layoutParts({ ...g, facecamZooms: camZooms }, o);
  const head = o.pre ? [`${o.input}${o.pre}[pre${o.sfx}]`] : [];
  return [
    ...head,
    ...customLayoutParts(layers, {
      input: o.pre ? `[pre${o.sfx}]` : o.input,
      output: o.output,
      sfx: o.sfx,
      width: g.outWidth,
      height: g.outHeight,
      background: c.d.layout.background,
      fps: g.fps,
      facecamZooms: camZooms,
    }),
  ];
}

/** Zooms de la facecam exprimés dans le temps d'une branche [t0, t1[. */
function localZooms(windows: readonly ZoomWindow[], t0: number, t1: number): ZoomWindow[] {
  return windows
    .filter((w) => w.endS > t0 && w.startS < t1)
    .map((w) => ({ ...w, startS: w.startS - t0, endS: w.endS - t0 }));
}

/**
 * Effets sonores (bibliothèque) : extrait exact du son (échantillons), gain, placement à l'instant
 * montage, puis complété par du silence jusqu'à la fin du clip. Mixés avec les pistes de
 * l'enregistrement AVANT la normalisation ; non concernés par l'atténuation et les bips (qui ne
 * visent que l'enregistrement) ; concernés par les fondus d'entrée et de sortie du mixage.
 */
function sfxParts(c: Compiled, inputOf: (assetId: string) => number) {
  const parts: string[] = [];
  const labels: string[] = [];
  if (!c.sfx.length) return { parts, labels };
  const samples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000);
  const total = samples(c.durationMs);
  const uses = new Map<string, number>();
  for (const p of c.sfx) uses.set(p.assetId, (uses.get(p.assetId) ?? 0) + 1);
  const pool = new Map<string, string[]>();
  for (const [id, n] of uses) {
    const idx = inputOf(id);
    const outs = Array.from({ length: n }, (_, j) => `[sx${idx}_${j}]`);
    parts.push(`[${idx}:a]${audioFormat}${n > 1 ? `,asplit=${n}` : ''}${outs.join('')}`);
    pool.set(id, outs);
  }
  c.sfx.forEach((p, k) => {
    const src = pool.get(p.assetId)!.shift()!;
    const start = samples(p.offsetMs);
    const len = samples(p.editEndMs) - samples(p.editStartMs);
    const label = `[fx${k}]`;
    parts.push(
      `${src}atrim=start_sample=${start}:end_sample=${start + len},asetpts=PTS-STARTPTS,${gainFilter(p.gainDb)},adelay=delays=${samples(p.editStartMs)}S:all=1,apad,atrim=end_sample=${total}${label}`,
    );
    labels.push(label);
  });
  return { parts, labels };
}

/**
 * Graphe de plusieurs segments : une branche par segment (image source → aplats permanents et
 * temporels → nombre exact d'images → flou créatif → disposition), concaténation, effets de
 * l'image composée, textes. Audio : une branche par segment et par piste (extrait exact avec
 * automatisation du gain, ou SILENCE numérique pendant un arrêt sur image et un vide), fondus de
 * raccord, concaténation par piste, gain, atténuation et bips, mixage (tons des bips compris),
 * normalisation, fondus d'entrée et de sortie.
 */
function multiGraph(c: Compiled, loudnorm: boolean): string {
  const g = c.graph;
  const W = g.outWidth;
  const H = g.outHeight;
  const F = num(g.fps);
  const src = dims(c).src;
  const parts: string[] = [];
  const videoLabels: string[] = [];
  const n = c.placed.length;
  const camWindows = c.d.layout.preset === 'facecam_top' ? g.facecamZooms : c.camZooms;
  c.placed.forEach((s, k) => {
    if (s.frames > 0) {
      const t0 = s.firstFrame / g.fps;
      const t1 = (s.firstFrame + s.frames) / g.fps;
      if (s.kind === 'gap') {
        parts.push(
          `color=c=${color(c.d.layout.background)}:s=${W}x${H}:r=${F},trim=end_frame=${s.frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v${k}]`,
        );
      } else {
        const durMs = s.editEndMs - s.editStartMs;
        const prelude = [
          `fps=${F}`,
          ...maskFilters(c.d.masks, src, {
            srcStartMs: s.srcMs!,
            srcEndMs: s.srcMs! + (s.kind === 'source' ? durMs : 0),
            frozenAtMs: s.kind === 'freeze' ? s.srcMs! : null,
          }),
        ].join(',');
        const frames =
          s.kind === 'source'
            ? `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${s.frames},setpts=PTS-STARTPTS`
            : `trim=end_frame=1,loop=loop=${s.frames - 1}:size=1:start=0,setpts=N/(${F}*TB)`;
        // Horodatages remis à zéro AVANT la cadence : selon la version de FFmpeg, la recherche
        // précise garde un léger décalage (image visible avant l'instant demandé) qui, arrondi par
        // `fps`, répéterait ou sauterait des images.
        parts.push(
          `[${s.input}:v]setpts=PTS-STARTPTS,${prelude},setpts=PTS-STARTPTS,${frames}[s${k}]`,
        );
        const blur = blurParts(`[s${k}]`, blursFor(c, s, t0, null), `_${k}`);
        parts.push(...blur.parts);
        parts.push(
          ...branchLayout(
            c,
            s.id,
            { input: blur.output, pre: '', output: `[v${k}]`, sfx: `_${k}` },
            localZooms(camWindows, t0, t1),
          ),
        );
      }
      videoLabels.push(`[v${k}]`);
    }
  });
  parts.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[cat]`);
  const assetInput = (id: string) => c.inputs.length + c.assets.findIndex((a) => a.id === id);
  parts.push(...videoTail(c, '[cat]', null, c.imageOverlays, assetInput));

  if (c.tracks.length) {
    const audioFx = c.resolved.filter((e) => EFFECT_CATALOG[e.type].category === 'audio');
    const sourceFx = sourceEffectsFilter(audioFx);
    c.tracks.forEach((t, ti) => {
      const automation =
        c.d.audio.tracks.find((x) => x.audioIndex === t.audioIndex)?.automation ?? [];
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
        const auto = automationFilter(automation, s.srcMs!, s.srcMs! + durMs);
        const fades = [
          ...(auto ? [auto] : []),
          ...(k > 0 ? [`afade=t=in:st=0:d=${num(fade)}`] : []),
          ...(k < n - 1 ? [`afade=t=out:st=${num(durMs / 1000 - fade)}:d=${num(fade)}`] : []),
        ];
        parts.push(
          `[${s.input}:a:${t.audioIndex}]${audioFormat},asetpts=PTS-STARTPTS,apad,atrim=end_sample=${samples}${fades.map((f) => `,${f}`).join('')}${label}`,
        );
        return label;
      });
      parts.push(
        `${labels.join('')}concat=n=${n}:v=0:a=1,${gainFilter(t.gainDb)}${sourceFx ? `,${sourceFx}` : ''}[t${ti}]`,
      );
    });
    const tones = bleepToneParts(audioFx, c.durationMs / 1000, audioFormat);
    parts.push(...tones.parts);
    const sfx = sfxParts(c, assetInput);
    parts.push(...sfx.parts);
    const inputs = [...c.tracks.map((_, k) => `[t${k}]`), ...tones.labels, ...sfx.labels];
    const mixed = inputs.length > 1;
    if (mixed) {
      parts.push(
        `${inputs.join('')}amix=inputs=${inputs.length}:duration=longest:normalize=0[amix]`,
      );
    }
    const master = masterFadeFilter(audioFx);
    parts.push(
      `${mixed ? '[amix]' : '[t0]'}${loudnormTail(loudnorm)}${master ? `,${master}` : ''}[a]`,
    );
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
  const hasText = hasSubs || c.overlays.length > 0;
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
    ass: hasText ? buildAss(c.lines, c.d.captions.style, c.overlays) : null,
    srt: hasSubs ? buildSrt(c.lines, c.d.captions.style) : null,
    effects: c.effects.map((e) => ({ id: e.id, type: e.type, startS: e.startS, endS: e.endS })),
    captionLines: c.lines.length,
    ...(c.single ? {} : { inputs: c.inputs, segments: c.placed }),
    ...(c.assets.length
      ? { assets: c.assets, media: { overlays: c.imageOverlays, sfx: c.sfx } }
      : {}),
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
  /** Images de la bibliothèque visibles à cet instant (entrées après la source). */
  assets: PlanAsset[];
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
    const srcAt = seg.srcMs! + offsetMs;
    input = { srcMs: srcAt };
    // Aplats à l'instant source de l'image (temporels compris, marge de sécurité comprise).
    const masks = maskFilters(c.d.masks, dims(c).src, {
      srcStartMs: srcAt,
      srcEndMs: srcAt,
      frozenAtMs: srcAt,
    });
    const pre = [
      'setpts=PTS-STARTPTS',
      `fps=${num(g.fps)}`,
      ...masks,
      'setpts=PTS-STARTPTS',
      'trim=end_frame=1',
      at,
    ].join(',');
    const blurs = blursFor(c, seg, 0, T);
    const camWindows = c.d.layout.preset === 'facecam_top' ? g.facecamZooms : c.camZooms;
    if (blurs.length) {
      parts.push(`[0:v]${pre}[fr]`);
      const blur = blurParts('[fr]', blurs, '');
      parts.push(...blur.parts);
      parts.push(
        ...branchLayout(
          c,
          seg.id,
          { input: blur.output, pre: '', output: '[comp]', sfx: '' },
          camWindows,
        ),
      );
    } else {
      parts.push(
        ...branchLayout(c, seg.id, { input: '[0:v]', pre, output: '[comp]', sfx: '' }, camWindows),
      );
    }
  }
  // Calques image visibles à l'instant de l'image de sortie (même règle [début, fin[ que l'export).
  const ms = T * 1000;
  const visible = c.imageOverlays.filter((o) => o.startMs <= ms + 1e-6 && ms + 1e-6 < o.endMs);
  const frameAssets = c.assets.filter(
    (a) => a.kind === 'image' && visible.some((o) => o.assetId === a.id),
  );
  const first = input ? 1 : 0;
  const inputOf = (id: string) => first + frameAssets.findIndex((a) => a.id === id);
  parts.push(...videoTail(c, '[comp]', at, visible, inputOf));
  return {
    assets: frameAssets,
    atEditMs: t,
    frameTimeMs: T * 1000,
    input,
    probeBytes: i.probeBytes,
    graph: parts.join(';'),
    ass:
      c.lines.length || c.overlays.length
        ? buildAss(c.lines, c.d.captions.style, c.overlays)
        : null,
    preset: c.preset,
  };
}
