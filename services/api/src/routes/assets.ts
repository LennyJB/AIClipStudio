/**
 * Routes de la bibliothèque de médias (étape 7, PR 7f).
 *
 *  - `GET    /api/media-assets[?kind=image|audio]`  liste (aucun chemin) ;
 *  - `POST   /api/media-assets?name=…&rights=…`     import (corps `application/octet-stream`) ;
 *  - `GET    /api/media-assets/:id`                 détail et utilisations ;
 *  - `GET    /api/media-assets/:id/file`            fichier normalisé (PNG ou WAV) ;
 *  - `GET    /api/media-assets/:id/preview`         aperçu d'une image (PNG ≤ 256 px) ;
 *  - `DELETE /api/media-assets/:id`                 suppression (refusée si utilisé).
 *
 * Contrôles d'accès (réutilisés de la §5.2) : adresse réelle du socket (bouclage), `Host` déduit
 * des origines autorisées, `Origin` absent ou autorisé, `Sec-Fetch-Site` absent ou
 * `same-origin`. L'import n'accepte qu'un corps `application/octet-stream` (une page d'une
 * autre origine ne peut pas l'envoyer sans requête préliminaire, toujours refusée). CORS fermé.
 * Aucun chemin ne vient de la requête.
 */
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@acs/shared';
import { PROTECTED_HEADERS } from '../clips/media-access';
import type { Services } from '../services';
import { sendFile } from './clips';
import { parse } from './validation';

const IdParams = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/u) });
const ListQuery = z.object({ kind: z.enum(['image', 'audio']).optional() }).strict();

function refusePreflight(_req: unknown, reply: FastifyReply) {
  return reply
    .status(403)
    .headers(PROTECTED_HEADERS)
    .send({ error: { code: 'FORBIDDEN', message: 'Accès refusé' } });
}

export function registerAssetRoutes(app: FastifyInstance, services: Services) {
  const { assets, editorMedia } = services;
  const access = editorMedia.access;
  const guard = (req: FastifyRequest) => {
    access.assertLoopback(req);
    access.assertHost(req);
    access.assertMediaOrigin(req);
    access.assertFetchSite(req);
  };

  // Corps brut, en flux : la taille est bornée par le service PENDANT la réception.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );

  app.get('/api/media-assets', async (req, reply) => {
    guard(req);
    const { kind } = parse(ListQuery, req.query ?? {});
    return reply.headers(PROTECTED_HEADERS).send({ assets: await assets.list(kind) });
  });

  app.post('/api/media-assets', async (req, reply) => {
    guard(req);
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (type !== 'application/octet-stream') {
      throw new AppError('VALIDATION_FAILED', 'Corps attendu : application/octet-stream');
    }
    const ac = new AbortController();
    req.raw.once('close', () => {
      if (!req.raw.complete) ac.abort();
    });
    const length = Number(req.headers['content-length']);
    const r = await assets.import(
      req.body as Readable,
      req.query ?? {},
      ac.signal,
      Number.isFinite(length) ? length : undefined,
    );
    return reply
      .status(r.duplicate ? 200 : 201)
      .headers(PROTECTED_HEADERS)
      .send(r);
  });
  app.options('/api/media-assets', refusePreflight);

  app.get('/api/media-assets/:id', async (req, reply) => {
    guard(req);
    const { id } = parse(IdParams, req.params);
    return reply.headers(PROTECTED_HEADERS).send(await assets.get(id));
  });

  const serve =
    (variant: 'file' | 'preview') => async (req: FastifyRequest, reply: FastifyReply) => {
      guard(req);
      const { id } = parse(IdParams, req.params);
      const { file, contentType } = await assets.open(id, variant);
      return sendFile(req, reply, file, {
        ...PROTECTED_HEADERS,
        // Contenu adressé par son empreinte : immuable (aucun rechargement inutile).
        'cache-control': 'private, max-age=31536000, immutable',
        'content-type': contentType,
        'content-disposition': 'inline',
        'content-security-policy': "default-src 'none'; sandbox",
      });
    };
  app.get('/api/media-assets/:id/file', serve('file'));
  app.get('/api/media-assets/:id/preview', serve('preview'));

  app.delete('/api/media-assets/:id', async (req, reply) => {
    guard(req);
    const { id } = parse(IdParams, req.params);
    return reply.headers(PROTECTED_HEADERS).send(await assets.remove(id));
  });
  app.options('/api/media-assets/:id', refusePreflight);
  app.options('/api/media-assets/:id/file', refusePreflight);
  app.options('/api/media-assets/:id/preview', refusePreflight);
}
