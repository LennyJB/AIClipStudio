/**
 * Accès aux médias de travail de l'éditeur (docs/plan-etape-7.md §5.2). Le proxy vidéo montre
 * l'image source SANS aplats : il est traité comme une donnée sensible, avec plusieurs contrôles
 * INDÉPENDANTS (chacun refuse seul sa requête interdite) :
 *
 *  1. adresse réelle du socket TCP (bouclage uniquement) — aucun en-tête de transfert n'est lu
 *     (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`), `trustProxy` reste désactivé ;
 *  2. `Host` exactement égal à l'un des `hôte:port` DÉDUITS des origines autorisées ;
 *  3. `Origin` : obligatoire et autorisé pour la demande de jeton ; pour la lecture du média,
 *     absent (balise `<video>`) ou autorisé ; `null` et toute autre origine sont refusés ;
 *  4. `Sec-Fetch-Site` : s'il est présent, seul `same-origin` est accepté (`same-site` refusé :
 *     pour une adresse IP, un autre port local est « même site ») ;
 *  5. jeton éphémère signé (HMAC-SHA-256, clé aléatoire en mémoire renouvelée à chaque démarrage),
 *     lié au projet, au dérivé et au bail, valable 10 minutes ;
 *  6. CORS fermé (aucun `Access-Control-Allow-Origin`, `OPTIONS` refusé) et
 *     `Cross-Origin-Resource-Policy: same-origin`.
 *
 * Hors du modèle de menace : un programme déjà exécuté sur le poste peut lire `storage/`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@acs/shared';

/** Durée de validité d'un jeton (l'éditeur le renouvelle avant son expiration). */
export const MEDIA_TOKEN_TTL_MS = 10 * 60_000;

/** Adresses de bouclage acceptées (adresse réelle du socket). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** En-têtes de réponse communs à toutes les routes protégées. */
export const PROTECTED_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

export interface MediaTokenPayload {
  /** Projet, dérivé et titulaire du bail auxquels le jeton est lié. */
  projectId: string;
  derivativeId: string;
  holder: string;
  /** Expiration (ms depuis l'époque Unix). */
  expiresAt: number;
}

const forbidden = (reason: string) =>
  // Message générique : la raison précise n'est donnée qu'aux journaux du serveur.
  new AppError('FORBIDDEN', 'Accès refusé', { details: { reason } });

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const b64 = (b: Buffer) => b.toString('base64url');

export class MediaAccess {
  /** Clé HMAC aléatoire, en mémoire uniquement : tout jeton devient invalide au redémarrage. */
  private readonly key = randomBytes(32);

  constructor(
    private readonly config: { allowedOrigins: readonly string[]; allowedHosts: readonly string[] },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /* ------------------------------ Contrôles ------------------------------ */

  /** 1. Adresse réelle du socket : seule source de vérité, aucun en-tête de transfert. */
  assertLoopback(req: FastifyRequest) {
    const addr = req.raw.socket.remoteAddress;
    if (!addr || !LOOPBACK.has(addr)) throw forbidden('remote_address');
  }

  /** 2. `Host` : exactement l'un des `hôte:port` déduits des origines autorisées. */
  assertHost(req: FastifyRequest) {
    const host = header(req, 'host');
    if (!host || !this.config.allowedHosts.includes(host.toLowerCase())) throw forbidden('host');
  }

  /** 3a. Demande de jeton : `Origin` OBLIGATOIRE et autorisé. */
  assertTokenOrigin(req: FastifyRequest) {
    const origin = header(req, 'origin');
    if (origin === undefined) throw forbidden('origin_missing');
    if (!this.config.allowedOrigins.includes(origin)) throw forbidden('origin');
  }

  /** 3b. Lecture du média : `Origin` absent (balise `<video>`) ou autorisé ; jamais `null`. */
  assertMediaOrigin(req: FastifyRequest) {
    const origin = header(req, 'origin');
    if (origin !== undefined && !this.config.allowedOrigins.includes(origin)) {
      throw forbidden('origin');
    }
  }

  /** 4. `Sec-Fetch-Site` : s'il est présent, seul `same-origin`. */
  assertFetchSite(req: FastifyRequest) {
    const site = header(req, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin') throw forbidden('fetch_site');
  }

  /** Demande de jeton : corps JSON uniquement (une autre origine ne peut l'envoyer sans préliminaire). */
  assertJsonBody(req: FastifyRequest) {
    const type = (header(req, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') throw forbidden('content_type');
  }

  /** Contrôles d'une demande de jeton (1, 2, 3a, 4 et corps JSON). */
  checkTokenRequest(req: FastifyRequest) {
    this.assertLoopback(req);
    this.assertHost(req);
    this.assertTokenOrigin(req);
    this.assertFetchSite(req);
    this.assertJsonBody(req);
  }

  /** Contrôles d'une lecture de média (1, 2, 3b, 4) ; le jeton est vérifié ensuite. */
  checkMediaRequest(req: FastifyRequest) {
    this.assertLoopback(req);
    this.assertHost(req);
    this.assertMediaOrigin(req);
    this.assertFetchSite(req);
  }

  /* -------------------------------- Jetons -------------------------------- */

  private sign(body: string) {
    return createHmac('sha256', this.key).update(body).digest();
  }

  /** Jeton `charge.signature` (signature HMAC-SHA-256 de 256 bits, base64url). */
  issue(p: Omit<MediaTokenPayload, 'expiresAt'>): { token: string; expiresAt: string } {
    const payload: MediaTokenPayload = { ...p, expiresAt: this.now() + MEDIA_TOKEN_TTL_MS };
    const body = b64(Buffer.from(JSON.stringify({ ...payload, n: b64(randomBytes(16)) })));
    return {
      token: `${body}.${b64(this.sign(body))}`,
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  /** Jeton signé, non expiré et lié EXACTEMENT à ce dérivé ; sinon 403. */
  verify(token: string | undefined, derivativeId: string): MediaTokenPayload {
    if (!token || token.length > 1024) throw forbidden('token_missing');
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) throw forbidden('token_malformed');
    const expected = this.sign(body);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw forbidden('token_signature');
    }
    let p: MediaTokenPayload;
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MediaTokenPayload;
    } catch {
      throw forbidden('token_malformed');
    }
    if (typeof p.expiresAt !== 'number' || p.expiresAt <= this.now()) {
      throw forbidden('token_expired');
    }
    if (p.derivativeId !== derivativeId) throw forbidden('token_scope');
    return p;
  }
}

/** URL journalisée : le jeton n'apparaît jamais dans les journaux du serveur. */
export function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/giu, '$1[masqué]');
}
