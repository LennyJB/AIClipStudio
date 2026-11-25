import { ApiError, type MissingRequirement, type VoiceCategory } from '../../api';

/** Messages en français des codes d'erreur de l'API (le message du serveur reste prioritaire). */
const CODE_MESSAGES: Record<string, string> = {
  VERSION_CONFLICT: 'Le projet a été modifié ailleurs : rechargez-le.',
  PROPOSAL_NOT_ACCEPTED: 'La proposition n’est plus acceptée : le projet est en lecture seule.',
  EXPORT_CONSENT_REQUIRED: 'Refusé : un accord ou une déclaration manque pour cet audio.',
  DURATION_OUT_OF_RANGE: 'Durée hors plage : confirmez-la explicitement avant l’export.',
  DISK_SPACE_LOW: 'Espace disque insuffisant pour ce rendu.',
  MEDIA_SOURCE_CHANGED: 'L’original a été modifié depuis l’import.',
  MEDIA_NOT_FOUND: 'Original introuvable.',
  TOOL_MISSING: 'FFmpeg est introuvable sur ce poste.',
  RENDER_FAILED: 'Le rendu a échoué.',
  VALIDATION_FAILED: 'Réglage refusé par le serveur.',
  NOT_FOUND: 'Élément introuvable.',
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Serveur injoignable : vérifiez qu’il est démarré.';
    return err.message || (err.code ? CODE_MESSAGES[err.code] : undefined) || 'Erreur inconnue';
  }
  if (err instanceof TypeError) return 'Serveur injoignable : vérifiez qu’il est démarré.';
  return err instanceof Error ? err.message : String(err);
}

/** Erreur réseau (aucune réponse du serveur) : la même requête peut être renvoyée. */
export const isNetworkError = (err: unknown) =>
  err instanceof TypeError || (err instanceof ApiError && err.status === 0);

export const CATEGORY_LABELS: Record<VoiceCategory, string> = {
  discord_voices: 'voix Discord',
  game_voice_chat: 'chat vocal du jeu',
  other_voices: 'autres voix de tiers',
};

const DECLARATION_LABELS: Record<string, string> = {
  mix_composition: 'composition de la piste « Tout » non déclarée',
  game_composition: 'présence du chat vocal dans la piste Jeu non déclarée',
  mic_composition: 'composition du micro non déclarée',
};

export function describeMissing(missing: readonly MissingRequirement[]): string {
  return missing
    .map((m) =>
      m.kind === 'declaration'
        ? (DECLARATION_LABELS[m.subject] ?? m.subject)
        : `accord requis : ${CATEGORY_LABELS[m.subject]}`,
    )
    .join(' ; ');
}

export const RENDER_STATUS_LABELS: Record<string, string> = {
  queued: 'en attente',
  running: 'en cours',
  finalizing: 'finalisation',
  succeeded: 'terminé',
  failed: 'échec',
  cancelled: 'annulé',
  evicted: 'aperçu supprimé (nettoyage)',
};

export const DECISION_LABELS: Record<string, string> = {
  pending: 'en attente de revue',
  accepted: 'acceptée',
  rejected: 'refusée',
};

export const LAYOUT_LABELS: Record<string, string> = {
  facecam_top: 'Facecam en haut, jeu en bas',
  gameplay_crop: 'Jeu recadré plein écran',
  blurred_fit: 'Jeu entier sur fond flou',
};

export const EFFECT_LABELS: Record<string, string> = {
  caption_emphasis: 'Mise en valeur de la chute (sous-titres)',
  punch_zoom: 'Zoom bref sur la chute',
  reaction_hold: 'Zoom léger sur la réaction',
};
