/** Journal éditorial : format versionné des événements (mémoire éditoriale v1). */
import { z } from 'zod';
import { RejectReasonSchema } from './reasons';
import { REVIEW_STATUSES } from './review';
import { ProposalSnapshotSchema } from './snapshot';

export const FEEDBACK_SCHEMA_VERSION = 1;

export const FEEDBACK_EVENT_TYPES = [
  'proposal_accepted',
  'proposal_rejected',
  'proposal_reset',
] as const;

export const FeedbackEventSchema = z
  .object({
    seq: z.number().int().positive(),
    id: z.string(),
    requestId: z.string(),
    schemaVersion: z.literal(FEEDBACK_SCHEMA_VERSION),
    type: z.enum(FEEDBACK_EVENT_TYPES),
    occurredAt: z.string(),
    recordingId: z.string(),
    gameId: z.string(),
    proposalId: z.string(),
    runId: z.string(),
    momentIdAtDecision: z.string(),
    previousStatus: z.enum(REVIEW_STATUSES),
    newStatus: z.enum(REVIEW_STATUSES),
    reasons: z.array(RejectReasonSchema),
    comment: z.string().nullable(),
    reevaluatesEventId: z.string().nullable(),
    snapshot: ProposalSnapshotSchema,
    source: z.enum(['ui', 'cli', 'api']),
  })
  .strict();

export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;
