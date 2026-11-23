import { z } from 'zod';

/**
 * Schémas des profils. Deux axes indépendants :
 *  - le profil CRÉATEUR (identité éditoriale, indépendante du jeu) ;
 *  - le profil de JEU (vocabulaire, événements, contexte propre au jeu).
 * Les profils sont des fichiers JSON dans /profiles, validés au chargement.
 */

const nonEmpty = z.string().trim().min(1);

/** Catégories éditoriales de moments (communes à tous les jeux). */
export const MomentCategorySchema = z.enum([
  'humour',
  'interaction',
  'absurde',
  'malentendu',
  'dispute_amusante',
  'reaction',
  'inattendu',
  'performance',
  'autre',
]);
export type MomentCategory = z.infer<typeof MomentCategorySchema>;

export const GameProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]+$/, 'identifiant en kebab-case attendu'),
    displayName: nonEmpty,
    /** Description courte du jeu, fournie comme contexte à l'analyse. */
    context: nonEmpty,
    /** Termes propres au jeu (aide la transcription et la compréhension). */
    vocabulary: z.array(nonEmpty).default([]),
    /** Événements de jeu notables : contexte, jamais critère unique. */
    notableEvents: z.array(nonEmpty).default([]),
    /** Consignes spécifiques au jeu pour l'analyse éditoriale. */
    analysisHints: z.array(nonEmpty).default([]),
  })
  .strict();
export type GameProfile = z.infer<typeof GameProfileSchema>;

export const EditingModeSchema = z.enum(['fidele', 'enrichi']);

export const CreatorProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: nonEmpty,
    language: z.string().regex(/^[a-z]{2}$/, 'code langue ISO 639-1 attendu'),
    /** Ce que le créateur considère comme un bon clip. */
    editorialPriorities: z.array(nonEmpty).min(1),
    /** Ce qu'il faut éviter de sélectionner. */
    avoid: z.array(nonEmpty).default([]),
    /** Pondération des catégories (0 = ignorer, 1 = priorité maximale). */
    categoryWeights: z.partialRecord(MomentCategorySchema, z.number().min(0).max(1)).default({}),
    clipDuration: z
      .object({
        minSeconds: z.number().positive(),
        maxSeconds: z.number().positive(),
        /** Contexte minimal conservé avant la chute d'un échange. */
        preferredLeadInSeconds: z.number().nonnegative(),
      })
      .strict()
      .refine((d) => d.minSeconds < d.maxSeconds, 'minSeconds doit être < maxSeconds'),
    editingStyle: z
      .object({
        defaultMode: EditingModeSchema,
        fidele: z.array(nonEmpty),
        enrichi: z.array(nonEmpty),
        /** Règles absolues (pas de dialogue inventé, pas d'effet gratuit…). */
        rules: z.array(nonEmpty).min(1),
      })
      .strict(),
  })
  .strict();
export type CreatorProfile = z.infer<typeof CreatorProfileSchema>;
