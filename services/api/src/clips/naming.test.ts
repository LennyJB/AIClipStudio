import { describe, expect, it } from 'vitest';
import { contentDisposition, exportDirName, slugify } from './naming';

describe('noms d’export', () => {
  it('ASCII, bornés, sans séparateur ni nom réservé', () => {
    expect(slugify('Le plan « infaillible » de Théo !')).toBe('le-plan-infaillible-de-theo');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('C:\\Windows\\System32')).toBe('c-windows-system32');
    expect(slugify('CON')).toBe('clip');
    expect(slugify('nul')).toBe('clip');
    expect(slugify('')).toBe('clip');
    expect(slugify('😀😀')).toBe('clip');
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });

  it('dossier daté et identifiant court ; en-tête de téléchargement encodé', () => {
    expect(
      exportDirName(
        'Ah super',
        '3f2a9c1e-0000-4000-8000-000000000000',
        new Date('2026-11-25T10:00:00Z'),
      ),
    ).toBe('2026-11-25_ah-super_3f2a9c1e');
    const h = contentDisposition('clip "été"\r\n.mp4');
    expect(h).not.toMatch(/[\r\n]/u);
    expect(h).toContain("filename*=UTF-8''clip%20%22%C3%A9t%C3%A9%22%0D%0A.mp4");
    expect(h.split('"')[1]).toBe('clip___t____.mp4');
  });
});
