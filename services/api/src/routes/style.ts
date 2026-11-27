import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services';
import { parse } from './validation';

const ProfileParams = z.object({ id: z.string().min(1).max(64) });
const UuidParams = z.object({ id: z.uuid() });

/**
 * Style de montage (étape 10) : catalogue, profils (versions, brouillons, validation), vidéos
 * de référence et style appliqué à un projet. Tout est local : aucune route n'appelle un service
 * externe ni ne transmet de vidéo.
 */
export function registerStyleRoutes(app: FastifyInstance, services: Services) {
  const { style } = services;

  app.get('/api/style/catalog', async () => style.catalog());

  app.get('/api/style-profiles', async () => ({ profiles: style.listProfiles() }));
  app.post('/api/style-profiles', async (req, reply) =>
    reply.status(201).send(style.createProfile(req.body ?? {})),
  );
  app.get('/api/style-profiles/:id', async (req) =>
    style.profile(parse(ProfileParams, req.params).id),
  );
  app.patch('/api/style-profiles/:id', async (req) =>
    style.updateProfile(parse(ProfileParams, req.params).id, req.body ?? {}),
  );
  /** Apprend un BROUILLON (références associées + décisions dans l'éditeur). */
  app.post('/api/style-profiles/:id/learn', async (req) =>
    style.learn(parse(ProfileParams, req.params).id, req.body ?? {}),
  );
  /** Modification manuelle : nouvelle version (brouillon). */
  app.put('/api/style-profiles/:id/draft', async (req) =>
    style.editDraft(parse(ProfileParams, req.params).id, req.body ?? {}),
  );
  /** Validation explicite d'une version : seule une version validée est appliquée. */
  app.post('/api/style-profiles/:id/validate', async (req) =>
    style.validate(parse(ProfileParams, req.params).id, req.body ?? {}),
  );

  app.get('/api/style-references', async () => ({ references: style.listReferences() }));
  app.post('/api/style-references', async (req, reply) => {
    const r = await style.importReference(req.body ?? {});
    return reply.status(r.created ? 201 : 200).send(r);
  });
  app.get('/api/style-references/:id', async (req) => ({
    reference: style.reference(parse(UuidParams, req.params).id),
  }));
  app.patch('/api/style-references/:id', async (req) => ({
    reference: style.updateReference(parse(UuidParams, req.params).id, req.body ?? {}),
  }));
  app.delete('/api/style-references/:id', async (req, reply) => {
    style.deleteReference(parse(UuidParams, req.params).id);
    return reply.status(204).send();
  });
  app.post('/api/style-references/:id/analyze', async (req, reply) =>
    reply.status(202).send(style.analyzeReference(parse(UuidParams, req.params).id)),
  );

  app.get('/api/clip-projects/:id/style', async (req) =>
    style.projectStyle(parse(UuidParams, req.params).id),
  );
}
