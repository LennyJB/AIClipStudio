import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dedupeSegments,
  isDuplicate,
  midpointMs,
  overlapRatio,
  planAllBlocks,
  planBlock,
  selectCoreSegments,
  textSimilarity,
  type BlockPlan,
  type ChunkingOptions,
  type RawSegment,
} from './chunking';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 200) });

const MIN = 60_000;
const OPTS: ChunkingOptions = { coreMs: 20 * MIN, overlapMs: 30_000, boundaryToleranceMs: 1_000 };

const seg = (startMs: number, endMs: number, text = `t${startMs}`): RawSegment => ({
  startMs,
  endMs,
  text,
  avgLogprob: -0.2,
  noSpeechProb: 0.01,
  compressionRatio: 1.2,
  words: [],
});

describe('planBlock', () => {
  it('zone centrale de 20 min, chevauchement de 30 s de chaque côté', () => {
    expect(planBlock(20 * MIN, 90 * MIN, OPTS)).toEqual({
      coreStartMs: 20 * MIN,
      coreEndMs: 40 * MIN,
      readStartMs: 20 * MIN - 30_000,
      readEndMs: 40 * MIN + 30_000,
      isLast: false,
    });
  });
  it('premier et dernier blocs restent dans la piste', () => {
    expect(planBlock(0, 90 * MIN, OPTS)).toMatchObject({ readStartMs: 0 });
    expect(planBlock(80 * MIN, 90 * MIN, OPTS)).toMatchObject({
      coreEndMs: 90 * MIN,
      readEndMs: 90 * MIN,
      isLast: true,
    });
    expect(planBlock(90 * MIN, 90 * MIN, OPTS)).toBeNull();
  });
  it('les zones centrales couvrent toute la piste sans trou ni recouvrement', () => {
    const blocks = planAllBlocks(65 * MIN + 1234, OPTS);
    expect(blocks.map((b) => [b.coreStartMs, b.coreEndMs])).toEqual([
      [0, 20 * MIN],
      [20 * MIN, 40 * MIN],
      [40 * MIN, 60 * MIN],
      [60 * MIN, 65 * MIN + 1234],
    ]);
  });
  it('refuse des options incohérentes', () => {
    expect(() => planBlock(0, MIN, { coreMs: 1000, overlapMs: 0, boundaryToleranceMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => planBlock(0, MIN, { ...OPTS, boundaryToleranceMs: 20_000 })).toThrow(RangeError);
  });
});

describe('attribution par point central', () => {
  const block: BlockPlan = {
    coreStartMs: 20 * MIN,
    coreEndMs: 40 * MIN,
    readStartMs: 0,
    readEndMs: 0,
    isLast: false,
  };

  it('une phrase à cheval sur la frontière appartient au bloc qui contient son point central', () => {
    const across = seg(40 * MIN - 4_000, 40 * MIN + 2_000); // milieu : 40 min − 1 s
    expect(selectCoreSegments([across], block, 0)).toHaveLength(1);
    const next: BlockPlan = { ...block, coreStartMs: 40 * MIN, coreEndMs: 60 * MIN };
    expect(selectCoreSegments([across], next, 0)).toHaveLength(0);
  });

  it('la tolérance accepte un point central légèrement hors zone', () => {
    const justAfter = seg(40 * MIN - 2_000, 40 * MIN + 2_600); // milieu : 40 min + 300 ms
    expect(selectCoreSegments([justAfter], block, 0)).toHaveLength(0);
    expect(selectCoreSegments([justAfter], block, 1_000)).toHaveLength(1);
  });

  it('écarte les segments vides ou de durée nulle et trie', () => {
    const r = selectCoreSegments(
      [seg(30 * MIN, 30 * MIN + 10), seg(25 * MIN, 25 * MIN), seg(21 * MIN, 21 * MIN + 5, '  ')],
      block,
      0,
    );
    expect(r.map((s) => s.startMs)).toEqual([30 * MIN]);
  });
});

describe('déduplication approximative', () => {
  it('similarité de texte insensible à la casse, aux accents et à la ponctuation', () => {
    expect(textSimilarity('Il a dit : « Non ! »', 'il a dit non')).toBe(1);
    expect(textSimilarity('je pose la spike', 'on rotate en B')).toBe(0);
  });

  it('même passage retranscrit avec un léger décalage = doublon', () => {
    const a = { startMs: 1_000, endMs: 4_000, text: 'Attends, attends, il est où ?' };
    expect(
      isDuplicate({ startMs: 1_250, endMs: 4_200, text: 'attends attends il est où' }, a),
    ).toBe(true);
    // Texte réécrit par Whisper mais même intervalle quasi identique : doublon aussi.
    expect(isDuplicate({ startMs: 1_100, endMs: 3_900, text: 'Attend, il est ou ?' }, a)).toBe(
      true,
    );
  });

  it('deux répliques courtes différentes, presque superposées, ne sont pas confondues', () => {
    // Cas trouvé par le test de propriété : « Quoi ? » puis « Non ! » décalés de 300 ms.
    expect(
      isDuplicate(
        { startMs: 300, endMs: 600, text: 'Non !' },
        { startMs: 280, endMs: 590, text: 'Quoi ?' },
      ),
    ).toBe(false);
  });

  it('segments consécutifs ou différents ≠ doublon', () => {
    const a = { startMs: 1_000, endMs: 4_000, text: 'première phrase' };
    expect(isDuplicate({ startMs: 4_000, endMs: 6_000, text: 'première phrase' }, a)).toBe(false);
    expect(isDuplicate({ startMs: 3_000, endMs: 7_000, text: 'tout autre chose' }, a)).toBe(false);
    expect(overlapRatio(a, { startMs: 3_000, endMs: 7_000 })).toBeCloseTo(1 / 3);
  });

  it('écarte aussi un doublon interne aux candidats', () => {
    const { kept, dropped } = dedupeSegments(
      [seg(0, 2_000, 'salut'), seg(100, 2_050, 'salut'), seg(3_000, 4_000, 'ça va')],
      [],
    );
    expect(kept.map((s) => s.text)).toEqual(['salut', 'ça va']);
    expect(dropped).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Simulation complète : phrases réelles, Whisper simulé avec décalage */
/* aléatoire différent à chaque bloc, troncature aux bords de fenêtre. */
/* ------------------------------------------------------------------ */

interface Phrase {
  startMs: number;
  endMs: number;
  text: string;
}

/** Phrases sans chevauchement, ≤ 25 s chacune (Whisper : segments ≤ 30 s). */
const arbPhrases = (durationMs: number) =>
  fc
    .array(
      fc.record({
        gap: fc.integer({ min: 0, max: 120_000 }),
        len: fc.integer({ min: 300, max: 25_000 }),
      }),
      {
        minLength: 1,
        maxLength: 120,
      },
    )
    .map((parts) => {
      const out: Phrase[] = [];
      let t = 0;
      parts.forEach((p, i) => {
        const start = t + p.gap;
        const end = start + p.len;
        if (end <= durationMs)
          out.push({ startMs: start, endMs: end, text: `phrase${i} mot${i}a mot${i}b mot${i}c` });
        t = end;
      });
      return out;
    });

/** Whisper simulé sur [readStart, readEnd[ : tronque ce qui dépasse, décale aléatoirement. */
function fakeWhisper(
  phrases: readonly Phrase[],
  block: BlockPlan,
  jitter: () => number,
): RawSegment[] {
  const out: RawSegment[] = [];
  for (const p of phrases) {
    const a = Math.max(p.startMs, block.readStartMs);
    const b = Math.min(p.endMs, block.readEndMs);
    if (b <= a) continue;
    const truncated = a !== p.startMs || b !== p.endMs;
    const d = jitter();
    const startMs = Math.max(block.readStartMs, a + d);
    const endMs = Math.min(block.readEndMs, Math.max(startMs + 1, b + d));
    out.push(seg(startMs, endMs, truncated ? `${p.text.split(' ')[0]} (coupé)` : p.text));
  }
  return out;
}

/** Boucle de transcription, avec possibilité de s'interrompre après N blocs. */
function runBlocks(
  phrases: readonly Phrase[],
  durationMs: number,
  committed: RawSegment[],
  start: number,
  jitter: () => number,
  maxBlocks = Infinity,
): number {
  let checkpoint = start;
  for (let n = 0; n < maxBlocks; n++) {
    const block = planBlock(checkpoint, durationMs, OPTS);
    if (!block) break;
    const candidates = selectCoreSegments(
      fakeWhisper(phrases, block, jitter),
      block,
      OPTS.boundaryToleranceMs,
    );
    const near = committed.filter(
      (c) => c.endMs > block.readStartMs && c.startMs < block.readEndMs,
    );
    const { kept } = dedupeSegments(candidates, near);
    committed.push(...kept); // « transaction » : segments + checkpoint ensemble
    checkpoint = block.coreEndMs;
  }
  return checkpoint;
}

function assertExactlyOnce(phrases: readonly Phrase[], committed: readonly RawSegment[]) {
  for (const p of phrases) {
    const matches = committed.filter((c) => c.text === p.text);
    expect(matches, `« ${p.text} » [${p.startMs}–${p.endMs}]`).toHaveLength(1);
    expect(Math.abs(midpointMs(matches[0]!) - midpointMs(p))).toBeLessThanOrEqual(400);
  }
  expect(committed.filter((c) => c.text.includes('(coupé)'))).toEqual([]);
  expect(committed).toHaveLength(phrases.length);
}

describe('frontières : ni perte ni doublon', () => {
  const D = 70 * MIN;

  it('phrases exactement centrées sur chaque frontière, avec décalages opposés', () => {
    const phrases: Phrase[] = [20, 40, 60].map((m, i) => ({
      startMs: m * MIN - 3_000,
      endMs: m * MIN + 3_000,
      text: `frontiere${i} a b c`,
    }));
    // Décalages qui poussent le point central de part et d'autre de la frontière selon le bloc.
    let k = 0;
    const alternating = () => (k++ % 2 === 0 ? 250 : -250);
    const committed: RawSegment[] = [];
    runBlocks(phrases, D, committed, 0, alternating);
    assertExactlyOnce(phrases, committed);
  });

  it('propriété : phrases aléatoires, décalages aléatoires ±300 ms', () => {
    fc.assert(
      fc.property(
        arbPhrases(D),
        fc.array(fc.integer({ min: -300, max: 300 }), { minLength: 50 }),
        (phrases, jit) => {
          let i = 0;
          const committed: RawSegment[] = [];
          runBlocks(phrases, D, committed, 0, () => jit[i++ % jit.length]!);
          assertExactlyOnce(phrases, committed);
        },
      ),
    );
  });

  it('propriété : interruption après N blocs puis reprise au checkpoint', () => {
    fc.assert(
      fc.property(
        arbPhrases(D),
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.integer({ min: -300, max: 300 }), { minLength: 50 }),
        (phrases, stopAfter, jit) => {
          let i = 0;
          const jitter = () => jit[i++ % jit.length]!;
          const committed: RawSegment[] = [];
          const checkpoint = runBlocks(phrases, D, committed, 0, jitter, stopAfter);
          // Reprise : nouveau « worker », décalages différents.
          i = 7;
          runBlocks(phrases, D, committed, checkpoint, jitter);
          assertExactlyOnce(phrases, committed);
        },
      ),
    );
  });

  it('piste silencieuse : aucun segment, toutes les zones parcourues', () => {
    const committed: RawSegment[] = [];
    expect(runBlocks([], D, committed, 0, () => 0)).toBe(D);
    expect(committed).toEqual([]);
  });
});
