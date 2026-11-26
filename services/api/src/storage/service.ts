import { existsSync } from 'node:fs';
import { readdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isInside } from '@acs/media';
import type { AppContext } from '../context';
import type { DerivativeKind } from '../derivatives/cache-key';
import { LeaseRepository } from '../derivatives/leases';
import { DerivativeRepository } from '../derivatives/repository';
import { JobRepository } from '../recordings/repository';
import { toAbs, toRel } from './paths';

export type CleanupCategory = 'temp' | 'orphan' | 'cache';

export interface CleanupItem {
  relPath: string;
  category: CleanupCategory;
  bytes: number;
  derivativeId?: string;
  /** Clé de cache du dérivé (baux, étape 7d). */
  cacheKey?: string;
  /** Aperçu de rendu évincé (étape 6b). */
  renderId?: string;
}

export interface CleanupReport {
  dryRun: boolean;
  items: CleanupItem[];
  totalBytes: number;
  /** Fichiers ignorés car utilisés par un traitement actif. */
  skippedInUse: number;
}

export interface CleanupOptions {
  dryRun?: boolean;
  /** Supprimer tout le cache (et pas seulement l'excédent au-delà de CACHE_MAX_GB). */
  evictAllCache?: boolean;
  includeTemp?: boolean;
  includeOrphans?: boolean;
  includeCache?: boolean;
  /** Un orphelin plus récent que ce délai est conservé (écriture possiblement en cours). */
  orphanGraceMs?: number;
}

export interface StorageUsage {
  storageDir: string;
  disk: { totalBytes: number; freeBytes: number } | null;
  databaseBytes: number;
  exportsBytes: number;
  processing: {
    totalBytes: number;
    derivatives: {
      count: number;
      bytes: number;
      cacheBytes: number;
      keepBytes: number;
      byKind: Partial<Record<DerivativeKind, { count: number; bytes: number }>>;
    };
    temp: { count: number; bytes: number };
    orphans: { count: number; bytes: number };
  };
  cacheMaxBytes: number;
  byRecording: { recordingId: string; fileName: string | null; bytes: number; count: number }[];
}

interface FileEntry {
  relPath: string;
  bytes: number;
  mtimeMs: number;
}

const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Espace disque : rapport et nettoyage.
 * Règles absolues :
 *  - n'opère QUE dans storage/processing (vérifié pour chaque fichier) ;
 *  - ne touche jamais un fichier déclaré par un traitement actif, ni un dérivé épinglé, ni un
 *    dérivé sous bail ACTIF (médias de travail d'une session de l'éditeur, étape 7d) ;
 *  - les originaux (hors stockage), projets et exports ne sont jamais concernés.
 */
export class StorageService {
  private readonly derivs: DerivativeRepository;
  private readonly jobs: JobRepository;
  private readonly leases: LeaseRepository;

  constructor(private readonly ctx: AppContext) {
    this.derivs = new DerivativeRepository(ctx.db);
    this.jobs = new JobRepository(ctx.db);
    this.leases = new LeaseRepository(ctx.db);
  }

  private get paths() {
    return this.ctx.config.paths;
  }

  private async walk(dir: string): Promise<FileEntry[]> {
    if (!existsSync(dir)) return [];
    const out: FileEntry[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await this.walk(abs)));
      else if (entry.isFile() && entry.name !== '.gitkeep') {
        const st = await stat(abs);
        out.push({ relPath: toRel(this.paths.storage, abs), bytes: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return out;
  }

  private async dirBytes(dir: string) {
    return (await this.walk(dir)).reduce((s, f) => s + f.bytes, 0);
  }

  /** Un chemin est protégé s'il (ou son fichier final) est déclaré par un traitement actif. */
  /**
   * Rendus (étape 6b) : dossiers protégés (rendu en attente, en cours ou en publication) et
   * aperçus réussis (cache évinçable, jamais « orphelins »). Les exports finaux sont dans
   * `exports/`, que le nettoyage ne parcourt jamais.
   */
  private renderState() {
    const rows = this.ctx.db
      .prepare(
        `SELECT id, kind, status, COALESCE(last_served_at, finished_at, created_at) AS used
         FROM clip_renders WHERE status <> 'evicted' ORDER BY used, id`,
      )
      .all() as { id: string; kind: string; status: string; used: string }[];
    const protectedPrefixes: string[] = [];
    const previews: { id: string; prefix: string }[] = [];
    for (const r of rows) {
      const dirs = [
        `processing/renders/tmp/${r.id}/`,
        `processing/renders/staging/${r.id}/`,
        `processing/renders/previews/${r.id}/`,
      ];
      if (['queued', 'running', 'finalizing'].includes(r.status)) protectedPrefixes.push(...dirs);
      else if (r.kind === 'preview' && r.status === 'succeeded') {
        previews.push({ id: r.id, prefix: dirs[2]! });
      }
    }
    return { protectedPrefixes, previews };
  }

  private protectedPaths(): Set<string> {
    const set = this.jobs.activeFilePaths();
    for (const p of [...set]) {
      set.add(`${p}.part`);
      if (p.endsWith('.part')) set.add(p.slice(0, -'.part'.length));
    }
    return set;
  }

  async usage(): Promise<StorageUsage> {
    const files = await this.walk(this.paths.processing);
    const derivatives = this.derivs.listByLeastRecentlyUsed();
    const known = new Set(derivatives.map((d) => d.relPath));
    const byKind: StorageUsage['processing']['derivatives']['byKind'] = {};
    const byRec = new Map<string, { bytes: number; count: number }>();
    let cacheBytes = 0;
    let keepBytes = 0;
    for (const d of derivatives) {
      const k = (byKind[d.kind] ??= { count: 0, bytes: 0 });
      k.count++;
      k.bytes += d.sizeBytes;
      if (d.retention === 'keep') keepBytes += d.sizeBytes;
      else cacheBytes += d.sizeBytes;
      const r = byRec.get(d.recordingId) ?? { bytes: 0, count: 0 };
      r.bytes += d.sizeBytes;
      r.count++;
      byRec.set(d.recordingId, r);
    }
    const temp = files.filter((f) => f.relPath.endsWith('.part'));
    const orphans = files.filter((f) => !f.relPath.endsWith('.part') && !known.has(f.relPath));

    const disk: StorageUsage['disk'] = await statfs(this.paths.storage).then(
      (s) => ({ totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }),
      () => null,
    );
    const dbFiles = ['', '-wal', '-shm'].map((suffix) => `${this.paths.database}${suffix}`);
    let databaseBytes = 0;
    for (const f of dbFiles) if (existsSync(f)) databaseBytes += (await stat(f)).size;

    const names = new Map(
      (this.ctx.db.prepare('SELECT id, file_name FROM recordings').all() as { id: string; file_name: string }[]).map(
        (r) => [r.id, r.file_name],
      ),
    );
    const sum = (list: FileEntry[]) => list.reduce((s, f) => s + f.bytes, 0);
    return {
      storageDir: this.paths.storage,
      disk,
      databaseBytes,
      exportsBytes: await this.dirBytes(this.paths.exports),
      processing: {
        totalBytes: sum(files),
        derivatives: { count: derivatives.length, bytes: cacheBytes + keepBytes, cacheBytes, keepBytes, byKind },
        temp: { count: temp.length, bytes: sum(temp) },
        orphans: { count: orphans.length, bytes: sum(orphans) },
      },
      cacheMaxBytes: this.ctx.config.cache.maxBytes,
      byRecording: [...byRec.entries()]
        .map(([recordingId, v]) => ({ recordingId, fileName: names.get(recordingId) ?? null, ...v }))
        .sort((a, b) => b.bytes - a.bytes),
    };
  }

  /** Calcule (et exécute si dryRun = false) le nettoyage. Simulation par défaut. */
  async clean(opts: CleanupOptions = {}): Promise<CleanupReport> {
    const dryRun = opts.dryRun ?? true;
    const grace = opts.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    const files = await this.walk(this.paths.processing);
    const prot = this.protectedPaths();
    const renders = this.renderState();
    const isProtected = (rel: string, prefixes = renders.protectedPrefixes, set = prot) =>
      set.has(rel) || prefixes.some((p) => rel.startsWith(p));
    const items: CleanupItem[] = [];
    let skippedInUse = 0;
    const consider = (item: CleanupItem) => {
      if (isProtected(item.relPath)) skippedInUse++;
      else items.push(item);
    };

    const derivatives = this.derivs.listByLeastRecentlyUsed();
    const known = new Set(derivatives.map((d) => d.relPath));
    const previewFiles = new Map<string, FileEntry[]>(
      renders.previews.map((p) => [p.id, files.filter((f) => f.relPath.startsWith(p.prefix))]),
    );
    for (const list of previewFiles.values()) for (const f of list) known.add(f.relPath);
    if (opts.includeTemp ?? true) {
      for (const f of files.filter((x) => x.relPath.endsWith('.part'))) {
        consider({ relPath: f.relPath, category: 'temp', bytes: f.bytes });
      }
    }
    if (opts.includeOrphans ?? true) {
      const now = Date.now();
      for (const f of files) {
        if (f.relPath.endsWith('.part') || known.has(f.relPath) || now - f.mtimeMs < grace) continue;
        // Fichiers d'un rendu encore connu en base (actif) : jamais orphelins.
        if (isProtected(f.relPath)) continue;
        consider({ relPath: f.relPath, category: 'orphan', bytes: f.bytes });
      }
    }
    if (opts.includeCache ?? true) {
      const cache = derivatives.filter((d) => d.retention === 'cache');
      const previewBytes = (id: string) =>
        (previewFiles.get(id) ?? []).reduce((s, f) => s + f.bytes, 0);
      let total =
        cache.reduce((s, d) => s + d.sizeBytes, 0) +
        renders.previews.reduce((s, p) => s + previewBytes(p.id), 0);
      const budget = opts.evictAllCache ? 0 : this.ctx.config.cache.maxBytes;
      // Aperçus de rendu d'abord (régénérables rapidement), du moins récemment servi au plus récent.
      for (const p of renders.previews) {
        if (total <= budget) break;
        for (const f of previewFiles.get(p.id) ?? []) {
          items.push({ relPath: f.relPath, category: 'cache', bytes: f.bytes, renderId: p.id });
        }
        total -= previewBytes(p.id);
      }
      const leased = this.leases.protectedCacheKeys();
      for (const d of cache) {
        if (total <= budget) break;
        if (prot.has(d.relPath) || leased.has(d.cacheKey)) {
          skippedInUse++;
          continue;
        }
        items.push({
          relPath: d.relPath,
          category: 'cache',
          bytes: d.sizeBytes,
          derivativeId: d.id,
          cacheKey: d.cacheKey,
        });
        total -= d.sizeBytes;
      }
    }

    const report: CleanupReport = {
      dryRun,
      items,
      totalBytes: items.reduce((s, i) => s + i.bytes, 0),
      skippedInUse,
    };
    if (dryRun || !items.length) return report;

    // Exécution : re-vérification de la protection et suppression des lignes dans une transaction
    // BEGIN IMMEDIATE (verrou d’écriture pris avant toute lecture),
    // puis suppression des fichiers (un dérivé sans ligne ne peut plus être servi).
    const executed = this.ctx.db.transaction(() => {
      const protNow = this.protectedPaths();
      const rendersNow = this.renderState();
      // Baux revérifiés SOUS LE VERROU : un bail pris pendant le calcul protège le dérivé.
      const leasedNow = this.leases.protectedCacheKeys();
      const evicted = new Set<string>();
      const ok = items.filter((i) => {
        if (isProtected(i.relPath, rendersNow.protectedPrefixes, protNow)) return false;
        if (i.cacheKey && leasedNow.has(i.cacheKey)) return false;
        if (!i.renderId) return true;
        // Un aperçu n'est supprimé que s'il est encore « réussi » ; un final ne l'est jamais
        // (contrainte SQL : un final ne peut pas passer à « evicted »).
        if (evicted.has(i.renderId)) return true;
        const changed = this.ctx.db
          .prepare(
            `UPDATE clip_renders SET status = 'evicted' WHERE id = ? AND kind = 'preview' AND status = 'succeeded'`,
          )
          .run(i.renderId).changes;
        if (changed) evicted.add(i.renderId);
        return changed === 1;
      });
      for (const i of ok) if (i.derivativeId) this.derivs.delete(i.derivativeId);
      this.leases.purgeExpired();
      return ok;
    }).immediate();
    for (const i of executed) {
      const abs = toAbs(this.paths.storage, i.relPath);
      if (!isInside(this.paths.processing, abs)) {
        this.ctx.log.error({ relPath: i.relPath }, 'Nettoyage refusé : fichier hors de processing/');
        continue;
      }
      await rm(abs, { force: true });
    }
    this.ctx.log.info(
      {
        files: executed.length,
        freedMB: Math.round(executed.reduce((s, i) => s + i.bytes, 0) / 1e5) / 10,
        byCategory: countBy(executed),
      },
      'Nettoyage effectué',
    );
    return { ...report, items: executed, totalBytes: executed.reduce((s, i) => s + i.bytes, 0) };
  }

  /** Démarrage : aucun traitement n'est actif, les fichiers temporaires sont tous obsolètes. */
  removeStaleTempFiles() {
    return this.clean({ dryRun: false, includeOrphans: false, includeCache: false });
  }

  /** Après un traitement réussi : éviction LRU si le cache dépasse CACHE_MAX_GB. */
  enforceCacheBudget() {
    return this.clean({ dryRun: false, includeTemp: false, includeOrphans: false });
  }
}

function countBy(items: CleanupItem[]) {
  const out: Partial<Record<CleanupCategory, number>> = {};
  for (const i of items) out[i.category] = (out[i.category] ?? 0) + 1;
  return out;
}
