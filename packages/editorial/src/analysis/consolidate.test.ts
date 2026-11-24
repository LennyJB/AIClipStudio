import { describe, expect, it } from 'vitest';
import { consolidate, type ConsolidationItem } from './consolidate';

const item = (over: Partial<ConsolidationItem>): ConsolidationItem => ({
  id: 'x',
  tier: 'clip',
  relevance: 70,
  reliability: 70,
  startMs: 0,
  endMs: 30_000,
  punchlineMs: 20_000,
  punchlineQuote: 'donc on est tous en B',
  ...over,
});

describe('consolidate', () => {
  it('zéro proposition → zéro ; propositions distinctes conservées (aucun quota)', () => {
    expect(consolidate([]).size).toBe(0);
    const quotes = [
      'il a planté le spike dans le vide',
      'tu viens de te tuer toi-même',
      'pourquoi tu cours vers eux',
      'mais il est derrière toi',
      'personne ne défuse jamais',
      'je suis le meilleur joueur du monde',
      'on a perdu contre trois joueurs',
      'tu as acheté un bouclier inutile',
      'arrête de parler à ton chat',
      'la porte était ouverte depuis le début',
      'il faut écouter les calls',
      'bon bah on rentre à la maison',
    ];
    const many = Array.from({ length: 12 }, (_, i) =>
      item({
        id: `p${i}`,
        startMs: i * 60_000,
        endMs: i * 60_000 + 30_000,
        punchlineMs: i * 60_000 + 20_000,
        punchlineQuote: quotes[i]!,
      }),
    );
    expect(consolidate(many).size).toBe(0);
  });

  it('chevauchement : garde la meilleure, fusionne l’autre', () => {
    const m = consolidate([
      item({ id: 'a', relevance: 70 }),
      item({ id: 'b', relevance: 90, startMs: 5_000, endMs: 35_000, punchlineMs: 21_000 }),
    ]);
    expect([...m]).toEqual([['a', 'b']]);
  });

  it('même blague répétée plus tard : doublon fusionné', () => {
    const m = consolidate([
      item({ id: 'a', relevance: 85 }),
      item({
        id: 'b',
        relevance: 60,
        startMs: 300_000,
        endMs: 330_000,
        punchlineMs: 320_000,
        punchlineQuote: 'Donc on est TOUS en B !',
      }),
    ]);
    expect(m.get('b')).toBe('a');
  });

  it('un moment secondaire n’est jamais promu : le clip est gardé, même moins pertinent', () => {
    const m = consolidate([
      item({ id: 'clip', tier: 'clip', relevance: 65 }),
      item({ id: 'sec', tier: 'secondary', relevance: 95, startMs: 2_000, endMs: 31_000 }),
    ]);
    expect(m.get('sec')).toBe('clip');
  });
});
