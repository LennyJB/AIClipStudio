import { createHash } from 'node:crypto';

export type DerivativeKind =
  'audio_transcription' | 'audio_stem' | 'waveform' | 'video_proxy' | 'thumbnail';

export interface DerivativeSpec {
  sourceFingerprint: string;
  kind: DerivativeKind;
  audioIndex: number | null;
  /** Plage source en ms ; null = tout l'enregistrement. */
  range: { startMs: number; endMs: number } | null;
  params: Record<string, unknown>;
  generatorVersion: number;
}

/** JSON canonique : clés triées récursivement (même entrée → même chaîne). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Clé de cache d'un dérivé : identique ⇔ même original, même usage, mêmes paramètres. */
export function derivativeCacheKey(spec: DerivativeSpec): string {
  return sha256(
    canonicalJson({
      v: spec.generatorVersion,
      fp: spec.sourceFingerprint,
      kind: spec.kind,
      audio: spec.audioIndex,
      range: spec.range,
      params: spec.params,
    }),
  );
}
