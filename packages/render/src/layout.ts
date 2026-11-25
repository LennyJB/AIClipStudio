/**
 * Dispositions 9:16 (docs/plan-etape-6.md §7.2) → graphe de filtres FFmpeg vidéo.
 *
 * Le graphe est construit UNIQUEMENT à partir de nombres validés et d'énumérations : aucun texte
 * (transcription, titre, chemin) n'y entre jamais. Les zones sensibles sont recouvertes d'aplats
 * opaques sur l'image SOURCE, avant tout recadrage (même approche que `frames.ts`) : elles ne
 * peuvent réapparaître dans aucun calque (fond flouté et facecam compris).
 */
import { opaqueMaskFilters, toPixelRect } from '@acs/media';
import {
  cropToAspect,
  even,
  evenPos,
  presetGeometry,
  type ClipProject,
  type PixelRect,
} from '@acs/timeline';

export { cropToAspect };
export type { PixelRect };

/** Fenêtre de zoom en temps montage (secondes), facteur maximal atteint au plateau. */
export interface ZoomWindow {
  startS: number;
  endS: number;
  factor: number;
}

export interface VideoGraphInput {
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  fps: number;
  layout: ClipProject['layout'];
  /** Zoom sur l'image composée (effet punch_zoom). */
  zooms: readonly ZoomWindow[];
  /** Zoom sur la facecam seule (effet reaction_hold, disposition facecam_top). */
  facecamZooms: readonly ZoomWindow[];
  /** Nom relatif (dans le dossier de travail) du fichier ASS, ou null sans sous-titres. */
  subtitlesFile: string | null;
  /** Nom relatif du dossier de polices fournies. */
  fontsDir: string;
}

const num = (n: number) => {
  if (!Number.isFinite(n)) throw new RangeError('valeur non finie dans le graphe');
  return Number(n.toFixed(4)).toString();
};

const crop = (r: PixelRect) => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;

/** Expression de facteur de zoom : montée et descente de 0,25 s, plateau au facteur demandé. */
export function zoomExpression(windows: readonly ZoomWindow[]): string {
  if (!windows.length) return '1';
  const ramp = 0.25;
  return `1${windows
    .map(
      (w) =>
        `+${num(w.factor - 1)}*clip(min((it-${num(w.startS)})/${ramp},(${num(w.endS)}-it)/${ramp}),0,1)`,
    )
    .join('')}`;
}

function zoompan(windows: readonly ZoomWindow[], w: number, h: number, fps: number): string {
  // Expressions entre apostrophes : leurs virgules ne séparent pas les filtres pour le parseur de
  // graphes de FFmpeg. Les valeurs viennent exclusivement de nombres validés.
  return `zoompan=z='${zoomExpression(windows)}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${num(fps)}`;
}

export interface VideoGeometry {
  masks: PixelRect[];
  gameplay: PixelRect;
  facecam: PixelRect | null;
  /** Hauteur de la bande facecam (facecam_top), 0 sinon. */
  facecamHeight: number;
}

/** Géométrie source : fonction partagée avec l'aperçu de l'éditeur (`@acs/timeline`, étape 7). */
export function computeGeometry(i: VideoGraphInput): VideoGeometry {
  const masks = i.layout.masks
    .filter((m) => m.mode === 'opaque')
    .map((m) => toPixelRect(m.rect, i.srcWidth, i.srcHeight));
  const geo = presetGeometry(
    i.layout,
    { width: i.srcWidth, height: i.srcHeight },
    { width: i.outWidth, height: i.outHeight },
  );
  return { masks, ...geo };
}

/**
 * Graphe vidéo complet : [0:v] → [v]. Ordre : cadence, aplats opaques (image source), remise à
 * zéro des horodatages, disposition, zoom, sous-titres, format final.
 */
export function buildVideoGraph(i: VideoGraphInput): string {
  const geo = computeGeometry(i);
  const W = i.outWidth;
  const H = i.outHeight;
  const base = [
    `fps=${num(i.fps)}`,
    ...opaqueMaskFilters(
      i.layout.masks.filter((m) => m.mode === 'opaque').map((m) => m.rect),
      i.srcWidth,
      i.srcHeight,
    ),
    'setpts=PTS-STARTPTS',
  ].join(',');
  const parts: string[] = [];
  const scale = (w: number, h: number) => `scale=${w}:${h}:flags=lanczos,setsar=1`;

  if (i.layout.preset === 'facecam_top') {
    const top = geo.facecamHeight;
    const bottom = H - top;
    const camZoom = i.facecamZooms.length ? `,${zoompan(i.facecamZooms, W, top, i.fps)}` : '';
    parts.push(
      `[0:v]${base},split=2[cam_in][game_in]`,
      `[cam_in]${crop(geo.facecam!)},${scale(W, top)}${camZoom}[cam]`,
      `[game_in]${crop(geo.gameplay)},${scale(W, bottom)}[game]`,
      `[cam][game]vstack=inputs=2[comp]`,
    );
  } else if (i.layout.preset === 'gameplay_crop') {
    parts.push(`[0:v]${base},${crop(geo.gameplay)},${scale(W, H)}[comp]`);
  } else {
    // Fond : même gameplay recadré en 9:16, agrandi et flouté ; premier plan : gameplay entier.
    const bg = cropToAspect(geo.gameplay, W / H, i.layout.focusX);
    const fgH = even(Math.min(H, (W * geo.gameplay.h) / geo.gameplay.w));
    const sigma = Math.max(4, Math.round((30 * W) / 1080));
    parts.push(
      `[0:v]${base},split=2[bg_in][fg_in]`,
      `[bg_in]${crop(bg)},${scale(W, H)},gblur=sigma=${sigma}[bg]`,
      `[fg_in]${crop(geo.gameplay)},${scale(W, fgH)}[fg]`,
      `[bg][fg]overlay=0:${evenPos((H - fgH) / 2)}[comp]`,
    );
  }
  const tail = [
    ...(i.zooms.length ? [zoompan(i.zooms, W, H, i.fps)] : []),
    ...(i.subtitlesFile
      ? [`subtitles=${safeName(i.subtitlesFile)}:fontsdir=${safeName(i.fontsDir)}`]
      : []),
    'format=yuv420p',
  ];
  parts.push(`[comp]${tail.join(',')}[v]`);
  return parts.join(';');
}

/** Noms de fichiers du graphe : relatifs, simples, sans caractère interprétable par FFmpeg. */
export function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u.test(name) || name.includes('..')) {
    throw new RangeError(`nom de fichier refusé dans le graphe : ${name}`);
  }
  return name;
}
