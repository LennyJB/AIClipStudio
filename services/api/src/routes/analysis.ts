import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@acs/shared';
import { AnalysisRequestSchema, SettingsUpdateSchema } from '../analysis/service';
import type { Services } from '../services';
import { parse } from './validation';

const IdParams = z.object({ id: z.uuid() });
const RunParams = z.object({ runId: z.uuid() });
const ProfileBody = z.object({ profileId: z.string().regex(/^[a-z0-9-]+$/) }).strict();
const PreviewBody = z
  .object({
    profileId: z.string().regex(/^[a-z0-9-]+$/),
    atMs: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Analyse éditoriale, étape 4a : réglages de confidentialité, cadrage, préparation locale
 * et consultation du contenu qui SERAIT transmis. Aucune route n'appelle Claude API.
 */
export function registerAnalysisRoutes(app: FastifyInstance, services: Services) {
  const { analysis, derivatives } = services;

  app.get('/api/analysis/config', async () => analysis.publicConfig());

  app.get('/api/framing-profiles', async () => ({ profiles: await analysis.framingProfiles() }));

  app.get('/api/recordings/:id/analysis-settings', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { settings: await analysis.settings(id) };
  });

  app.put('/api/recordings/:id/analysis-settings', async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(SettingsUpdateSchema, req.body ?? {});
    return { settings: await analysis.updateSettings(id, body) };
  });

  app.post('/api/recordings/:id/framing-preview', async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(PreviewBody, req.body ?? {});
    const res = await analysis.framingPreview(id, body.profileId, body.atMs);
    return {
      atMs: res.atMs,
      files: res.files.map((f) => ({
        ...f,
        url: `/api/recordings/${id}/framing-preview/${f.name}`,
      })),
    };
  });

  app.get('/api/recordings/:id/framing-preview/:name', async (req, reply) => {
    const { id, name } = parse(IdParams.extend({ name: z.string().max(200) }), req.params);
    const file = analysis.framingPreviewFile(id, name);
    return reply
      .type('image/jpeg')
      .header('cache-control', 'no-store')
      .send(createReadStream(file));
  });

  app.post('/api/recordings/:id/framing-validation', async (req) => {
    const { id } = parse(IdParams, req.params);
    const { profileId } = parse(ProfileBody, req.body ?? {});
    return { settings: await analysis.validateFraming(id, profileId) };
  });

  /**
   * Prépare l'analyse localement (mode dry_run, défaut) ou lance l'analyse payante avec Claude
   * (mode claude : `acceptBudgetUsd` obligatoire). 200 si le résultat existe déjà, 202 sinon.
   */
  app.post('/api/recordings/:id/analyses', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(AnalysisRequestSchema, req.body ?? {});
    const res = await analysis.request(id, body);
    return reply.status(res.status === 'ready' ? 200 : 202).send(res);
  });

  app.get('/api/recordings/:id/analyses', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { runs: analysis.listRuns(id) };
  });

  app.get('/api/analyses/:runId', async (req) => {
    const { runId } = parse(RunParams, req.params);
    return analysis.getRun(runId);
  });

  app.get('/api/analyses/:runId/manifest', async (req) => {
    const { runId } = parse(RunParams, req.params);
    return { manifest: await analysis.manifest(runId) };
  });

  app.get('/api/analyses/:runId/windows/:rank/payload', async (req) => {
    const { runId, rank } = parse(
      RunParams.extend({ rank: z.coerce.number().int().min(1).max(100_000) }),
      req.params,
    );
    return analysis.windowPayload(runId, rank);
  });

  app.get('/api/analyses/:runId/triage/:index', async (req) => {
    const { runId, index } = parse(
      RunParams.extend({ index: z.coerce.number().int().min(1).max(1_000) }),
      req.params,
    );
    return analysis.triageChunk(runId, index);
  });

  app.get('/api/analyses/:runId/proposals', async (req) => {
    const { runId } = parse(RunParams, req.params);
    const q = parse(z.object({ includeMerged: z.enum(['0', '1']).optional() }).strict(), req.query);
    return { proposals: analysis.proposals(runId, q.includeMerged === '1') };
  });

  app.get('/api/analyses/:runId/triage-moments', async (req) => {
    const { runId } = parse(RunParams, req.params);
    return { moments: analysis.triageMoments(runId) };
  });

  /** Appels à Claude : statut, jetons, coût réel ; coûts par étape et par fenêtre. */
  app.get('/api/analyses/:runId/calls', async (req) => {
    const { runId } = parse(RunParams, req.params);
    return analysis.calls(runId);
  });

  /** Requête ou réponse enregistrée d'un appel (sans la clé API). */
  app.get('/api/analyses/:runId/calls/:callId/:kind', async (req) => {
    const { runId, callId, kind } = parse(
      RunParams.extend({ callId: z.uuid(), kind: z.enum(['request', 'response']) }),
      req.params,
    );
    return analysis.callFile(runId, callId, kind);
  });

  /** Coût réel cumulé d'un enregistrement (toutes analyses). */
  app.get('/api/recordings/:id/analysis-costs', async (req) => {
    const { id } = parse(IdParams, req.params);
    return analysis.recordingCosts(id);
  });

  /** Image préparée (dérivé « frame » uniquement). */
  app.get('/api/frames/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const d = derivatives.repo.get(id);
    if (!d || d.kind !== 'frame') throw new AppError('NOT_FOUND', 'Image introuvable');
    const abs = derivatives.abs(d.relPath);
    if (!existsSync(abs))
      throw new AppError('NOT_FOUND', 'Image supprimée du cache : relancez la préparation');
    return reply.type('image/jpeg').header('cache-control', 'no-store').send(createReadStream(abs));
  });
}
