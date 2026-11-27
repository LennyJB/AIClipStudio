/**
 * Baux sur les dérivés (migration 9, étape 7d) : contraintes, cascade, et nettoyage qui ne
 * supprime JAMAIS un dérivé sous bail actif, puis le supprime une fois le bail expiré.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig, ROOT_DIR } from './config';
import { migrate, MIGRATIONS, openDatabase, type Db } from './db';
import { LeaseRepository } from './derivatives/leases';
import { DerivativeRepository } from './derivatives/repository';
import { StorageService } from './storage/service';

const REC = `INSERT INTO recordings (id, source_path, file_name, size_bytes, mtime_ms, fingerprint, container,
  game_id, media_info_json) VALUES ('rec', '/a.mkv', 'a.mkv', 1, 1, 'fp', 'mkv', 'generic', '{}')`;

const key = (name: string) => createHash('sha256').update(name).digest('hex');

async function setup() {
  const storage = await mkdtemp(path.join(tmpdir(), 'acs-baux-'));
  const config = loadConfig({ NODE_ENV: 'test', STORAGE_DIR: storage }, ROOT_DIR);
  const db = openDatabase(':memory:');
  db.prepare(REC).run();
  const derivs = new DerivativeRepository(db);
  const add = (name: string, bytes = 1000) => {
    const relPath = `processing/editor/rec/${name}.mp4`;
    const abs = path.join(storage, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.alloc(bytes));
    return derivs.upsert({
      id: `d-${name}`,
      cacheKey: key(name),
      recordingId: 'rec',
      sourceFingerprint: 'fp',
      kind: 'video_proxy',
      audioIndex: null,
      range: { startMs: 0, endMs: 1000 },
      paramsJson: '{}',
      generatorVersion: 1,
      inputDerivativeId: null,
      relPath,
      sizeBytes: bytes,
      durationMs: 1000,
    });
  };
  const ctx = { config, db, log: pino({ level: 'silent' }) };
  return {
    storage,
    db,
    add,
    storageService: new StorageService(ctx),
    leases: new LeaseRepository(db),
  };
}

const expireAll = (db: Db) =>
  db.prepare(`UPDATE derivative_leases SET expires_at = '2000-01-01T00:00:00.000Z'`).run();

describe('baux sur les dérivés', () => {
  it('migration 9 : appliquée sur une base v8 ; contraintes ; bail possible sur un média pas encore produit', () => {
    const db = openDatabase(':memory:', MIGRATIONS.slice(0, 8));
    expect(migrate(db, MIGRATIONS.slice(0, 9))).toEqual([9]);
    const ins = db.prepare(
      'INSERT INTO derivative_leases (cache_key, holder, expires_at) VALUES (?, ?, ?)',
    );
    // Clé d'un média encore en préparation (aucune ligne media_derivatives) : accepté.
    ins.run(key('attendu'), 'editor:p:s', '2999-01-01T00:00:00.000Z');
    expect(() => ins.run(key('attendu'), 'editor:p:s', '2999-01-01T00:00:00.000Z')).toThrow(
      /UNIQUE|PRIMARY/,
    );
    expect(() => ins.run('court', 'x', '2999-01-01T00:00:00.000Z')).toThrow(/CHECK/);
    expect(() => ins.run(key('a'), '', '2999-01-01T00:00:00.000Z')).toThrow(/CHECK/);
    expect(() => ins.run(key('a'), 'x', 'demain')).toThrow(/CHECK/);
  });

  it('acquérir, prolonger (jamais raccourcir), libérer ; bail expiré = inactif', async () => {
    let now = Date.parse('2026-11-26T10:00:00.000Z');
    const { db, add } = await setup();
    const leases = new LeaseRepository(db, () => now);
    const d = add('proxy');
    const exp = leases.acquire([d.cacheKey], 'editor:p:s1', 600_000);
    expect(exp).toBe('2026-11-26T10:10:00.000Z');
    expect(leases.active(d.cacheKey, 'editor:p:s1')).toMatchObject({ expiresAt: exp });
    expect(leases.active(d.cacheKey, 'editor:p:autre')).toBeNull();
    leases.acquire([d.cacheKey], 'editor:p:s1', 1000); // ne raccourcit pas
    expect(leases.active(d.cacheKey, 'editor:p:s1')?.expiresAt).toBe(exp);
    now += 600_001;
    expect(leases.active(d.cacheKey, 'editor:p:s1')).toBeNull();
    expect(leases.protectedCacheKeys().size).toBe(0);
    leases.acquire([d.cacheKey], 'editor:p:s2', 600_000);
    expect(leases.release('editor:p:s2')).toBe(1);
    expect(leases.purgeExpired()).toBe(1);
  });

  it('nettoyage : jamais pendant un bail actif ; après expiration, le dérivé redevient évinçable', async () => {
    const { storage, db, add, storageService, leases } = await setup();
    const proxy = add('proxy');
    const other = add('autre');
    leases.acquire([proxy.cacheKey], 'editor:p:s', 600_000);
    const r1 = await storageService.clean({ dryRun: false, evictAllCache: true });
    expect(r1.items.map((i) => i.derivativeId)).toEqual([other.id]);
    expect(r1.skippedInUse).toBe(1);
    expect(existsSync(path.join(storage, proxy.relPath))).toBe(true);
    expect(existsSync(path.join(storage, other.relPath))).toBe(false);
    // Bail expiré (session de l'éditeur fermée) : cache évinçable ; le bail expiré est purgé.
    expireAll(db);
    const r2 = await storageService.clean({ dryRun: false, evictAllCache: true });
    expect(r2.items.map((i) => i.derivativeId)).toEqual([proxy.id]);
    expect(existsSync(path.join(storage, proxy.relPath))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM derivative_leases').get()).toEqual({ n: 0 });
  });

  it('bail pris PENDANT le calcul du nettoyage : revérifié sous le verrou, le dérivé est conservé', async () => {
    const { storage, add, storageService, leases } = await setup();
    const proxy = add('proxy');
    const service = storageService as unknown as { leases: LeaseRepository };
    const real = service.leases;
    let calls = 0;
    // Premier calcul : aucun bail ; un bail est pris juste avant la transaction d'exécution.
    service.leases = {
      protectedCacheKeys: () => {
        calls++;
        if (calls === 1) {
          const keys = real.protectedCacheKeys();
          leases.acquire([proxy.cacheKey], 'editor:p:s', 600_000);
          return keys;
        }
        return real.protectedCacheKeys();
      },
      purgeExpired: () => real.purgeExpired(),
    } as unknown as LeaseRepository;
    const r = await storageService.clean({ dryRun: false, evictAllCache: true });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r.items).toEqual([]);
    expect(existsSync(path.join(storage, proxy.relPath))).toBe(true);
  });
});
