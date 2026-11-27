/**
 * Médias de travail de l'éditeur (étape 7d) côté navigateur : préparation (proxy, vignettes
 * masquées, pistes de montage AUTORISÉES et activées, formes d'onde), bail renouvelé tant que
 * l'éditeur est ouvert, jetons éphémères demandés par `fetch` POST (même origine), libération à
 * la fermeture. Aucun chemin de fichier n'est jamais manipulé : uniquement des identifiants.
 */
import type { EditorApi, EditorMedia } from '../api';

/** Renouvellement du bail (le serveur le donne pour 15 minutes). */
export const LEASE_RENEW_MS = 5 * 60_000;
/** Marge avant expiration d'un jeton (10 minutes) pour en redemander un. */
const TOKEN_MARGIN_MS = 60_000;

export class EditorMediaSession {
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private renew: ReturnType<typeof setInterval> | null = null;
  media: EditorMedia | null = null;

  constructor(
    private readonly projectId: string,
    readonly sessionId: string,
    private readonly api: Pick<
      EditorApi,
      'prepareMedia' | 'releaseMedia' | 'mediaToken' | 'mediaUrl'
    >,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Prépare les médias ; rappelle `onUpdate` jusqu'à ce que tout soit prêt. */
  async start(onUpdate: (m: EditorMedia) => void, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; !signal.aborted; attempt++) {
      const m = await this.api.prepareMedia(this.projectId, this.sessionId);
      this.media = m;
      onUpdate(m);
      if (m.status === 'ready') break;
      await new Promise((r) => setTimeout(r, Math.min(3000, 500 + attempt * 250)));
    }
    if (signal.aborted) return;
    this.renew = setInterval(() => {
      this.api
        .prepareMedia(this.projectId, this.sessionId)
        .then((m) => {
          this.media = m;
          onUpdate(m);
        })
        .catch(() => {});
    }, LEASE_RENEW_MS);
  }

  /**
   * Nouvelle préparation (décision d'audio exporté changée) : seules les pistes autorisées
   * AUJOURD'HUI sont renvoyées par le serveur ; les jetons des autres ne sont plus réutilisés.
   */
  async refresh(onUpdate: (m: EditorMedia) => void): Promise<void> {
    this.tokens.clear();
    const m = await this.api.prepareMedia(this.projectId, this.sessionId);
    this.media = m;
    onUpdate(m);
  }

  /** URL d'un média avec un jeton valide (demandé au besoin). */
  async url(derivativeId: string): Promise<string> {
    const cached = this.tokens.get(derivativeId);
    if (cached && cached.expiresAt - this.now() > TOKEN_MARGIN_MS) {
      return this.api.mediaUrl(derivativeId, cached.token);
    }
    const t = await this.api.mediaToken(this.projectId, this.sessionId, derivativeId);
    this.tokens.set(derivativeId, { token: t.token, expiresAt: Date.parse(t.expiresAt) });
    return this.api.mediaUrl(derivativeId, t.token);
  }

  /** Fermeture de l'éditeur : baux rendus (et point de contrôle côté serveur). */
  async stop(): Promise<void> {
    if (this.renew) clearInterval(this.renew);
    this.renew = null;
    this.tokens.clear();
    await this.api.releaseMedia(this.projectId, this.sessionId).catch(() => {});
  }
}

/** Forme d'onde « .dat » (audiowaveform v1, 8 bits) : en-tête de 20 octets, paires min/max. */
export interface Waveform {
  sampleRate: number;
  samplesPerPoint: number;
  length: number;
  data: Int8Array;
}

export function parseWaveform(buf: ArrayBuffer): Waveform {
  const v = new DataView(buf);
  if (buf.byteLength < 20 || v.getInt32(0, true) !== 1 || v.getUint32(4, true) !== 1) {
    throw new Error('Forme d’onde illisible');
  }
  const length = v.getUint32(16, true);
  const data = new Int8Array(buf, 20, Math.min(length * 2, buf.byteLength - 20));
  return { sampleRate: v.getInt32(8, true), samplesPerPoint: v.getInt32(12, true), length, data };
}

/** Amplitude (0..1) maximale d'une forme d'onde sur [fromMs, toMs[ (temps de la piste). */
export function waveformPeak(w: Waveform, fromMs: number, toMs: number): number {
  const pps = w.sampleRate / w.samplesPerPoint;
  const a = Math.max(0, Math.floor((fromMs / 1000) * pps));
  const b = Math.min(w.length, Math.max(a + 1, Math.ceil((toMs / 1000) * pps)));
  let m = 0;
  for (let i = a; i < b; i++) {
    m = Math.max(m, Math.abs(w.data[2 * i]!), Math.abs(w.data[2 * i + 1]!));
  }
  return m / 128;
}
