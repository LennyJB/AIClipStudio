/**
 * Routes des médias de travail de l'éditeur (étape 7d, docs/plan-etape-7.md §5.2).
 *
 *  - `POST /api/clip-projects/:id/editor-media`          préparation + bail de session ;
 *  - `POST /api/clip-projects/:id/editor-media/release`  fin de session (baux rendus) ;
 *  - `POST /api/clip-projects/:id/media-token`           jeton éphémère (contrôles §5.2) ;
 *  - `GET|HEAD /api/editor-media/:derivativeId?token=…`   lecture (Range), contrôles §5.2 ;
 *  - `GET /api/editor/fonts/:file`                       polices OFL de l'aperçu.
 *
 * CORS fermé : aucun `Access-Control-Allow-Origin`, toute requête préliminaire `OPTIONS` reçoit
 * 403. Aucun chemin ne vient de la requête : le fichier est résolu en base.
 */
import { readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '@acs/shared';
import { PROTECTED_HEADERS } from '../clips/media-access';
import { FONTS_DIR } from '../clips/render-service';
import type { Services } from '../services';
import { sendFile } from './clips';
import { parse } from './validation';

const IdParams = z.object({ id: z.uuid() });
const MediaParams = z.object({ derivativeId: z.string().min(1).max(100) });
const MediaQuery = z.object({ token: z.string().max(1024).optional() }).strict();

/** Requêtes préliminaires CORS : toujours refusées (aucun en-tête CORS émis). */
function refusePreflight(_req: unknown, reply: FastifyReply) {
  return reply
    .status(403)
    .headers(PROTECTED_HEADERS)
    .send({ error: { code: 'FORBIDDEN', message: 'Accès refusé' } });
}

/** Polices servies à l'aperçu : liste fermée, déduite du dossier des polices fournies. */
function fontFiles(): Set<string> {
  return new Set(readdirSync(FONTS_DIR).filter((f) => /^[A-Za-z0-9-]+\.(ttf|otf)$/u.test(f)));
}

export function registerEditorMediaRoutes(app: FastifyInstance, services: Services) {
  const { editorMedia } = services;
  const fonts = fontFiles();

  app.post('/api/clip-projects/:id/editor-media', async (req) => {
    const { id } = parse(IdParams, req.params);
    return editorMedia.prepare(id, req.body ?? {});
  });

  app.post('/api/clip-projects/:id/editor-media/release', async (req) => {
    const { id } = parse(IdParams, req.params);
    return editorMedia.release(id, req.body ?? {});
  });

  app.post('/api/clip-projects/:id/media-token', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const r = editorMedia.issueToken(req, id);
    return reply.headers(PROTECTED_HEADERS).send(r);
  });
  app.options('/api/clip-projects/:id/media-token', refusePreflight);

  const media = async (req: Parameters<typeof sendFile>[0], reply: FastifyReply) => {
    const { derivativeId } = parse(MediaParams, req.params);
    const { token } = parse(MediaQuery, req.query ?? {});
    const { file, contentType } = await editorMedia.open(req, derivativeId, token);
    return sendFile(req, reply, file, {
      ...PROTECTED_HEADERS,
      'content-type': contentType,
      // N'est PAS une protection (§5.2) : seulement l'affichage plutôt que l'enregistrement.
      'content-disposition': 'inline',
    });
  };
  // HEAD est créée par Fastify à partir de GET (mêmes contrôles, corps vide).
  app.get('/api/editor-media/:derivativeId', media);
  app.options('/api/editor-media/:derivativeId', refusePreflight);

  app.get('/api/editor/fonts/:file', async (req, reply) => {
    editorMedia.access.assertLoopback(req);
    editorMedia.access.assertHost(req);
    const { file } = parse(z.object({ file: z.string().max(100) }), req.params);
    if (!fonts.has(file)) throw new AppError('NOT_FOUND', 'Police inconnue');
    const handle = await open(path.join(FONTS_DIR, file), 'r');
    const st = await handle.stat();
    return sendFile(
      req,
      reply,
      { handle, size: st.size },
      {
        ...PROTECTED_HEADERS,
        'cache-control': 'private, max-age=3600',
        'content-type': file.endsWith('.otf') ? 'font/otf' : 'font/ttf',
      },
    );
  });
  app.options('/api/editor/fonts/:file', refusePreflight);
}
