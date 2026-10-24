import { describe, expect, it } from 'vitest';
import { DeepSeekConfig } from '../../src/model/deepseek-config';
import { testDeepSeekConnection } from '../../src/utils/gender-classifier';
import {
  chatCompletionResponse,
  createFakeChatFetch,
  createFakeTypeSafeFetch,
  fakeResponse,
  noulAnswer,
  testConfig,
  typeSafeSystemOneResponse,
} from './test-helpers';

/** Config routed to the DeepSeek provider (legacy connection-test path). */
function deepSeekConnectionConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return testConfig({ provider: 'deepseek', mode: 'proxy', apiKey: '', ...overrides });
}

/** Config routed to TypeSafe Jev; DeepSeek fallback is off by default. */
function typeSafeConnectionConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return testConfig({
    provider: 'typesafe',
    fallbackToDeepSeek: false,
    typesafeBaseUrl: 'https://api.typesafe.test',
    typesafeModel: 'jev-latest',
    typesafeApiKey: 'ts-connection-key',
    mode: 'proxy',
    directBaseUrl: 'https://api.deepseek.test',
    apiKey: '',
    ...overrides,
  });
}

/** A TypeSafe probe responder that answers the `noul` connectivity question. */
function typeSafeProbeResponse(model = 'jev-2026-10-01'): Response {
  return typeSafeSystemOneResponse({ model, answers: { probe: noulAnswer(1) } });
}

describe('testDeepSeekConnection: demo mode', () => {
  it('never makes a request in demo mode', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('should not happen'));
    const result = await testDeepSeekConnection(testConfig({ provider: 'demo' }), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Offline demo classifier: no connection is needed.');
    expect(fake.calls).toHaveLength(0);
  });

  it('treats mode demo as offline even when a hosted provider is selected', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('should not happen'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig({ mode: 'demo' }), {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Offline demo classifier');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('testDeepSeekConnection: DeepSeek provider', () => {
  it('reports success for a well-formed probe response', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('{"ok":true}'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig({ model: 'deepseek-chat' }), {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected to DeepSeek using model deepseek-chat.');
    expect(fake.calls).toHaveLength(1);
  });

  it('sends a single tiny probe with no retries and no key in proxy mode', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('{"ok":true}'));
    await testDeepSeekConnection(deepSeekConnectionConfig({ maxRetries: 5 }), { fetchImpl: fake.fetchImpl });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    expect(fake.calls[0].body.stream).toBe(false);
    expect(fake.calls[0].body.response_format).toEqual({ type: 'json_object' });
  });

  it('never probes TypeSafe when the DeepSeek provider is selected', async () => {
    const fake = createFakeTypeSafeFetch(() => chatCompletionResponse('{"ok":true}'));
    const result = await testDeepSeekConnection(
      deepSeekConnectionConfig({ typesafeApiKey: 'ts-leftover-key' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe('http://127.0.0.1:8787/v1/chat/completions');
    expect(fake.calls[0].headers.authorization).toBeUndefined();
  });

  it('rejects direct mode without a key before calling the network', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('never'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig({ mode: 'direct', apiKey: '   ' }), {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('API key');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports authentication failures without leaking the key', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 401, body: { error: { message: 'bad key' } } }));
    const result = await testDeepSeekConnection(
      deepSeekConnectionConfig({ mode: 'direct', apiKey: 'sk-secret-value' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Authentication failed (HTTP 401). Check your DeepSeek API key.');
    expect(result.message).not.toContain('sk-secret-value');
  });

  it('mentions the proxy key when proxy-mode auth fails', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 403 }));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig({ mode: 'proxy' }), {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('DEEPSEEK_API_KEY');
  });

  it('explains a 404 endpoint problem', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 404 }));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('explains a 429 rate limit', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 429 }));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('rate limit');
  });

  it('explains a 500 server error', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 503 }));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('503');
  });

  it('explains a network failure', async () => {
    const fake = createFakeChatFetch(() => {
      throw new TypeError('fetch failed');
    });
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not reach DeepSeek');
  });

  it('reports a response that is valid JSON but not the probe shape', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('{"hello":"world"}'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('expected JSON');
  });

  it('accepts a fenced probe response', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('```json\n{"ok":true}\n```'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('rejects an empty proxy URL', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('never'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig({ proxyBaseUrl: '  ' }), {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('proxy URL is empty');
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects an empty model name', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('never'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig({ model: ' ' }), {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('model name');
    expect(fake.calls).toHaveLength(0);
  });

  it('never throws, even for a non-Error rejection', async () => {
    const fake = createFakeChatFetch(() => Promise.reject('unexpected string rejection'));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('reports HTTP 400 as a rejection', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 400 }));
    const result = await testDeepSeekConnection(deepSeekConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('400');
  });
});

describe('testDeepSeekConnection: TypeSafe primary with DeepSeek fallback', () => {
  it('reports the fallback when no TypeSafe key is configured but fallback is active', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('{"ok":true}'));
    const result = await testDeepSeekConnection(
      typeSafeConnectionConfig({ fallbackToDeepSeek: true, typesafeApiKey: '' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      'TypeSafe API key is not set. Connected to DeepSeek using model deepseek-chat. (fallback active)',
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('reports a failing fallback when no TypeSafe key is configured', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 401 }));
    const result = await testDeepSeekConnection(
      typeSafeConnectionConfig({ fallbackToDeepSeek: true, typesafeApiKey: '' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('TypeSafe API key is not set.');
    expect(result.message).toContain('Authentication failed');
  });

  it('asks for a TypeSafe key when neither provider is usable', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('never'));
    const result = await testDeepSeekConnection(
      typeSafeConnectionConfig({ fallbackToDeepSeek: false, typesafeApiKey: '' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Add a TypeSafe API key in the classifier settings, or configure the DeepSeek fallback.',
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('probes TypeSafe Jev and reports that no fallback is configured', async () => {
    const fake = createFakeTypeSafeFetch(() => typeSafeProbeResponse());
    const result = await testDeepSeekConnection(typeSafeConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      'Connected to TypeSafe Jev using model jev-2026-10-01. DeepSeek fallback: not configured.',
    );
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.url).toBe('https://api.typesafe.test/v1/systemone');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer ts-connection-key');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body.model).toBe('jev-latest');
    expect(call.body.state).toBe('The sky is blue on a clear day.');
    expect(call.body.questions).toEqual({
      probe: { type: 'noul', instructions: 'Is the sky blue on a clear day?' },
    });
    expect(result.message).not.toContain('ts-connection-key');
  });

  it('falls back to the configured model alias when the response omits the model', async () => {
    const fake = createFakeTypeSafeFetch(() => typeSafeProbeResponse(''));
    const result = await testDeepSeekConnection(typeSafeConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('using model jev-latest');
  });

  it('reports the DeepSeek fallback as ready when both providers answer', async () => {
    const fake = createFakeTypeSafeFetch(call =>
      call.url.indexOf('/v1/systemone') >= 0
        ? typeSafeProbeResponse()
        : chatCompletionResponse('{"ok":true}'),
    );
    const result = await testDeepSeekConnection(
      typeSafeConnectionConfig({ fallbackToDeepSeek: true, directBaseUrl: 'https://api.deepseek.test', mode: 'direct', apiKey: 'ds-fallback-key' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected to TypeSafe Jev using model jev-2026-10-01. Fallback DeepSeek: ready.');
    expect(fake.calls.map(call => call.url)).toEqual([
      'https://api.typesafe.test/v1/systemone',
      'https://api.deepseek.test/v1/chat/completions',
    ]);
    expect(fake.calls[1].headers.authorization).toBe('Bearer ds-fallback-key');
  });

  it('reports a failing DeepSeek fallback while staying successful on the primary', async () => {
    const fake = createFakeTypeSafeFetch(call =>
      call.url.indexOf('/v1/systemone') >= 0
        ? typeSafeProbeResponse()
        : fakeResponse({ status: 401 }),
    );
    const result = await testDeepSeekConnection(
      typeSafeConnectionConfig({ fallbackToDeepSeek: true, mode: 'direct', apiKey: 'ds-bad-key', directBaseUrl: 'https://api.deepseek.test' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Fallback DeepSeek: Authentication failed (HTTP 401).');
    expect(result.message).not.toContain('ds-bad-key');
  });

  it('reports a probe response without the expected answer', async () => {
    const fake = createFakeTypeSafeFetch(() => typeSafeSystemOneResponse({ model: 'jev-2026-10-01', answers: {} }));
    const result = await testDeepSeekConnection(typeSafeConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('TypeSafe responded, but not with the expected answer.');
  });

  it('explains TypeSafe authentication failures', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ status: 401 }));
    const result = await testDeepSeekConnection(typeSafeConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Authentication failed (HTTP 401). Check the TypeSafe API key.');
    expect(fake.calls).toHaveLength(1);
  });

  it('explains TypeSafe balance, endpoint, rate-limit and server failures', async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [402, 'insufficient balance (HTTP 402)'],
      [404, 'endpoint or model not found (HTTP 404)'],
      [429, 'rate limit reached (HTTP 429)'],
      [503, 'server error (HTTP 503)'],
      [400, 'rejected the connection test (HTTP 400)'],
    ];
    for (const [status, expected] of cases) {
      const fake = createFakeTypeSafeFetch(() => fakeResponse({ status }));
      const result = await testDeepSeekConnection(typeSafeConnectionConfig(), { fetchImpl: fake.fetchImpl });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(expected);
      // maxRetries is forced to zero for the connection probe: one single call.
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('explains a TypeSafe network failure', async () => {
    const fake = createFakeTypeSafeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const result = await testDeepSeekConnection(typeSafeConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Could not reach TypeSafe (network error or timeout). Check your connection.');
  });

  it('reports primary failure with fallback readiness in one message', async () => {
    const fake = createFakeTypeSafeFetch(call =>
      call.url.indexOf('/v1/systemone') >= 0 ? fakeResponse({ status: 500 }) : chatCompletionResponse('{"ok":true}'),
    );
    const result = await testDeepSeekConnection(
      typeSafeConnectionConfig({ fallbackToDeepSeek: true, mode: 'direct', apiKey: 'ds-fallback-key', directBaseUrl: 'https://api.deepseek.test' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      'TypeSafe Jev: TypeSafe server error (HTTP 500). Try again later. Fallback DeepSeek: Connected to DeepSeek using model deepseek-chat.',
    );
  });

  it('reports both providers failing', async () => {
    const fake = createFakeTypeSafeFetch(call =>
      call.url.indexOf('/v1/systemone') >= 0 ? fakeResponse({ status: 401 }) : fakeResponse({ status: 500 }),
    );
    const result = await testDeepSeekConnection(
      typeSafeConnectionConfig({ fallbackToDeepSeek: true, mode: 'proxy', proxyBaseUrl: 'http://127.0.0.1:8787' }),
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'TypeSafe Jev: Authentication failed (HTTP 401). Check the TypeSafe API key. ' +
        'Fallback DeepSeek: DeepSeek server error (HTTP 500). Try again later.',
    );
  });

  it('never throws for a primary provider rejection that is not an Error', async () => {
    const fake = createFakeTypeSafeFetch(() => Promise.reject('unexpected string rejection'));
    const result = await testDeepSeekConnection(typeSafeConnectionConfig(), { fetchImpl: fake.fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
