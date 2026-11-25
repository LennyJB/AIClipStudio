/**
 * Préréglages de rendu (docs/plan-etape-6.md §7.5) : même plan de rendu pour l'aperçu et
 * l'export, seules la définition et la qualité d'encodage changent.
 */

/** Version du moteur : entre dans l'empreinte du plan (un changement invalide les rendus). */
export const RENDER_ENGINE_VERSION = 1;

export type RenderKind = 'preview' | 'final';

export interface RenderPreset {
  kind: RenderKind;
  width: number;
  height: number;
  crf: number;
  x264Preset: string;
  audioBitrate: string;
}

export interface PresetConfig {
  finalCrf: number;
  x264Preset: string;
  previewHeight: number;
}

export const DEFAULT_PRESET_CONFIG: PresetConfig = {
  finalCrf: 18,
  x264Preset: 'medium',
  previewHeight: 960,
};

/** Résolution du projet (référence des sous-titres : PlayResX/Y). */
export const CANVAS = { width: 1080, height: 1920 } as const;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function presetFor(
  kind: RenderKind,
  cfg: PresetConfig = DEFAULT_PRESET_CONFIG,
): RenderPreset {
  if (kind === 'final') {
    return {
      kind,
      width: CANVAS.width,
      height: CANVAS.height,
      crf: cfg.finalCrf,
      x264Preset: cfg.x264Preset,
      audioBitrate: '192k',
    };
  }
  const height = even(Math.min(CANVAS.height, Math.max(320, cfg.previewHeight)));
  return {
    kind,
    width: even((height * 9) / 16),
    height,
    crf: 30,
    x264Preset: 'veryfast',
    audioBitrate: '128k',
  };
}

/** Fréquence de sortie : celle de la source, plafonnée à 60 i/s (30 si inconnue). */
export function outputFps(sourceFps: number | null): number {
  if (!sourceFps || !Number.isFinite(sourceFps) || sourceFps <= 0) return 30;
  return Math.min(60, Math.round(sourceFps * 1000) / 1000);
}
