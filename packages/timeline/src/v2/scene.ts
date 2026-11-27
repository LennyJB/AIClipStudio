/**
 * Description de scène (docs/plan-etape-7.md §2.4) : ce qui doit être vu et entendu à un instant
 * du montage. Code PUR, consommé par l'aperçu canvas (PR 7e) et par le plan FFmpeg (PR 7c) :
 * même géométrie, mêmes masques, mêmes sous-titres, même mixage.
 *
 * Sémantique (§3.3), définie ICI et testée :
 *  - arrêt sur image : image figée (mêmes aplats que l'instant figé), SILENCE des pistes de
 *    l'enregistrement ; éléments ancrés au contenu affichés figés ; effets sonores ancrés au
 *    contenu NON rejoués ; éléments ancrés au montage continuent ;
 *  - vide (`gap`) : fond seul (aucune image source, donc aucune zone sensible possible), silence
 *    des pistes de l'enregistrement, aucun élément ancré au contenu ; éléments ancrés au montage
 *    continuent ;
 *  - masques de confidentialité : aplats OPAQUES appliqués sur l'image source avant tout
 *    recadrage ; `blur_region` est un effet appliqué APRÈS les aplats, jamais une protection ;
 *  - raccords : fondu audio de RACCORD_FADE_MS à chaque entrée et sortie de segment.
 */
import {
  resolveTiming,
  totalEditDuration,
  editToSource,
  type EditMs,
  type GapPosition,
  type SourcePosition,
  type SourceMs,
  type Timing,
} from '../time';
import { presetLayers, toPixelRect, type PixelRect, type PlacedLayer } from '../geometry';
import type { CaptionRole } from '../captions';
import { EFFECT_CATALOG, resolvedEffects } from './effects';
import { segmentsV2, type ClipProjectV2, type EffectTypeV2, type TimingV2 } from './schema';

/** Fondu anti-clic à chaque raccord (aperçu ET export). */
export const RACCORD_FADE_MS = 8;

/** Effets de mouvement : absents en mode fidèle (règle de l'étape 6, étendue au catalogue v2). */
export const MOTION_EFFECTS: readonly EffectTypeV2[] = (
  Object.keys(EFFECT_CATALOG) as EffectTypeV2[]
).filter((t) => EFFECT_CATALOG[t].motion);

/**
 * Marge de sécurité d'un masque TEMPOREL (ms), de chaque côté de sa plage : l'image affichée à un
 * instant peut provenir d'une image source voisine (cadence, recherche précise selon la version de
 * FFmpeg). L'aplat est donc posé un peu plus longtemps que demandé, dans l'aperçu comme dans
 * l'export : jamais moins masqué.
 */
export const MASK_TIME_MARGIN_MS = 100;

/** Le masque est-il actif sur l'image source à `srcMs` ? (permanent, ou plage + marge) */
export function maskActiveAt(
  m: { srcRange: { srcStartMs: number; srcEndMs: number } | null },
  srcMs: number,
): boolean {
  return (
    !m.srcRange ||
    (m.srcRange.srcStartMs - MASK_TIME_MARGIN_MS <= srcMs &&
      srcMs < m.srcRange.srcEndMs + MASK_TIME_MARGIN_MS)
  );
}

export interface SceneOptions {
  src: { width: number; height: number };
  out: { width: number; height: number };
  /**
   * Pistes autorisées AUJOURD'HUI (décision du serveur). OBLIGATOIRE : une liste vide n'autorise
   * aucune piste ; rien n'est autorisé par défaut.
   */
  allowedAudioIndexes: readonly number[];
  /**
   * Sources de sous-titres autorisées AUJOURD'HUI (décision du serveur). OBLIGATOIRE : une source
   * dont l'accord a été révoqué n'est jamais affichée, même si le document la contient encore.
   */
  allowedCaptionRoles: readonly CaptionRole[];
}

export interface SceneAudioTrack {
  audioIndex: number;
  /** Gain total en dB (gain de la piste + automatisation à cet instant). */
  gainDb: number;
}

export interface Scene {
  editMs: number;
  /** Type de retour exact d'`editToSource` (null : hors du clip). */
  position: SourcePosition | GapPosition | null;
  background: string;
  /** Calques de l'image source (vides pendant un vide), du bas vers le haut. */
  layers: PlacedLayer[];
  /** Aplats OPAQUES actifs, en pixels de l'image SOURCE (vides pendant un vide). */
  masks: PixelRect[];
  /** Masques désactivés par le créateur (avertissement permanent). */
  disabledMaskIds: string[];
  /**
   * Effets visuels actifs (mode et activation appliqués), dans l'ordre d'application, avec leurs
   * paramètres (valeurs par défaut comprises) et leur fenêtre active (temps montage, s).
   */
  effects: {
    id: string;
    type: EffectTypeV2;
    region: PixelRect | null;
    params: Record<string, number>;
    startS: number;
    endS: number;
  }[];
  /** Sous-titres visibles (items de transcription et manuels). */
  captionIds: string[];
  /** Calques graphiques visibles, du bas vers le haut. */
  overlayIds: string[];
  audio: {
    /** Faux pendant un arrêt sur image, un vide, ou un export sans son. */
    sourceAudible: boolean;
    tracks: SceneAudioTrack[];
    /** Effets sonores actifs à cet instant. */
    sfxIds: string[];
  };
}

const asTiming = (t: TimingV2): Timing => t as unknown as Timing;

/** L'élément est-il visible à `t` (temps montage) ? */
function visibleAt(d: ClipProjectV2, timing: TimingV2, t: number): boolean {
  return resolveTiming(segmentsV2(d.segments), asTiming(timing)).ranges.some(
    (r) => r.editStartMs <= t && t < r.editEndMs,
  );
}

/** Plage visible en excluant les arrêts sur image (effets sonores ancrés au contenu). */
function playingAt(d: ClipProjectV2, timing: TimingV2, t: number): boolean {
  return resolveTiming(segmentsV2(d.segments), asTiming(timing)).ranges.some(
    (r) => !r.frozen && r.editStartMs <= t && t < r.editEndMs,
  );
}

/** Gain d'automatisation (dB) : linéaire entre les points, constant avant le premier et après le dernier. */
export function automationGainDb(
  points: readonly { srcMs: number; gainDb: number }[],
  srcMs: number,
): number {
  if (!points.length) return 0;
  if (srcMs <= points[0]!.srcMs) return points[0]!.gainDb;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (srcMs <= b.srcMs)
      return a.gainDb + ((b.gainDb - a.gainDb) * (srcMs - a.srcMs)) / (b.srcMs - a.srcMs);
  }
  return points.at(-1)!.gainDb;
}

/**
 * Calques d'un segment, en pixels, du bas vers le haut : surcharge du segment, sinon disposition
 * personnalisée, sinon disposition prédéfinie. Même calcul pour le canvas et le graphe FFmpeg.
 */
export function segmentLayers(
  d: ClipProjectV2,
  segmentId: string,
  o: Pick<SceneOptions, 'src' | 'out'>,
): PlacedLayer[] {
  const override = d.layout.overrides.find((x) => x.id === segmentId);
  const custom = override?.layers ?? (d.layout.preset === 'custom' ? d.layout.layers : null);
  if (!custom) {
    return presetLayers(
      { ...d.layout, preset: d.layout.preset as Exclude<typeof d.layout.preset, 'custom'> },
      o.src,
      o.out,
    ).sort((a, b) => a.z - b.z);
  }
  return custom
    .map((l) => ({
      role: l.role,
      crop: toPixelRect(l.crop, o.src.width, o.src.height),
      frame: toPixelRect(l.frame, o.out.width, o.out.height),
      z: l.z,
      blurred: false,
    }))
    .sort((a, b) => a.z - b.z);
}

/**
 * Point de l'image de SORTIE (fraction) où apparaît le centre d'une zone SOURCE : calque le plus
 * haut dont le recadrage contient ce centre ; centre de l'image si aucun calque ne le montre.
 * Sert de centre au zoom localisé (`zoom`), dans l'aperçu comme dans l'export.
 */
export function regionCenterOnOutput(
  layers: readonly PlacedLayer[],
  region: PixelRect,
  out: { width: number; height: number },
): { cx: number; cy: number } {
  const px = region.x + region.w / 2;
  const py = region.y + region.h / 2;
  for (const l of [...layers].reverse()) {
    if (l.blurred) continue;
    const c = l.crop;
    if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
      const fx = l.frame.x + ((px - c.x) / c.w) * l.frame.w;
      const fy = l.frame.y + ((py - c.y) / c.h) * l.frame.h;
      return {
        cx: Math.min(1, Math.max(0, fx / out.width)),
        cy: Math.min(1, Math.max(0, fy / out.height)),
      };
    }
  }
  return { cx: 0.5, cy: 0.5 };
}

/** Scène à l'instant `t` du montage. */
export function sceneAt(d: ClipProjectV2, t: EditMs | number, o: SceneOptions): Scene {
  const segs = segmentsV2(d.segments);
  const total = totalEditDuration(segs);
  const position = editToSource(segs, t as EditMs);
  const inSource = position?.kind === 'source';
  const srcMs = inSource ? (position as SourcePosition).srcMs : null;
  const frozen = inSource && (position as SourcePosition).frozen;

  const activeMasks = d.masks.filter((m) => srcMs !== null && maskActiveAt(m, srcMs));

  const tS = t / 1000;
  const effects =
    t >= 0 && t < total
      ? resolvedEffects(d)
          .filter((e) => EFFECT_CATALOG[e.type].category === 'visual')
          .filter((e) => e.startS <= tS && tS < e.endS)
          // Aucun effet localisé dans un vide (pas d'image source à traiter).
          .filter((e) => inSource || e.region === null)
          .map((e) => ({
            id: e.id,
            type: e.type,
            region: e.region ? toPixelRect(e.region, o.src.width, o.src.height) : null,
            params: e.params,
            startS: e.startS,
            endS: e.endS,
          }))
      : [];

  const items = d.captions.items.map((i) => {
    const ov = d.captions.overrides.find((x) => x.id === i.id);
    return {
      id: i.id,
      timing: {
        anchor: 'source' as const,
        srcStartMs: (ov?.srcStartMs ?? i.srcStartMs) as SourceMs,
        srcEndMs: (ov?.srcEndMs ?? i.srcEndMs) as SourceMs,
      },
      role: i.speakerRole,
    };
  });
  // Sources affichées = sources choisies ∩ sources autorisées aujourd'hui. Les sous-titres manuels
  // (écrits par le créateur, aucune voix de tiers) ne dépendent d'aucune source audio.
  const captionIds = !d.captions.enabled
    ? []
    : [
        ...items
          .filter(
            (i) => d.captions.sources.includes(i.role) && o.allowedCaptionRoles.includes(i.role),
          )
          .filter((i) => visibleAt(d, i.timing, t)),
        ...d.captions.manual
          .map((m) => ({
            id: m.id,
            timing: { anchor: 'source' as const, srcStartMs: m.srcStartMs, srcEndMs: m.srcEndMs },
          }))
          .filter((m) => visibleAt(d, m.timing, t)),
      ].map((x) => x.id);

  const overlayIds = d.overlays
    .filter((ov) => t >= 0 && t < total && visibleAt(d, ov.timing, t))
    .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
    .map((ov) => ov.id);

  const allowed = o.allowedAudioIndexes;
  const tracks =
    inSource && !frozen && !d.audio.silent
      ? d.audio.tracks
          .filter((tr) => tr.enabled && allowed.includes(tr.audioIndex))
          .map((tr) => ({
            audioIndex: tr.audioIndex,
            gainDb: tr.gainDb + automationGainDb(tr.automation, srcMs!),
          }))
      : [];
  // Audible seulement si au moins une piste autorisée ET activée est effectivement jouée.
  const sourceAudible = tracks.length > 0;
  const sfxIds = d.audio.silent
    ? []
    : d.audio.sfx
        .filter(
          (s) =>
            t >= 0 &&
            t < total &&
            (s.timing.anchor === 'edit' ? visibleAt(d, s.timing, t) : playingAt(d, s.timing, t)),
        )
        .map((s) => s.id);

  return {
    editMs: t,
    position,
    background: d.layout.background,
    layers: inSource ? segmentLayers(d, position!.segmentId, o) : [],
    masks: activeMasks
      .filter((m) => m.mode === 'opaque')
      .map((m) => toPixelRect(m.rect, o.src.width, o.src.height)),
    disabledMaskIds: d.masks.filter((m) => m.mode === 'off').map((m) => m.id),
    effects,
    captionIds,
    overlayIds,
    audio: { sourceAudible, tracks, sfxIds },
  };
}
