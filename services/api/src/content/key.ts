/**
 * Clé d'entrée d'une détection automatique des types de contenu (étape 9). Calculée en UN seul
 * endroit, utilisée à la fois pour enregistrer une détection et pour décider si une détection
 * existante est encore valable (analyse éditoriale, affichage).
 *
 * Elle couvre tout ce qui détermine la détection : original, transcriptions retenues, rôles des
 * pistes, profil de jeu, profils de contenu, présence de vidéo et version du détecteur.
 */
import { CONTENT_DETECTOR_VERSION, profileHash, stableHash } from '@acs/editorial';

export interface ContentKeyParts {
  fingerprint: string | undefined;
  transcriptions: readonly { id: string; segmentCount: number; completedAt: string | null }[];
  audioTracks: readonly { audioIndex: number; role: string }[];
  game: { id: string } & Record<string, unknown>;
  contentProfiles: unknown;
  hasVideo: boolean;
}

export function contentDetectionKey(
  p: ContentKeyParts,
  detectorVersion: string = CONTENT_DETECTOR_VERSION,
): string {
  return stableHash({
    v: detectorVersion,
    fp: p.fingerprint,
    transcriptions: p.transcriptions.map((t) => ({
      id: t.id,
      n: t.segmentCount,
      at: t.completedAt,
    })),
    roles: p.audioTracks.map((t) => [t.audioIndex, t.role]),
    game: { id: p.game.id, hash: profileHash(p.game) },
    content: profileHash(p.contentProfiles),
    video: p.hasVideo,
  });
}
