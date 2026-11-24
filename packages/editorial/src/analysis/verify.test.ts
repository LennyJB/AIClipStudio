import { describe, expect, it } from 'vitest';
import type { DeepMoment } from './schemas';
import { seg } from './test-helpers';
import { quoteMatches } from './text';
import { verifyMoment } from './verify';

const s1 = seg('creator', 1_000, 3_000, 'on va en A, fais-moi confiance');
const s2 = seg('teammates', 3_500, 5_000, 'SECRET réponse non transmise');
const s3 = seg('creator', 5_500, 7_000, 'Ah. Donc on est tous en B.');
const s4 = seg('creator', 7_200, 9_000, 'Magnifique stratégie, vraiment.');
const byId = new Map([s1, s2, s3, s4].map((s) => [s.id, s]));
// s2 (Discord) n'a PAS été transmis : absent de sentTexts.
const sent = new Map([
  [s1.id, 'on va en A, fais-moi confiance'],
  [s3.id, 'Ah. Donc on est tous en B.'],
  [s4.id, 'Magnifique stratégie, vraiment.'],
]);
const ctx = { sentTexts: sent, segmentsById: byId, frameLabels: new Set(['F1']) };

const moment = (over: Partial<DeepMoment> = {}): DeepMoment => ({
  suggestedTier: 'clip',
  title: 'Le call inversé',
  explanation: 'Annonce A, tout le monde va en B, ironie finale.',
  categories: ['malentendu'],
  relevance: 80,
  setupSegmentId: s1.id,
  punchlineSegmentId: s3.id,
  reactionEndSegmentId: s4.id,
  standalone: true,
  evidence: [
    { segmentId: s1.id, quote: 'on va en A', role: 'mise_en_place' },
    { segmentId: s3.id, quote: 'DONC on est tous en b', role: 'chute' },
  ],
  visualEvidence: [{ frameLabel: 'F1', note: 'site B' }],
  tracksUsed: ['MIC'],
  editingHint: { mode: 'fidele', ideas: [] },
  uncertainty: null,
  ...over,
});

describe('quoteMatches', () => {
  it('ignore casse, accents et ponctuation, mais exige des mots entiers', () => {
    expect(quoteMatches('magnifique strategie', 'Magnifique stratégie, vraiment.')).toBe(true);
    expect(quoteMatches('gnifique strat', 'Magnifique stratégie')).toBe(false);
    expect(quoteMatches('une phrase inventée', 'Magnifique stratégie')).toBe(false);
    expect(quoteMatches('', 'x')).toBe(false);
  });
});

describe('verifyMoment', () => {
  it('accepte un moment correct (citations retrouvées malgré la casse)', () => {
    const r = verifyMoment(moment(), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.evidence).toHaveLength(2);
      expect(r.value.visual).toHaveLength(1);
      expect(r.value.issues).toEqual([]);
    }
  });

  it('rejette un identifiant inventé', () => {
    expect(verifyMoment(moment({ punchlineSegmentId: 999_999 }), ctx)).toMatchObject({ ok: false });
  });

  it('rejette un segment Discord non transmis, même s’il existe localement', () => {
    expect(verifyMoment(moment({ setupSegmentId: s2.id }), ctx)).toMatchObject({ ok: false });
  });

  it('rejette un ordre inversé', () => {
    expect(
      verifyMoment(moment({ setupSegmentId: s4.id, reactionEndSegmentId: s1.id }), ctx),
    ).toMatchObject({ ok: false });
  });

  it('retire une citation inventée ; sans citation vérifiée de la chute, rejette', () => {
    const partial = verifyMoment(
      moment({
        evidence: [
          { segmentId: s1.id, quote: 'phrase jamais prononcée', role: 'mise_en_place' },
          { segmentId: s3.id, quote: 'on est tous en B', role: 'chute' },
          { segmentId: s2.id, quote: 'SECRET', role: 'reaction' },
        ],
      }),
      ctx,
    );
    expect(partial.ok).toBe(true);
    if (partial.ok) {
      expect(partial.value.evidence.map((e) => e.segmentId)).toEqual([s3.id]);
      expect(partial.value.issues).toHaveLength(2);
      expect(partial.value.quotesProposed).toBe(3);
    }
    const noPunch = verifyMoment(
      moment({ evidence: [{ segmentId: s3.id, quote: 'on est tous en C', role: 'chute' }] }),
      ctx,
    );
    expect(noPunch).toMatchObject({ ok: false, reason: 'aucune citation vérifiée de la chute' });
  });

  it('retire une image inexistante', () => {
    const r = verifyMoment(moment({ visualEvidence: [{ frameLabel: 'F9', note: '' }] }), ctx);
    expect(r.ok && r.value.visual).toEqual([]);
  });
});
