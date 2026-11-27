import { z } from 'zod';

/**
 * Types de contenu d'un stream (étape 9). Un enregistrement n'a pas UN type : il est découpé
 * en segments horodatés, chacun avec son type, sa confiance et sa provenance. « Mixte » n'est
 * pas un type de segment : c'est le résumé d'un enregistrement qui contient plusieurs types.
 * `unknown` : la détection ne conclut pas (jamais un type imposé faute de mieux).
 */
export const CONTENT_TYPES = ['gaming', 'just_chatting', 'reaction', 'podcast', 'irl'] as const;
export const ContentTypeSchema = z.enum(CONTENT_TYPES);
export type ContentType = z.infer<typeof ContentTypeSchema>;
export const SegmentContentTypeSchema = z.enum([...CONTENT_TYPES, 'unknown']);
export type SegmentContentType = z.infer<typeof SegmentContentTypeSchema>;

export const CONTENT_TYPE_LABELS: Record<SegmentContentType, string> = {
  gaming: 'Gaming',
  just_chatting: 'Just Chatting',
  reaction: 'Réaction',
  podcast: 'Podcast / Discussion',
  irl: 'IRL',
  unknown: 'Indéterminé',
};

const nonEmpty = z.string().trim().min(1);

/**
 * Pondération du repérage local (mêmes clés que `LOCAL_SCORE_WEIGHTS` de @acs/editorial).
 * Somme = 1. Le volume sonore reste plafonné : un pic sonore seul ne crée jamais de fenêtre.
 */
export const LocalWeightsSchema = z
  .object({
    exchange: z.number().min(0).max(1),
    answeredQuestion: z.number().min(0).max(1),
    simultaneous: z.number().min(0).max(1),
    laughter: z.number().min(0).max(1),
    interjection: z.number().min(0).max(1),
    density: z.number().min(0).max(1),
    loudness: z.number().min(0).max(0.25),
    gameTerm: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 0.001,
    'la somme des poids doit valoir 1',
  );
export type LocalWeights = z.infer<typeof LocalWeightsSchema>;

/** Profil d'un type de contenu (profiles/content/<id>.json). */
export const ContentProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ContentTypeSchema,
    displayName: nonEmpty,
    /** Description du format, fournie comme contexte à l'analyse éditoriale. */
    context: nonEmpty,
    /** Ce qui fait un bon moment dans ce format. */
    analysisHints: z.array(nonEmpty).default([]),
    /**
     * Expressions caractéristiques du format (minuscules, sans accent requis) : indices de
     * TRANSCRIPTION, jamais suffisants seuls pour conclure (confiance plafonnée).
     */
    detectionCues: z.array(nonEmpty).default([]),
    /** Pondération propre au format ; absente : pondération historique (gaming). */
    localWeights: LocalWeightsSchema.optional(),
  })
  .strict();
export type ContentProfile = z.infer<typeof ContentProfileSchema>;

/** Segment saisi par le créateur (correction) : bornes en temps source, type ou indéterminé. */
export const ContentSegmentInputSchema = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
    type: SegmentContentTypeSchema,
  })
  .strict()
  .refine((s) => s.endMs > s.startMs, 'fin avant le début');
export type ContentSegmentInput = z.infer<typeof ContentSegmentInputSchema>;
