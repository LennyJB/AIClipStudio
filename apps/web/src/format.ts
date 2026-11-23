/** Temps source (ms) → « hh:mm:ss.mmm ». */
export function formatSourceMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  const milli = safe % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(milli, 3)}`;
}

/** Durée lisible : « 1 h 05 min », « 42 s ». */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export const ROLE_LABELS: Record<string, string> = {
  mic: 'Micro',
  discord: 'Discord',
  mix: 'Mix',
  game: 'Jeu',
  unknown: 'Piste',
};

/**
 * Périphérique RÉELLEMENT utilisé, d'après les blocs enregistrés.
 * « GPU » n'est affiché que si tous les blocs ont tourné sur CUDA.
 */
export function describeDevices(
  devicesUsed: readonly string[],
  fallbackError: string | null,
): string {
  const cuda = devicesUsed.includes('cuda');
  const cpu = devicesUsed.includes('cpu');
  if (cuda && cpu) return 'Mixte : GPU puis CPU (repli après échec CUDA)';
  if (cuda) return 'GPU (CUDA)';
  if (cpu) return fallbackError ? 'CPU (repli après échec CUDA)' : 'CPU';
  return '—';
}

export const STATUS_LABELS: Record<string, string> = {
  pending: 'En attente',
  running: 'En cours',
  completed: 'Terminée',
  failed: 'Échec',
  interrupted: 'Interrompue',
  cancelled: 'Annulée',
};

export const SUSPICION_LABELS: Record<string, string> = {
  no_speech: 'probablement pas de parole',
  low_logprob: 'faible confiance du modèle',
  repetition: 'texte répétitif',
  known_hallucination: 'phrase souvent inventée par Whisper',
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  queued: 'en attente',
  running: 'en cours',
  succeeded: 'terminé',
  failed: 'échec',
  interrupted: 'interrompu',
  cancelled: 'annulé',
};
