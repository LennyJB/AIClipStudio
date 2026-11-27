/**
 * Calques image (et mèmes) et effets sonores de la bibliothèque de médias (étape 7, PR 7f) :
 * placement en temps montage, PARTAGÉ par l'aperçu (canvas, Web Audio) et l'export (FFmpeg).
 *
 * Règles :
 *  - un calque image est visible sur les plages de son ancrage (contenu ou montage), bornées au
 *    clip ; il est étiré à son cadre (normalisé dans l'image 9:16) ; l'interface initialise le
 *    cadre avec le rapport de l'image ;
 *  - il est posé sur l'image COMPOSÉE (après aplats, disposition, zooms, secousse et éclair) et
 *    sous les sous-titres et calques texte : il ne touche jamais l'image source, donc jamais les
 *    aplats de confidentialité, qui sont posés avant et ne peuvent pas être « découverts » ;
 *  - un effet sonore ancré au CONTENU suit les coupes comme le son de l'enregistrement : chaque
 *    plage reprend le son à la position correspondante ; il se tait pendant les arrêts sur image
 *    et les vides. Ancré au MONTAGE, il est joué une fois à son instant. Le son n'est jamais
 *    prolongé au-delà de sa durée ni de la fin du clip ; export sans son ⇒ aucun effet sonore.
 */
import { placeSegments, resolveTiming, totalEditDuration, type Timing } from '../time';
import { segmentsV2, type ClipProjectV2, type TimingV2 } from './schema';

const asTiming = (t: TimingV2): Timing => t as unknown as Timing;

export interface ImageOverlayPlacement {
  id: string;
  assetId: string;
  kind: 'image' | 'meme';
  /** Plage en temps montage [startMs, endMs[. */
  startMs: number;
  endMs: number;
  frame: { x: number; y: number; w: number; h: number };
  opacity: number;
  z: number;
}

/** Plages visibles des calques image et mèmes (triées : ordre d'empilement, id, début). */
export function imageOverlayPlacements(d: ClipProjectV2): ImageOverlayPlacement[] {
  const segments = segmentsV2(d.segments);
  const total = totalEditDuration(segments);
  const out: ImageOverlayPlacement[] = [];
  for (const o of d.overlays) {
    if (o.kind === 'text' || !o.assetId) continue;
    for (const r of resolveTiming(segments, asTiming(o.timing)).ranges) {
      const startMs = Math.max(0, r.editStartMs);
      const endMs = Math.min(total, r.editEndMs);
      if (endMs <= startMs) continue;
      out.push({
        id: o.id,
        assetId: o.assetId,
        kind: o.kind,
        startMs,
        endMs,
        frame: o.frame,
        opacity: o.opacity,
        z: o.z,
      });
    }
  }
  return out.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1) || a.startMs - b.startMs);
}

/**
 * Cadre normalisé → pixels de l'image de sortie (W × H). Même arrondi pour le canvas et FFmpeg :
 * coin arrondi au pixel le plus proche, dimensions arrondies, au moins 1 px.
 */
export function overlayPixelRect(
  frame: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const x = Math.min(width - 1, Math.round(frame.x * width));
  const y = Math.min(height - 1, Math.round(frame.y * height));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width - x, Math.round(frame.w * width))),
    h: Math.max(1, Math.min(height - y, Math.round(frame.h * height))),
  };
}

export interface SfxPlacement {
  id: string;
  assetId: string;
  /** Plage jouée en temps montage [editStartMs, editEndMs[. */
  editStartMs: number;
  editEndMs: number;
  /** Position dans le son au début de la plage (ms). */
  offsetMs: number;
  gainDb: number;
}

/**
 * Plages jouées des effets sonores. `durations` : durée de chaque son (ms) ; un son dont la
 * durée est inconnue n'est PAS joué ici (l'appelant le refuse explicitement : média manquant).
 */
export function sfxPlacements(
  d: ClipProjectV2,
  durations: Readonly<Record<string, number>>,
): SfxPlacement[] {
  if (d.audio.silent) return [];
  const segments = segmentsV2(d.segments);
  const total = totalEditDuration(segments);
  const placed = new Map(placeSegments(segments).map((p) => [p.segment.id, p]));
  const out: SfxPlacement[] = [];
  for (const s of d.audio.sfx) {
    const dur = durations[s.assetId];
    if (dur === undefined || !(dur > 0)) continue;
    const push = (start: number, end: number, offset: number) => {
      let a = start;
      let off = offset;
      if (a < 0) {
        off -= a;
        a = 0;
      }
      const b = Math.min(end, total, a + (dur - off));
      if (b - a < 1 || off >= dur) return;
      out.push({
        id: s.id,
        assetId: s.assetId,
        editStartMs: Math.round(a),
        editEndMs: Math.round(b),
        offsetMs: Math.round(off),
        gainDb: s.gainDb,
      });
    };
    if (s.timing.anchor === 'edit') {
      const r = resolveTiming(segments, asTiming(s.timing)).ranges[0]!;
      push(r.editStartMs, r.editEndMs, 0);
      continue;
    }
    for (const r of resolveTiming(segments, asTiming(s.timing)).ranges) {
      if (r.frozen) continue; // silence pendant un arrêt sur image (comme l'enregistrement)
      const p = r.segmentId ? placed.get(r.segmentId) : undefined;
      if (!p || p.segment.kind !== 'source') continue;
      const srcAt = p.segment.srcStartMs + (r.editStartMs - p.editStartMs);
      push(r.editStartMs, r.editEndMs, srcAt - s.timing.srcStartMs);
    }
  }
  return out.sort((a, b) => a.editStartMs - b.editStartMs || (a.id < b.id ? -1 : 1));
}
