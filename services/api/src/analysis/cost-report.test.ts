import { describe, expect, it } from 'vitest';
import { costSummaryLines, type RunCosts } from './cost-report';

const base: RunCosts = {
  realCostUsd: 0.42,
  budgetUsd: 5,
  overrunUsd: 0,
  budgetExceeded: false,
  aboveReservationCalls: 0,
  aboveReservationUsd: 0,
  calls: 4,
  reusedCalls: 1,
  unknownCostCalls: 0,
  byStage: [],
  byWindow: [],
};

describe('costSummaryLines', () => {
  it('distingue le coût réel calculé et le plafond de réservation', () => {
    const t = costSummaryLines(base).join('\n');
    expect(t).toMatch(/Coût réel calculé : 0\.4200 \$/);
    expect(t).toMatch(/Plafond de réservation : 5\.0000 \$/);
    expect(t).toMatch(/facture d’Anthropic fait foi/);
    expect(t).not.toMatch(/DÉPASSEMENT/);
  });

  it('dépassement : coût réel complet et montant du dépassement affichés', () => {
    const t = costSummaryLines({
      ...base,
      realCostUsd: 5.31,
      overrunUsd: 0.31,
      budgetExceeded: true,
      aboveReservationCalls: 1,
      aboveReservationUsd: 0.4,
    }).join('\n');
    expect(t).toMatch(/Coût réel calculé : 5\.3100 \$/);
    expect(t).toMatch(/DÉPASSEMENT DU PLAFOND : .* de 0\.3100 \$/);
    expect(t).toMatch(/1 appel\(s\) ont coûté 0\.4000 \$ de plus que leur réservation/);
  });
});
