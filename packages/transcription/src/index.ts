/**
 * @acs/transcription — pont Node ↔ Faster-Whisper (étape 3).
 * Le worker Python (./python) est lancé via child_process sans shell,
 * avec des arguments contrôlés, et renvoie du JSON validé par Zod.
 */
export const TRANSCRIPTION_PACKAGE = '@acs/transcription' as const;
