/**
 * Moments : regroupement des propositions d'un même enregistrement qui désignent le même passage,
 * d'une analyse à l'autre (plan de l'étape 5, § 3).
 *
 *  - Rapprochement (`matchMoment`, symétrique) : même phrase de chute, ou chutes à 2 s au plus ET
 *    recouvrement d'au moins 50 % de la plus courte des deux plages.
 *  - Pas d'effet de chaîne : une proposition n'est comparée qu'à la RÉFÉRENCE FIGÉE d'un moment
 *    (copie de sa proposition fondatrice), jamais à ses autres membres.
 *  - Déterminisme : pour un même ordre de traitement, le résultat est toujours le même. Un ordre
 *    différent peut légitimement donner d'autres regroupements (la référence est la fondatrice).
 *  - Stabilité : seules les propositions encore sans moment sont affectées ; les appartenances
 *    existantes ne sont jamais recalculées (garanti aussi par la base).
 */
import type { DecisionState, EffectiveDecision, FeedbackEventType } from './review';
import { PENDING_STATE } from './review';

export const MOMENT_RULE_VERSION = 1;
/** Écart maximal entre deux chutes pour un rapprochement par recouvrement. */
export const PUNCHLINE_TOLERANCE_MS = 2000;
/** Recouvrement minimal, rapporté à la plus courte des deux plages. */
export const MIN_OVERLAP_RATIO = 0.5;

/** Ce qui identifie un passage (temps source). */
export interface MomentRef {
  punchlineSegmentId: number;
  punchlineMs: number;
  srcStartMs: number;
  srcEndMs: number;
}

export type MatchKind = 'same_punchline' | 'overlap';

export interface MomentMatch {
  kind: MatchKind;
  /** Recouvrement (0 à 1) rapporté à la plus courte des deux plages. */
  overlap: number;
  /** Écart absolu entre les chutes, en ms. */
  punchlineGapMs: number;
}

export function overlapRatio(a: MomentRef, b: MomentRef): number {
  const inter = Math.min(a.srcEndMs, b.srcEndMs) - Math.max(a.srcStartMs, b.srcStartMs);
  const shortest = Math.min(a.srcEndMs - a.srcStartMs, b.srcEndMs - b.srcStartMs);
  return inter <= 0 || shortest <= 0 ? 0 : inter / shortest;
}

/** Rapprochement de deux passages, ou null. Symétrique. */
export function matchMoment(a: MomentRef, b: MomentRef): MomentMatch | null {
  const overlap = overlapRatio(a, b);
  const punchlineGapMs = Math.abs(a.punchlineMs - b.punchlineMs);
  if (a.punchlineSegmentId === b.punchlineSegmentId) {
    return { kind: 'same_punchline', overlap, punchlineGapMs };
  }
  if (punchlineGapMs <= PUNCHLINE_TOLERANCE_MS && overlap >= MIN_OVERLAP_RATIO) {
    return { kind: 'overlap', overlap, punchlineGapMs };
  }
  return null;
}

export function sameMoment(a: MomentRef, b: MomentRef): boolean {
  return matchMoment(a, b) !== null;
}

/** Moment existant : sa référence figée et son rang d'ancienneté. */
export interface ExistingMoment {
  id: string;
  ref: MomentRef;
  /** Ordre de création (plus petit = plus ancien). */
  order: number;
}

export interface ProposalToAssign {
  id: string;
  ref: MomentRef;
  /** Horodatage de création (ISO) : fixe l'ordre de traitement, avec l'identifiant. */
  createdAt: string;
}

export type Assignment =
  | {
      proposalId: string;
      momentId: string;
      kind: 'founder';
      score: 1;
      /** Le moment est créé par cette proposition, avec cette référence figée. */
      newMoment: { id: string; ref: MomentRef; order: number };
    }
  | { proposalId: string; momentId: string; kind: MatchKind; score: number; newMoment: null };

/** Meilleur candidat : même chute, puis recouvrement, puis chutes proches, puis plus ancien. */
function better(
  a: { m: MomentMatch; moment: ExistingMoment },
  b: { m: MomentMatch; moment: ExistingMoment },
): boolean {
  const ka = a.m.kind === 'same_punchline' ? 0 : 1;
  const kb = b.m.kind === 'same_punchline' ? 0 : 1;
  if (ka !== kb) return ka < kb;
  if (a.m.overlap !== b.m.overlap) return a.m.overlap > b.m.overlap;
  if (a.m.punchlineGapMs !== b.m.punchlineGapMs) return a.m.punchlineGapMs < b.m.punchlineGapMs;
  if (a.moment.order !== b.moment.order) return a.moment.order < b.moment.order;
  return a.moment.id < b.moment.id;
}

/**
 * Affecte des propositions NOUVELLES (sans moment) aux moments existants ou à de nouveaux moments.
 * Ordre de traitement : `createdAt` puis `id`. `newMomentId` fournit l'identifiant des moments
 * créés (injecté pour rester une fonction pure et testable).
 */
export function assignMoments(
  existing: readonly ExistingMoment[],
  proposals: readonly ProposalToAssign[],
  newMomentId: () => string,
): Assignment[] {
  const moments = [...existing];
  let nextOrder = moments.reduce((m, x) => Math.max(m, x.order), -1) + 1;
  const sorted = [...proposals].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.createdAt < b.createdAt
        ? -1
        : 1,
  );
  const out: Assignment[] = [];
  for (const p of sorted) {
    let best: { m: MomentMatch; moment: ExistingMoment } | null = null;
    for (const moment of moments) {
      const m = matchMoment(p.ref, moment.ref); // référence figée UNIQUEMENT : pas de chaîne
      if (m && (!best || better({ m, moment }, best))) best = { m, moment };
    }
    if (best) {
      out.push({
        proposalId: p.id,
        momentId: best.moment.id,
        kind: best.m.kind,
        score: best.m.kind === 'same_punchline' ? 1 : best.m.overlap,
        newMoment: null,
      });
    } else {
      const created = { id: newMomentId(), ref: { ...p.ref }, order: nextOrder++ };
      moments.push(created);
      out.push({
        proposalId: p.id,
        momentId: created.id,
        kind: 'founder',
        score: 1,
        newMoment: created,
      });
    }
  }
  return out;
}

/** Événement éditorial, réduit à ce qui compte pour la décision effective. */
export interface DecisionEvent {
  id: string;
  seq: number;
  proposalId: string;
  type: FeedbackEventType;
  reasons: DecisionState['reasons'];
  comment: string | null;
}

/**
 * Décision effective de chaque moment (une seule par moment) : le DERNIER événement éditorial
 * parmi les propositions qui en sont membres aujourd'hui, quel que soit son type.
 * `proposal_reset` → moment « à examiner », sans source : on ne revient JAMAIS à un événement
 * plus ancien ni à la décision d'un autre membre. Les moments sans événement n'apparaissent pas
 * (ils sont « à examiner »).
 */
export function effectiveDecisions(
  events: readonly DecisionEvent[],
  memberships: ReadonlyMap<string, string>,
): Map<string, EffectiveDecision & { seq: number }> {
  const latest = new Map<string, DecisionEvent>();
  for (const e of events) {
    const moment = memberships.get(e.proposalId);
    if (moment === undefined) continue;
    const cur = latest.get(moment);
    if (!cur || e.seq > cur.seq) latest.set(moment, e);
  }
  const out = new Map<string, EffectiveDecision & { seq: number }>();
  for (const [moment, e] of latest) {
    out.set(
      moment,
      e.type === 'proposal_reset'
        ? { ...PENDING_STATE, reasons: [], sourceProposalId: null, eventId: e.id, seq: e.seq }
        : {
            status: e.type === 'proposal_accepted' ? 'accepted' : 'rejected',
            reasons: [...e.reasons],
            comment: e.comment,
            sourceProposalId: e.proposalId,
            eventId: e.id,
            seq: e.seq,
          },
    );
  }
  return out;
}
