/**
 * État d'interface de l'éditeur (non persistant, jamais envoyé) : tête de lecture, lecture,
 * sélection, zoom et défilement de la timeline.
 */
import { createStore } from 'zustand/vanilla';

export type Selection =
  | { kind: 'segment'; id: string }
  | { kind: 'caption'; id: string }
  | { kind: 'effect'; id: string }
  | { kind: 'overlay'; id: string }
  | { kind: 'mask'; id: string }
  | { kind: 'layer'; id: string }
  | { kind: 'track'; audioIndex: number };

export interface UiState {
  playheadMs: number;
  playing: boolean;
  /** Pistes de l'enregistrement réellement jouées par Web Audio (vide à l'arrêt). */
  playingTracks: number[];
  /** Vitesse J/K/L : négative (retour), 0 (arrêt), positive. Seule la lecture ×1 est sonorisée. */
  shuttle: number;
  selection: Selection | null;
  /** Pixels par seconde de la timeline. */
  pxPerSec: number;
  scrollPx: number;
  snapping: boolean;
  setPlayhead(ms: number): void;
  setPlaying(p: boolean): void;
  setPlayingTracks(t: number[]): void;
  select(s: Selection | null): void;
  setZoom(pxPerSec: number): void;
  setScroll(px: number): void;
  setShuttle(v: number): void;
  toggleSnapping(): void;
}

export const MIN_PX_PER_SEC = 10;
export const MAX_PX_PER_SEC = 600;

export function createUiStore() {
  return createStore<UiState>()((set) => ({
    playheadMs: 0,
    playing: false,
    playingTracks: [],
    shuttle: 0,
    selection: null,
    pxPerSec: 60,
    scrollPx: 0,
    snapping: true,
    setPlayhead: (ms) => set({ playheadMs: Math.max(0, Math.round(ms)) }),
    // À l'arrêt, plus aucune piste n'est jouée.
    setPlaying: (playing) => set(playing ? { playing } : { playing, playingTracks: [] }),
    setPlayingTracks: (playingTracks) => set({ playingTracks }),
    select: (selection) => set({ selection }),
    setZoom: (px) => set({ pxPerSec: Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, px)) }),
    setScroll: (scrollPx) => set({ scrollPx: Math.max(0, scrollPx) }),
    setShuttle: (shuttle) => set({ shuttle }),
    toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  }));
}

export type UiStore = ReturnType<typeof createUiStore>;
