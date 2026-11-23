import type { TranscriptionDto } from './repository';

/**
 * Les durées et facteurs temps réel de plusieurs transcriptions ne sont comparables que si
 * chacune a tourné sur UN SEUL périphérique, le même pour toutes. Une transcription mixte
 * (GPU puis CPU après repli) n'est jamais comparable. Les transcriptions sans aucun bloc
 * enregistré (pas encore démarrées, échec immédiat) n'ont pas de durée : elles sont ignorées.
 */
export function devicesComparable(
  transcriptions: readonly Pick<TranscriptionDto, 'devicesUsed'>[],
): boolean {
  const measured = transcriptions.filter((t) => t.devicesUsed.length > 0);
  if (measured.some((t) => t.devicesUsed.length > 1)) return false;
  return new Set(measured.map((t) => t.devicesUsed[0])).size <= 1;
}
