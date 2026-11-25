/**
 * Réapplication d'un lot local construit sur une ancienne tête (docs/plan-etape-7.md §6.3).
 *
 * Principe : JAMAIS sur la seule base d'identifiants différents. La réapplication automatique
 * n'est acceptée que si l'indépendance est DÉMONTRÉE dans les deux sens et que les deux ordres
 * donnent le même document. Sinon : conflit explicite, le brouillon est conservé par l'appelant.
 *
 * Notations : L = lot local, D = entrées distantes intermédiaires ; lu(x) et écrit(x) comprennent
 * les dépendances structurelles déclarées par les opérations.
 *
 *  1. écrit(D) ∩ (lu(L) ∪ écrit(L)) = ∅
 *  2. lu(D) ∩ écrit(L) = ∅                       (sens inverse, obligatoire)
 *  3. aucune entrée de D n'est un `undo`/`redo` qui touche une clé lue ou écrite par L
 *  4. préconditions de L vraies sur la nouvelle tête, ET préconditions de D vraies sur le
 *     document obtenu en appliquant L en premier (les deux ordres sont valides)
 *  5. même empreinte canonique pour « D puis L » et « L puis D » (filet de sécurité)
 *  6. invariants respectés (garantis par l'application des opérations)
 *  7. aucune opération de L ne touche aux masques ni à l'audio (confirmation toujours exigée)
 */
import type { EntryKind } from './history';
import { isSensitiveKey, keyFingerprint, type StateKey } from './keys';
import { applyBatch, documentFingerprint, OpError, type AppliedOp, type ApplyContext } from './ops';
import type { ClipProjectV2 } from './schema';

export interface RemoteEntry {
  kind: EntryKind;
  ops: readonly unknown[];
}

export type ReapplyRefusal =
  | 'LOCAL_INVALID'
  | 'REMOTE_INVALID'
  | 'C1_REMOTE_WRITE_VS_LOCAL'
  | 'C2_REMOTE_READ_VS_LOCAL_WRITE'
  | 'C3_REMOTE_HISTORY'
  | 'C4_PRECONDITIONS'
  | 'C5_ORDER_DEPENDENT'
  | 'C6_INVARIANT'
  | 'C7_SENSITIVE';

export type ReapplyDecision =
  | { ok: true; doc: ClipProjectV2; applied: AppliedOp[] }
  | { ok: false; reason: ReapplyRefusal; keys: StateKey[] };

interface Footprint {
  reads: Set<StateKey>;
  writes: Set<StateKey>;
  /** Clés lues avant toute écriture du lot, avec leur valeur initiale. */
  external: Map<StateKey, string | null>;
}

function footprint(applied: readonly AppliedOp[]): Footprint {
  const reads = new Set<StateKey>();
  const writes = new Set<StateKey>();
  const external = new Map<StateKey, string | null>();
  for (const a of applied) {
    for (const k of a.reads) {
      reads.add(k);
      if (!writes.has(k) && !external.has(k)) external.set(k, a.preconditions[k] ?? null);
    }
    for (const k of a.writes) writes.add(k);
  }
  return { reads, writes, external };
}

const intersect = (a: Set<StateKey>, b: Set<StateKey>) => [...a].filter((k) => b.has(k)).sort();
const union = (a: Set<StateKey>, b: Set<StateKey>) => new Set([...a, ...b]);

function tryBatch(doc: ClipProjectV2, ops: readonly unknown[], ctx: ApplyContext) {
  try {
    return applyBatch(doc, ops, ctx);
  } catch (e) {
    if (e instanceof OpError) return e;
    throw e;
  }
}

export function decideReapply(
  base: ClipProjectV2,
  remote: readonly RemoteEntry[],
  local: readonly unknown[],
  ctx: ApplyContext = {},
): ReapplyDecision {
  const refuse = (reason: ReapplyRefusal, keys: StateKey[] = []): ReapplyDecision => ({
    ok: false,
    reason,
    keys,
  });

  // Empreintes : D rejoué depuis la base (tel qu'il a été appliqué), L calculé sur la base.
  const remoteOps = remote.flatMap((e) => e.ops);
  const d = tryBatch(base, remoteOps, {});
  if (d instanceof OpError) return refuse('REMOTE_INVALID');
  const l = tryBatch(base, local, ctx);
  if (l instanceof OpError) return refuse('LOCAL_INVALID');
  const fD = footprint(d.applied);
  const fL = footprint(l.applied);
  const touchedL = union(fL.reads, fL.writes);

  // 1. Écritures distantes contre lectures et écritures locales.
  const c1 = intersect(fD.writes, touchedL);
  if (c1.length) return refuse('C1_REMOTE_WRITE_VS_LOCAL', c1);

  // 2. Lectures distantes contre écritures locales (sens inverse).
  const c2 = intersect(fD.reads, fL.writes);
  if (c2.length) return refuse('C2_REMOTE_READ_VS_LOCAL_WRITE', c2);

  // 3. Annuler / rétablir distants touchant ce que L lit ou écrit.
  let cursor = 0;
  for (const e of remote) {
    const slice = d.applied.slice(cursor, cursor + e.ops.length);
    cursor += e.ops.length;
    if (e.kind !== 'undo' && e.kind !== 'redo') continue;
    const fe = footprint(slice);
    const c3 = intersect(union(fe.reads, fe.writes), touchedL);
    if (c3.length) return refuse('C3_REMOTE_HISTORY', c3);
  }

  // 4. Préconditions dans les deux ordres.
  const head = d.doc;
  const docL = l.doc;
  const failedL = [...fL.external]
    .filter(([k, v]) => keyFingerprint(head, k) !== v)
    .map(([k]) => k);
  if (failedL.length) return refuse('C4_PRECONDITIONS', failedL.sort());
  const failedD = [...fD.external]
    .filter(([k, v]) => keyFingerprint(docL, k) !== v)
    .map(([k]) => k);
  if (failedD.length) return refuse('C4_PRECONDITIONS', failedD.sort());

  // 7. Masques et audio : jamais de réapplication automatique (vérifié avant tout calcul final).
  const sensitive = [...fL.writes].filter(isSensitiveKey).sort();
  if (sensitive.length) return refuse('C7_SENSITIVE', sensitive);

  // 5 et 6. Les deux ordres : valides (invariants) et identiques.
  const dThenL = tryBatch(head, local, ctx);
  if (dThenL instanceof OpError) {
    return refuse(dThenL.code === 'INVARIANT_VIOLATED' ? 'C6_INVARIANT' : 'C4_PRECONDITIONS');
  }
  const lThenD = tryBatch(docL, remoteOps, {});
  if (lThenD instanceof OpError) {
    return refuse(lThenD.code === 'INVARIANT_VIOLATED' ? 'C6_INVARIANT' : 'C4_PRECONDITIONS');
  }
  if (documentFingerprint(dThenL.doc) !== documentFingerprint(lThenD.doc)) {
    return refuse('C5_ORDER_DEPENDENT');
  }
  return { ok: true, doc: dThenL.doc, applied: dThenL.applied };
}
