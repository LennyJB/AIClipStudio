/**
 * Bibliothèque de médias (étape 7, PR 7f) : images fixes et effets sonores importés par le
 * créateur, ré-encodés et stockés sous `storage/assets/`.
 *
 *  - Import : flux reçu dans un dossier temporaire (taille bornée PENDANT la réception, empreinte
 *    calculée au vol), validation et normalisation (`@acs/media` `importAsset`), déplacement
 *    atomique vers `assets/<2 car.>/<id>.png|wav`, ligne en base. Identifiant = sha256 des
 *    octets importés : un même fichier n'est jamais stocké deux fois (déduplication).
 *  - Aucun chemin ne vient du client : le fichier est résolu en base (chemin relatif contrôlé
 *    par la base ET par `toAbs`) puis ouvert par `openServableFile` (pas de lien symbolique,
 *    strictement dans le dossier de la bibliothèque).
 *  - Suppression : refusée tant que le média est référencé par un projet (document d'une
 *    version, journal d'édition — une annulation pourrait le ramener) ou un rendu non terminé.
 *    Vérification et suppression dans la même transaction `BEGIN IMMEDIATE` que les lots
 *    d'édition : un lot qui ajoute le média ne peut pas s'intercaler.
 *  - Fichier manquant ou altéré : signalé (`status: 'missing'`), jamais remplacé en silence ;
 *    un rendu qui en dépend est refusé (`ASSET_MISSING`). Réimporter le même fichier le répare.
 *  - Rendu : chaque média utilisé est revérifié (empreinte) et COPIÉ dans le dossier de travail
 *    du rendu : sa suppression ou son altération pendant le rendu est sans effet.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { importAsset, ASSET_NORMALIZER_VERSION, reject } from '@acs/media';
import { AppError } from '@acs/shared';
import type { ClipProjectV2 } from '@acs/timeline';
import type { AppContext } from '../context';
import { openServableFile, type OpenedFile } from '../review/servable-file';
import { parse } from '../routes/validation';
import { toAbs } from '../storage/paths';

export const ASSET_RIGHTS = ['own', 'licensed', 'public_domain'] as const;
export type AssetRights = (typeof ASSET_RIGHTS)[number];

/** Paramètres d'un import : nom AFFICHÉ (jamais un chemin), déclaration de droits obligatoire. */
export const ImportQuerySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      // Uniquement le nom affiché : aucun séparateur de dossier, aucun caractère de contrôle.
      .refine(
        (n) => !/[\\/]/u.test(n) && ![...n].some((c) => c.charCodeAt(0) < 32),
        'nom de fichier invalide',
      ),
    rights: z.enum(ASSET_RIGHTS),
    rightsNote: z.string().trim().max(300).optional(),
  })
  .strict();

const AssetIdSchema = z.string().regex(/^[0-9a-f]{64}$/u, 'identifiant de média invalide');

interface AssetRow {
  id: string;
  kind: 'image' | 'audio';
  source_format: string;
  format: 'png' | 'wav';
  rel_path: string;
  preview_rel_path: string | null;
  file_sha256: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  peaks_json: string | null;
  display_name: string;
  rights: AssetRights;
  rights_note: string | null;
  created_at: string;
}

/** Vue publique d'un média : AUCUN chemin. */
export interface AssetDto {
  id: string;
  kind: 'image' | 'audio';
  sourceFormat: string;
  displayName: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  peaks: number[] | null;
  rights: AssetRights;
  rightsNote: string | null;
  createdAt: string;
  /** `missing` : fichier absent ou altéré sur le disque (réimporter le même fichier le répare). */
  status: 'ok' | 'missing';
}

export interface AssetUsage {
  /** Projets qui référencent le média (version, point de contrôle ou journal). */
  projectIds: string[];
  /** Rendus en attente ou en cours de ces projets. */
  activeRenders: number;
}

/** Médias référencés par un document (calques image et mème, effets sonores). */
export function referencedAssets(d: ClipProjectV2): { image: string[]; audio: string[] } {
  const image = new Set<string>();
  for (const o of d.overlays) if (o.kind !== 'text' && o.assetId) image.add(o.assetId);
  const audio = new Set(d.audio.sfx.map((s) => s.assetId));
  return { image: [...image].sort(), audio: [...audio].sort() };
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export class AssetService {
  private readonly dir: string;
  private readonly incoming: string;

  constructor(private readonly ctx: AppContext) {
    this.dir = ctx.config.paths.assets;
    this.incoming = path.join(this.dir, '.incoming');
  }

  /* ------------------------------ Lecture ------------------------------ */

  private row(id: string): AssetRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as
      AssetRow | undefined;
  }

  private rowOrThrow(id: string): AssetRow {
    const r = this.row(parse(AssetIdSchema, id));
    if (!r) throw new AppError('NOT_FOUND', 'Média introuvable dans la bibliothèque');
    return r;
  }

  private async present(r: AssetRow): Promise<boolean> {
    try {
      const st = await stat(toAbs(this.ctx.config.paths.storage, r.rel_path));
      return st.isFile() && st.size === r.size_bytes;
    } catch {
      return false;
    }
  }

  private async dto(r: AssetRow): Promise<AssetDto> {
    return {
      id: r.id,
      kind: r.kind,
      sourceFormat: r.source_format,
      displayName: r.display_name,
      sizeBytes: r.size_bytes,
      width: r.width,
      height: r.height,
      durationMs: r.duration_ms,
      peaks: r.peaks_json ? (JSON.parse(r.peaks_json) as number[]) : null,
      rights: r.rights,
      rightsNote: r.rights_note,
      createdAt: r.created_at,
      status: (await this.present(r)) ? 'ok' : 'missing',
    };
  }

  async list(kind?: 'image' | 'audio'): Promise<AssetDto[]> {
    const rows = (
      kind
        ? this.ctx.db
            .prepare('SELECT * FROM media_assets WHERE kind = ? ORDER BY created_at DESC, id')
            .all(kind)
        : this.ctx.db.prepare('SELECT * FROM media_assets ORDER BY created_at DESC, id').all()
    ) as AssetRow[];
    return Promise.all(rows.map((r) => this.dto(r)));
  }

  async get(id: string): Promise<AssetDto & { usage: AssetUsage }> {
    const r = this.rowOrThrow(id);
    return { ...(await this.dto(r)), usage: this.usage(r.id) };
  }

  /** Références au média : documents des versions, journal d'édition, rendus en cours. */
  usage(id: string): AssetUsage {
    const db = this.ctx.db;
    const projects = new Set<string>();
    for (const r of db
      .prepare(
        `SELECT DISTINCT project_id FROM clip_project_revisions WHERE instr(document_json, ?) > 0`,
      )
      .all(id) as { project_id: string }[]) {
      projects.add(r.project_id);
    }
    for (const r of db
      .prepare(
        `SELECT DISTINCT project_id FROM clip_project_edits
          WHERE instr(ops_json, ?) > 0 OR instr(inverse_json, ?) > 0`,
      )
      .all(id, id) as { project_id: string }[]) {
      projects.add(r.project_id);
    }
    const ids = [...projects].sort();
    const activeRenders = ids.length
      ? (
          db
            .prepare(
              `SELECT count(*) AS n FROM clip_renders
                WHERE status IN ('queued','running','finalizing')
                  AND project_id IN (${ids.map(() => '?').join(',')})`,
            )
            .get(...ids) as { n: number }
        ).n
      : 0;
    return { projectIds: ids, activeRenders };
  }

  /** Fichier servi (normalisé ou aperçu) : résolu en base, jamais depuis la requête. */
  async open(
    id: string,
    variant: 'file' | 'preview',
  ): Promise<{ file: OpenedFile; contentType: string }> {
    const r = this.rowOrThrow(id);
    const rel = variant === 'preview' ? (r.preview_rel_path ?? r.rel_path) : r.rel_path;
    if (variant === 'preview' && r.kind !== 'image') {
      throw new AppError('NOT_FOUND', 'Aucun aperçu image pour un son');
    }
    try {
      const file = await openServableFile(
        toAbs(this.ctx.config.paths.storage, rel),
        this.dir,
        r.kind === 'image' ? '.png' : '.wav',
      );
      return { file, contentType: r.kind === 'image' ? 'image/png' : 'audio/wav' };
    } catch {
      throw new AppError('ASSET_MISSING', 'Fichier du média manquant : réimportez-le', {
        details: { assetIds: [r.id] },
      });
    }
  }

  /* ------------------------------- Import ------------------------------- */

  /**
   * Importe un fichier reçu en flux. Refus explicite (`ASSET_REJECTED`) de tout fichier invalide ;
   * un fichier déjà présent (même empreinte) est renvoyé tel quel (`duplicate: true`).
   */
  async import(
    stream: Readable,
    query: unknown,
    signal?: AbortSignal,
    declaredBytes?: number,
  ): Promise<{ asset: AssetDto; duplicate: boolean }> {
    const q = parse(ImportQuerySchema, query);
    const limits = this.ctx.config.assets;
    if (declaredBytes !== undefined && declaredBytes > limits.maxBytes) {
      // Taille annoncée excessive : refus avant toute écriture.
      stream.resume();
      throw reject(
        'too_large',
        `Fichier trop volumineux (${Math.floor(limits.maxBytes / 1024 / 1024)} Mo au plus)`,
      );
    }
    const work = path.join(this.incoming, randomUUID());
    await mkdir(work, { recursive: true });
    try {
      const upload = path.join(work, 'upload.bin');
      const hash = createHash('sha256');
      let size = 0;
      let tooLarge = false;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          // Taille bornée PENDANT la réception : au-delà, plus rien n'est écrit ; le reste du
          // corps est lu et jeté (la réponse de refus peut ainsi être envoyée proprement).
          if (size > limits.maxBytes) tooLarge = true;
          if (tooLarge) {
            cb();
            return;
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(stream, meter, createWriteStream(upload, { flags: 'wx' }));
      } catch {
        throw new AppError('VALIDATION_FAILED', 'Réception du fichier interrompue');
      }
      if (tooLarge) {
        throw reject(
          'too_large',
          `Fichier trop volumineux (${Math.floor(limits.maxBytes / 1024 / 1024)} Mo au plus)`,
        );
      }
      if (size === 0) throw reject('empty', 'Fichier vide');
      const id = hash.digest('hex');
      const existing = this.row(id);
      if (existing && (await this.intact(existing))) {
        return { asset: await this.dto(existing), duplicate: true };
      }
      const n = await importAsset({
        ffmpeg: this.ctx.config.tools.ffmpeg,
        ffprobe: this.ctx.config.tools.ffprobe,
        input: upload,
        declaredName: q.name,
        workDir: path.join(work, 'out'),
        limits,
        ...(signal ? { signal } : {}),
      });
      const shard = id.slice(0, 2);
      const relPath = `assets/${shard}/${id}.${n.format}`;
      const relPreview = n.preview ? `assets/${shard}/${id}.preview.png` : null;
      await mkdir(path.join(this.dir, shard), { recursive: true });
      if (n.preview && relPreview) {
        await rename(n.preview, toAbs(this.ctx.config.paths.storage, relPreview));
      }
      await rename(n.file, toAbs(this.ctx.config.paths.storage, relPath));
      if (existing) {
        // Ligne existante, fichier manquant ou altéré : réparé par le même import (mêmes octets).
        if (existing.file_sha256 !== n.fileSha256 || existing.size_bytes !== n.sizeBytes) {
          throw new AppError(
            'ASSET_MISSING',
            'Le fichier réimporté ne reproduit pas le média enregistré (version de FFmpeg différente ?)',
            { details: { assetIds: [id] } },
          );
        }
        this.ctx.log.info({ assetId: id }, 'Média réparé par réimportation');
        return { asset: await this.dto(existing), duplicate: true };
      }
      this.ctx.db
        .prepare(
          `INSERT INTO media_assets (id, kind, source_format, format, rel_path, preview_rel_path,
             file_sha256, size_bytes, width, height, duration_ms, peaks_json, display_name, rights,
             rights_note, normalizer_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          id,
          n.kind,
          n.sourceFormat,
          n.format,
          relPath,
          relPreview,
          n.fileSha256,
          n.sizeBytes,
          n.width,
          n.height,
          n.durationMs,
          n.peaks ? JSON.stringify(n.peaks) : null,
          q.name.slice(0, 120),
          q.rights,
          q.rightsNote || null,
          ASSET_NORMALIZER_VERSION,
        );
      this.ctx.log.info({ assetId: id, kind: n.kind }, 'Média importé dans la bibliothèque');
      return { asset: await this.dto(this.row(id)!), duplicate: false };
    } finally {
      // L'import d'origine n'est JAMAIS conservé : seul le fichier normalisé l'est.
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Fichier présent et identique à son empreinte enregistrée. */
  private async intact(r: AssetRow): Promise<boolean> {
    try {
      const b = await readFile(toAbs(this.ctx.config.paths.storage, r.rel_path));
      return b.length === r.size_bytes && sha256(b) === r.file_sha256;
    } catch {
      return false;
    }
  }

  /* ----------------------------- Suppression ---------------------------- */

  /**
   * Supprime un média qui n'est plus référencé. La vérification et la suppression de la ligne se
   * font sous `BEGIN IMMEDIATE` (aucun lot d'édition ne peut s'intercaler) ; les fichiers sont
   * effacés ensuite (un échec laisse au pire un fichier orphelin, retiré au démarrage).
   */
  async remove(id: string): Promise<{ deleted: true }> {
    const r = this.rowOrThrow(id);
    this.ctx.db
      .transaction(() => {
        const u = this.usage(r.id);
        if (u.projectIds.length || u.activeRenders) {
          throw new AppError(
            'ASSET_IN_USE',
            `Média utilisé par ${u.projectIds.length} projet(s)${u.activeRenders ? ` et ${u.activeRenders} rendu(s) en cours` : ''} : retirez-le d’abord des projets`,
            { details: { projects: u.projectIds.length, activeRenders: u.activeRenders } },
          );
        }
        this.ctx.db.prepare('DELETE FROM media_assets WHERE id = ?').run(r.id);
      })
      .immediate();
    for (const rel of [r.rel_path, r.preview_rel_path]) {
      if (rel) await rm(toAbs(this.ctx.config.paths.storage, rel), { force: true });
    }
    this.ctx.log.info({ assetId: r.id }, 'Média supprimé de la bibliothèque');
    return { deleted: true };
  }

  /* ------------------------ Édition et rendu ---------------------------- */

  /**
   * Garde des lots d'édition (appelée DANS leur transaction) : tout média référencé par le
   * document existe et a le bon type (image pour un calque, son pour un effet sonore).
   */
  assertReferencable(d: ClipProjectV2) {
    const refs = referencedAssets(d);
    const bad: string[] = [];
    const check = this.ctx.db.prepare('SELECT kind FROM media_assets WHERE id = ?');
    for (const [kind, ids] of [
      ['image', refs.image],
      ['audio', refs.audio],
    ] as const) {
      for (const id of ids) {
        const row = check.get(id) as { kind: string } | undefined;
        if (!row || row.kind !== kind) bad.push(id);
      }
    }
    if (bad.length) {
      throw new AppError(
        'ASSET_MISSING',
        'Média absent de la bibliothèque (ou de mauvais type) : importez-le avant de l’utiliser',
        { details: { assetIds: bad } },
      );
    }
  }

  /**
   * Prépare les médias d'un rendu : chacun doit exister, être intact (empreinte) et est COPIÉ
   * dans `workDir` (nom = identifiant). Retourne les noms de fichiers relatifs à `workDir`.
   * Aucun repli : un média manquant ou altéré fait échouer le rendu explicitement.
   */
  async stageForRender(d: ClipProjectV2, workDir: string): Promise<Record<string, string>> {
    const refs = referencedAssets(d);
    const ids = [...refs.image, ...refs.audio];
    const out: Record<string, string> = {};
    const missing: string[] = [];
    for (const id of ids) {
      const r = this.row(id);
      if (!r) {
        missing.push(id);
        continue;
      }
      const name = `asset-${id}.${r.format}`;
      const dest = path.join(workDir, name);
      try {
        await copyFile(toAbs(this.ctx.config.paths.storage, r.rel_path), dest);
        const b = await readFile(dest);
        if (b.length !== r.size_bytes || sha256(b) !== r.file_sha256) {
          await rm(dest, { force: true });
          missing.push(id);
          continue;
        }
      } catch {
        missing.push(id);
        continue;
      }
      out[id] = name;
    }
    if (missing.length) {
      throw new AppError(
        'ASSET_MISSING',
        `Média(s) de la bibliothèque manquant(s) ou altéré(s) : ${missing.length}. Réimportez-les ou retirez-les du clip.`,
        { details: { assetIds: missing } },
      );
    }
    return out;
  }

  /**
   * Entrées du plan de rendu : médias référencés, présents en base ET sur le disque (taille
   * vérifiée ; l'empreinte l'est à la copie). Un média absent n'y figure pas : le plan le refuse
   * explicitement (`ASSET_MISSING`).
   */
  async planInputs(
    d: ClipProjectV2,
  ): Promise<
    Record<
      string,
      { kind: 'image' | 'audio'; file: string; sha256: string; durationMs: number | null }
    >
  > {
    const refs = referencedAssets(d);
    const out: Record<
      string,
      { kind: 'image' | 'audio'; file: string; sha256: string; durationMs: number | null }
    > = {};
    for (const id of [...refs.image, ...refs.audio]) {
      const r = this.row(id);
      if (!r || !(await this.present(r))) continue;
      out[id] = {
        kind: r.kind,
        file: `asset-${id}.${r.format}`,
        sha256: r.file_sha256,
        durationMs: r.duration_ms,
      };
    }
    return out;
  }

  /** Durées des sons (ms) : nécessaires au plan de rendu et à l'aperçu. */
  audioDurations(ids: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    const q = this.ctx.db.prepare(
      `SELECT duration_ms FROM media_assets WHERE id = ? AND kind = 'audio'`,
    );
    for (const id of ids) {
      const r = q.get(id) as { duration_ms: number } | undefined;
      if (r) out[id] = r.duration_ms;
    }
    return out;
  }

  /* ----------------------------- Démarrage ----------------------------- */

  /** Imports interrompus et fichiers orphelins (sans ligne en base) : retirés au démarrage. */
  async recover(): Promise<void> {
    await rm(this.incoming, { recursive: true, force: true });
    let shards: string[];
    try {
      shards = await readdir(this.dir);
    } catch {
      return;
    }
    const known = new Set(
      (
        this.ctx.db.prepare('SELECT rel_path, preview_rel_path FROM media_assets').all() as {
          rel_path: string;
          preview_rel_path: string | null;
        }[]
      ).flatMap((r) => [r.rel_path, r.preview_rel_path].filter(Boolean) as string[]),
    );
    for (const shard of shards) {
      if (!/^[0-9a-f]{2}$/u.test(shard)) continue;
      for (const f of await readdir(path.join(this.dir, shard))) {
        const rel = `assets/${shard}/${f}`;
        if (!known.has(rel)) {
          await rm(path.join(this.dir, shard, f), { force: true });
          this.ctx.log.warn({ file: rel }, 'Fichier orphelin de la bibliothèque retiré');
        }
      }
    }
  }
}
