import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createPseudonymizer } from './privacy';

fc.configureGlobal({ numRuns: Number(process.env.FC_RUNS ?? 200) });

const file = {
  schemaVersion: 1 as const,
  pseudonyms: [
    { names: ['Lenny', 'LennyJB'], label: 'Créateur' },
    { names: ['Théo', 'Teo le boss'] },
    { names: ['Jean Paul'] },
    { names: ['Jean'] },
  ],
};

describe('createPseudonymizer', () => {
  const p = createPseudonymizer(file);

  it('remplace les noms listés par des étiquettes stables (casse et accents ignorés)', () => {
    const r = p.apply('Theo il a dit à LENNYJB que théo était nul, hein lenny');
    expect(r.text).toBe(
      '[Personne B] il a dit à [Créateur] que [Personne B] était nul, hein [Créateur]',
    );
    expect(r.pseudonyms).toEqual({ 'Personne B': 2, Créateur: 2 });
  });

  it('préfère le nom le plus long et respecte les limites de mots', () => {
    expect(p.apply('Jean  Paul et Jean, mais pas Jeannot').text).toBe(
      '[Personne C] et [Personne D], mais pas Jeannot',
    );
    expect(p.apply('Teo le boss arrive').text).toBe('[Personne B] arrive');
  });

  it('masque e-mails, liens, numéros et mentions', () => {
    const r = p.apply(
      'écris à jean.dupont@mail.fr ou va sur https://exemple.com/x et twitch.tv/lenny, appelle le 06 12 34 56 78, merci @Pseudo_42',
    );
    expect(r.text).not.toMatch(/dupont|exemple\.com|twitch|06 12|Pseudo_42/);
    expect(r.masked).toEqual({ email: 1, url: 2, phone: 1, mention: 1 });
  });

  it('sans fichier : seuls les masques automatiques s’appliquent', () => {
    const r = createPseudonymizer(null).apply('Lenny : mon mail est a@b.fr');
    expect(r.text).toBe('Lenny : mon mail est [e-mail masqué]');
  });

  it('propriété : aucun nom listé ne subsiste, quel que soit le texte autour', () => {
    const names = ['Lenny', 'LennyJB', 'Théo', 'Teo le boss', 'Jean Paul', 'Jean'];
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(fc.constantFrom(...names), fc.constantFrom('ok', 'mdr', '?', 'sur A', ',')),
          {
            maxLength: 12,
          },
        ),
        (parts) => {
          const out = p.apply(parts.join(' ')).text;
          const words = out
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .toLowerCase()
            .split(/[^\p{L}\p{N}_]+/u);
          for (const n of ['lenny', 'lennyjb', 'theo', 'jean']) expect(words).not.toContain(n);
        },
      ),
    );
  });
});
