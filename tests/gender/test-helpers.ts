/**
 * Shared fakes for the DeepSeek layer tests.
 *
 * IMPORTANT: tests must never reach the real network. `tests/setup.ts` stubs
 * the global fetch to throw; every test here injects one of the fakes below
 * instead (and the classifier/client accept `fetchImpl` for exactly that).
 */
import { vi } from 'vitest';
import { DEFAULT_DEEPSEEK_CONFIG, DeepSeekConfig } from '../../src/model/deepseek-config';
import { DeepSeekChatMessage } from '../../src/utils/deepseek-client';
import { TypeSafeAnswer, TypeSafeApiError } from '../../src/utils/typesafe-client';

/** A fully-populated test config derived from the real defaults. */
export function testConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return { ...DEFAULT_DEEPSEEK_CONFIG, apiKey: '', ...overrides };
}

export interface FakeResponseOptions {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

function readHeaderMap(headers: Record<string, string>, name: string): string | null {
  const lowered = name.toLowerCase();
  const keys = Object.keys(headers);
  for (const key of keys) {
    if (key.toLowerCase() === lowered) {
      return headers[key];
    }
  }
  return null;
}

/** A minimal `Response`-shaped object; the code under test only uses a subset. */
export function fakeResponse(options: FakeResponseOptions = {}): Response {
  const status = options.status === undefined ? 200 : options.status;
  const bodyValue: unknown = options.body === undefined ? '' : options.body;
  const bodyText = typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue);
  const headers = options.headers === undefined ? {} : options.headers;
  const fake = {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: {
      get(name: string): string | null {
        return readHeaderMap(headers, name);
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

/** OpenAI-compatible successful chat response with the given assistant content. */
export function chatCompletionResponse(content: string): Response {
  return fakeResponse({
    body: {
      id: 'chatcmpl-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    },
  });
}

export interface RecordedChatCall {
  readonly url: string;
  readonly method: string;
  /** Lowercase header map exactly as passed by the client. */
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}

export interface FakeChatFetch {
  /** Pass this to `fetchImpl`. */
  readonly fetchImpl: typeof fetch;
  readonly calls: RecordedChatCall[];
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function parseJsonObject(body: string): Record<string, unknown> {
  if (body === '') {
    return {};
  }
  const parsed: unknown = JSON.parse(body);
  return isRecord(parsed) ? parsed : {};
}

/**
 * Build a fake fetch that records every chat call and delegates the response
 * decision to `responder`. No real network is involved.
 */
export function createFakeChatFetch(
  responder: (call: RecordedChatCall, callIndex: number) => Response | Promise<Response>,
): FakeChatFetch {
  const calls: RecordedChatCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = init !== undefined && typeof init.body === 'string' ? init.body : '';
    const call: RecordedChatCall = {
      url: requestUrl(input),
      method: init !== undefined && typeof init.method === 'string' ? init.method : 'GET',
      headers: headersToRecord(init === undefined ? undefined : init.headers),
      body: parseJsonObject(bodyText),
      signal: init === undefined || init.signal === null ? undefined : init.signal,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  return { fetchImpl: mock as unknown as typeof fetch, calls };
}

/** Extract system/user prompt strings from a recorded chat body. */
export function promptContents(body: Record<string, unknown>): readonly string[] {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  const contents: string[] = [];
  for (const message of messages) {
    contents.push(isRecord(message) && typeof message.content === 'string' ? message.content : '');
  }
  return contents;
}

/** Assistant JSON content for a list of `{id, gender, confidence, reason}` rows. */
export function modelResultsContent(rows: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({ results: rows });
}

/** Convenience wrapper around `modelResultsContent` for a single result. */
export function modelResultContent(id: string, gender: string, confidence: number, reason = 'test reason'): string {
  return modelResultsContent([{ id, gender, confidence, reason }]);
}

/** In-memory `Storage` implementation for cache/classifier tests. */
export class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    const value = this.store.get(key);
    return value === undefined ? null : value;
  }

  key(index: number): string | null {
    const keys: string[] = [];
    this.store.forEach((_value, mapKey) => {
      keys.push(mapKey);
    });
    if (index < 0 || index >= keys.length) {
      return null;
    }
    return keys[index];
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  /** All keys currently stored (helper for assertions). */
  keys(): readonly string[] {
    const result: string[] = [];
    this.store.forEach((_value, mapKey) => {
      result.push(mapKey);
    });
    return result;
  }
}

/** A Storage implementation whose every operation throws (privacy mode). */
export class BrokenStorage implements Storage {
  get length(): number {
    throw new Error('storage is unavailable');
  }

  clear(): void {
    throw new Error('storage is unavailable');
  }

  getItem(_key: string): string | null {
    throw new Error('storage is unavailable');
  }

  key(_index: number): string | null {
    throw new Error('storage is unavailable');
  }

  removeItem(_key: string): void {
    throw new Error('storage is unavailable');
  }

  setItem(_key: string, _value: string): void {
    throw new Error('storage is unavailable');
  }
}

/** Plain chat message helper so tests do not repeat boilerplate. */
export function chatMessages(): readonly DeepSeekChatMessage[] {
  return [
    { role: 'system', content: 'classify' },
    { role: 'user', content: 'accounts' },
  ];
}

/* ------------------------------------------------------------------------- */
/* TypeSafe "Jev" System One fakes                                            */
/* ------------------------------------------------------------------------- */

export interface RecordedTypeSafeCall {
  readonly url: string;
  readonly method: string;
  /** Lowercase header map exactly as passed by the client. */
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}

export interface FakeTypeSafeFetch {
  /** Pass this to `fetchImpl`. */
  readonly fetchImpl: typeof fetch;
  readonly calls: RecordedTypeSafeCall[];
}

/**
 * Build a fake fetch that records every TypeSafe call and delegates the
 * response to `responder`. No real network is involved.
 */
export function createFakeTypeSafeFetch(
  responder: (call: RecordedTypeSafeCall, callIndex: number) => Response | Promise<Response>,
): FakeTypeSafeFetch {
  const calls: RecordedTypeSafeCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = init !== undefined && typeof init.body === 'string' ? init.body : '';
    const call: RecordedTypeSafeCall = {
      url: requestUrl(input),
      method: init !== undefined && typeof init.method === 'string' ? init.method : 'GET',
      headers: headersToRecord(init === undefined ? undefined : init.headers),
      body: parseJsonObject(bodyText),
      signal: init === undefined || init.signal === null ? undefined : init.signal,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  return { fetchImpl: mock as unknown as typeof fetch, calls };
}

/** One valid TypeSafe `choice` answer. */
export function choiceAnswer(
  choice: string,
  confidence = 0.9,
  probabilities?: Record<string, number>,
): TypeSafeAnswer {
  const resolvedProbabilities = probabilities === undefined ? { [choice]: confidence } : probabilities;
  return { type: 'choice', choice, confidence, probabilities: resolvedProbabilities };
}

/** One valid TypeSafe `noul` (yes/no) answer. */
export function noulAnswer(noul: number): TypeSafeAnswer {
  return { type: 'noul', noul };
}

export interface TypeSafeResponseOptions {
  readonly model?: string;
  readonly answers: Record<string, TypeSafeAnswer>;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
}

/** A `Response` carrying a well-formed TypeSafe System One body. */
export function typeSafeSystemOneResponse(options: TypeSafeResponseOptions): Response {
  return fakeResponse({
    body: {
      model: options.model === undefined ? 'jev-test-model' : options.model,
      answers: options.answers,
      usage: options.usage === undefined ? { input_tokens: 10, output_tokens: 5 } : options.usage,
    },
  });
}

/** Question keys of a recorded System One call, in request order. */
export function typeSafeQuestionKeys(call: RecordedTypeSafeCall): readonly string[] {
  const questions = call.body.questions;
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    return [];
  }
  return Object.keys(questions);
}

/** State rows of a recorded System One call (empty for malformed bodies). */
export function typeSafeStateRows(call: RecordedTypeSafeCall): ReadonlyArray<Record<string, unknown>> {
  const state = call.body.state;
  if (!Array.isArray(state)) {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const row of state) {
    if (isRecord(row)) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Respond to a recorded System One call with one `choice` answer per question,
 * cycling through `choices`. Models the real API answering account_1...
 */
export function typeSafeGenderResponseFromCall(
  call: RecordedTypeSafeCall,
  choices: readonly string[],
  model = 'jev-test-model',
): Response {
  const answers: Record<string, TypeSafeAnswer> = {};
  let position = 0;
  for (const key of typeSafeQuestionKeys(call)) {
    const choice = choices.length === 0 ? 'ambiguous' : choices[position % choices.length];
    answers[key] = choiceAnswer(choice, 0.9, {
      female: 0.9,
      male: 0.02,
      machine: 0.02,
      organization: 0.03,
      ambiguous: 0.03,
    });
    position++;
  }
  return typeSafeSystemOneResponse({ model, answers });
}

/** A `Response` carrying the TypeSafe model list shape. */
export function typeSafeModelsResponse(modelNames: readonly string[]): Response {
  return fakeResponse({ body: { models: modelNames.map(name => ({ name })) } });
}

/** Await a promise that must reject with a TypeSafeApiError and return it. */
export async function catchTypeSafeError(promise: Promise<unknown>): Promise<TypeSafeApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TypeSafeApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the promise to reject with a TypeSafeApiError');
}

/**
 * Route one injected fetch implementation to different fakes by request URL.
 * The provider router uses a single `fetchImpl` for primary + fallback, so
 * tests that exercise both providers need URL-based dispatch.
 */
export function routeFetchByUrl(
  isPrimary: (url: string) => boolean,
  primaryFetch: typeof fetch,
  fallbackFetch: typeof fetch,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    return isPrimary(url) ? primaryFetch(input, init) : fallbackFetch(input, init);
  }) as typeof fetch;
}

/* ------------------------------------------------------------------------- */
/* Provider-aware config helpers                                              */
/* ------------------------------------------------------------------------- */

/** Config routed to the TypeSafe Jev provider (DeepSeek keys also present). */
export function typeSafeConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return testConfig({
    provider: 'typesafe',
    fallbackToDeepSeek: false,
    typesafeBaseUrl: 'https://api.typesafe.test',
    typesafeModel: 'jev-latest',
    typesafeApiKey: 'ts-test-key',
    mode: 'direct',
    directBaseUrl: 'https://api.deepseek.test',
    apiKey: 'ds-test-key',
    maxRetries: 0,
    ...overrides,
  });
}

/** Config routed to the DeepSeek provider only. */
export function deepSeekConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return testConfig({
    provider: 'deepseek',
    fallbackToDeepSeek: false,
    mode: 'direct',
    directBaseUrl: 'https://api.deepseek.test',
    apiKey: 'ds-test-key',
    maxRetries: 0,
    ...overrides,
  });
}
