import { z } from 'zod';

/**
 * Schémas liés à l'analyse éditoriale (étape 4) qui vivent dans des fichiers :
 *  - profils de CADRAGE (profiles/framing/*.json, versionnés) ;
 *  - fichier de CONFIDENTIALITÉ (pseudonymes, hors dépôt : il contient des noms réels).
 */

const nonEmpty = z.string().trim().min(1);
const unit = z.number().min(0).max(1);
const size = z.number().gt(0).max(1);
const EPS = 1e-9;

/** Rectangle en coordonnées NORMALISÉES (0..1) de l'image source : indépendant de la résolution. */
export const NormRectSchema = z
  .object({ x: unit, y: unit, w: size, h: size })
  .strict()
  .refine((r) => r.x + r.w <= 1 + EPS && r.y + r.h <= 1 + EPS, 'le rectangle sort de l’image');
export type NormRect = z.infer<typeof NormRectSchema>;

export const FramingMaskSchema = z
  .object({ label: nonEmpty.max(60), x: unit, y: unit, w: size, h: size })
  .strict()
  .refine((r) => r.x + r.w <= 1 + EPS && r.y + r.h <= 1 + EPS, 'la zone masquée sort de l’image');
export type FramingMask = z.infer<typeof FramingMaskSchema>;

/**
 * Profil de cadrage : où se trouvent le gameplay et la facecam dans l'image enregistrée,
 * et quelles zones masquer (pseudos, incrustation Discord, chat…) avant tout envoi.
 * Un profil n'est utilisé pour un enregistrement qu'après validation explicite (aperçu).
 */
export const FramingProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]+$/, 'identifiant en kebab-case attendu'),
    displayName: nonEmpty.max(80),
    description: z.string().max(500).optional(),
    /** Zone de gameplay envoyée (recadrage). */
    gameplay: NormRectSchema,
    /** Position de la facecam dans l'image, ou null s'il n'y en a pas. Masquée sauf accord. */
    facecam: NormRectSchema.nullable(),
    /** Zones toujours masquées (aplat opaque) avant envoi. */
    masks: z.array(FramingMaskSchema).max(20).default([]),
  })
  .strict();
export type FramingProfile = z.infer<typeof FramingProfileSchema>;

/**
 * Fichier de confidentialité (ANALYSIS_PRIVACY_FILE, hors dépôt).
 * Chaque entrée regroupe les façons d'écrire le nom d'une même personne ;
 * elles sont remplacées par une étiquette stable avant tout envoi.
 */
export const PrivacyFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    pseudonyms: z
      .array(
        z
          .object({
            names: z.array(nonEmpty.max(100)).min(1).max(20),
            /** Étiquette affichée à la place du nom (sinon « Personne A », « Personne B »…). */
            label: z
              .string()
              .regex(/^[\p{L}\p{N} '’-]{1,40}$/u, 'lettres, chiffres, espaces et tirets uniquement')
              .optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();
export type PrivacyFile = z.infer<typeof PrivacyFileSchema>;

/** Portée du repérage global par le modèle économique (étape 4b). */
export const TriageScopeSchema = z.enum(['off', 'signals', 'full']);
export type TriageScope = z.infer<typeof TriageScopeSchema>;
