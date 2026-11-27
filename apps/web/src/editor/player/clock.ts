/**
 * Horloge de lecture (docs/plan-etape-7.md §5.3) : l'horloge MAÎTRE est celle de l'audio
 * (`AudioContext.currentTime`) ; la vidéo s'y recale. Sans audio (export muet, aucune piste
 * autorisée), l'horloge du navigateur la remplace. Le temps retourné est un temps MONTAGE (ms),
 * borné au clip.
 */
export interface TimeSource {
  /** Secondes, monotone. */
  now(): number;
}

export class PlaybackClock {
  private anchorSource = 0;
  private anchorEdit = 0;
  private running = false;

  constructor(
    private source: TimeSource,
    private durationMs: number,
  ) {}

  /** Change d'horloge de référence (audio quand il y en a), sans changer le temps montage. */
  setSource(source: TimeSource) {
    const t = this.now();
    this.source = source;
    this.anchorEdit = t;
    this.anchorSource = source.now();
  }

  get playing() {
    return this.running;
  }

  setDuration(ms: number) {
    this.durationMs = ms;
    if (this.now() >= ms) this.seek(Math.max(0, ms - 1));
  }

  /** Temps montage courant (ms). */
  now(): number {
    const t = this.running
      ? this.anchorEdit + (this.source.now() - this.anchorSource) * 1000
      : this.anchorEdit;
    return Math.min(Math.max(0, t), this.durationMs);
  }

  play() {
    if (this.running) return;
    if (this.anchorEdit >= this.durationMs) this.anchorEdit = 0;
    this.anchorSource = this.source.now();
    this.running = true;
  }

  /** Démarre la lecture : le temps montage courant correspond à l'instant `sourceSeconds`. */
  startAt(sourceSeconds: number) {
    if (this.anchorEdit >= this.durationMs) this.anchorEdit = 0;
    this.anchorSource = sourceSeconds;
    this.running = true;
  }

  pause() {
    if (!this.running) return;
    this.anchorEdit = this.now();
    this.running = false;
  }

  seek(ms: number) {
    this.anchorEdit = Math.min(Math.max(0, ms), this.durationMs);
    this.anchorSource = this.source.now();
  }

  /** Fin du clip atteinte pendant la lecture. */
  ended() {
    return this.running && this.now() >= this.durationMs;
  }
}

/** Seuil de recalage de la vidéo sur l'horloge (s). */
export const DRIFT_THRESHOLD_S = 0.08;

export interface VideoLike {
  currentTime: number;
  paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
}

/**
 * Double tampon vidéo : deux éléments ; celui du segment courant est joué et recalé sur
 * l'horloge au-delà de DRIFT_THRESHOLD_S ; l'autre est préchargé au début du segment suivant.
 * `targets[k]` : instant du proxy (s) au début du segment k (null : vide) ; `frozen[k]` : arrêt
 * sur image.
 */
export class VideoSync {
  private active = 0;
  private activeSegment = -1;

  constructor(private readonly videos: [VideoLike, VideoLike]) {}

  /** Élément affichant actuellement l'image. */
  current(): VideoLike {
    return this.videos[this.active]!;
  }

  /**
   * À chaque image : `segment` courant, instant du proxy attendu, état de lecture, et instant de
   * début du segment suivant à précharger (null s'il n'y en a pas ou si c'est un vide).
   */
  update(o: {
    segment: number;
    target: number | null;
    frozen: boolean;
    playing: boolean;
    next: number | null;
  }): { seeked: boolean; drift: number } {
    if (o.segment !== this.activeSegment) {
      // Changement de segment : l'élément préchargé devient actif.
      if (this.activeSegment >= 0 && o.segment === this.activeSegment + 1)
        this.active = 1 - this.active;
      this.activeSegment = o.segment;
      this.videos[1 - this.active]!.pause();
    }
    const v = this.videos[this.active]!;
    const spare = this.videos[1 - this.active]!;
    if (o.next !== null && Math.abs(spare.currentTime - o.next) > 0.001 && spare.paused) {
      spare.currentTime = o.next;
    }
    if (o.target === null) {
      if (!v.paused) v.pause();
      return { seeked: false, drift: 0 };
    }
    const drift = v.currentTime - o.target;
    let seeked = false;
    if (o.frozen || !o.playing) {
      if (!v.paused) v.pause();
      if (Math.abs(drift) > 0.001) {
        v.currentTime = o.target;
        seeked = true;
      }
    } else {
      if (Math.abs(drift) > DRIFT_THRESHOLD_S) {
        v.currentTime = o.target;
        seeked = true;
      }
      if (v.paused) void v.play();
    }
    return { seeked, drift };
  }
}
