/**
 * Requête à Claude, sous une forme canonique indépendante du SDK :
 *  - `toApiBody` : le corps réellement envoyé (images en base64) ;
 *  - `toReviewBody` : le même corps, consultable avant tout appel (images remplacées par
 *    leur empreinte) — c'est ce que le dry-run écrit sur disque ;
 *  - `requestHash` : empreinte de la requête (réutilisation des réponses déjà obtenues).
 *
 * Volontairement : aucun `tools` (aucun appel d'outil possible), aucun `fallbacks` (aucun
 * repli vers un autre modèle), aucun `temperature`, aucun préremplissage.
 */
import type { Effort } from '../analysis/estimate';
import { stableHash } from '../hash';

export interface RequestImage {
  /** F1, F2… : nom utilisé dans le texte et dans les preuves visuelles. */
  label: string;
  derivativeId: string;
  sha256: string;
  sizeBytes: number;
  mediaType: 'image/jpeg';
}

export interface ModelRequest {
  stage: 'triage' | 'deep';
  model: string;
  effort: Effort;
  maxTokens: number;
  promptVersion: string;
  system: string;
  userText: string;
  images: readonly RequestImage[];
  schemaName: string;
  schema: Record<string, unknown>;
}

type Body = Record<string, unknown>;

function body(req: ModelRequest, image: (img: RequestImage) => string): Body {
  const content: unknown[] = [];
  for (const img of req.images) {
    content.push({ type: 'text', text: `Image ${img.label} :` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: image(img) },
    });
  }
  content.push({ type: 'text', text: req.userText });
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    thinking: { type: 'adaptive' },
    output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
  };
}

/** Corps consultable : identique au corps envoyé, images remplacées par leur empreinte. */
export function toReviewBody(req: ModelRequest): Body {
  return body(
    req,
    (img) =>
      `<image ${img.label} : dérivé ${img.derivativeId}, sha256 ${img.sha256}, ${img.sizeBytes} octets>`,
  );
}

/** Corps envoyé. `loadBase64` fournit les octets de chaque image (vérifiés par l'appelant). */
export function toApiBody(req: ModelRequest, loadBase64: (img: RequestImage) => string): Body {
  return body(req, loadBase64);
}

/** Empreinte de la requête : identique ⇔ même modèle, mêmes paramètres, mêmes données. */
export function requestHash(req: ModelRequest): string {
  return stableHash({
    v: 1,
    schemaName: req.schemaName,
    promptVersion: req.promptVersion,
    body: toReviewBody(req),
  });
}
