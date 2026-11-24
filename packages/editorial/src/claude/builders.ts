/** Construction des requêtes de repérage et d'analyse (utilisée par le dry-run ET les appels). */
import type { CreatorProfile, GameProfile } from '@acs/shared';
import { DeepResultSchema, toApiSchema, TriageResultSchema } from '../analysis/schemas';
import { buildDeepSystem, buildDeepUser, DEEP_PROMPT_VERSION } from '../prompts/deep';
import { buildTriageSystem, buildTriageUser, TRIAGE_PROMPT_VERSION } from '../prompts/triage';
import type { Effort } from '../analysis/estimate';
import type { ModelRequest, RequestImage } from './request';

const TRIAGE_SCHEMA = toApiSchema(TriageResultSchema);
const DEEP_SCHEMA = toApiSchema(DeepResultSchema);

export function triageRequest(p: {
  model: string;
  effort: Effort;
  maxTokens: number;
  creator: CreatorProfile;
  game: GameProfile;
  chunkText: string;
}): ModelRequest {
  return {
    stage: 'triage',
    model: p.model,
    effort: p.effort,
    maxTokens: p.maxTokens,
    promptVersion: TRIAGE_PROMPT_VERSION,
    system: buildTriageSystem({ creator: p.creator, game: p.game }),
    userText: buildTriageUser(p.chunkText),
    images: [],
    schemaName: 'TriageResult',
    schema: TRIAGE_SCHEMA,
  };
}

export function deepRequest(p: {
  model: string;
  effort: Effort;
  maxTokens: number;
  creator: CreatorProfile;
  game: GameProfile;
  clip: { minSeconds: number; maxSeconds: number };
  payloadText: string;
  images: readonly RequestImage[];
  streamSummary: string | null;
}): ModelRequest {
  return {
    stage: 'deep',
    model: p.model,
    effort: p.effort,
    maxTokens: p.maxTokens,
    promptVersion: DEEP_PROMPT_VERSION,
    system: buildDeepSystem({ creator: p.creator, game: p.game, clip: p.clip }),
    userText: buildDeepUser({ streamSummary: p.streamSummary, payloadText: p.payloadText }),
    images: p.images,
    schemaName: 'DeepResult',
    schema: DEEP_SCHEMA,
  };
}
