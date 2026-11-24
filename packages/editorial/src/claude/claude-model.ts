/**
 * Implémentation réelle avec le SDK officiel. C'est le SEUL code qui parle à Claude API.
 *  - streaming (réponses longues en effort high) puis message final ;
 *  - aucune nouvelle tentative du SDK (`maxRetries: 0`) : le budget décide de chaque tentative ;
 *  - interdit pendant les tests, sauf avec un faux transport injecté (`fetch`).
 */
import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '@acs/shared';
import { classifyError } from './errors';
import type { CallOptions, EditorialModel, ModelOutcome } from './model';
import { toApiBody, type ModelRequest, type RequestImage } from './request';

export interface ClaudeModelOptions {
  apiKey: string;
  /** Faux transport (tests uniquement). */
  fetch?: typeof fetch;
}

type ApiMessage = Anthropic.Messages.Message;

export class ClaudeModel implements EditorialModel {
  readonly name = 'claude-api';
  private readonly client: Anthropic;

  constructor(opts: ClaudeModelOptions) {
    if (process.env.NODE_ENV === 'test' && !opts.fetch) {
      throw new AppError(
        'CLAUDE_NOT_CONFIGURED',
        'Appel réel à Claude API interdit pendant les tests (utiliser un faux modèle)',
      );
    }
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  private async body(req: ModelRequest, opts: CallOptions) {
    const images = new Map<string, string>();
    for (const img of req.images) images.set(img.label, await opts.loadImage(img));
    return toApiBody(req, (img: RequestImage) => images.get(img.label)!);
  }

  async call(req: ModelRequest, opts: CallOptions): Promise<ModelOutcome> {
    const body = await this.body(req, opts);
    try {
      const stream = this.client.messages.stream(
        body as unknown as Anthropic.Messages.MessageStreamParams,
        { timeout: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      const msg = (await stream.finalMessage()) as ApiMessage;
      return toOutcome(msg, stream.request_id ?? null);
    } catch (err) {
      throw classifyError(err, opts.signal?.aborted ?? false);
    }
  }

  /** Le modèle existe-t-il pour cette clé ? (Models API : aucune génération, aucun coût.) */
  async checkModel(
    id: string,
  ): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
    try {
      const m = await this.client.models.retrieve(id, {}, { timeout: 30_000 });
      return { ok: true, displayName: m.display_name };
    } catch (err) {
      const e = classifyError(err, false);
      return { ok: false, error: `${e.code} : ${e.message}` };
    }
  }

  async countTokens(req: ModelRequest, opts: CallOptions): Promise<number> {
    const b = await this.body(req, opts);
    try {
      const r = await this.client.messages.countTokens(
        {
          model: req.model,
          system: b['system'],
          messages: b['messages'],
        } as unknown as Anthropic.Messages.MessageCountTokensParams,
        { timeout: 60_000, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      return r.input_tokens;
    } catch (err) {
      throw classifyError(err, opts.signal?.aborted ?? false);
    }
  }
}

/** Message de l'API → résultat. `stop_reason` est TOUJOURS examiné avant le contenu. */
export function toOutcome(msg: ApiMessage, requestId: string | null): ModelOutcome {
  const u = msg.usage;
  const usage = {
    inputTokens: u.input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };
  const base = {
    usage,
    stopReason: msg.stop_reason ?? null,
    providerRequestId: requestId,
    raw: msg,
  };
  const text = msg.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (msg.stop_reason === 'refusal') {
    return {
      ...base,
      kind: 'refused',
      category: msg.stop_details?.category ?? null,
      explanation: msg.stop_details?.explanation ?? null,
    };
  }
  if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded') {
    return { ...base, kind: 'truncated', text };
  }
  const unexpectedBlocks: string[] = msg.content
    .map((b): string => b.type)
    .filter((t) => t !== 'text' && t !== 'thinking' && t !== 'redacted_thinking');
  if (msg.stop_reason === 'tool_use' || msg.stop_reason === 'pause_turn') {
    unexpectedBlocks.push(`stop_reason:${msg.stop_reason}`);
  }
  return { ...base, kind: 'completed', text, unexpectedBlocks };
}
