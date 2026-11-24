/**
 * Copie d'une proposition au moment de la décision. Le journal éditorial reste exploitable seul,
 * même si l'analyse ou la proposition disparaît ensuite.
 */
import { z } from 'zod';

export const ProposalSnapshotSchema = z
  .object({
    tier: z.enum(['clip', 'secondary']),
    title: z.string(),
    categories: z.array(z.string()),
    relevance: z.number().int().min(0).max(100),
    reliability: z.number().int().min(0).max(100),
    flags: z.array(z.string()),
    srcStartMs: z.number().int().nonnegative(),
    srcEndMs: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    punchlineMs: z.number().int().nonnegative(),
    standalone: z.boolean(),
    promptVersion: z.string().nullable(),
    models: z.object({ triage: z.string().nullable(), deep: z.string().nullable() }),
    pipelineVersion: z.number().int(),
    memoryVersion: z.string().nullable(),
  })
  .strict();

export type ProposalSnapshot = z.infer<typeof ProposalSnapshotSchema>;

export function buildSnapshot(p: Omit<ProposalSnapshot, 'durationMs'>): ProposalSnapshot {
  return ProposalSnapshotSchema.parse({
    ...p,
    categories: [...p.categories],
    flags: [...p.flags],
    durationMs: p.srcEndMs - p.srcStartMs,
  });
}
