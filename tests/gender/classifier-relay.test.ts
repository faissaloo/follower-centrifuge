/**
 * Browser-side WebSocket relay transport tests.
 *
 * The relay exists because instagram.com's CSP blocks direct fetch to the
 * classifier APIs while explicitly allowing ws://localhost:*. Everything here
 * uses an in-memory fake socket; no real network is touched.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ClassifierRelayError,
  createRelayFetch,
  isInstagramHostname,
  relayWillBeUsed,
  resolveClassifierFetch,
  shouldUseRelay,
  probeRelayConnection,
  RelaySocketFactory,
} from '../../src/utils/classifier-relay';
import { DEFAULT_DEEPSEEK_CONFIG, DeepSeekConfig } from '../../src/model/deepseek-config';
import { createGenderClassifier } from '../../src/utils/gender-classifier';
import { MemoryStorage } from './test-helpers';

type Listener = (event: { readonly data?: unknown }) => void;

interface FakeSocketOptions {
  readonly response?: (request: Record<string, unknown>) => unknown;
  readonly failOnOpen?: boolean;
  readonly silent?: boolean;
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: Listener | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly options: FakeSocketOptions;

  constructor(url: string, options: FakeSocketOptions = {}) {
    this.url = url;
    this.options = options;
    FakeSocket.instances.push(this);
    setTimeout(() => {
      if (options.failOnOpen === true) {
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
    if (this.options.silent === true) {
      return;
    }
    const request = JSON.parse(data) as Record<string, unknown>;
    const response = this.options.response !== undefined ? this.options.response(request) : undefined;
    setTimeout(() => {
      if (response !== undefined) {
        this.onmessage?.({ data: JSON.stringify(response) });
      }
    }, 0);
  }

  close(): void {
    // No-op for the fake; the real socket closes after each request.
  }
}

function socketFactory(options: FakeSocketOptions = {}) {
  return (url: string) => new FakeSocket(url, options);
}

function envWithRelay(): DeepSeekConfig {
  return {
    ...DEFAULT_DEEPSEEK_CONFIG,
    relayMode: 'relay',
    relayUrl: 'ws://localhost:8787/ws',
    provider: 'typesafe',
    typesafeApiKey: 'apikey_test_key',
    fallbackToDeepSeek: false,
    requestTimeoutMs: 2000,
    maxRetries: 0,
  };
}

describe('relay policy', () => {
  it('recognises instagram hostnames', () => {
    expect(isInstagramHostname('instagram.com')).toBe(true);
    expect(isInstagramHostname('www.instagram.com')).toBe(true);
    expect(isInstagramHostname('localhost')).toBe(false);
    expect(isInstagramHostname('notinstagram.com')).toBe(false);
  });

  it('uses the relay on Instagram in auto mode, and honours explicit modes', () => {
    expect(shouldUseRelay({ relayMode: 'auto' }, 'www.instagram.com')).toBe(true);
    expect(shouldUseRelay({ relayMode: 'auto' }, 'localhost')).toBe(false);
    expect(shouldUseRelay({ relayMode: 'relay' }, 'localhost')).toBe(true);
    expect(shouldUseRelay({ relayMode: 'direct' }, 'www.instagram.com')).toBe(false);
    expect(relayWillBeUsed({ relayMode: 'auto' }, { hostname: 'instagram.com' })).toBe(true);
    expect(relayWillBeUsed({ relayMode: 'auto' }, { hostname: 'instagram.com', fetchImpl: vi.fn() })).toBe(false);
  });

  it('prefers an injected fetch over the relay', () => {
    const injected = vi.fn() as unknown as typeof fetch;
    expect(resolveClassifierFetch(envWithRelay(), { fetchImpl: injected, hostname: 'instagram.com' })).toBe(injected);
  });
});

describe('createRelayFetch', () => {
  it('sends an HTTP envelope over the WebSocket and returns a Response', async () => {
    const fake = socketFactory({
      response: request => ({
        kind: 'http-response',
        id: request.id,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      }),
    });
    const relayFetch = createRelayFetch({ relayUrl: 'ws://localhost:8787/ws', socketFactory: fake });
    const response = await relayFetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer apikey_test', 'Content-Type': 'application/json' },
      body: '{"model":"jev-latest"}',
    });
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });

    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(socket.url).toBe('ws://localhost:8787/ws');
    const request = JSON.parse(socket.sent[0]) as Record<string, unknown>;
    expect(request.kind).toBe('http');
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.method).toBe('POST');
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer apikey_test');
    expect(JSON.parse(String(request.body))).toEqual({ model: 'jev-latest' });
  });

  it('reports an actionable error when the relay is not running', async () => {
    const relayFetch = createRelayFetch({ relayUrl: 'ws://localhost:8787/ws', socketFactory: socketFactory({ failOnOpen: true }) });
    await expect(relayFetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      name: 'ClassifierRelayError',
      code: 'unreachable',
    });
    await expect(relayFetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(
      /npm run proxy/,
    );
  });

  it('adds a Firefox local-CA trust hint when relevant', async () => {
    const original = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 Firefox/158.0', configurable: true });
    try {
      const relayFetch = createRelayFetch({ relayUrl: 'ws://localhost:8787/ws', socketFactory: socketFactory({ failOnOpen: true }) });
      await expect(relayFetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toThrow(
        /trust:relay|restart Firefox/i,
      );
    } finally {
      Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true });
    }
  });

  it('surfaces relay-side errors verbatim', async () => {
    const fake = socketFactory({
      response: () => ({ kind: 'error', code: 'forbidden', message: 'Relay only forwards classifier hosts.' }),
    });
    const relayFetch = createRelayFetch({ relayUrl: 'ws://localhost:8787/ws', socketFactory: fake });
    await expect(relayFetch('https://evil.test/collect', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ClassifierRelayError);
    await expect(relayFetch('https://evil.test/collect', { method: 'POST', body: '{}' })).rejects.toThrow(/only forwards classifier hosts/);
  });

  it('falls back to the secure wss relay when plain ws is blocked (Firefox)', async () => {
    const seen: string[] = [];
    const factory = (url: string) => {
      seen.push(url);
      if (url.startsWith('ws://')) {
        return new FakeSocket(url, { failOnOpen: true });
      }
      return new FakeSocket(url, {
        response: request => ({
          kind: 'http-response',
          id: request.id,
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}',
        }),
      });
    };
    const relayFetch = createRelayFetch({
      relayUrl: 'ws://localhost:8787/ws',
      fallbackRelayUrls: ['wss://localhost:8788/ws'],
      socketFactory: factory,
    });
    const response = await relayFetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(seen).toEqual(['ws://localhost:8787/ws', 'wss://localhost:8788/ws']);
  });

  it('times out when the relay never answers', async () => {
    const fake = socketFactory({ silent: true });
    const relayFetch = createRelayFetch({ relayUrl: 'ws://localhost:8787/ws', socketFactory: fake, timeoutMs: 1000 });
    await expect(relayFetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('classifier through the relay', () => {
  it('routes TypeSafe requests through the relay on instagram.com and classifies', async () => {
    const fake = socketFactory({
      response: request => {
        const body = JSON.parse(String(request.body)) as {
          readonly state?: ReadonlyArray<Record<string, unknown>>;
          readonly questions?: Readonly<Record<string, unknown>>;
        };
        const answers: Record<string, unknown> = {};
        for (const key of Object.keys(body.questions ?? {})) {
          answers[key] = { type: 'choice', choice: 'female', confidence: 0.93, probabilities: { female: 0.93, male: 0.03 } };
        }
        return {
          kind: 'http-response',
          id: request.id,
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'jev-loopback', answers, usage: { input_tokens: 10, output_tokens: 2 } }),
        };
      },
    });
    const classifier = createGenderClassifier(envWithRelay(), {
      storage: new MemoryStorage(),
      webSocketFactory: fake,
      hostname: 'www.instagram.com',
    });
    const entries = await classifier.classifyBatch([
      { id: 'u1', username: 'alina', fullName: 'Alina Moreno' },
      { id: 'u2', username: 'bob', fullName: 'Bob Builder' },
    ]);
    expect(entries.map(entry => entry.gender)).toEqual(['female', 'female']);
    expect(entries.every(entry => entry.source === 'typesafe')).toBe(true);

    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    const request = JSON.parse(socket.sent[0]) as Record<string, unknown>;
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer apikey_test_key');
  });

  it('fails fast after the first transport error instead of retrying every batch', async () => {
    FakeSocket.instances = [];
    const failing = socketFactory({ failOnOpen: true });
    const classifier = createGenderClassifier(envWithRelay(), {
      storage: new MemoryStorage(),
      webSocketFactory: failing,
      hostname: 'www.instagram.com',
    });
    await expect(classifier.classifyBatch([{ id: 'u1', username: 'alina', fullName: 'Alina Moreno' }])).rejects.toThrow(/relay/i);
    const socketsAfterFirst = FakeSocket.instances.length;
    await expect(classifier.classifyBatch([{ id: 'u2', username: 'bob', fullName: 'Bob Builder' }])).rejects.toThrow(/relay/i);
    expect(FakeSocket.instances.length).toBe(socketsAfterFirst);
  });

  it('does not use the relay on non-Instagram origins', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const config = { ...envWithRelay(), relayMode: 'auto' as const };
    expect(resolveClassifierFetch(config, { hostname: 'localhost', fetchImpl })).toBe(fetchImpl);
    expect(relayWillBeUsed(config, { hostname: 'localhost' })).toBe(false);
  });
});

describe('launch relay preflight', () => {
  function fakeFactory(outcomes: Array<'open' | 'error'>): RelaySocketFactory {
    let index = 0;
    return () => {
      const outcome = outcomes[index] ?? 'error';
      index += 1;
      const socket = {
        onopen: null as ((event: unknown) => void) | null,
        onmessage: null,
        onerror: null as ((event: unknown) => void) | null,
        onclose: null,
        send: vi.fn(),
        close: vi.fn(),
      };
      setTimeout(() => {
        if (outcome === 'open') {
          socket.onopen?.({});
        } else {
          socket.onerror?.({});
        }
      }, 0);
      return socket;
    };
  }

  it('reports success and the working endpoint, trying fallbacks in order', async () => {
    const result = await probeRelayConnection({
      relayUrl: 'ws://localhost:8787/ws',
      fallbackRelayUrls: ['wss://localhost:8788/ws'],
      socketFactory: fakeFactory(['error', 'open']),
      timeoutMs: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.relayUrl).toBe('wss://localhost:8788/ws');
  });

  it('explains how to start the proxy and how Firefox trusts the CA when nothing answers', async () => {
    const result = await probeRelayConnection({
      relayUrl: 'ws://localhost:8787/ws',
      fallbackRelayUrls: ['wss://localhost:8788/ws'],
      socketFactory: fakeFactory(['error', 'error']),
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('npm run proxy');
    expect(result.message).toContain('Firefox');
  });
});

