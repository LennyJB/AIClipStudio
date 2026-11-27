import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CorrectionSchema, DetectRequestSchema } from '../content/service';
import type { Services } from '../services';
import { parse } from './validation';

const IdParams = z.object({ id: z.uuid() });

/**
 * Types de contenu (étape 9) : consultation, détection locale (aucun appel externe) et
 * correction par le créateur.
 */
export function registerContentTypeRoutes(app: FastifyInstance, services: Services) {
  const { contentTypes } = services;

  app.get('/api/recordings/:id/content-types', async (req) => {
    const { id } = parse(IdParams, req.params);
    return contentTypes.view(id);
  });

  /** 200 si une détection identique existe déjà, 202 si un traitement est lancé. */
  app.post('/api/recordings/:id/content-types/detect', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(DetectRequestSchema, req.body ?? {});
    const res = await contentTypes.requestDetection(id, body);
    return reply.status(res.status === 'ready' ? 200 : 202).send(res);
  });

  /** Correction complète (ou `segments: null` pour revenir à la détection automatique). */
  app.put('/api/recordings/:id/content-types', async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(CorrectionSchema, req.body ?? {});
    return contentTypes.correct(id, body);
  });
}
