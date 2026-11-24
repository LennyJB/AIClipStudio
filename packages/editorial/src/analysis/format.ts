/** Mise en forme des temps source pour le contenu préparé et l'affichage. */

/** 3723456 → « 01:02:03.4 » (dixièmes : assez précis pour désigner une phrase). */
export function formatClock(ms: number, tenths = true): string {
  const total = Math.max(0, Math.round(ms / 100));
  const t = total % 10;
  const s = Math.floor(total / 10);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return tenths ? `${hh}:${mm}:${ss}.${t}` : `${hh}:${mm}:${ss}`;
}

/** 192000 → « 3 min 12 s ». */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
