import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services';
import { parse } from './validation';

const CleanBody = z
  .object({
    /** Simulation par défaut : rien n'est supprimé sans dryRun = false explicite. */
    dryRun: z.boolean().default(true),
    evictAllCache: z.boolean().default(false),
    includeTemp: z.boolean().default(true),
    includeOrphans: z.boolean().default(true),
    includeCache: z.boolean().default(true),
  })
  .strict();

export function registerStorageRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/storage', async () => ({ usage: await services.storage.usage() }));

  app.post('/api/storage/clean', async (req) => {
    const opts = parse(CleanBody, req.body ?? {});
    return { report: await services.storage.clean(opts) };
  });
}
