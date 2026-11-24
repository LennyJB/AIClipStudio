/**
 * Routes de la revue des propositions (étape 5). Tous les corps et paramètres sont validés par
 * des schémas Zod stricts. Aucune route n'appelle Claude.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services';
import { DecisionBodySchema, DetachBodySchema, ListQuerySchema } from '../review/service';
import { parse } from './validation';

const IdParams = z.object({ id: z.uuid() });

export function registerReviewRoutes(app: FastifyInstance, services: Services) {
  const { review } = services;

  /** Propositions d'une analyse (par défaut la dernière terminée), avec leur décision. */
  app.get('/api/recordings/:id/proposals', async (req) => {
    const { id } = parse(IdParams, req.params);
    return review.list(id, parse(ListQuerySchema, req.query ?? {}));
  });

  app.get('/api/proposals/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    return review.detail(id);
  });

  app.get('/api/proposals/:id/context', async (req) => {
    const { id } = parse(IdParams, req.params);
    const q = parse(
      z
        .object({
          beforeMs: z.coerce.number().int().min(0).max(120_000).optional(),
          afterMs: z.coerce.number().int().min(0).max(120_000).optional(),
        })
        .strict(),
      req.query ?? {},
    );
    return review.context(id, {
      ...(q.beforeMs !== undefined ? { beforeMs: q.beforeMs } : {}),
      ...(q.afterMs !== undefined ? { afterMs: q.afterMs } : {}),
    });
  });

  /** Décision : accepter, refuser, réinitialiser ; `reevaluate` pour une décision prise ailleurs. */
  app.post('/api/proposals/:id/decision', async (req) => {
    const { id } = parse(IdParams, req.params);
    return review.decide(id, parse(DecisionBodySchema, req.body ?? {}), 'ui');
  });

  /** Détacher explicitement la proposition de son moment. */
  app.post('/api/proposals/:id/detach', async (req) => {
    const { id } = parse(IdParams, req.params);
    return review.detach(id, parse(DetachBodySchema, req.body ?? {}), 'ui');
  });

  app.get('/api/proposals/:id/events', async (req) => {
    const { id } = parse(IdParams, req.params);
    return review.history(id);
  });

  /** Journal éditorial paginé (retrouver les décisions ; base de l'étape 6). */
  app.get('/api/feedback-events', async (req) => {
    const q = parse(
      z
        .object({
          recordingId: z.uuid().optional(),
          gameId: z
            .string()
            .regex(/^[a-z0-9-]+$/)
            .optional(),
          momentId: z.uuid().optional(),
          type: z.enum(['proposal_accepted', 'proposal_rejected', 'proposal_reset']).optional(),
          afterSeq: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        })
        .strict(),
      req.query ?? {},
    );
    return review.journal({
      ...(q.recordingId ? { recordingId: q.recordingId } : {}),
      ...(q.gameId ? { gameId: q.gameId } : {}),
      ...(q.momentId ? { momentId: q.momentId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.afterSeq !== undefined ? { afterSeq: q.afterSeq } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
  });
}
