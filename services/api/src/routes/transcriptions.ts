import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import type { Services } from '../services';
import { TranscribeRequestSchema } from '../transcriptions/service';
import { parse } from './validation';

const IdParams = z.object({ id: z.uuid() });
const csvList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter(Boolean) : undefined));

const TranscriptQuery = z
  .object({
    model: z
      .string()
      .regex(/^[\w.\-/]+$/)
      .optional(),
    transcriptionIds: csvList.pipe(z.array(z.string().min(1).max(64)).max(20).optional()),
    audioIndex: csvList.pipe(
      z
        .array(
          z
            .string()
            .regex(/^\d{1,2}$/)
            .transform(Number),
        )
        .max(16)
        .optional(),
    ),
    fromMs: z.coerce.number().int().nonnegative().optional(),
    toMs: z.coerce.number().int().positive().optional(),
  })
  .strict();

export function registerTranscriptionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  services: Services,
) {
  const { transcriptions } = services;

  /** Réglages utiles à l'interface (jamais de secret). */
  app.get('/api/transcription/config', async () => {
    const w = ctx.config.whisper;
    return {
      defaultModel: w.model,
      modelChoices: w.modelChoices,
      device: w.device,
      cpuFallback: w.cpuFallback,
      language: w.language,
      wordTimestamps: w.wordTimestamps,
    };
  });

  /** Lance (ou reprend) la transcription. 200 si déjà disponible, 202 si un traitement est en cours. */
  app.post('/api/recordings/:id/transcriptions', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(TranscribeRequestSchema, req.body ?? {});
    const res = await transcriptions.request(id, body);
    return reply.status(res.status === 'ready' ? 200 : 202).send(res);
  });

  /** Toutes les transcriptions (état, métriques) et les groupes comparables entre modèles. */
  app.get('/api/recordings/:id/transcriptions', async (req) => {
    const { id } = parse(IdParams, req.params);
    return transcriptions.list(id);
  });

  /** Segments par ordre chronologique (toutes pistes), en temps source. */
  app.get('/api/recordings/:id/transcript', async (req) => {
    const { id } = parse(IdParams, req.params);
    const q = parse(TranscriptQuery, req.query);
    return transcriptions.transcript(id, {
      ...(q.model ? { model: q.model } : {}),
      ...(q.transcriptionIds ? { transcriptionIds: q.transcriptionIds } : {}),
      ...(q.audioIndex ? { audioIndexes: q.audioIndex } : {}),
      ...(q.fromMs !== undefined ? { fromMs: q.fromMs } : {}),
      ...(q.toMs !== undefined ? { toMs: q.toMs } : {}),
    });
  });
}
