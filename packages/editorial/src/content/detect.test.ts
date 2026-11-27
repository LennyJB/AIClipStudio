import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ContentProfile, ContentType } from '@acs/shared';
import { computeSignals } from '../analysis/signals';
import { seg } from '../analysis/test-helpers';
import type { AnalysisSegment, Speaker } from '../analysis/types';
import { loadContentProfiles } from '../profiles';
import {
  CONTENT_BLOCK_MS,
  CORROBORATED_CAP,
  SINGLE_CORROBORATION_CAP,
  TRANSCRIPT_ONLY_CAP,
  detectContentTypes,
  summarizeContent,
  type VisualSample,
} from './detect';

const PROFILES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../profiles',
);
let profiles: Record<ContentType, ContentProfile>;
beforeAll(async () => {
  profiles = await loadContentProfiles(PROFILES_DIR);
});

const MIN = 60_000;
const GAME_TERMS = ['spike', 'defuse', 'clutch', 'ace', 'round'];

/** Une minute de parole : phrases de 4 s séparées de 1 s, en alternant les voix données. */
function minute(startMs: number, speakers: Speaker[], lines: string[]): AnalysisSegment[] {
  const out: AnalysisSegment[] = [];
  for (let i = 0; i < 12; i++) {
    const s = startMs + i * 5000;
    out.push(seg(speakers[i % speakers.length]!, s, s + 4000, lines[i % lines.length]!));
  }
  return out;
}

const FORMATS = {
  gaming: {
    speakers: ['creator', 'teammates'] as Speaker[],
    lines: [
      'ils plantent le spike en B',
      'je defuse couvre moi',
      'clutch clutch vas-y',
      'on gagne le round',
      'je suis mort il m’a tué',
      'ace pour lui',
    ],
    visual: 18,
  },
  just_chatting: {
    speakers: ['creator'] as Speaker[],
    lines: [
      'merci pour le sub les amis',
      'alors dans le chat quelqu’un demande',
      'vous en pensez quoi dites-moi',
      'bon je vous raconte ma journée',
      'merci pour le follow',
      'je mange des pâtes ce soir',
    ],
    visual: 2,
  },
  reaction: {
    speakers: ['creator'] as Speaker[],
    lines: [
      'attends je mets pause',
      'regardez ça c’est fou !',
      'on regarde la suite de la vidéo',
      'il a dit quoi là ?',
      'je relance',
      'non mais cette vidéo',
    ],
    visual: 15,
  },
  podcast: {
    speakers: ['creator', 'teammates'] as Speaker[],
    lines: [
      'bienvenue à notre invité dans cet épisode',
      'merci de m’avoir invité, c’est un plaisir de parler de mon parcours',
      'question suivante, comment as-tu commencé ?',
      'eh bien au début je travaillais dans une petite structure',
      'et ton parcours depuis ?',
      'j’ai beaucoup appris en route',
    ],
    visual: 3,
  },
  irl: {
    speakers: ['creator'] as Speaker[],
    lines: [
      'on est dans la rue là',
      'regardez on arrive à la gare',
      'il fait froid ce matin',
      'on marche vers le resto',
      'les gens sont sympas ici',
      'on prend le métro',
    ],
    visual: 14,
  },
} satisfies Record<ContentType, { speakers: Speaker[]; lines: string[]; visual: number }>;

interface Plan {
  type: ContentType | 'silence' | 'monologue' | 'gaming_thanks';
  minutes: number;
}

function build(plan: Plan[], opts: { visual?: boolean; separate?: boolean } = {}) {
  const segments: AnalysisSegment[] = [];
  const visual: VisualSample[] = [];
  let t = 0;
  for (const p of plan) {
    for (let m = 0; m < p.minutes; m++, t += MIN) {
      let score: number;
      if (p.type === 'silence') score = 1;
      else if (p.type === 'gaming_thanks') {
        // En pleine partie, le créateur remercie le chat : mots de Just Chatting, image de jeu.
        segments.push(
          ...minute(
            t,
            ['creator', 'teammates'],
            [
              'merci pour le sub',
              'dans le chat ils disent',
              'merci pour le follow',
              'on gagne le round',
            ],
          ),
        );
        score = 18;
      } else if (p.type === 'monologue') {
        segments.push(
          ...minute(
            t,
            ['creator'],
            ['bon alors', 'je réfléchis un peu', 'c’est une histoire longue', 'enfin bref'],
          ),
        );
        score = 6;
      } else {
        const f = FORMATS[p.type];
        segments.push(...minute(t, f.speakers, f.lines));
        score = f.visual;
      }
      for (let k = 0; k < 30; k++) visual.push({ tMs: t + k * 2000, score });
    }
  }
  const mapped =
    opts.separate === false
      ? segments.map((s) => ({ ...s, speaker: 'mixed' as const, audioIndex: 0 }))
      : segments;
  const signals = computeSignals({
    durationMs: t,
    segments: mapped,
    energy: [],
    gameTerms: GAME_TERMS,
  });
  return {
    durationMs: t,
    segments: mapped,
    signals,
    profiles,
    gameTermsMeaningful: true,
    visual: opts.visual === false ? null : visual,
  };
}

describe('détection des types de contenu : un format par enregistrement', () => {
  for (const type of Object.keys(FORMATS) as ContentType[]) {
    it(`${type} : reconnu sur tout l’enregistrement, confiance corroborée, résumé = ${type}`, () => {
      const d = detectContentTypes(build([{ type, minutes: 12 }]));
      expect(d.segments).toHaveLength(1);
      expect(d.segments[0]).toMatchObject({ startMs: 0, endMs: 12 * MIN, type, source: 'auto' });
      expect(d.segments[0]!.confidence).toBeGreaterThan(TRANSCRIPT_ONLY_CAP);
      expect(d.segments[0]!.confidence).toBeLessThanOrEqual(CORROBORATED_CAP);
      expect(d.segments[0]!.basis).toContain('visuel');
      expect(d.summary).toMatchObject({ kind: type, unknownShare: 0 });
      expect(d.limits).toEqual([]);
    });
  }
});

describe('streams mixtes et changements de contexte', () => {
  it('Just Chatting → Gaming → Réaction : trois segments, transitions situées à un bloc près, résumé « mixte »', () => {
    const d = detectContentTypes(
      build([
        { type: 'just_chatting', minutes: 15 },
        { type: 'gaming', minutes: 30 },
        { type: 'reaction', minutes: 15 },
      ]),
    );
    expect(d.segments.map((s) => s.type)).toEqual(['just_chatting', 'gaming', 'reaction']);
    expect(Math.abs(d.segments[0]!.endMs - 15 * MIN)).toBeLessThanOrEqual(CONTENT_BLOCK_MS);
    expect(Math.abs(d.segments[1]!.endMs - 45 * MIN)).toBeLessThanOrEqual(CONTENT_BLOCK_MS);
    expect(d.segments.at(-1)!.endMs).toBe(60 * MIN);
    expect(d.summary.kind).toBe('mixed');
    expect(d.summary.types.map((t) => t.type)).toEqual(['gaming', 'just_chatting', 'reaction']);
  });

  it('segments contigus, ordonnés, qui couvrent tout l’enregistrement (jamais de trou)', () => {
    const d = detectContentTypes(
      build([
        { type: 'podcast', minutes: 8 },
        { type: 'silence', minutes: 4 },
        { type: 'irl', minutes: 9 },
        { type: 'gaming', minutes: 6 },
      ]),
    );
    expect(d.segments[0]!.startMs).toBe(0);
    for (let i = 1; i < d.segments.length; i++) {
      expect(d.segments[i]!.startMs).toBe(d.segments[i - 1]!.endMs);
      expect(d.segments[i]!.type).not.toBe(d.segments[i - 1]!.type);
    }
    expect(d.segments.at(-1)!.endMs).toBe(27 * MIN);
    expect(d.segments.map((s) => s.type)).toEqual(['podcast', 'unknown', 'irl', 'gaming']);
  });

  it('une minute ambiguë (remerciements au chat en pleine partie) est lissée : pas de micro-segment', () => {
    const d = detectContentTypes(
      build([
        { type: 'gaming', minutes: 10 },
        { type: 'gaming_thanks', minutes: 1 },
        { type: 'gaming', minutes: 10 },
      ]),
    );
    expect(d.segments.map((s) => s.type)).toEqual(['gaming']);
  });

  it('une vraie pause Just Chatting de 5 min au milieu d’une partie est conservée', () => {
    const d = detectContentTypes(
      build([
        { type: 'gaming', minutes: 10 },
        { type: 'just_chatting', minutes: 5 },
        { type: 'gaming', minutes: 10 },
      ]),
    );
    expect(d.segments.map((s) => s.type)).toEqual(['gaming', 'just_chatting', 'gaming']);
    expect(d.summary.kind).toBe('mixed');
  });

  it('un passage minoritaire (< 10 % et < 5 min) n’en fait pas un stream mixte', () => {
    const d = detectContentTypes(
      build([
        { type: 'gaming', minutes: 40 },
        { type: 'just_chatting', minutes: 4 },
      ]),
    );
    expect(d.segments.map((s) => s.type)).toEqual(['gaming', 'just_chatting']);
    expect(d.summary.kind).toBe('gaming');
  });
});

describe('classifications incertaines : ne pas conclure plutôt que se tromper', () => {
  it('silence sans image mesurée : indéterminé, avec la raison', () => {
    const d = detectContentTypes(build([{ type: 'silence', minutes: 5 }], { visual: false }));
    expect(d.segments).toEqual([
      expect.objectContaining({ type: 'unknown', confidence: 0, reason: expect.any(String) }),
    ]);
    expect(d.summary.kind).toBe('unknown');
  });

  it('monologue neutre sans indice de format : indéterminé (les candidats restent visibles)', () => {
    const d = detectContentTypes({
      ...build([{ type: 'monologue', minutes: 6 }], { visual: false }),
      gameTermsMeaningful: false,
    });
    expect(d.segments.map((s) => s.type)).toEqual(['unknown']);
    expect(d.summary.kind).toBe('unknown');
  });

  it('image animée sans aucun mot caractéristique : jeu, vidéo regardée ou extérieur ne sont PAS départagés', () => {
    const input = build([{ type: 'monologue', minutes: 6 }]);
    const visual = input.visual!.map((v) => ({ ...v, score: 15 }));
    const d = detectContentTypes({ ...input, visual, gameTermsMeaningful: false });
    expect(d.segments.map((s) => s.type)).toEqual(['unknown']);
    expect(d.segments[0]!.reason).toMatch(/aucun indice propre/u);
  });

  describe('contre-épreuves : l’activité de l’image ne suffit JAMAIS à conclure', () => {
    /** Image saturée d'activité (au-delà de l'échelle), aucun mot de format. */
    const animated = (
      input: ReturnType<typeof build>,
      opts: { gameTermsMeaningful?: boolean } = {},
    ) => ({
      ...input,
      visual: input.visual!.map((v) => ({ ...v, score: 60 })),
      gameTermsMeaningful: opts.gameTermsMeaningful ?? true,
    });

    it('monologue avec exclamations et rires transcrits : ni Réaction, ni IRL, ni Gaming', () => {
      const segments: AnalysisSegment[] = [];
      for (let m = 0; m < 8; m++)
        segments.push(
          ...minute(
            m * MIN,
            ['creator'],
            ['oh la la !', 'mdr non mais attends', 'sérieux ?!', 'ptdr'],
          ),
        );
      const input = {
        ...build([{ type: 'monologue', minutes: 8 }]),
        segments,
        signals: computeSignals({
          durationMs: 8 * MIN,
          segments,
          energy: [],
          gameTerms: GAME_TERMS,
        }),
      };
      for (const meaningful of [true, false]) {
        const d = detectContentTypes(animated(input, { gameTermsMeaningful: meaningful }));
        expect(d.segments.map((s) => s.type)).toEqual(['unknown']);
        expect(d.summary.kind).toBe('unknown');
      }
    });

    it('échange équilibré à deux voix, image animée, aucun mot de format : ni Gaming ni Podcast', () => {
      const segments: AnalysisSegment[] = [];
      for (let m = 0; m < 8; m++)
        segments.push(
          ...minute(
            m * MIN,
            ['creator', 'teammates'],
            ['bon alors on fait quoi', 'je sais pas trop', 'vas-y toi', 'd’accord'],
          ),
        );
      const input = {
        ...build([{ type: 'monologue', minutes: 8 }]),
        segments,
        signals: computeSignals({
          durationMs: 8 * MIN,
          segments,
          energy: [],
          gameTerms: GAME_TERMS,
        }),
      };
      const d = detectContentTypes(animated(input));
      expect(d.segments.map((s) => s.type)).toEqual(['unknown']);
    });

    it('image animée et voix seule (caméra qui bouge) : jamais IRL sans mots d’extérieur', () => {
      const d = detectContentTypes(animated(build([{ type: 'monologue', minutes: 8 }])));
      expect(d.segments.every((s) => s.type === 'unknown')).toBe(true);
    });

    it('l’image ne fait que corroborer : même transcription, confiance bornée, contradiction pénalisée', () => {
      const words = build([{ type: 'reaction', minutes: 10 }]);
      const none = detectContentTypes({ ...words, visual: null });
      const moving = detectContentTypes(animated(words));
      const still = detectContentTypes({
        ...words,
        visual: words.visual!.map((v) => ({ ...v, score: 0 })),
      });
      const conf = (d: ReturnType<typeof detectContentTypes>) =>
        Math.max(...d.segments.filter((s) => s.type === 'reaction').map((s) => s.confidence), 0);
      expect(conf(none)).toBeLessThanOrEqual(TRANSCRIPT_ONLY_CAP);
      // Une seule mesure corrobore (l'image) : jamais au-delà du plafond correspondant.
      expect(conf(moving)).toBeLessThanOrEqual(SINGLE_CORROBORATION_CAP);
      expect(conf(moving)).toBeGreaterThanOrEqual(conf(none));
      // Image fixe : contredit une réaction ⇒ moins sûre qu'avec l'image animée.
      expect(conf(still)).toBeLessThan(conf(moving));
    });
  });

  it('transcription seule : confiance plafonnée selon ce qui corrobore, limite annoncée', () => {
    for (const type of ['just_chatting', 'reaction', 'gaming'] as const) {
      const d = detectContentTypes(build([{ type, minutes: 10 }], { visual: false }));
      for (const s of d.segments) {
        expect(s.basis).not.toContain('visuel');
        const cap = s.basis.includes('structure_audio')
          ? SINGLE_CORROBORATION_CAP
          : TRANSCRIPT_ONLY_CAP;
        expect(s.confidence).toBeLessThanOrEqual(cap);
        if (s.type !== 'unknown') expect(s.type).toBe(type);
      }
      expect(d.limits.join(' ')).toMatch(/non mesurée/u);
    }
  });

  it('piste unique « Tout » sans image : jamais de répartition des voix inventée', () => {
    const d = detectContentTypes(
      build([{ type: 'podcast', minutes: 10 }], { visual: false, separate: false }),
    );
    for (const s of d.segments) {
      expect(s.basis).not.toContain('structure_audio');
      expect(s.confidence).toBeLessThanOrEqual(TRANSCRIPT_ONLY_CAP);
    }
    expect(d.limits.join(' ')).toMatch(/piste unique/u);
  });

  it('profil de jeu générique : l’absence de termes du jeu n’est pas un indice', () => {
    const d = detectContentTypes({
      ...build([{ type: 'gaming', minutes: 10 }], { visual: false }),
      gameTermsMeaningful: false,
    });
    // Sans termes ni image, une partie en équipe ressemble aussi à une discussion.
    expect(d.segments.every((s) => s.confidence <= TRANSCRIPT_ONLY_CAP)).toBe(true);
    expect(d.limits.join(' ')).toMatch(/générique/u);
  });
});

describe('résumé', () => {
  it('court enregistrement : un format couvrant ≥ 25 % compte même sous 5 min', () => {
    const s = summarizeContent(
      [
        { startMs: 0, endMs: 6 * MIN, type: 'gaming' },
        { startMs: 6 * MIN, endMs: 10 * MIN, type: 'just_chatting' },
      ],
      10 * MIN,
    );
    expect(s.kind).toBe('mixed');
  });

  it('déterministe : même entrée, même détection', () => {
    const input = build([
      { type: 'reaction', minutes: 7 },
      { type: 'irl', minutes: 7 },
    ]);
    expect(detectContentTypes(input)).toEqual(detectContentTypes(input));
  });
});
