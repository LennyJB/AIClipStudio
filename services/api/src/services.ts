import { ClaudeModel, type EditorialModel } from '@acs/editorial';
import { AnalysisService } from './analysis/service';
import { AssetService } from './assets/service';
import type { AppContext } from './context';
import { DerivativeService } from './derivatives/service';
import { LeaseRepository } from './derivatives/leases';
import { EditorMediaService } from './clips/editor-media';
import { MediaAccess } from './clips/media-access';
import { JobRunner } from './jobs/runner';
import { StorageService } from './storage/service';
import { TranscriptionService } from './transcriptions/service';
import { ReviewService } from './review/service';
import { ExportAudioService } from './clips/export-audio';
import { ClipProjectService } from './clips/service';
import { RenderService } from './clips/render-service';
import { ContentTypeService } from './content/service';

export interface Services {
  runner: JobRunner;
  derivatives: DerivativeService;
  storage: StorageService;
  transcriptions: TranscriptionService;
  analysis: AnalysisService;
  review: ReviewService;
  exportAudio: ExportAudioService;
  clips: ClipProjectService;
  renders: RenderService;
  /** Médias de travail de l'éditeur (étape 7d) : préparation, baux, accès protégé. */
  editorMedia: EditorMediaService;
  /** Bibliothèque de médias (étape 7f) : images fixes et effets sonores importés. */
  assets: AssetService;
  /** Types de contenu et segmentation temporelle (étape 9). */
  contentTypes: ContentTypeService;
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
  const contentTypes = new ContentTypeService(ctx, () => runner, analysis, derivatives);
  const review = new ReviewService(ctx, transcriptions, derivatives);
  const exportAudio = new ExportAudioService(ctx);
  const clips = new ClipProjectService(ctx, review, analysis, exportAudio);
  const assets = new AssetService(ctx);
  clips.edits.assetGuard = (d) => assets.assertReferencable(d);
  const renders = new RenderService(ctx, clips, exportAudio, () => runner, assets);
  const editorMedia = new EditorMediaService(
    ctx,
    clips,
    derivatives,
    exportAudio,
    new MediaAccess(ctx.config.editor),
    new LeaseRepository(ctx.db),
  );
  const runner: JobRunner = new JobRunner(
    ctx,
    {
      ...derivatives.handlers(),
      ...transcriptions.handlers(),
      ...analysis.handlers(),
      ...renders.handlers(),
      ...contentTypes.handlers(),
    },
    {
      onSucceeded: async () => {
        await storage.enforceCacheBudget();
      },
    },
  );
  // Une décision de revue qui change annule les rendus en attente ou en cours du moment
  // (économie de calcul ; la garantie reste la publication sous verrou).
  review.onDecisionChanged = (proposalIds) => renders.cancelForProposals(proposalIds);
  return {
    runner,
    derivatives,
    storage,
    transcriptions,
    analysis,
    review,
    exportAudio,
    clips,
    renders,
    editorMedia,
    assets,
    contentTypes,
  };
}

/** Au démarrage : traitements, transcriptions et analyses restés « en cours » deviennent interrompus. */
export function recoverServices(s: Services) {
  s.runner.recover();
  s.transcriptions.recover();
  s.analysis.recover();
  // Les rendus « en publication » sont récupérés de façon asynchrone : `recoverFinalizing()`
  // doit être attendu avant tout autre travail (serveur et CLI).
  s.renders.recoverStale();
}
