import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listGameProfileIds } from '@acs/editorial';
import { AppError, TrackRoleSchema } from '@acs/shared';
import type { AppContext } from '../context';
import { importRecording } from '../recordings/import';
import { JobRepository, RecordingRepository } from '../recordings/repository';
import type { Services } from '../services';
import { parse } from './validation';

const ImportBody = z
  .object({
    path: z.string().trim().min(1).max(4096),
    gameId: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    trackRoles: z.array(TrackRoleSchema).min(1).max(16).optional(),
  })
  .strict();

const RolesBody = z.object({ roles: z.array(TrackRoleSchema).min(1).max(16) }).strict();
const StemsBody = z
  .object({ srcStartMs: z.number().int().nonnegative(), srcEndMs: z.number().int().positive() })
  .strict()
  .refine((b) => b.srcEndMs > b.srcStartMs, 'srcEndMs doit être supérieur à srcStartMs');
const IdParams = z.object({ id: z.uuid() });
const AnyIdParams = z.object({ id: z.string().min(1).max(64) });

export function registerRecordingRoutes(app: FastifyInstance, ctx: AppContext, services: Services) {
  const recordings = new RecordingRepository(ctx.db);
  const jobs = new JobRepository(ctx.db);
  const { runner, derivatives } = services;

  const getOr404 = (id: string) => {
    const rec = recordings.get(id);
    if (!rec) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return rec;
  };
  const statusCode = (status: 'ready' | 'pending') => (status === 'ready' ? 200 : 202);

  app.get('/api/games', async () => ({
    games: await listGameProfileIds(ctx.config.paths.profiles),
  }));

  app.post('/api/recordings', async (req, reply) => {
    const body = parse(ImportBody, req.body);
    const result = await importRecording({ ...ctx, log: req.log }, body);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.get('/api/recordings', async () => ({ recordings: recordings.list() }));

  app.get('/api/recordings/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    return {
      recording: getOr404(id),
      derivatives: derivatives.repo.listForRecording(id),
      jobs: jobs.listForRecording(id),
    };
  });

  app.patch('/api/recordings/:id/tracks', async (req) => {
    const { id } = parse(IdParams, req.params);
    const { roles } = parse(RolesBody, req.body);
    const rec = getOr404(id);
    if (roles.length !== rec.audioTracks.length) {
      throw new AppError('VALIDATION_FAILED', `${rec.audioTracks.length} rôle(s) attendu(s)`);
    }
    recordings.updateRoles(id, roles);
    return { recording: getOr404(id) };
  });

  /** WAV 16 kHz mono pour Whisper (tout l'enregistrement). 200 si prêt, 202 si en préparation. */
  app.post('/api/recordings/:id/transcription-audio', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const res = derivatives.requestTranscriptionAudio(id);
    return reply.status(statusCode(res.status)).send(res);
  });

  /** Pistes de montage 48 kHz stéréo autour d'un clip (fenêtre élargie et alignée). */
  app.post('/api/recordings/:id/audio-stems', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const { srcStartMs, srcEndMs } = parse(StemsBody, req.body);
    const res = derivatives.requestAudioStems(id, srcStartMs, srcEndMs);
    return reply.status(statusCode(res.status)).send(res);
  });

  app.post('/api/derivatives/:id/waveform', async (req, reply) => {
    const { id } = parse(AnyIdParams, req.params);
    const res = derivatives.requestWaveform(id);
    return reply.status(statusCode(res.status)).send(res);
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    const job = jobs.get(id);
    if (!job) throw new AppError('NOT_FOUND', 'Traitement introuvable');
    return { job };
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { job: runner.cancel(id) };
  });
}
