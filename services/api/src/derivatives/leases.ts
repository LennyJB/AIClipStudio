/**
 * Baux sur les dérivés (migration 9, docs/plan-etape-7.md §5.2) : un dérivé utilisé par une
 * session de l'éditeur est protégé du nettoyage tant que son bail est ACTIF (`expires_at` dans le
 * futur). Un bail expiré ne protège plus rien : le dérivé redevient un cache évinçable.
 *
 * Le bail porte sur la CLÉ DE CACHE (déterministe, connue dès la demande) et non sur la ligne du
 * dérivé : un média encore en préparation au moment de la demande est protégé DÈS sa création par
 * le traitement, y compris contre l'éviction automatique qui suit chaque traitement réussi.
 *
 * Titulaire (`holder`) : identifiant opaque et borné, par exemple `editor:<projet>:<session>`.
 * Les horodatages sont au format ISO 8601 UTC (`toISOString`), comparables comme des chaînes.
 */
import type { Db } from '../db';

export interface Lease {
  cacheKey: string;
  holder: string;
  expiresAt: string;
}

export class LeaseRepository {
  constructor(
    private readonly db: Db,
    /** Horloge (injectable pour les tests). */
    private readonly now: () => number = () => Date.now(),
  ) {}

  private iso(ms: number) {
    return new Date(ms).toISOString();
  }

  /**
   * Crée ou prolonge les baux d'un titulaire sur des clés de cache (jamais raccourcis). Les clés
   * peuvent désigner des médias pas encore produits.
   */
  acquire(cacheKeys: readonly string[], holder: string, ttlMs: number): string {
    const expiresAt = this.iso(this.now() + ttlMs);
    const stmt = this.db.prepare(
      `INSERT INTO derivative_leases (cache_key, holder, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (cache_key, holder)
       DO UPDATE SET expires_at = max(expires_at, excluded.expires_at)`,
    );
    this.db.transaction(() => {
      for (const k of new Set(cacheKeys)) stmt.run(k, holder, expiresAt);
    })();
    return expiresAt;
  }

  /** Fin de session : tous les baux du titulaire sont rendus. */
  release(holder: string): number {
    return this.db.prepare('DELETE FROM derivative_leases WHERE holder = ?').run(holder).changes;
  }

  /** Bail actif de ce titulaire sur cette clé de cache (expiration incluse dans la réponse). */
  active(cacheKey: string, holder: string): Lease | null {
    const r = this.db
      .prepare(
        `SELECT cache_key, holder, expires_at FROM derivative_leases
         WHERE cache_key = ? AND holder = ? AND expires_at > ?`,
      )
      .get(cacheKey, holder, this.iso(this.now())) as
      { cache_key: string; holder: string; expires_at: string } | undefined;
    return r ? { cacheKey: r.cache_key, holder: r.holder, expiresAt: r.expires_at } : null;
  }

  /** Clés de cache protégées : au moins un bail actif (média produit ou encore attendu). */
  protectedCacheKeys(): Set<string> {
    return new Set(
      (
        this.db
          .prepare('SELECT DISTINCT cache_key FROM derivative_leases WHERE expires_at > ?')
          .all(this.iso(this.now())) as { cache_key: string }[]
      ).map((r) => r.cache_key),
    );
  }

  /** Suppression des baux expirés (ménage ; ils ne protègent déjà plus rien). */
  purgeExpired(): number {
    return this.db
      .prepare('DELETE FROM derivative_leases WHERE expires_at <= ?')
      .run(this.iso(this.now())).changes;
  }
}
