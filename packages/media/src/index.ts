/**
 * @acs/media — intégration FFmpeg/ffprobe (étape 2).
 * Responsabilités prévues : lecture des métadonnées, inventaire des pistes,
 * extraction audio, images représentatives. Les originaux ne sont jamais
 * modifiés : toute sortie est écrite dans storage/processing/.
 */
export const MEDIA_PACKAGE = '@acs/media' as const;
