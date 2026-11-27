/**
 * Libellés des anomalies d'un enregistrement (étape 8). Les anomalies « graves » rendent le
 * fichier `degraded` : il n'est jamais présenté comme parfaitement valide.
 */
export const WARNING_LABELS: Record<string, string> = {
  duration_unknown: 'durée inconnue (les traitements la déduiront de l’audio)',
  no_audio: 'aucune piste audio',
  no_video: 'aucune piste vidéo',
  audio_track_offset: 'une piste audio commence après le début du fichier (décalage compensé)',
  video_track_offset: 'la vidéo commence après le début du fichier (décalage compensé)',
  unexpected_container: 'conteneur inhabituel',
  duration_estimated: 'durée estimée par le conteneur, mesurée à l’import',
  duration_mismatch: 'durées incohérentes : durée réelle mesurée à l’import',
  audio_track_short: 'une piste audio s’arrête bien avant la fin (fin muette)',
  audio_metadata_incomplete: 'métadonnées audio incomplètes (codec, fréquence ou canaux)',
  truncated: 'fichier incomplet (tronqué) : seule la partie lisible est exploitable',
  decode_errors: 'erreurs de lecture détectées : certains passages peuvent être inexploitables',
  track_roles_from_config:
    'rôles des pistes supposés d’après leur ordre (pistes sans nom) : export et sous-titres bloqués jusqu’à confirmation',
};

export const warningLabel = (w: string) => WARNING_LABELS[w] ?? w;
