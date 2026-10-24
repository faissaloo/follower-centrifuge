/**
 * Full-chain integration tests for both classifier providers, entirely on
 * loopback:
 *
 *  DeepSeek provider:
 *   GenderClassifier (provider 'deepseek')
 *     -> DeepSeekChatClient (HTTP over loopback)
 *       -> bundled local proxy (real Node http server)
 *         -> fake DeepSeek upstream (real Node http server, injected fetch)
 *
 *  TypeSafe provider:
 *   GenderClassifier (provider 'typesafe', with DeepSeek fallback)
 *     -> TypeSafeClient (HTTP over loopback systemone)
 *       -> fake TypeSafe "Jev" upstream (real Node http server)
 *     -> (on failure) DeepSeekChatClient -> fake DeepSeek upstream
 *
 * These tests exercise the actual request/response plumbing, proxy key
 * injection, JSON-mode request shape, System One `state`/`questions`/criteria
 * request shape, strict parsing, caching, per-entry provenance and fallback —
 * without any real API call and without touching the global network guard (all
 * HTTP goes to 127.0.0.1 ephemeral ports via an injected fetch).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, IncomingMessage, request as httpRequest, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { startDeepSeekProxy, RunningDeepSeekProxy } from '../../server/deepseek-proxy.mjs';
import {
  GenderClassificationError,
  GENDER_CATEGORY_CRITERIA,
  TYPESAFE_GENDER_INSTRUCTIONS,
  createDeepSeekGenderClassifier,
  createGenderClassifier,
} from '../../src/utils/gender-classifier';
import { DEFAULT_DEEPSEEK_CONFIG, DeepSeekConfig } from '../../src/model/deepseek-config';
import { GenderInput } from '../../src/model/gender';
import { networkGuard } from '../setup';

interface CapturedChatRequest {
  readonly url: string;
  readonly authorization: string;
  readonly contentType: string;
  readonly body: {
    readonly model: string;
    readonly temperature: number;
    readonly stream: boolean;
    readonly response_format: { readonly type: string };
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  };
}

interface CapturedTypeSafeRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
  readonly contentType: string;
  readonly accept: string;
  readonly body: {
    readonly model: string;
    readonly state: ReadonlyArray<Record<string, unknown>>;
    readonly questions: Record<
      string,
      { readonly type: string; readonly instructions: string; readonly criteria?: Record<string, string> }
    >;
  };
}

/** Minimal fetch-shaped response so jsdom does not need a native Response. */
function makeResponse(status: number, body: string, headers: Record<string, string | undefined>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

/** fetch implementation that only talks to 127.0.0.1 (never the real network). */
const loopbackFetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  if (url.hostname !== '127.0.0.1') {
    return Promise.reject(new Error(`blocked non-loopback test request: ${url.origin}`));
  }
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? init.body : '';
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers as Record<string, string> | undefined;
  if (rawHeaders !== undefined) {
    for (const key of Object.keys(rawHeaders)) {
      headers[key.toLowerCase()] = rawHeaders[key];
    }
  }
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res: IncomingMessage) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () => {
          resolve(makeResponse(res.statusCode ?? 0, text, res.headers as Record<string, string>));
        });
      },
    );
    req.on('error', reject);
    if (body !== '') {
      req.write(body);
    }
    req.end();
  });
}) as unknown as typeof fetch;

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key)!) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } as Storage;
}

const capturedChat: CapturedChatRequest[] = [];
const capturedTypeSafe: CapturedTypeSafeRequest[] = [];
let typeSafeFailMode = false;
let typeSafeFailStatus = 500;

let deepseekServer: ReturnType<typeof createServer>;
let typeSafeServer: ReturnType<typeof createServer>;
let deepseekUrl = '';
let typeSafeUrl = '';
let proxy: RunningDeepSeekProxy;

const FAKE_RESULTS = {
  results: [
    { id: '1', gender: 'female', confidence: 0.96, reason: 'alice is a conventionally feminine given name' },
    { id: '2', gender: 'male', confidence: 0.9, reason: 'bob is a conventionally masculine given name' },
    { id: '3', gender: 'machine', confidence: 0.88, reason: 'username reads like a bot' },
    { id: '4', gender: 'organization', confidence: 0.86, reason: 'business name' },
    { id: '5', gender: 'ambiguous', confidence: 0.3, reason: 'not enough information' },
  ],
};

const TS_CATEGORY_ORDER = ['female', 'male', 'machine', 'organization', 'ambiguous'] as const;
const TS_CONFIDENCE_ORDER = [0.97, 0.91, 0.89, 0.87, 0.33] as const;

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

function probabilityMap(choice: string): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const category of TS_CATEGORY_ORDER) {
    probabilities[category] = category === choice ? 0.9 : 0.025;
  }
  return probabilities;
}

function startDeepSeekUpstream(): void {
  deepseekServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void collectBody(req).then(raw => {
      capturedChat.push({
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        contentType: String(req.headers['content-type'] ?? ''),
        body: JSON.parse(raw) as CapturedChatRequest['body'],
      });
      const content = JSON.stringify(FAKE_RESULTS);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
}

function startTypeSafeUpstream(): void {
  typeSafeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void collectBody(req).then(raw => {
      const body = JSON.parse(raw) as CapturedTypeSafeRequest['body'];
      capturedTypeSafe.push({
        url: req.url ?? '',
        method: req.method ?? '',
        authorization: String(req.headers.authorization ?? ''),
        contentType: String(req.headers['content-type'] ?? ''),
        accept: String(req.headers.accept ?? ''),
        body,
      });
      if (typeSafeFailMode) {
        res.writeHead(typeSafeFailStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'loopback type-safe failure' }));
        return;
      }
      const answers: Record<string, unknown> = {};
      let position = 0;
      for (const questionKey of Object.keys(body.questions)) {
        const category = TS_CATEGORY_ORDER[position % TS_CATEGORY_ORDER.length];
        const confidence = TS_CONFIDENCE_ORDER[position % TS_CONFIDENCE_ORDER.length];
        answers[questionKey] = {
          type: 'choice',
          choice: category,
          confidence,
          probabilities: probabilityMap(category),
        };
        position++;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'jev-loopback-model',
          answers,
          usage: { input_tokens: 42, output_tokens: 7 },
        }),
      );
    });
  });
}

const USERS: readonly GenderInput[] = [
  { id: '1', username: 'alice.w', fullName: 'Alice Wonder' },
  { id: '2', username: 'bob.b', fullName: 'Bob Builder' },
  { id: '3', username: 'photon.bot', fullName: 'Photon Bot' },
  { id: '4', username: 'brandco', fullName: '' },
  { id: '5', username: 'nightform', fullName: 'Alex Mercer' },
];

function proxyConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return {
    ...DEFAULT_DEEPSEEK_CONFIG,
    provider: 'deepseek',
    fallbackToDeepSeek: false,
    mode: 'proxy',
    proxyBaseUrl: `http://127.0.0.1:${proxy.port}`,
    model: 'deepseek-chat',
    apiKey: '',
    batchSize: 25,
    requestTimeoutMs: 5000,
    maxRetries: 0,
    ...overrides,
  };
}

function typeSafeLoopbackConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return {
    ...DEFAULT_DEEPSEEK_CONFIG,
    provider: 'typesafe',
    fallbackToDeepSeek: false,
    typesafeBaseUrl: typeSafeUrl,
    typesafeModel: 'jev-latest',
    typesafeApiKey: 'ts-loopback-key',
    mode: 'proxy',
    proxyBaseUrl: `http://127.0.0.1:${proxy.port}`,
    model: 'deepseek-chat',
    apiKey: '',
    batchSize: 25,
    requestTimeoutMs: 5000,
    maxRetries: 0,
    ...overrides,
  };
}

function classifierDeps() {
  return {
    fetchImpl: loopbackFetch,
    sleep: async () => undefined,
    now: () => 1735689600000,
    storage: memoryStorage(),
  };
}

function resetCaptures(): void {
  capturedChat.length = 0;
  capturedTypeSafe.length = 0;
  typeSafeFailMode = false;
  typeSafeFailStatus = 500;
}

beforeAll(async () => {
  startDeepSeekUpstream();
  startTypeSafeUpstream();
  deepseekUrl = await listen(deepseekServer);
  typeSafeUrl = await listen(typeSafeServer);
  proxy = await startDeepSeekProxy({
    env: {
      DEEPSEEK_API_KEY: 'test-key-from-env',
      DEEPSEEK_BASE_URL: deepseekUrl,
      CORS_ORIGINS: 'https://www.instagram.com',
    },
    host: '127.0.0.1',
    port: 0,
    fetchImpl: loopbackFetch,
    logger: { error: () => undefined },
  });
});

afterAll(async () => {
  await proxy.close();
  await closeServer(deepseekServer);
  await closeServer(typeSafeServer);
});

describe('DeepSeek chain: classifier -> HTTP client -> local proxy -> fake upstream', () => {
  it('classifies through the proxy, forwarding the server-side API key and JSON-mode request', async () => {
    resetCaptures();
    const classifier = createDeepSeekGenderClassifier(proxyConfig(), classifierDeps());

    const guesses = await classifier.classifyBatch(USERS);

    expect(guesses.map(guess => guess.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(guesses.map(guess => guess.gender)).toEqual([
      'female',
      'male',
      'machine',
      'organization',
      'ambiguous',
    ]);
    expect(guesses[0].confidence).toBeCloseTo(0.96, 5);
    expect(guesses.every(guess => guess.source === 'deepseek')).toBe(true);
    expect(guesses.every(guess => guess.model === 'deepseek-chat')).toBe(true);
    expect(classifier.source).toBe('deepseek');
    expect(classifier.version).toBe('v3:deepseek:deepseek-chat:proxy');

    expect(capturedChat).toHaveLength(1);
    const [request] = capturedChat;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.contentType).toContain('application/json');
    // The browser app sent no key; the proxy injected the env key upstream.
    expect(request.authorization).toBe('Bearer test-key-from-env');
    expect(request.body.model).toBe('deepseek-chat');
    expect(request.body.temperature).toBe(0);
    expect(request.body.stream).toBe(false);
    expect(request.body.response_format.type).toBe('json_object');
    expect(request.body.messages[0].role).toBe('system');
    expect(request.body.messages[0].content).toMatch(/untrusted/i);
    // The prompt describes all five categories.
    expect(request.body.messages[0].content).toContain('"machine"');
    expect(request.body.messages[0].content).toContain('"organization"');
    expect(request.body.messages[0].content).toContain('"ambiguous"');
    expect(request.body.messages[1].content).toContain('Alice Wonder');
    expect(request.body.messages[1].content).toContain('alice.w');
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it('serves repeat classifications from the local cache without another upstream request', async () => {
    resetCaptures();
    const classifier = createDeepSeekGenderClassifier(proxyConfig(), classifierDeps());

    const first = await classifier.classifyBatch(USERS);
    const callsAfterFirst = capturedChat.length;
    const second = await classifier.classifyBatch(USERS);

    expect(callsAfterFirst).toBe(1);
    expect(capturedChat).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second.every(guess => guess.source === 'deepseek')).toBe(true);
  });

  it('works in direct mode against a base URL, carrying the browser-side key', async () => {
    resetCaptures();
    const config = proxyConfig({ mode: 'direct', directBaseUrl: deepseekUrl, apiKey: 'direct-key' });
    const classifier = createDeepSeekGenderClassifier(config, classifierDeps());

    const guesses = await classifier.classifyBatch(USERS);

    expect(guesses).toHaveLength(5);
    expect(capturedChat).toHaveLength(1);
    expect(capturedChat[0].authorization).toBe('Bearer direct-key');
    expect(capturedChat[0].url).toBe('/v1/chat/completions');
  });

  it('fails safely (typed error) when the proxy is unreachable', async () => {
    const config = proxyConfig({ proxyBaseUrl: 'http://127.0.0.1:1', maxRetries: 0 });
    const classifier = createDeepSeekGenderClassifier(config, classifierDeps());
    await expect(classifier.classifyBatch(USERS)).rejects.toBeInstanceOf(GenderClassificationError);
  });
});

describe('TypeSafe chain: classifier -> Jev System One client -> fake loopback upstream', () => {
  it('classifies via POST /v1/systemone with model, state, per-account choice questions and criteria', async () => {
    resetCaptures();
    const classifier = createGenderClassifier(typeSafeLoopbackConfig(), classifierDeps());

    const guesses = await classifier.classifyBatch(USERS);

    // Five-category mapping from the loopback Jev answers (one per account).
    expect(guesses.map(guess => guess.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(guesses.map(guess => guess.gender)).toEqual([
      'female',
      'male',
      'machine',
      'organization',
      'ambiguous',
    ]);
    expect(guesses.map(guess => guess.confidence)).toEqual([0.97, 0.91, 0.89, 0.87, 0.33]);
    expect(guesses.every(guess => guess.source === 'typesafe')).toBe(true);
    // Provenance records the model that answered, not just the requested alias.
    expect(guesses.every(guess => guess.model === 'jev-latest')).toBe(true);
    expect(classifier.source).toBe('typesafe');
    expect(classifier.version).toBe('v3:typesafe:jev-latest');

    expect(capturedTypeSafe).toHaveLength(1);
    const [request] = capturedTypeSafe;
    expect(request.url).toBe('/v1/systemone');
    expect(request.method).toBe('POST');
    expect(request.authorization).toBe('Bearer ts-loopback-key');
    expect(request.contentType).toContain('application/json');
    expect(request.accept).toContain('application/json');
    expect(request.body.model).toBe('jev-latest');

    // State: one row per account, numbered, only public name fields.
    expect(request.body.state).toHaveLength(5);
    expect(request.body.state[0]).toEqual({ account: 1, username: 'alice.w', display_name: 'Alice Wonder' });
    expect(request.body.state[3]).toEqual({ account: 4, username: 'brandco', display_name: '' });
    expect(Object.keys(request.body.state[0]).sort()).toEqual(['account', 'display_name', 'username']);
    expect(JSON.stringify(request.body.state)).not.toContain('"id"');

    // Questions: one choice question per account with the shared criteria.
    const questionKeys = Object.keys(request.body.questions);
    expect(questionKeys).toEqual(['account_1', 'account_2', 'account_3', 'account_4', 'account_5']);
    for (const [index, key] of questionKeys.entries()) {
      const question = request.body.questions[key];
      expect(question.type).toBe('choice');
      expect(question.criteria).toEqual({
        female: GENDER_CATEGORY_CRITERIA.female,
        male: GENDER_CATEGORY_CRITERIA.male,
        machine: GENDER_CATEGORY_CRITERIA.machine,
        organization: GENDER_CATEGORY_CRITERIA.organization,
        ambiguous: GENDER_CATEGORY_CRITERIA.ambiguous,
      });
      expect(question.instructions).toContain(TYPESAFE_GENDER_INSTRUCTIONS);
      expect(question.instructions).toContain(`Account number ${index + 1}.`);
    }
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it('serves repeat classifications from the cache without another System One request', async () => {
    resetCaptures();
    const classifier = createGenderClassifier(typeSafeLoopbackConfig(), classifierDeps());

    const first = await classifier.classifyBatch(USERS);
    const callsAfterFirst = capturedTypeSafe.length;
    const second = await classifier.classifyBatch(USERS);

    expect(callsAfterFirst).toBe(1);
    expect(capturedTypeSafe).toHaveLength(1);
    // Cache hits re-attach the requested model alias instead of the answering
    // model name, so compare the classification semantics rather than `model`.
    const semantics = (entries: ReadonlyArray<{ id: string; gender: string; confidence: number }>) =>
      entries.map(entry => ({ id: entry.id, gender: entry.gender, confidence: entry.confidence }));
    expect(semantics(second)).toEqual(semantics(first));
    expect(second.every(guess => guess.source === 'typesafe')).toBe(true);
  });

  it('keeps the TypeSafe cache separate from the DeepSeek cache (different versions)', async () => {
    resetCaptures();
    const deps = classifierDeps();
    const typeSafeClassifier = createGenderClassifier(typeSafeLoopbackConfig(), deps);
    await typeSafeClassifier.classifyBatch([USERS[0]]);
    expect(capturedTypeSafe).toHaveLength(1);
    expect(capturedChat).toHaveLength(0);

    // The DeepSeek classifier cannot reuse the TypeSafe cache entry, so it
    // must call its own upstream.
    const deepSeekClassifier = createDeepSeekGenderClassifier(proxyConfig(), {
      ...deps,
      storage: deps.storage,
    });
    await deepSeekClassifier.classifyBatch([USERS[0]]);
    expect(capturedChat).toHaveLength(1);
    expect(capturedTypeSafe).toHaveLength(1);
  });
});

describe('TypeSafe primary with DeepSeek fallback: end-to-end provenance', () => {
  function routedLoopbackConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
    return typeSafeLoopbackConfig({
      fallbackToDeepSeek: true,
      mode: 'direct',
      directBaseUrl: deepseekUrl,
      apiKey: 'fallback-key',
      ...overrides,
    });
  }

  it('records every entry as typesafe when the primary provider is healthy', async () => {
    resetCaptures();
    const classifier = createGenderClassifier(routedLoopbackConfig(), classifierDeps());
    expect(classifier.source).toBe('typesafe');
    expect(classifier.version).toBe('v3:typesafe:jev-latest+fallback:v3:deepseek:deepseek-chat:direct');

    const guesses = await classifier.classifyBatch(USERS);

    expect(guesses.every(guess => guess.source === 'typesafe')).toBe(true);
    expect(capturedTypeSafe).toHaveLength(1);
    expect(capturedChat).toHaveLength(0);
  });

  it('falls back to the second loopback DeepSeek upstream and labels entries as deepseek', async () => {
    resetCaptures();
    typeSafeFailMode = true;
    const classifier = createGenderClassifier(routedLoopbackConfig(), classifierDeps());

    const guesses = await classifier.classifyBatch(USERS);

    expect(guesses.map(guess => guess.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(guesses.map(guess => guess.gender)).toEqual([
      'female',
      'male',
      'machine',
      'organization',
      'ambiguous',
    ]);
    expect(guesses.every(guess => guess.source === 'deepseek')).toBe(true);
    expect(guesses.every(guess => guess.model === 'deepseek-chat')).toBe(true);

    expect(capturedTypeSafe).toHaveLength(1);
    expect(capturedChat).toHaveLength(1);
    expect(capturedChat[0].authorization).toBe('Bearer fallback-key');
    expect(capturedChat[0].url).toBe('/v1/chat/completions');
  });

  it('mixes typesafe and deepseek provenance across batches of the same classifier', async () => {
    resetCaptures();
    const classifier = createGenderClassifier(routedLoopbackConfig(), classifierDeps());

    // Batch one is served by the healthy primary.
    const primaryEntries = await classifier.classifyBatch([USERS[0], USERS[1], USERS[2]]);
    expect(primaryEntries.map(entry => entry.source)).toEqual(['typesafe', 'typesafe', 'typesafe']);
    expect(primaryEntries.map(entry => entry.gender)).toEqual(['female', 'male', 'machine']);

    // The primary goes down; batch two is served by the fallback.
    typeSafeFailMode = true;
    const fallbackEntries = await classifier.classifyBatch([USERS[3], USERS[4]]);
    expect(fallbackEntries.map(entry => entry.source)).toEqual(['deepseek', 'deepseek']);
    expect(fallbackEntries.map(entry => entry.model)).toEqual(['deepseek-chat', 'deepseek-chat']);
    expect(fallbackEntries.map(entry => entry.gender)).toEqual(['organization', 'ambiguous']);

    // The same classifier now has mixed per-entry provenance across batches,
    // while primary entries kept their own model label.
    const allProvenance = [...primaryEntries, ...fallbackEntries].map(entry => entry.source);
    expect(allProvenance.filter(source => source === 'typesafe')).toHaveLength(3);
    expect(allProvenance.filter(source => source === 'deepseek')).toHaveLength(2);
    expect(primaryEntries.every(entry => entry.model === 'jev-latest')).toBe(true);
    expect(capturedTypeSafe).toHaveLength(2);
    expect(capturedChat).toHaveLength(1);
  });

  it('propagates the primary error when the fallback is disabled', async () => {
    resetCaptures();
    typeSafeFailMode = true;
    typeSafeFailStatus = 401;
    const classifier = createGenderClassifier(typeSafeLoopbackConfig({ fallbackToDeepSeek: false }), classifierDeps());

    const error = await classifier
      .classifyBatch(USERS)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenderClassificationError);
    const classificationError = error as GenderClassificationError;
    expect(classificationError.code).toBe('transport');
    expect(classificationError.status).toBe(401);
    expect(classificationError.retryable).toBe(false);
    expect(capturedTypeSafe).toHaveLength(1);
    expect(capturedChat).toHaveLength(0);
  });

  it('reports both loopback providers failing in a single typed error', async () => {
    resetCaptures();
    typeSafeFailMode = true;
    typeSafeFailStatus = 503;
    const config = routedLoopbackConfig({ directBaseUrl: 'http://127.0.0.1:1' });
    const classifier = createGenderClassifier(config, classifierDeps());

    const error = await classifier
      .classifyBatch(USERS)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenderClassificationError);
    expect((error as GenderClassificationError).message).toContain(
      'Primary provider failed and the fallback also failed',
    );
    expect(capturedTypeSafe).toHaveLength(1);
  });
});
