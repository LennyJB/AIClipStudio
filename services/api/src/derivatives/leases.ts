/**
 * Baux sur les dérivés (migration 9, docs/plan-etape-7.md §5.2) : un dérivé utilisé par une
 * session de l'éditeur est protégé du nettoyage tant que son bail est ACTIF (`expires_at` dans le
 * futur). Un bail expiré ne protège plus rien : le dérivé redevient un cache évinçable.
 *
 * Titulaire (`holder`) : identifiant opaque et borné, par exemple `editor:<projet>:<session>`.
 * Les horodatages sont au format ISO 8601 UTC (`toISOString`), comparables comme des chaînes.
 */
import type { Db } from '../db';

export interface Lease {
  derivativeId: string;
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

  /** Crée ou prolonge les baux d'un titulaire sur des dérivés (jamais raccourcis). */
  acquire(derivativeIds: readonly string[], holder: string, ttlMs: number): string {
    const expiresAt = this.iso(this.now() + ttlMs);
    const stmt = this.db.prepare(
      `INSERT INTO derivative_leases (derivative_id, holder, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (derivative_id, holder)
       DO UPDATE SET expires_at = max(expires_at, excluded.expires_at)`,
    );
    this.db.transaction(() => {
      for (const id of new Set(derivativeIds)) stmt.run(id, holder, expiresAt);
    })();
    return expiresAt;
  }

  /** Fin de session : tous les baux du titulaire sont rendus. */
  release(holder: string): number {
    return this.db.prepare('DELETE FROM derivative_leases WHERE holder = ?').run(holder).changes;
  }

  /** Bail actif de ce titulaire sur ce dérivé (expiration incluse dans la réponse). */
  active(derivativeId: string, holder: string): Lease | null {
    const r = this.db
      .prepare(
        `SELECT derivative_id, holder, expires_at FROM derivative_leases
         WHERE derivative_id = ? AND holder = ? AND expires_at > ?`,
      )
      .get(derivativeId, holder, this.iso(this.now())) as
      { derivative_id: string; holder: string; expires_at: string } | undefined;
    return r ? { derivativeId: r.derivative_id, holder: r.holder, expiresAt: r.expires_at } : null;
  }

  /** Dérivés protégés : au moins un bail actif. */
  protectedDerivativeIds(): Set<string> {
    return new Set(
      (
        this.db
          .prepare('SELECT DISTINCT derivative_id FROM derivative_leases WHERE expires_at > ?')
          .all(this.iso(this.now())) as { derivative_id: string }[]
      ).map((r) => r.derivative_id),
    );
  }

  /** Suppression des baux expirés (ménage ; ils ne protègent déjà plus rien). */
  purgeExpired(): number {
    return this.db
      .prepare('DELETE FROM derivative_leases WHERE expires_at <= ?')
      .run(this.iso(this.now())).changes;
  }
}
