/**
 * Faux modèle scénarisé pour les tests : aucune requête réseau. Chaque appel est journalisé
 * (pour vérifier qu'aucun appel réussi n'est refait), et la réponse vient d'un scénario.
 */
import { ModelCallError } from './errors';
import type { CallOptions, EditorialModel, ModelOutcome, ModelUsage } from './model';
import type { ModelRequest } from './request';

export type FakeReply =
  | { kind: 'json'; value: unknown; usage?: Partial<ModelUsage> }
  | { kind: 'text'; text: string; usage?: Partial<ModelUsage> }
  | { kind: 'refused'; category?: string | null; usage?: Partial<ModelUsage> }
  | { kind: 'truncated'; usage?: Partial<ModelUsage> }
  | { kind: 'error'; error: ModelCallError }
  | { kind: 'hang' }; // attend l'annulation (arrêt pendant un appel)

export type FakeScript = (req: ModelRequest, callIndex: number) => FakeReply;

export const fakeUsage = (u: Partial<ModelUsage> = {}): ModelUsage => ({
  inputTokens: 1_000,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 500,
  ...u,
});

export class FakeModel implements EditorialModel {
  readonly name = 'fake';
  readonly calls: ModelRequest[] = [];

  constructor(private readonly script: FakeScript) {}

  countTokens(req: ModelRequest): Promise<number> {
    return Promise.resolve(Math.ceil((req.system.length + req.userText.length) / 3));
  }

  async call(req: ModelRequest, opts: CallOptions): Promise<ModelOutcome> {
    const index = this.calls.length;
    this.calls.push(req);
    for (const img of req.images) await opts.loadImage(img); // vérifie que les images existent
    const r = this.script(req, index);
    const base = {
      stopReason: 'end_turn',
      providerRequestId: `fake-${index}`,
      raw: { fake: true },
    };
    switch (r.kind) {
      case 'json':
        return {
          ...base,
          kind: 'completed',
          text: JSON.stringify(r.value),
          unexpectedBlocks: [],
          usage: fakeUsage(r.usage),
        };
      case 'text':
        return {
          ...base,
          kind: 'completed',
          text: r.text,
          unexpectedBlocks: [],
          usage: fakeUsage(r.usage),
        };
      case 'refused':
        return {
          ...base,
          stopReason: 'refusal',
          kind: 'refused',
          category: r.category ?? null,
          explanation: 'Refus simulé',
          usage: fakeUsage({ outputTokens: 0, ...r.usage }),
        };
      case 'truncated':
        return {
          ...base,
          stopReason: 'max_tokens',
          kind: 'truncated',
          text: '{"moments": [',
          usage: fakeUsage({ outputTokens: req.maxTokens, ...r.usage }),
        };
      case 'error':
        throw r.error;
      case 'hang':
        return new Promise((_, reject) => {
          const fail = () =>
            reject(
              new ModelCallError('aborted', 'ABORTED', 'Appel annulé', {
                status: null,
                retryAfterMs: null,
                providerRequestId: null,
                maybeBilled: true,
              }),
            );
          if (opts.signal?.aborted) fail();
          opts.signal?.addEventListener('abort', fail, { once: true });
        });
    }
  }
}
