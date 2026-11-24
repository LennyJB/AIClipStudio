/**
 * Schémas des réponses de Claude (étape 4b).
 *
 * Le schéma JSON envoyé à l'API (sorties structurées) ne garantit pas tout : bornes
 * numériques, longueurs et nombre d'éléments ne sont PAS imposées par l'API. Ils sont donc
 * retirés du schéma envoyé (sinon refus) et revalidés ici par Zod, strictement : tout champ
 * inconnu, toute valeur hors bornes rejette la réponse.
 */
import { z } from 'zod';
import { MomentCategorySchema } from '@acs/shared';

const segmentId = z.number().int().min(1);

/* -------------------------------- Repérage -------------------------------- */

export const TRIAGE_KINDS = [
  'humour',
  'ironie',
  'malentendu',
  'echange',
  'reaction',
  'inattendu',
  'gameplay',
  'autre',
] as const;

export const TriageMomentSchema = z
  .object({
    startSegmentId: segmentId,
    endSegmentId: segmentId,
    kind: z.enum(TRIAGE_KINDS),
    strength: z.enum(['fort', 'moyen']),
    why: z.string().trim().min(1).max(300),
  })
  .strict();

export const TriageResultSchema = z
  .object({
    moments: z.array(TriageMomentSchema).max(40),
    /** Résumé NON VÉRIFIÉ (blagues récurrentes, contexte) : jamais une preuve. */
    streamSummary: z.string().max(800),
  })
  .strict();
export type TriageResult = z.infer<typeof TriageResultSchema>;
export type TriageMoment = z.infer<typeof TriageMomentSchema>;

/* --------------------------- Analyse approfondie --------------------------- */

export const EVIDENCE_ROLES = ['mise_en_place', 'chute', 'reaction', 'contexte'] as const;

export const DeepMomentSchema = z
  .object({
    suggestedTier: z.enum(['clip', 'secondaire']),
    title: z.string().trim().min(3).max(90),
    explanation: z.string().trim().min(10).max(700),
    categories: z.array(MomentCategorySchema).min(1).max(3),
    /** Pertinence éditoriale (0 à 100), jugée par Claude. */
    relevance: z.number().int().min(0).max(100),
    setupSegmentId: segmentId,
    punchlineSegmentId: segmentId,
    reactionEndSegmentId: segmentId,
    standalone: z.boolean(),
    evidence: z
      .array(
        z
          .object({
            segmentId,
            quote: z.string().trim().min(1).max(240),
            role: z.enum(EVIDENCE_ROLES),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    visualEvidence: z
      .array(
        z
          .object({
            frameLabel: z.string().regex(/^F\d{1,2}$/),
            note: z.string().trim().max(200),
          })
          .strict(),
      )
      .max(6),
    tracksUsed: z.array(z.enum(['MIC', 'DSC', 'MIX'])).max(3),
    editingHint: z
      .object({
        mode: z.enum(['fidele', 'enrichi']),
        ideas: z.array(z.string().trim().max(160)).max(3),
      })
      .strict(),
    uncertainty: z.string().trim().max(300).nullable(),
  })
  .strict();

export const DeepResultSchema = z
  .object({
    /** Zéro moment est une réponse normale. */
    moments: z.array(DeepMomentSchema).max(3),
    noClipReason: z.string().trim().max(400).nullable(),
  })
  .strict();
export type DeepResult = z.infer<typeof DeepResultSchema>;
export type DeepMoment = z.infer<typeof DeepMomentSchema>;

/* ------------------------- Schéma envoyé à l'API ------------------------- */

/** Mots-clés que les sorties structurées n'appliquent pas (revalidés par Zod). */
const UNSUPPORTED_KEYS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'format',
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYS.has(k)) continue;
    // Seuls minItems 0 ou 1 sont pris en charge.
    if (k === 'minItems') {
      out[k] = Math.min(1, Number(v));
      continue;
    }
    out[k] = sanitize(v);
  }
  if (out['type'] === 'object') out['additionalProperties'] = false;
  return out;
}

/** JSON Schema compatible avec les sorties structurées de l'API. */
export function toApiSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/**
 * Lit la réponse texte de Claude : JSON strict, puis validation Zod.
 * Renvoie une erreur lisible (jamais d'exception) : la réponse est une donnée non fiable.
 */
export function parseModelJson<T extends z.ZodType>(
  schema: T,
  text: string,
): { ok: true; value: z.output<T> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: 'JSON invalide' };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    return {
      ok: false,
      error: r.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`)
        .join(' ; '),
    };
  }
  return { ok: true, value: r.data };
}
