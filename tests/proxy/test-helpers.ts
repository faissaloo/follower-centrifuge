/**
 * HTTP-level helpers for the local proxy tests.
 *
 * The proxy is exercised as a real ephemeral `http.Server` on 127.0.0.1 (as the
 * task requires), while its *upstream* transport is always an injected fake
 * fetch: no test ever reaches the real DeepSeek API.
 */
import http from 'node:http';
import { vi } from 'vitest';

/** A listening test server. */
export interface TestServer {
  readonly server: http.Server;
  readonly port: number;
  close(): Promise<void>;
}

/** Start an ephemeral HTTP server bound to 127.0.0.1. */
export function startTestServer(handler: http.RequestListener): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a TCP server address'));
        return;
      }
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise<void>(done => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

export interface ProxyRequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface ProxyResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly text: string;
  /** Parse the body as JSON (throws when it is not JSON). */
  json(): unknown;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Perform one HTTP request against a local test server. */
export function proxyRequest(port: number, options: ProxyRequestOptions = {}): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method === undefined ? 'GET' : options.method,
        path: options.path === undefined ? '/' : options.path,
        headers: options.headers,
      },
      response => {
        response.setEncoding('utf8');
        let text = '';
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode === undefined ? 0 : response.statusCode,
            headers: response.headers,
            text,
            json: () => tryParseJson(text),
          });
        });
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

/** Read a response header as a string (Node lowercases header names). */
export function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return undefined;
}

export interface FakeResponseOptions {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** Minimal `Response`-shaped object for the injected upstream fetch. */
export function fakeUpstreamResponse(options: FakeResponseOptions = {}): Response {
  const status = options.status === undefined ? 200 : options.status;
  const bodyValue: unknown = options.body === undefined ? '' : options.body;
  const bodyText = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue);
  const headers = options.headers === undefined ? {} : options.headers;
  const fake = {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        const lowered = name.toLowerCase();
        const keys = Object.keys(headers);
        for (const key of keys) {
          if (key.toLowerCase() === lowered) {
            return headers[key];
          }
        }
        return null;
      },
    },
    text: async () => bodyText,
    json: async () => {
      const parsed: unknown = JSON.parse(bodyText);
      return parsed;
    },
  };
  return fake as unknown as Response;
}

export interface FakeUpstreamCall {
  readonly url: string;
  readonly method: string;
  /** Lowercase header map passed by the proxy to the upstream. */
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
}

export interface FakeUpstream {
  readonly fetchImpl: typeof fetch;
  readonly calls: FakeUpstreamCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (isRecord(headers)) {
    const keys = Object.keys(headers);
    for (const key of keys) {
      const value = headers[key];
      if (typeof value === 'string') {
        result[key.toLowerCase()] = value;
      }
    }
  }
  return result;
}

/** Fake upstream fetch that records calls and delegates the response. */
export function createFakeUpstreamFetch(
  responder: (call: FakeUpstreamCall, callIndex: number) => Response | Promise<Response>,
): FakeUpstream {
  const calls: FakeUpstreamCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: FakeUpstreamCall = {
      url,
      method: init !== undefined && typeof init.method === 'string' ? init.method : 'GET',
      headers: headersToRecord(init === undefined ? undefined : init.headers),
      body: init !== undefined && typeof init.body === 'string' ? init.body : '',
      signal: init === undefined || init.signal === null ? undefined : init.signal,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  return { fetchImpl: mock as unknown as typeof fetch, calls };
}

/** Upstream fetch that never settles until the proxy aborts the request. */
export function createHangingUpstreamFetch(): FakeUpstream {
  return createFakeUpstreamFetch(
    call =>
      new Promise<Response>((_resolve, reject) => {
        const signal = call.signal;
        if (signal === undefined) {
          reject(new Error('proxy did not pass an abort signal'));
          return;
        }
        if (signal.aborted) {
          reject(new Error('proxy aborted the upstream request'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new Error('proxy aborted the upstream request'));
        });
      }),
  );
}

/** Environment map for the proxy under test (fake key, fake upstream host). */
export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DEEPSEEK_API_KEY: 'sk-test-key-not-real',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.test',
    ...overrides,
  };
}

/** A chat completions request body the app would send. */
export function chatRequest(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}
