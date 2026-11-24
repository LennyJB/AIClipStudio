/** Interface d'un modèle éditorial : le vrai Claude ou un faux modèle pour les tests. */
import type { ModelRequest, RequestImage } from './request';

export interface ModelUsage {
  /** Jetons d'entrée facturés au tarif normal. */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Sortie, réflexion comprise (total facturé). */
  outputTokens: number;
}

interface OutcomeBase {
  usage: ModelUsage;
  stopReason: string | null;
  providerRequestId: string | null;
  /** Message brut renvoyé par l'API (enregistré tel quel pour la traçabilité). */
  raw: unknown;
}

export type ModelOutcome =
  | (OutcomeBase & {
      kind: 'completed';
      text: string;
      /** Blocs inattendus (appel d'outil…) : la réponse sera traitée comme invalide. */
      unexpectedBlocks: string[];
    })
  | (OutcomeBase & { kind: 'refused'; category: string | null; explanation: string | null })
  | (OutcomeBase & { kind: 'truncated'; text: string });

export interface CallOptions {
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  /** Octets de l'image, en base64 (empreinte vérifiée par l'appelant). */
  loadImage: (img: RequestImage) => Promise<string>;
}

export interface EditorialModel {
  readonly name: string;
  call(req: ModelRequest, opts: CallOptions): Promise<ModelOutcome>;
  /** Jetons d'entrée (estimation de l'API, gratuite). */
  countTokens(req: ModelRequest, opts: CallOptions): Promise<number>;
}
