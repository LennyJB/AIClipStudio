/**
 * Vérification locale d'un moment proposé par Claude. Rien n'est cru sur parole :
 *  - les identifiants doivent désigner des segments RÉELLEMENT transmis dans cette requête
 *    (un segment Discord non transmis ne peut pas être cité) ;
 *  - mise en place ≤ chute ≤ fin de réaction, dans le temps ;
 *  - chaque citation doit se retrouver mot à mot dans le texte envoyé de son segment ;
 *    une citation fausse est retirée ; sans citation vérifiée de la chute, le moment est rejeté ;
 *  - une preuve visuelle doit désigner une image réellement fournie.
 */
import type { DeepMoment } from './schemas';
import { quoteMatches } from './text';
import type { AnalysisSegment } from './types';

export interface VerifyContext {
  /** Texte EXACT transmis, par identifiant de segment (fenêtre courante). */
  sentTexts: ReadonlyMap<number, string>;
  /** Tous les segments locaux, par identifiant (temps, mots). */
  segmentsById: ReadonlyMap<number, AnalysisSegment>;
  frameLabels: ReadonlySet<string>;
}

export interface VerifiedEvidence {
  segmentId: number;
  quote: string;
  role: DeepMoment['evidence'][number]['role'];
  srcMs: number;
}

export interface VerifiedMoment {
  moment: DeepMoment;
  setup: AnalysisSegment;
  punchline: AnalysisSegment;
  reactionEnd: AnalysisSegment;
  evidence: VerifiedEvidence[];
  /** Nombre de citations proposées (vérifiées ou non). */
  quotesProposed: number;
  visual: { frameLabel: string; note: string }[];
  /** Problèmes non bloquants (citation retirée, image inconnue…). */
  issues: string[];
}

export type VerifyResult = { ok: true; value: VerifiedMoment } | { ok: false; reason: string };

export function verifyMoment(m: DeepMoment, ctx: VerifyContext): VerifyResult {
  const seg = (id: number) => (ctx.sentTexts.has(id) ? ctx.segmentsById.get(id) : undefined);
  const setup = seg(m.setupSegmentId);
  const punchline = seg(m.punchlineSegmentId);
  const reactionEnd = seg(m.reactionEndSegmentId);
  if (!setup || !punchline || !reactionEnd) {
    return { ok: false, reason: 'identifiant de segment inexistant ou non transmis' };
  }
  if (!(setup.startMs <= punchline.startMs && punchline.startMs <= reactionEnd.startMs)) {
    return { ok: false, reason: 'ordre mise en place → chute → réaction incohérent' };
  }
  const issues: string[] = [];
  const evidence: VerifiedEvidence[] = [];
  for (const e of m.evidence) {
    const text = ctx.sentTexts.get(e.segmentId);
    const s = ctx.segmentsById.get(e.segmentId);
    if (text === undefined || !s) {
      issues.push(`citation retirée : segment #${e.segmentId} non transmis`);
      continue;
    }
    if (!quoteMatches(e.quote, text)) {
      issues.push(`citation retirée : introuvable mot à mot dans #${e.segmentId}`);
      continue;
    }
    evidence.push({ segmentId: e.segmentId, quote: e.quote, role: e.role, srcMs: s.startMs });
  }
  if (!evidence.some((e) => e.segmentId === punchline.id)) {
    return { ok: false, reason: 'aucune citation vérifiée de la chute' };
  }
  const visual = m.visualEvidence.filter((v) => {
    if (ctx.frameLabels.has(v.frameLabel)) return true;
    issues.push(`image inconnue retirée : ${v.frameLabel}`);
    return false;
  });
  return {
    ok: true,
    value: {
      moment: m,
      setup,
      punchline,
      reactionEnd,
      evidence,
      quotesProposed: m.evidence.length,
      visual,
      issues,
    },
  };
}
