import { createHash } from 'node:crypto';

/** JSON canonique : clés triées récursivement (même contenu → même chaîne). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
