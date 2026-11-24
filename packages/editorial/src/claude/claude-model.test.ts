import { describe, expect, it } from 'vitest';
import { ClaudeModel } from './claude-model';
import { ModelCallError } from './errors';
import type { ModelRequest } from './request';

const req: ModelRequest = {
  stage: 'deep',
  model: 'claude-opus-5-5',
  effort: 'high',
  maxTokens: 12_000,
  promptVersion: 'deep-v1',
  system: 'Système',
  userText: 'Données',
  images: [
    { label: 'F1', derivativeId: 'd1', sha256: 'abc', sizeBytes: 3, mediaType: 'image/jpeg' },
  ],
  schemaName: 'DeepResult',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};
const opts = (o: Partial<{ signal: AbortSignal; timeoutMs: number }> = {}) => ({
  timeoutMs: 5_000,
  loadImage: () => Promise.resolve('SU1BR0U='),
  ...o,
});

const sse = (events: Record<string, unknown>[], failAfter?: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      events.forEach((e, i) => {
        if (failAfter !== undefined && i === failAfter) {
          controller.error(new TypeError('terminated'));
          return;
        }
        controller.enqueue(
          enc.encode(`event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`),
        );
      });
      if (failAfter === undefined) controller.close();
    },
  });

function messageEvents(text: string, stop: string, details: unknown = null) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 1200,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null, stop_details: details },
      usage: { output_tokens: 4321 },
    },
    { type: 'message_stop' },
  ];
}

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (sent: Sent, n: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Sent = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    sent.push(s);
    return respond(s, sent.length);
  }) as typeof fetch;
  return { f, sent };
}

const ok = (events: Record<string, unknown>[], failAfter?: number) =>
  new Response(sse(events, failAfter), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_123' },
  });
const httpError = (status: number, type: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: 'x' } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function callError(model: ClaudeModel, o = opts()): Promise<ModelCallError> {
  try {
    await model.call(req, o);
  } catch (err) {
    return err as ModelCallError;
  }
  throw new Error('aucune erreur');
}

describe('ClaudeModel (faux transport, aucun réseau)', () => {
  it('refuse de s’exécuter en test sans faux transport (aucun appel réel possible)', () => {
    expect(() => new ClaudeModel({ apiKey: 'cle-factice' })).toThrow(/interdit pendant les tests/);
  });

  it('envoie la requête attendue et lit la réponse (usage, identifiant)', async () => {
    const { f, sent } = fakeFetch(() =>
      ok(messageEvents('{"moments":[],"noClipReason":"rien"}', 'end_turn')),
    );
    const m = new ClaudeModel({ apiKey: 'cle-factice-de-test', fetch: f });
    const r = await m.call(req, opts());
    expect(r).toMatchObject({
      kind: 'completed',
      text: '{"moments":[],"noClipReason":"rien"}',
      unexpectedBlocks: [],
      providerRequestId: 'req_123',
      usage: { inputTokens: 1200, cacheWriteTokens: 3000, cacheReadTokens: 0, outputTokens: 4321 },
    });
    expect(sent).toHaveLength(1);
    const b = sent[0]!.body;
    expect(sent[0]!.url).toMatch(/\/v1\/messages$/);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer cle-factice-de-test');
    expect(sent[0]!.headers.get('x-stainless-retry-count')).toBe('0');
    expect(b).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 12_000,
      stream: true,
      thinking: { type: 'adaptive' },
    });
    expect(b['output_config']).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
    for (const k of ['tools', 'tool_choice', 'fallbacks', 'temperature', 'top_p', 'top_k'])
      expect(b).not.toHaveProperty(k);
    expect(JSON.stringify(b)).toContain('SU1BR0U='); // l'image part en base64
  });

  it('refus : enregistré tel quel, une seule requête, aucun autre modèle', async () => {
    const { f, sent } = fakeFetch(() =>
      ok(messageEvents('', 'refusal', { type: 'refusal', category: 'cyber', explanation: 'non' })),
    );
    const r = await new ClaudeModel({ apiKey: 'k', fetch: f }).call(req, opts());
    expect(r).toMatchObject({ kind: 'refused', category: 'cyber', explanation: 'non' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body['model']).toBe('claude-opus-5-5');
  });

  it('sortie tronquée par max_tokens', async () => {
    const { f } = fakeFetch(() => ok(messageEvents('{"moments": [', 'max_tokens')));
    const r = await new ClaudeModel({ apiKey: 'k', fetch: f }).call(req, opts());
    expect(r.kind).toBe('truncated');
  });

  it.each([
    [429, 'rate_limit_error', 'retryable', { 'retry-after': '2' }, 2000],
    [529, 'overloaded_error', 'retryable', {}, null],
    [500, 'api_error', 'retryable', {}, null],
    [400, 'invalid_request_error', 'window', {}, null],
    [413, 'request_too_large', 'window', {}, null],
    [401, 'authentication_error', 'run', {}, null],
    [403, 'permission_error', 'run', {}, null],
    [402, 'billing_error', 'run', {}, null],
  ])(
    'HTTP %i → %s (une seule requête : aucune nouvelle tentative du SDK)',
    async (status, type, kind, headers, retry) => {
      const { f, sent } = fakeFetch(() => httpError(status, type, headers));
      const e = await callError(new ClaudeModel({ apiKey: 'k', fetch: f }));
      expect(e).toBeInstanceOf(ModelCallError);
      expect(e.kind).toBe(kind);
      expect(e.info.maybeBilled).toBe(false);
      expect(e.info.retryAfterMs).toBe(retry);
      expect(sent).toHaveLength(1);
    },
  );

  it('coupure en cours de flux : nouvelle tentative possible, coût possible (prudence)', async () => {
    const { f } = fakeFetch(() => ok(messageEvents('{"mom', 'end_turn'), 3));
    const e = await callError(new ClaudeModel({ apiKey: 'k', fetch: f }));
    expect(e.kind).toBe('retryable');
    expect(e.info.maybeBilled).toBe(true);
  });

  it('délai dépassé et annulation', async () => {
    const hanging = (_: Sent) =>
      new Promise<Response>(() => {
        /* ne répond jamais */
      });
    const slow = fakeFetch(hanging);
    // Le SDK annule la requête via le signal transmis à fetch : on le respecte.
    const f2 = (async (input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        void slow.f(input, init);
      })) as typeof fetch;
    const t = await callError(new ClaudeModel({ apiKey: 'k', fetch: f2 }), opts({ timeoutMs: 50 }));
    expect(t.kind).toBe('retryable');
    expect(t.code).toBe('TIMEOUT');
    const ac = new AbortController();
    const p = callError(new ClaudeModel({ apiKey: 'k', fetch: f2 }), opts({ signal: ac.signal }));
    ac.abort();
    expect((await p).kind).toBe('aborted');
  });

  it('compte les jetons d’entrée (point d’accès gratuit)', async () => {
    const { f, sent } = fakeFetch(
      () =>
        new Response(JSON.stringify({ input_tokens: 4242 }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await new ClaudeModel({ apiKey: 'k', fetch: f }).countTokens(req, opts())).toBe(4242);
    expect(sent[0]!.url).toMatch(/count_tokens/);
    expect(sent[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('vérifie un modèle sans génération (Models API)', async () => {
    const { f, sent } = fakeFetch((r) =>
      r.url.endsWith('/claude-opus-5-5')
        ? new Response(
            JSON.stringify({
              id: 'claude-opus-5-5',
              display_name: 'Claude Opus 5.5',
              type: 'model',
              created_at: '2026-01-01T00:00:00Z',
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : httpError(404, 'not_found_error'),
    );
    const m = new ClaudeModel({ apiKey: 'k', fetch: f });
    expect(await m.checkModel('claude-opus-5-5')).toEqual({
      ok: true,
      displayName: 'Claude Opus 5.5',
    });
    expect((await m.checkModel('claude-inconnu')).ok).toBe(false);
    expect(sent.every((x) => !x.url.endsWith('/messages'))).toBe(true);
  });
});
