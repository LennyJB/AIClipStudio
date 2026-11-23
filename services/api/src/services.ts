import type { AppContext } from './context';
import { DerivativeService } from './derivatives/service';
import { JobRunner } from './jobs/runner';
import { StorageService } from './storage/service';
import { TranscriptionService } from './transcriptions/service';

export interface Services {
  runner: JobRunner;
  derivatives: DerivativeService;
  storage: StorageService;
  transcriptions: TranscriptionService;
}

/** Assemble les services partagés par l'API et les scripts CLI. */
export function createServices(ctx: AppContext): Services {
  const storage = new StorageService(ctx);
  // Les services créent des traitements : ils reçoivent le runner de façon différée.
  const derivatives = new DerivativeService(ctx, () => runner);
  const transcriptions = new TranscriptionService(ctx, () => runner, derivatives);
  const runner: JobRunner = new JobRunner(
    ctx,
    { ...derivatives.handlers(), ...transcriptions.handlers() },
    {
      onSucceeded: async () => {
        await storage.enforceCacheBudget();
      },
    },
  );
  return { runner, derivatives, storage, transcriptions };
}

/** Au démarrage : traitements et transcriptions restés « en cours » deviennent interrompus. */
export function recoverServices(s: Services) {
  s.runner.recover();
  s.transcriptions.recover();
}
