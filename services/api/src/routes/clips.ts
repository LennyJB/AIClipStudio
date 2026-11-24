/**
 * Routes des projets de clip et de l'audio exporté (étape 6a). Corps et paramètres validés par
 * des schémas Zod stricts. Aucun rendu ici (étape 6b), aucun appel réseau.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services';
import { parse } from './validation';

const IdParams = z.object({ id: z.uuid() });

export function registerClipRoutes(app: FastifyInstance, services: Services) {
  const { clips, exportAudio } = services;

  /** Propositions acceptées (une par moment) et leur projet de clip. */
  app.get('/api/recordings/:id/clips', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.listForRecording(id);
  });

  /** Consentements, déclarations, pistes exportables (et pourquoi), historique. */
  app.get('/api/recordings/:id/export-audio', async (req) => {
    const { id } = parse(IdParams, req.params);
    return exportAudio.view(id);
  });

  app.post('/api/recordings/:id/export-audio', async (req) => {
    const { id } = parse(IdParams, req.params);
    return exportAudio.record(id, req.body ?? {}, 'ui');
  });

  /** Crée (ou renvoie) le projet de clip d'une proposition acceptée. */
  app.post('/api/proposals/:id/clip-project', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const r = await clips.create(id, req.body ?? {}, 'ui');
    return reply.status(r.created ? 201 : 200).send(r);
  });

  app.get('/api/clip-projects/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.view(id);
  });

  app.get('/api/clip-projects/:id/revisions', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { revisions: clips.revisions(id) };
  });

  /** Réglages simples (sans timeline) : crée une nouvelle révision immuable. */
  app.patch('/api/clip-projects/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.patch(id, req.body ?? {}, 'ui');
  });
}
