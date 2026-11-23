import type { AppContext } from './context';
import { DerivativeService } from './derivatives/service';
import { JobRunner } from './jobs/runner';
import { StorageService } from './storage/service';

export interface Services {
  runner: JobRunner;
  derivatives: DerivativeService;
  storage: StorageService;
}

/** Assemble les services partagés par l'API et les scripts CLI. */
export function createServices(ctx: AppContext): Services {
  const storage = new StorageService(ctx);
  // Le service des dérivés crée des traitements : il reçoit le runner de façon différée.
  const derivatives = new DerivativeService(ctx, () => runner);
  const runner: JobRunner = new JobRunner(ctx, derivatives.handlers(), {
    onSucceeded: async () => {
      await storage.enforceCacheBudget();
    },
  });
  return { runner, derivatives, storage };
}
