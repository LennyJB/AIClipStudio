/**
 * Scénario de test partagé (3 minutes) : un échange animé et une ironie calme, avec un faux
 * modèle qui y trouve un clip (ironie) et un moment secondaire (échange). Aucun appel réel.
 */
import type { FakeReply, ModelRequest } from '@acs/editorial';

const S = 1000;

export const SCENARIO_MIC = [
  { startMs: 30 * S, endMs: 33 * S, text: 'tu vas où là ?' },
  { startMs: 38 * S, endMs: 41 * S, text: 'attends quoi ? mdr' },
  { startMs: 46 * S, endMs: 49 * S, text: 'sérieux ?! mais non' },
  { startMs: 90 * S, endMs: 93 * S, text: 'je regarde la carte' },
  { startMs: 100 * S, endMs: 103 * S, text: 'on prend le temps cette fois' },
  { startMs: 110 * S, endMs: 113 * S, text: 'bon je fais confiance à Théo' },
  { startMs: 118 * S, endMs: 121 * S, text: 'Bon on va tenter le plan de Théo' },
  { startMs: 125 * S, endMs: 128 * S, text: 'Ah super, j’adore perdre ce round' },
  { startMs: 130 * S, endMs: 133 * S, text: 'Vraiment, magnifique stratégie' },
  { startMs: 140 * S, endMs: 143 * S, text: 'on recommence la manche' },
  { startMs: 160 * S, endMs: 163 * S, text: 'allez on se concentre' },
];

export const SCENARIO_DISCORD = [
  { startMs: 34 * S, endMs: 37 * S, text: 'SECRETDISCORD je suis à B ?' },
  { startMs: 42 * S, endMs: 45 * S, text: 'SECRETBIS rotate rotate' },
  { startMs: 122 * S, endMs: 124 * S, text: 'SECRETTER fais-moi confiance' },
];

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Identifiant d'un segment dans le texte réellement envoyé (comme le ferait le modèle). */
export const idOf = (req: ModelRequest, phrase: string) => {
  const m = new RegExp(`#(\\d+) MIC[^\\]]*\\] ${escapeRe(phrase)}`).exec(req.userText);
  return m ? Number(m[1]) : null;
};

function moment(
  tier: 'clip' | 'secondaire',
  title: string,
  relevance: number,
  ids: [number, number, number],
  quotes: [string, string, string],
) {
  return {
    suggestedTier: tier,
    title,
    explanation: `${title} : explication.`,
    categories: ['humour'],
    relevance,
    setupSegmentId: ids[0],
    punchlineSegmentId: ids[1],
    reactionEndSegmentId: ids[2],
    standalone: true,
    evidence: [
      { segmentId: ids[0], quote: quotes[0], role: 'mise_en_place' },
      { segmentId: ids[1], quote: quotes[1], role: 'chute' },
      { segmentId: ids[2], quote: quotes[2], role: 'reaction' },
    ],
    visualEvidence: [],
    tracksUsed: ['MIC'],
    editingHint: { mode: 'fidele', ideas: [] },
    uncertainty: null,
  };
}

/** Repérage : l'ironie calme ; analyse : un clip (ironie) et un moment secondaire (échange). */
export function scenarioScript(req: ModelRequest): FakeReply {
  if (req.stage === 'triage') {
    const a = idOf(req, 'Bon on va tenter le plan de [Coéquipier 1]');
    const b = idOf(req, 'Vraiment, magnifique stratégie');
    return {
      kind: 'json',
      value: {
        moments:
          a && b
            ? [
                {
                  startSegmentId: a,
                  endSegmentId: b,
                  kind: 'ironie',
                  strength: 'fort',
                  why: 'Ironie.',
                },
              ]
            : [],
        streamSummary: 'Partie de Valorant.',
      },
    };
  }
  const moments: unknown[] = [];
  const s = idOf(req, 'Bon on va tenter le plan de [Coéquipier 1]');
  const p = idOf(req, 'Ah super, j’adore perdre ce round');
  const r = idOf(req, 'Vraiment, magnifique stratégie');
  if (s && p && r) {
    moments.push(
      moment(
        'clip',
        'Le plan infaillible',
        84,
        [s, p, r],
        ['on va tenter le plan', 'j’adore perdre ce round', 'magnifique stratégie'],
      ),
    );
  }
  const s2 = idOf(req, 'tu vas où là ?');
  const p2 = idOf(req, 'attends quoi ? mdr');
  const r2 = idOf(req, 'sérieux ?! mais non');
  if (s2 && p2 && r2) {
    moments.push(
      moment(
        'secondaire',
        'Le malentendu',
        50,
        [s2, p2, r2],
        ['tu vas où', 'attends quoi', 'mais non'],
      ),
    );
  }
  return { kind: 'json', value: { moments, noClipReason: moments.length ? null : 'Rien.' } };
}
