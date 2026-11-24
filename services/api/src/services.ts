import { ClaudeModel, type EditorialModel } from '@acs/editorial';
import { AnalysisService } from './analysis/service';
import type { AppContext } from './context';
import { DerivativeService } from './derivatives/service';
import { JobRunner } from './jobs/runner';
import { StorageService } from './storage/service';
import { TranscriptionService } from './transcriptions/service';
import { ReviewService } from './review/service';

export interface Services {
  runner: JobRunner;
  derivatives: DerivativeService;
  storage: StorageService;
  transcriptions: TranscriptionService;
  analysis: AnalysisService;
  review: ReviewService;
}

export interface ServiceOptions {
  /**
   * Modèle éditorial. Par défaut : Claude API si ANTHROPIC_API_KEY est configurée (créé à la
   * première utilisation), sinon aucun (seule la préparation locale est possible).
   * Les tests injectent un faux modèle : aucun appel réel.
   */
  model?: EditorialModel | null;
}

/** Assemble les services partagés par l'API et les scripts CLI. */
export function createServices(ctx: AppContext, opts: ServiceOptions = {}): Services {
  let model: EditorialModel | null | undefined = opts.model;
  const modelProvider = () => {
    if (model === undefined) {
      const apiKey = ctx.config.claude.apiKey;
      model = apiKey ? new ClaudeModel({ apiKey }) : null;
    }
    return model;
  };
  const storage = new StorageService(ctx);
  // Les services créent des traitements : ils reçoivent le runner de façon différée.
  const derivatives = new DerivativeService(ctx, () => runner);
  const transcriptions = new TranscriptionService(ctx, () => runner, derivatives);
  const analysis = new AnalysisService(ctx, () => runner, derivatives, modelProvider);
  const runner: JobRunner = new JobRunner(
    ctx,
    { ...derivatives.handlers(), ...transcriptions.handlers(), ...analysis.handlers() },
    {
      onSucceeded: async () => {
        await storage.enforceCacheBudget();
      },
    },
  );
  const review = new ReviewService(ctx, transcriptions);
  return { runner, derivatives, storage, transcriptions, analysis, review };
}

/** Au démarrage : traitements, transcriptions et analyses restés « en cours » deviennent interrompus. */
export function recoverServices(s: Services) {
  s.runner.recover();
  s.transcriptions.recover();
  s.analysis.recover();
}
