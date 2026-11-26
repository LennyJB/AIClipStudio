/**
 * Routes des projets de clip, de l'audio exporté (étape 6a) et des rendus (étape 6b). Corps et
 * paramètres validés par des schémas Zod stricts ; aucun chemin ne vient de la requête.
 * Aucun appel réseau, aucune publication : l'export s'arrête au fichier.
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OpenedFile } from '../review/servable-file';
import { decideRange, rangeHeaders } from '../review/http-range';
import { contentDisposition } from '../clips/naming';
import type { Services } from '../services';
import { parse } from './validation';

/** Envoie un fichier ouvert, avec requêtes partielles (Range) et HEAD. */
export function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: OpenedFile,
  headers: Record<string, string>,
) {
  const { handle, size } = file;
  const header = (n: string) => {
    const v = req.headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const decision = decideRange(header('range'), size, header('if-range'));
  reply.headers({
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
    ...rangeHeaders(decision, size),
  });
  const status = decision.kind === 'unsatisfiable' ? 416 : decision.kind === 'partial' ? 206 : 200;
  if (decision.kind === 'unsatisfiable' || req.method === 'HEAD' || size === 0) {
    void handle.close();
    return reply.status(status).send(Readable.from([]));
  }
  const stream =
    decision.kind === 'partial'
      ? handle.createReadStream({ start: decision.start, end: decision.end })
      : handle.createReadStream();
  return reply.status(status).send(stream);
}

const IdParams = z.object({ id: z.uuid() });

export function registerClipRoutes(app: FastifyInstance, services: Services) {
  const { clips, exportAudio, renders } = services;

  /** Propositions acceptées (une par moment) et leur projet de clip. */
  app.get('/api/recordings/:id/clips', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.listForRecording(id);
  });

  /** Consentements, déclarations, pistes exportables (et pourquoi), historique. */
  app.get('/api/recordings/:id/export-audio', async (req) => {
    const { id } = parse(IdParams, req.params);
    return exportAudio.view(id);
  });

  app.post('/api/recordings/:id/export-audio', async (req) => {
    const { id } = parse(IdParams, req.params);
    return exportAudio.record(id, req.body ?? {}, 'ui');
  });

  /** Crée (ou renvoie) le projet de clip d'une proposition acceptée. */
  app.post('/api/proposals/:id/clip-project', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const r = await clips.create(id, req.body ?? {}, 'ui');
    return reply.status(r.created ? 201 : 200).send(r);
  });

  app.get('/api/clip-projects/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.view(id);
  });

  app.get('/api/clip-projects/:id/revisions', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { revisions: clips.revisions(id) };
  });

  /** Réglages simples (sans timeline) : crée une nouvelle révision immuable. */
  app.patch('/api/clip-projects/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.patch(id, req.body ?? {}, 'ui');
  });

  /* ------------------------ Journal d'édition (étape 7b) ------------------------ */

  /** Document v2 courant (éditeur) : version, empreinte, historique. */
  app.get('/api/clip-projects/:id/document', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.editorDocument(id);
  });

  /** Lot d'opérations, annulation ou rétablissement (journal en ajout seul). */
  app.post('/api/clip-projects/:id/edits', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.submitEdit(id, req.body ?? {}, 'ui');
  });

  /** Élargit la fenêtre éditable (nouveau manifeste d'intégrité construit par le serveur). */
  app.post('/api/clip-projects/:id/window', async (req) => {
    const { id } = parse(IdParams, req.params);
    return clips.extendWindow(id, req.body ?? {}, 'ui');
  });

  /** Entrées du journal après une version (synchronisation entre onglets). */
  app.get('/api/clip-projects/:id/edits', async (req) => {
    const { id } = parse(IdParams, req.params);
    const q = parse(
      z.object({ since: z.coerce.number().int().min(0).default(0) }).strict(),
      req.query ?? {},
    );
    return clips.editsSince(id, q.since);
  });

  /* --------------------------------- Rendus --------------------------------- */

  /** Demande un aperçu ou un export final (202 : en file ; 200 : rendu identique existant). */
  app.post('/api/clip-projects/:id/renders', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const r = await renders.request(id, req.body ?? {}, 'ui');
    return reply.status(r.created ? 202 : 200).send(r);
  });

  app.get('/api/clip-projects/:id/renders', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { renders: renders.list(id) };
  });

  /**
   * Image fixe de la disposition (masques compris), sans rendu vidéo. Une demande plus récente
   * sur le même projet arrête la précédente (409 CANCELLED) ; au plus 2 en cours (409 CONFLICT).
   */
  app.get('/api/clip-projects/:id/frame', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const q = parse(
      z.object({ atEditMs: z.coerce.number().int().min(0).max(180_000).default(0) }).strict(),
      req.query ?? {},
    );
    // Client parti avant la réponse (requête abandonnée par le navigateur) : FFmpeg est arrêté.
    const ctrl = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) ctrl.abort();
    });
    const jpg = await renders.frame(id, q.atEditMs, ctrl.signal);
    return reply
      .headers({
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      .send(jpg);
  });

  /** Effets proposés (catalogue v1) : nouvelle révision « système », désactivations conservées. */
  app.post('/api/clip-projects/:id/effects/suggest', async (req) => {
    const { id } = parse(IdParams, req.params);
    return renders.suggest(id, req.body ?? {});
  });

  app.get('/api/renders/:id', async (req) => {
    const { id } = parse(IdParams, req.params);
    return renders.view(id);
  });

  app.post('/api/renders/:id/cancel', async (req) => {
    const { id } = parse(IdParams, req.params);
    return renders.cancel(id);
  });

  /** Lecture de la vidéo (aperçu ou final), Range et HEAD. */
  app.get('/api/renders/:id/video', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const f = await renders.openVideo(id);
    return sendFile(req, reply, f, {
      'content-type': 'video/mp4',
      'content-disposition': 'inline',
    });
  });

  /** Téléchargement d'un export final (pièce jointe, nom assaini). */
  app.get('/api/renders/:id/download', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const name = renders.downloadName(id);
    const f = await renders.openVideo(id);
    return sendFile(req, reply, f, {
      'content-type': 'video/mp4',
      'content-disposition': contentDisposition(name),
    });
  });

  app.get('/api/renders/:id/subtitles.srt', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const f = await renders.openSubtitles(id);
    return sendFile(req, reply, f, {
      'content-type': 'application/x-subrip; charset=utf-8',
      'content-disposition': 'inline',
    });
  });
}
