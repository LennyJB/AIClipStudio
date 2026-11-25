/**
 * Géométrie des dispositions 9:16 (étape 7, plan §2.4) : rectangles normalisés → pixels, recadrage
 * au rapport voulu, rectangles de chaque calque. Code PUR, partagé : le plan FFmpeg
 * (`@acs/render`) et l'aperçu canvas du navigateur calculent EXACTEMENT les mêmes rectangles.
 *
 * Les règles d'arrondi sont celles de l'étape 6 (`@acs/media` frames.ts, `@acs/render`
 * layout.ts) : dimensions paires ≥ 2, positions paires ≥ 0. Elles sont testées à l'identique.
 */

/** Rectangle normalisé (0..1). */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Dimension paire (≥ 2). */
export const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
/** Position paire (≥ 0). */
export const evenPos = (n: number) => Math.max(0, Math.floor(n / 2) * 2);

/** Rectangle normalisé → pixels (dimensions paires, toujours dans l'image). */
export function toPixelRect(r: NormRect, width: number, height: number): PixelRect {
  const x = Math.min(width - 2, Math.max(0, Math.floor(r.x * width)));
  const y = Math.min(height - 2, Math.max(0, Math.floor(r.y * height)));
  const w = even(Math.min(width - x, Math.ceil(r.w * width)));
  const h = even(Math.min(height - y, Math.ceil(r.h * height)));
  return { x, y, w, h };
}

/** Plus grand rectangle d'un rapport donné dans `r`, décalé horizontalement selon `focusX`. */
export function cropToAspect(r: PixelRect, aspect: number, focusX = 0.5): PixelRect {
  const w = even(Math.min(r.w, r.h * aspect));
  const h = even(Math.min(r.h, w / aspect));
  const x = r.x + evenPos(Math.max(0, Math.min(1, focusX)) * (r.w - w));
  const y = r.y + evenPos((r.h - h) / 2);
  return { x, y, w, h };
}

/** Champs de disposition communs aux documents v1 et v2. */
export interface PresetLayoutInput {
  preset: 'facecam_top' | 'gameplay_crop' | 'blurred_fit';
  gameplayRect: NormRect;
  facecamRect: NormRect | null;
  focusX: number;
  facecamShare: number;
}

export interface PresetGeometry {
  /** Rectangle source du gameplay. */
  gameplay: PixelRect;
  /** Rectangle source de la facecam (facecam_top), null sinon. */
  facecam: PixelRect | null;
  /** Hauteur de la bande facecam (facecam_top), 0 sinon. */
  facecamHeight: number;
}

/**
 * Rectangles SOURCE des dispositions prédéfinies : la fonction utilisée par le moteur de
 * l'étape 6 (`computeGeometry`), désormais partagée avec l'aperçu.
 */
export function presetGeometry(
  layout: PresetLayoutInput,
  src: { width: number; height: number },
  out: { width: number; height: number },
): PresetGeometry {
  const g = toPixelRect(layout.gameplayRect, src.width, src.height);
  if (layout.preset === 'facecam_top') {
    if (!layout.facecamRect) throw new RangeError('disposition facecam_top sans facecam');
    const top = even(out.height * layout.facecamShare);
    const bottom = out.height - top;
    const f = toPixelRect(layout.facecamRect, src.width, src.height);
    return {
      facecam: cropToAspect(f, out.width / top, 0.5),
      gameplay: cropToAspect(g, out.width / bottom, layout.focusX),
      facecamHeight: top,
    };
  }
  if (layout.preset === 'gameplay_crop') {
    return {
      facecam: null,
      gameplay: cropToAspect(g, out.width / out.height, layout.focusX),
      facecamHeight: 0,
    };
  }
  return { facecam: null, gameplay: { ...g, w: even(g.w), h: even(g.h) }, facecamHeight: 0 };
}

/** Calque placé : zone de l'image SOURCE (`crop`) dessinée dans la zone de SORTIE (`frame`). */
export interface PlacedLayer {
  role: 'gameplay' | 'facecam' | 'background';
  crop: PixelRect;
  frame: PixelRect;
  /** Ordre d'empilement (croissant = dessiné plus tard, donc au-dessus). */
  z: number;
  /** Fond flouté (blurred_fit) : effet visuel de mise en page, jamais une protection. */
  blurred: boolean;
}

/** Calques des dispositions prédéfinies, en pixels (même calcul que le graphe FFmpeg). */
export function presetLayers(
  layout: PresetLayoutInput,
  src: { width: number; height: number },
  out: { width: number; height: number },
): PlacedLayer[] {
  const geo = presetGeometry(layout, src, out);
  const W = out.width;
  const H = out.height;
  if (layout.preset === 'facecam_top') {
    const top = geo.facecamHeight;
    return [
      {
        role: 'facecam',
        crop: geo.facecam!,
        frame: { x: 0, y: 0, w: W, h: top },
        z: 1,
        blurred: false,
      },
      {
        role: 'gameplay',
        crop: geo.gameplay,
        frame: { x: 0, y: top, w: W, h: H - top },
        z: 0,
        blurred: false,
      },
    ];
  }
  if (layout.preset === 'gameplay_crop') {
    return [
      {
        role: 'gameplay',
        crop: geo.gameplay,
        frame: { x: 0, y: 0, w: W, h: H },
        z: 0,
        blurred: false,
      },
    ];
  }
  const bg = cropToAspect(geo.gameplay, W / H, layout.focusX);
  const fgH = even(Math.min(H, (W * geo.gameplay.h) / geo.gameplay.w));
  return [
    { role: 'background', crop: bg, frame: { x: 0, y: 0, w: W, h: H }, z: 0, blurred: true },
    {
      role: 'gameplay',
      crop: geo.gameplay,
      frame: { x: 0, y: evenPos((H - fgH) / 2), w: W, h: fgH },
      z: 1,
      blurred: false,
    },
  ];
}
