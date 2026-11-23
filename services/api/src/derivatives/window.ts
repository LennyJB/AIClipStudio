/**
 * Fenêtre source préparée autour d'un clip : marge de chaque côté, puis
 * alignement sur une grille (deux clips proches partagent la même fenêtre,
 * donc la même extraction en cache).
 */
export function clipWindow(
  srcStartMs: number,
  srcEndMs: number,
  opts: { marginMs: number; gridMs: number; durationMs: number | null },
): { startMs: number; endMs: number } {
  const start = Math.max(0, Math.floor((srcStartMs - opts.marginMs) / opts.gridMs) * opts.gridMs);
  let end = Math.ceil((srcEndMs + opts.marginMs) / opts.gridMs) * opts.gridMs;
  if (opts.durationMs !== null && opts.durationMs > 0)
    end = Math.min(end, Math.ceil(opts.durationMs));
  return { startMs: start, endMs: Math.max(end, start + 1) };
}
