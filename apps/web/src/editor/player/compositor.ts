/**
 * Composition de l'aperçu sur canvas (docs/plan-etape-7.md §2.4, §5.3), à partir de la SCÈNE
 * partagée avec le plan FFmpeg (`sceneAt`) : même géométrie, mêmes masques, mêmes effets, mêmes
 * lignes de texte.
 *
 * Ordre (identique à l'export) :
 *   image source (proxy NON masqué, jamais affiché tel quel) → aplats OPAQUES sur l'image
 *   source → flou créatif → calques de la disposition → zooms → secousse → éclair →
 *   sous-titres → calques texte.
 * Le proxy n'est dessiné que dans un tampon hors écran ; les aplats y sont posés AVANT que la
 * moindre partie n'en soit copiée vers le canvas visible : aucune zone sensible ne peut s'afficher.
 *
 * Limite assumée (§2.4) : le texte (canvas contre libass) peut différer de quelques pixels ;
 * « Image exacte » (FFmpeg) fait foi.
 */
import {
  CAPTION_MARGIN_H,
  CAPTION_POSITIONS,
  flashAlphaAt,
  regionCenterOnOutput,
  shakeOffsetAt,
  TEXT_CANVAS,
  TEXT_OVERLAY_OUTLINE_PX,
  textOverlayFontPx,
  upperText,
  wrapWords,
  zoomFactorAt,
  type CaptionLine,
  type CaptionStyle,
  type PixelRect,
  type Scene,
  type TextOverlayLine,
} from '@acs/timeline';

export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): CanvasRenderingContext2D | null;
}

export interface FrameInput {
  scene: Scene;
  /** Image du proxy à l'instant source de la scène (null : pas encore chargée). */
  video: CanvasImageSource | null;
  videoSize: { width: number; height: number };
  /** Dimensions de l'enregistrement (repère des masques et recadrages de la scène). */
  src: { width: number; height: number };
  captions: readonly CaptionLine[];
  overlays: readonly TextOverlayLine[];
  globalStyle: CaptionStyle;
  /** Zooms de la facecam (`reaction_hold`) actifs : facteur à l'instant. */
  facecamZoom: number;
}

const FONT_FAMILY: Record<CaptionStyle['font'], { family: string; weight: number }> = {
  'Montserrat ExtraBold': { family: '"Montserrat ExtraBold"', weight: 800 },
  Inter: { family: '"Inter"', weight: 700 },
};

/** Rectangle source (pixels de l'enregistrement) → pixels du proxy, élargi vers l'extérieur. */
export function toProxyRect(
  r: PixelRect,
  src: { width: number; height: number },
  proxy: { width: number; height: number },
): PixelRect {
  const kx = proxy.width / src.width;
  const ky = proxy.height / src.height;
  const x = Math.floor(r.x * kx);
  const y = Math.floor(r.y * ky);
  return {
    x,
    y,
    w: Math.min(proxy.width - x, Math.ceil((r.x + r.w) * kx) - x),
    h: Math.min(proxy.height - y, Math.ceil((r.y + r.h) * ky) - y),
  };
}

export class Compositor {
  private readonly source: CanvasLike;
  private readonly work: CanvasLike;
  private readonly tmp: CanvasLike;

  constructor(
    private readonly out: CanvasLike,
    make: (w: number, h: number) => CanvasLike,
  ) {
    this.source = make(2, 2);
    this.work = make(out.width, out.height);
    this.tmp = make(out.width, out.height);
  }

  /** Tampon source après aplats (tests : vérification des pixels masqués). */
  sourceBuffer(): CanvasLike {
    return this.source;
  }

  render(f: FrameInput): void {
    const ctx = this.out.getContext('2d');
    const work = this.work.getContext('2d');
    if (!ctx || !work) return;
    const W = this.out.width;
    const H = this.out.height;
    const s = f.scene;
    work.save();
    work.fillStyle = s.background;
    work.fillRect(0, 0, W, H);
    work.restore();

    if (s.position?.kind === 'source' && f.video && s.layers.length) {
      this.prepareSource(f);
      for (const l of s.layers) this.drawLayer(work, l, f);
    }
    this.compositeEffects(work, f);

    ctx.save();
    ctx.drawImage(this.work as unknown as CanvasImageSource, 0, 0);
    ctx.restore();
    for (const line of f.captions) this.drawCaption(ctx, line, f.globalStyle, s.editMs);
    for (const o of f.overlays) {
      if (s.editMs >= o.startMs && s.editMs < o.endMs) this.drawOverlay(ctx, o);
    }
  }

  /** Image source → tampon hors écran, aplats OPAQUES puis flou créatif. */
  private prepareSource(f: FrameInput) {
    const { width: pw, height: ph } = f.videoSize;
    if (this.source.width !== pw || this.source.height !== ph) {
      this.source.width = pw;
      this.source.height = ph;
    }
    const c = this.source.getContext('2d')!;
    c.save();
    c.filter = 'none';
    c.globalAlpha = 1;
    c.drawImage(f.video!, 0, 0, pw, ph);
    // Aplats : posés AVANT toute copie du tampon (protection de confidentialité).
    c.fillStyle = '#000000';
    for (const m of f.scene.masks) {
      const r = toProxyRect(m, f.src, f.videoSize);
      c.fillRect(r.x, r.y, r.w, r.h);
    }
    c.restore();
    // Flou créatif APRÈS les aplats (jamais une protection).
    for (const e of f.scene.effects) {
      if (e.type !== 'blur_region' || !e.region) continue;
      const r = toProxyRect(e.region, f.src, f.videoSize);
      const t = this.tmp.getContext('2d')!;
      if (this.tmp.width < r.w || this.tmp.height < r.h) {
        this.tmp.width = Math.max(this.tmp.width, r.w);
        this.tmp.height = Math.max(this.tmp.height, r.h);
      }
      t.save();
      t.clearRect(0, 0, r.w, r.h);
      t.drawImage(this.source as unknown as CanvasImageSource, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      t.restore();
      c.save();
      c.filter = `blur(${((e.params['sigma'] ?? 20) * pw) / f.src.width}px)`;
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
      c.clip();
      c.drawImage(this.tmp as unknown as CanvasImageSource, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      c.restore();
    }
  }

  private drawLayer(work: CanvasRenderingContext2D, l: Scene['layers'][number], f: FrameInput) {
    let crop = toProxyRect(l.crop, f.src, f.videoSize);
    if (l.role === 'facecam' && f.facecamZoom > 1) {
      // Zoom de la facecam : centre du calque, comme `zoompan` sur le calque.
      const w = crop.w / f.facecamZoom;
      const h = crop.h / f.facecamZoom;
      crop = { x: crop.x + (crop.w - w) / 2, y: crop.y + (crop.h - h) / 2, w, h };
    }
    work.save();
    if (l.blurred) work.filter = `blur(${Math.max(4, Math.round((30 * this.out.width) / 1080))}px)`;
    work.drawImage(
      this.source as unknown as CanvasImageSource,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      l.frame.x,
      l.frame.y,
      l.frame.w,
      l.frame.h,
    );
    work.restore();
  }

  private compositeEffects(work: CanvasRenderingContext2D, f: FrameInput) {
    const W = this.out.width;
    const H = this.out.height;
    const t = f.scene.editMs / 1000;
    const fx = f.scene.effects;
    const zooms = fx
      .filter((e) => e.type === 'punch_zoom' || e.type === 'zoom')
      .map((e) => ({
        startS: e.startS,
        endS: e.endS,
        factor: Math.min(e.type === 'zoom' ? 3 : 1.3, Math.max(1, e.params['factor'] ?? 1)),
      }));
    const tmp = this.tmp.getContext('2d')!;
    const copy = () => {
      if (this.tmp.width !== W || this.tmp.height !== H) {
        this.tmp.width = W;
        this.tmp.height = H;
      }
      tmp.clearRect(0, 0, W, H);
      tmp.drawImage(this.work as unknown as CanvasImageSource, 0, 0);
    };
    const z = zoomFactorAt(zooms, t);
    if (z > 1.0001) {
      let center = { cx: 0.5, cy: 0.5 };
      for (const e of fx) {
        if (e.type === 'zoom' && e.region && e.startS <= t && t <= e.endS) {
          center = regionCenterOnOutput(f.scene.layers, e.region, { width: W, height: H });
        }
      }
      const w = W / z;
      const h = H / z;
      const sx = Math.min(Math.max(center.cx * W - w / 2, 0), W - w);
      const sy = Math.min(Math.max(center.cy * H - h / 2, 0), H - h);
      copy();
      work.drawImage(this.tmp as unknown as CanvasImageSource, sx, sy, w, h, 0, 0, W, H);
    }
    let dx = 0;
    let dy = 0;
    for (const e of fx) {
      if (e.type !== 'shake') continue;
      const o = shakeOffsetAt(
        {
          startS: e.startS,
          endS: e.endS,
          amplitude: Math.min(0.05, e.params['amplitude'] ?? 0.01),
        },
        t,
        W,
      );
      dx += o.dx;
      dy += o.dy;
    }
    if (dx || dy) {
      copy();
      work.drawImage(this.tmp as unknown as CanvasImageSource, dx, dy);
    }
    for (const e of fx) {
      if (e.type !== 'flash') continue;
      const a = flashAlphaAt(
        { startS: e.startS, endS: e.endS, intensity: Math.min(1, e.params['intensity'] ?? 0.8) },
        t,
      );
      if (a <= 0) continue;
      work.save();
      work.globalAlpha = a;
      work.fillStyle = '#FFFFFF';
      work.fillRect(0, 0, W, H);
      work.restore();
    }
  }

  private drawCaption(
    ctx: CanvasRenderingContext2D,
    line: CaptionLine,
    global: CaptionStyle,
    editMs: number,
  ) {
    if (editMs < line.startMs || editMs >= line.endMs) return;
    const style = line.style ?? global;
    const k = this.out.width / TEXT_CANVAS.width;
    const size = (line.emphasize ? style.sizePx * 1.08 : style.sizePx) * k;
    const words = (line.words?.length ? line.words.map((w) => w.text) : line.text.split(' '))
      .map((w) => upperText(w, style.uppercase))
      .filter(Boolean);
    const wrapped = wrapWords(words, style.maxCharsPerLine, style.maxLines);
    const font = FONT_FAMILY[style.font];
    const lh = size * 1.2;
    const blockH = lh * wrapped.length;
    const pos = CAPTION_POSITIONS[style.position];
    let top: number;
    let cx = this.out.width / 2;
    if (line.position) {
      cx = line.position.x * this.out.width;
      top = line.position.y * this.out.height - blockH / 2;
    } else if (pos.alignment === 2) top = this.out.height - pos.marginV * k - blockH;
    else if (pos.alignment === 8) top = pos.marginV * k;
    else top = (this.out.height - blockH) / 2;
    ctx.save();
    ctx.font = `${font.weight} ${size}px ${font.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const maxW = this.out.width - 2 * CAPTION_MARGIN_H * k;
    let index = 0;
    wrapped.forEach((ln, i) => {
      const y = top + lh * i + lh / 2;
      const text = ln.join(' ');
      if (style.shadow) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillText(text, cx + 2 * k, y + 2 * k, maxW);
      }
      if (style.outlinePx > 0) {
        ctx.strokeStyle = style.outlineColor;
        ctx.lineWidth = style.outlinePx * 2 * k;
        ctx.strokeText(text, cx, y, maxW);
      }
      // Mot prononcé : couleur de mise en évidence une fois son instant atteint (karaoké).
      if (style.karaoke && line.words && !line.emphasize) {
        const total = ctx.measureText(text).width;
        let x = cx - total / 2;
        ctx.textAlign = 'left';
        for (const w of ln) {
          const src = line.words[index++];
          const shown = upperText(w, style.uppercase);
          ctx.fillStyle = src && editMs >= src.startMs ? style.highlightColor : style.color;
          ctx.fillText(shown, x, y);
          x += ctx.measureText(`${shown} `).width;
        }
        ctx.textAlign = 'center';
      } else {
        ctx.fillStyle = line.emphasize ? style.highlightColor : style.color;
        ctx.fillText(text, cx, y, maxW);
      }
    });
    ctx.restore();
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, o: TextOverlayLine) {
    const k = this.out.width / TEXT_CANVAS.width;
    const size = textOverlayFontPx(o.frame.h) * k;
    ctx.save();
    ctx.globalAlpha = o.opacity;
    ctx.font = `800 ${size}px "Montserrat ExtraBold"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const cx = (o.frame.x + o.frame.w / 2) * this.out.width;
    const cy = (o.frame.y + o.frame.h / 2) * this.out.height;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = TEXT_OVERLAY_OUTLINE_PX * 2 * k;
    ctx.strokeText(o.text, cx, cy);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(o.text, cx, cy);
    ctx.restore();
  }
}
