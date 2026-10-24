import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_COMPLETIONS_PATH,
  DEFAULT_CORS_ORIGINS,
  HEALTH_PATH,
  MAX_REQUEST_BODY_BYTES,
  createProxyHandler,
  parseCorsOrigins,
} from '../../server/proxy-handler.mjs';
import { startDeepSeekProxy } from '../../server/deepseek-proxy.mjs';
import {
  FakeUpstream,
  TestServer,
  chatRequest,
  createFakeUpstreamFetch,
  createHangingUpstreamFetch,
  fakeUpstreamResponse,
  headerValue,
  proxyRequest,
  startTestServer,
  testEnv,
} from './test-helpers';

const FIXED_NOW = 1700000000000;
const ALLOWED_ORIGIN = 'https://www.instagram.com';
const DISALLOWED_ORIGIN = 'https://evil.example';

interface StartProxyOptions {
  readonly upstream?: FakeUpstream;
  readonly timeoutMs?: number;
  readonly logger?: { error?: (message: string) => void };
}

let running: TestServer | null = null;

afterEach(async () => {
  if (running !== null) {
    const server = running;
    running = null;
    await server.close();
  }
});

async function startProxy(env: Record<string, string | undefined>, options: StartProxyOptions = {}): Promise<TestServer> {
  const upstream = options.upstream === undefined ? createFakeUpstreamFetch(() => fakeUpstreamResponse()) : options.upstream;
  const handler = createProxyHandler({
    env,
    fetchImpl: upstream.fetchImpl,
    now: () => FIXED_NOW,
    timeoutMs: options.timeoutMs,
    logger: options.logger,
  });
  running = await startTestServer(handler);
  return running;
}

function parseJsonOf(response: { json(): unknown }): Record<string, unknown> {
  const parsed = response.json();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object response');
  }
  return parsed as Record<string, unknown>;
}

function chatPayload(): Record<string, unknown> {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'classify these accounts' }],
    temperature: 0,
    response_format: { type: 'json_object' },
    stream: false,
  };
}

describe('CORS origin parsing', () => {
  it('falls back to the default allowlist when unset or empty', () => {
    expect(parseCorsOrigins(undefined)).toEqual(DEFAULT_CORS_ORIGINS.slice());
    expect(parseCorsOrigins('   ')).toEqual(DEFAULT_CORS_ORIGINS.slice());
  });

  it('parses, trims and deduplicates a custom allowlist', () => {
    expect(parseCorsOrigins(' https://a.example ,https://b.example, https://a.example ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('keeps a wildcard entry for permissive local setups', () => {
    expect(parseCorsOrigins('*')).toEqual(['*']);
  });
});

describe('GET /health', () => {
  it('reports liveness and configuration without leaking the key', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, { path: HEALTH_PATH });
    expect(response.status).toBe(200);
    const body = parseJsonOf(response);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('deepseek-proxy');
    expect(body.keyConfigured).toBe(true);
    expect(body.upstreamBaseUrl).toBe('https://api.deepseek.test');
    expect(body.time).toBe('2023-11-14T22:13:20.000Z');
    expect(response.text).not.toContain('sk-test-key-not-real');
  });

  it('reports keyConfigured false when no key is configured', async () => {
    const server = await startProxy(testEnv({ DEEPSEEK_API_KEY: undefined }));
    const response = await proxyRequest(server.port, { path: HEALTH_PATH });
    expect(parseJsonOf(response).keyConfigured).toBe(false);
  });

  it('adds CORS headers for allowed origins', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, { path: HEALTH_PATH, headers: { origin: ALLOWED_ORIGIN } });
    expect(response.status).toBe(200);
    expect(headerValue(response.headers, 'access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(headerValue(response.headers, 'vary')).toContain('Origin');
  });

  it('rejects disallowed origins', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, { path: HEALTH_PATH, headers: { origin: DISALLOWED_ORIGIN } });
    expect(response.status).toBe(403);
    const body = parseJsonOf(response);
    expect(body.error).toBeDefined();
    expect(headerValue(response.headers, 'access-control-allow-origin')).toBeUndefined();
  });

  it('rejects non-GET methods with 405 and an Allow header', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, { path: HEALTH_PATH, method: 'POST' });
    expect(response.status).toBe(405);
    expect(headerValue(response.headers, 'allow')).toBe('GET');

    const headResponse = await proxyRequest(server.port, { path: HEALTH_PATH, method: 'HEAD' });
    expect(headResponse.status).toBe(405);
  });
});

describe('POST /v1/chat/completions forwarding', () => {
  it('forwards the request and injects the server-side API key', async () => {
    const upstream = createFakeUpstreamFetch(() =>
      fakeUpstreamResponse({ body: { choices: [{ message: { content: '{"results":[]}' } }] } }),
    );
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      headers: { 'origin': ALLOWED_ORIGIN, 'content-type': 'application/json' },
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call.url).toBe('https://api.deepseek.test/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer sk-test-key-not-real');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body)).toEqual(chatPayload());
    expect(headerValue(response.headers, 'access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(headerValue(response.headers, 'content-type')).toContain('application/json');
    expect(parseJsonOf(response)).toEqual({ choices: [{ message: { content: '{"results":[]}' } }] });
  });

  it('preserves an app-provided Authorization header instead of injecting one', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse({ body: { ok: true } }));
    const server = await startProxy(testEnv(), { upstream });
    await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      headers: { authorization: 'Bearer sk-from-the-app' },
      body: chatRequest(chatPayload()),
    });
    expect(upstream.calls[0].headers.authorization).toBe('Bearer sk-from-the-app');
  });

  it('rejects requests without a key when the server has none either', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse({ body: {} }));
    const server = await startProxy(testEnv({ DEEPSEEK_API_KEY: undefined }), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(500);
    const body = parseJsonOf(response);
    expect(body.error).toBeDefined();
    expect(upstream.calls).toHaveLength(0);
  });

  it('forwards an app-provided key even when the server has none', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse({ body: { ok: true } }));
    const server = await startProxy(testEnv({ DEEPSEEK_API_KEY: undefined }), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      headers: { authorization: 'Bearer sk-from-the-app' },
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(200);
    expect(upstream.calls[0].headers.authorization).toBe('Bearer sk-from-the-app');
  });

  it('rejects disallowed origins before contacting the upstream', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse());
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      headers: { origin: DISALLOWED_ORIGIN },
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
  });

  it('allows non-browser callers without an Origin header and adds no ACAO header', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse({ body: { ok: true } }));
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(200);
    expect(headerValue(response.headers, 'access-control-allow-origin')).toBeUndefined();
  });

  it('relays upstream error statuses and bodies', async () => {
    const upstream = createFakeUpstreamFetch(() =>
      fakeUpstreamResponse({ status: 429, body: { error: { message: 'Rate limit reached' } } }),
    );
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(429);
    const body = parseJsonOf(response);
    expect(body.error).toBeDefined();
  });

  it('relays a non-JSON upstream body with its content type', async () => {
    const upstream = createFakeUpstreamFetch(() =>
      fakeUpstreamResponse({ status: 502, body: 'upstream gateway exploded', headers: { 'content-type': 'text/plain' } }),
    );
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(502);
    expect(headerValue(response.headers, 'content-type')).toContain('text/plain');
    expect(response.text).toBe('upstream gateway exploded');
  });

  it('trims trailing slashes from DEEPSEEK_BASE_URL', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse({ body: { ok: true } }));
    const server = await startProxy(testEnv({ DEEPSEEK_BASE_URL: 'https://api.deepseek.test///' }), { upstream });
    await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(upstream.calls[0].url).toBe('https://api.deepseek.test/v1/chat/completions');
  });
});

describe('proxy request validation', () => {
  it('returns 413 when the request body exceeds the cap', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse());
    const server = await startProxy(testEnv(), { upstream });
    const hugeBody = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }] });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: hugeBody,
    });
    expect(response.status).toBe(413);
    expect(upstream.calls).toHaveLength(0);
  });

  it('returns 400 for invalid JSON bodies', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse());
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('returns 400 when messages is missing or empty', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse());
    const server = await startProxy(testEnv(), { upstream });
    const missing = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: JSON.stringify({ model: 'deepseek-chat' }),
    });
    expect(missing.status).toBe(400);
    const empty = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    });
    expect(empty.status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses streaming responses', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse());
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
    });
    expect(response.status).toBe(400);
    expect(parseJsonOf(response).error).toBeDefined();
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('proxy method and path routing', () => {
  it('returns 404 for unknown paths', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, { path: '/v1/embeddings' });
    expect(response.status).toBe(404);
    expect(parseJsonOf(response).error).toBeDefined();
  });

  it('returns 405 for wrong methods with Allow headers', async () => {
    const server = await startProxy(testEnv());
    const getCompletion = await proxyRequest(server.port, { method: 'GET', path: CHAT_COMPLETIONS_PATH });
    expect(getCompletion.status).toBe(405);
    expect(headerValue(getCompletion.headers, 'allow')).toContain('POST');
  });
});

describe('proxy CORS preflight', () => {
  it('answers OPTIONS preflight with the CORS contract', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, {
      method: 'OPTIONS',
      path: CHAT_COMPLETIONS_PATH,
      headers: { 'origin': ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(response.status).toBe(204);
    expect(headerValue(response.headers, 'access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(headerValue(response.headers, 'access-control-allow-methods')).toContain('POST');
    expect(headerValue(response.headers, 'access-control-allow-headers')).toContain('Authorization');
    expect(headerValue(response.headers, 'access-control-max-age')).toBe('600');
  });

  it('rejects preflight from a disallowed origin', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, {
      method: 'OPTIONS',
      path: CHAT_COMPLETIONS_PATH,
      headers: { origin: DISALLOWED_ORIGIN },
    });
    expect(response.status).toBe(403);
  });

  it('returns 404 for preflight on an unknown path', async () => {
    const server = await startProxy(testEnv());
    const response = await proxyRequest(server.port, {
      method: 'OPTIONS',
      path: '/unknown',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(404);
  });

  it('honors a custom CORS_ORIGINS allowlist', async () => {
    const server = await startProxy(testEnv({ CORS_ORIGINS: 'https://custom.example' }));
    const allowed = await proxyRequest(server.port, { path: HEALTH_PATH, headers: { origin: 'https://custom.example' } });
    expect(allowed.status).toBe(200);
    const rejected = await proxyRequest(server.port, { path: HEALTH_PATH, headers: { origin: ALLOWED_ORIGIN } });
    expect(rejected.status).toBe(403);
  });

  it('supports a wildcard origin for permissive local setups', async () => {
    const server = await startProxy(testEnv({ CORS_ORIGINS: '*' }));
    const response = await proxyRequest(server.port, { path: HEALTH_PATH, headers: { origin: 'https://anything.example' } });
    expect(response.status).toBe(200);
    expect(headerValue(response.headers, 'access-control-allow-origin')).toBe('*');
  });
});

describe('proxy upstream failures', () => {
  it('returns 502 when the upstream fetch throws', async () => {
    const upstream = createFakeUpstreamFetch(() => {
      throw new TypeError('network down');
    });
    const server = await startProxy(testEnv(), { upstream });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(502);
    expect(parseJsonOf(response).error).toBeDefined();
  });

  it('returns 504 when the upstream times out', async () => {
    const hanging = createHangingUpstreamFetch();
    const server = await startProxy(testEnv(), { upstream: hanging, timeoutMs: 20 });
    const response = await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(response.status).toBe(504);
    expect(parseJsonOf(response).error).toBeDefined();
  });

  it('never logs the API key or request/response bodies', async () => {
    const logger = { error: vi.fn() };
    const upstream = createFakeUpstreamFetch(() => {
      throw new TypeError('network down');
    });
    const server = await startProxy(testEnv(), { upstream, logger });
    await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'SECRET_ACCOUNT_NAME_XYZ' }],
      }),
    });
    expect(logger.error).toHaveBeenCalled();
    const calls = logger.error.mock.calls as unknown[][];
    for (const call of calls) {
      const message = String(call[0]);
      expect(message).not.toContain('sk-test-key-not-real');
      expect(message).not.toContain('SECRET_ACCOUNT_NAME_XYZ');
    }
  });

  it('does not log on successful requests', async () => {
    const logger = { error: vi.fn() };
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse({ body: { ok: true } }));
    const server = await startProxy(testEnv(), { upstream, logger });
    await proxyRequest(server.port, {
      method: 'POST',
      path: CHAT_COMPLETIONS_PATH,
      body: chatRequest(chatPayload()),
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('startDeepSeekProxy entry point', () => {
  it('starts on loopback with an ephemeral port and serves /health', async () => {
    const upstream = createFakeUpstreamFetch(() => fakeUpstreamResponse());
    const started = await startDeepSeekProxy({
      env: testEnv(),
      port: 0,
      fetchImpl: upstream.fetchImpl,
      now: () => FIXED_NOW,
      logger: { error: vi.fn() },
    });
    try {
      expect(started.host).toBe('127.0.0.1');
      expect(started.port).toBeGreaterThan(0);
      const address = started.server.address();
      expect(address !== null && typeof address === 'object' ? address.address : '').toBe('127.0.0.1');
      const response = await proxyRequest(started.port, { path: HEALTH_PATH });
      expect(response.status).toBe(200);
      expect(parseJsonOf(response).status).toBe('ok');
    } finally {
      await started.close();
    }
  });

  it('can be started twice without auto-starting on import', async () => {
    const first = await startDeepSeekProxy({ env: testEnv(), port: 0, fetchImpl: createFakeUpstreamFetch(() => fakeUpstreamResponse()).fetchImpl });
    const second = await startDeepSeekProxy({ env: testEnv(), port: 0, fetchImpl: createFakeUpstreamFetch(() => fakeUpstreamResponse()).fetchImpl });
    try {
      expect(first.port).not.toBe(second.port);
      expect((await proxyRequest(first.port, { path: HEALTH_PATH })).status).toBe(200);
      expect((await proxyRequest(second.port, { path: HEALTH_PATH })).status).toBe(200);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
