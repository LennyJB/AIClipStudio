import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listGameProfileIds } from '@acs/editorial';
import { AppError, TrackRoleSchema } from '@acs/shared';
import type { AppContext } from '../context';
import type { JobRunner } from '../jobs/runner';
import { importRecording } from '../recordings/import';
import { JobRepository, RecordingRepository } from '../recordings/repository';

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
const IdParams = z.object({ id: z.uuid() });

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 'Requête invalide', {
      details: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function registerRecordingRoutes(app: FastifyInstance, ctx: AppContext, runner: JobRunner) {
  const recordings = new RecordingRepository(ctx.db);
  const jobs = new JobRepository(ctx.db);

  const getOr404 = (id: string) => {
    const rec = recordings.get(id);
    if (!rec) throw new AppError('NOT_FOUND', 'Enregistrement introuvable');
    return rec;
  };

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
    return { recording: getOr404(id), jobs: jobs.listForRecording(id) };
  });

  app.patch('/api/recordings/:id/tracks', async (req) => {
    const { id } = parse(IdParams, req.params);
    const { roles } = parse(RolesBody, req.body);
    const rec = getOr404(id);
    if (roles.length !== rec.audioTracks.length) {
      throw new AppError('VALIDATION_FAILED', `${rec.audioTracks.length} rôle(s) attendu(s)`);
    }
    if (jobs.findActive(id, 'extract_audio')) {
      throw new AppError('CONFLICT', 'Extraction en cours : attendez la fin ou annulez-la');
    }
    recordings.updateRoles(id, roles);
    return { recording: getOr404(id) };
  });

  app.post('/api/recordings/:id/extract-audio', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    getOr404(id);
    const { job, created } = runner.enqueue(id, 'extract_audio');
    return reply.status(created ? 202 : 200).send({ job });
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    const job = jobs.get(id);
    if (!job) throw new AppError('NOT_FOUND', 'Travail introuvable');
    return { job };
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { job: runner.cancel(id) };
  });
}
