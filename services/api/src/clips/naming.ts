/**
 * Noms d'export sûrs (docs/plan-etape-6.md §11) : ASCII, longueur bornée, jamais de séparateur
 * de chemin, de « .. » ni de nom réservé Windows. Le titre vient de l'analyse : donnée non fiable.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;

export function slugify(title: string, max = 40): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, max)
    .replace(/-+$/gu, '');
  if (!ascii || RESERVED.test(ascii)) return 'clip';
  return ascii;
}

/** Dossier d'export : « AAAA-MM-JJ_titre_idcourt ». */
export function exportDirName(title: string, renderId: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  const short = renderId.replace(/[^a-f0-9]/giu, '').slice(0, 8) || 'rendu';
  return `${day}_${slugify(title)}_${short}`;
}

/** Valeur d'en-tête Content-Disposition (RFC 6266 / 5987), sans aucun caractère dangereux. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^A-Za-z0-9._-]/gu, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
