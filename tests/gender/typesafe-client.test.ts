import { describe, expect, it, vi } from 'vitest';
import {
  TYPESAFE_DEFAULT_TIMEOUT_MS,
  TYPESAFE_MODELS_PATH,
  TYPESAFE_RETRY_AFTER_MAX_MS,
  TYPESAFE_SYSTEMONE_PATH,
  TypeSafeApiError,
  TypeSafeChoiceQuestion,
  TypeSafeClient,
  TypeSafeClientConfig,
  buildGenderChoiceCriteria,
  createTypeSafeClient,
  parseTypeSafeResponse,
} from '../../src/utils/typesafe-client';
import {
  catchTypeSafeError,
  choiceAnswer,
  createFakeTypeSafeFetch,
  fakeResponse,
  noulAnswer,
  typeSafeModelsResponse,
  typeSafeSystemOneResponse,
} from './test-helpers';

const BASE_CONFIG: TypeSafeClientConfig = {
  baseUrl: 'https://api.typesafe.test',
  apiKey: 'apikey_test_key',
  model: 'jev-latest',
  requestTimeoutMs: 5000,
  maxRetries: 0,
};

function createClient(
  fetchImpl: typeof fetch,
  overrides: Partial<TypeSafeClientConfig> = {},
  deps: { sleep?: (milliseconds: number) => Promise<void>; random?: () => number; now?: () => number } = {},
): TypeSafeClient {
  return createTypeSafeClient({ ...BASE_CONFIG, ...overrides }, { fetchImpl, ...deps });
}

const CHOICE_QUESTION: TypeSafeChoiceQuestion = {
  type: 'choice',
  instructions: 'Classify this account.',
  criteria: { female: 'woman', male: 'man', machine: 'bot', organization: 'org', ambiguous: 'unsure' },
};

function hangingFetch(): typeof fetch {
  const mock = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init === undefined ? null : init.signal;
        if (signal !== undefined && signal !== null) {
          signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        }
      }),
  );
  return mock as unknown as typeof fetch;
}

function recordingSleep(): { readonly sleep: (milliseconds: number) => Promise<void>; readonly sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
    },
  };
}

describe('TypeSafe client request shape', () => {
  it('posts {model, state, questions} to /v1/systemone with bearer auth', async () => {
    const fake = createFakeTypeSafeFetch(() => typeSafeSystemOneResponse({ answers: { question_1: choiceAnswer('female') } }));
    const client = createClient(fake.fetchImpl);
    const state = [{ account: 1, username: 'alina.w', display_name: 'Alina Wonder' }];
    const questions = { question_1: CHOICE_QUESTION };

    const response = await client.systemOne(state, questions);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.url).toBe('https://api.typesafe.test/v1/systemone');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer apikey_test_key');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers.accept).toBe('application/json');
    expect(call.body).toEqual({ model: 'jev-latest', state, questions });
    expect(call.signal).toBeDefined();
    expect(response.answers.question_1).toMatchObject({ type: 'choice', choice: 'female' });
  });

  it('trims the base URL, API key and model name', async () => {
    const fake = createFakeTypeSafeFetch(() => typeSafeSystemOneResponse({ answers: {} }));
    const client = createClient(fake.fetchImpl, {
      baseUrl: 'https://api.typesafe.test///',
      apiKey: '  apikey_trimmed  ',
      model: '  jev-mini ',
    });
    await client.systemOne('state', { question_1: CHOICE_QUESTION });
    expect(client.model).toBe('jev-mini');
    expect(fake.calls[0].url).toBe('https://api.typesafe.test/v1/systemone');
    expect(fake.calls[0].headers.authorization).toBe('Bearer apikey_trimmed');
    expect(fake.calls[0].body.model).toBe('jev-mini');
  });

  it('parses choice and noul answers, filtering malformed values', async () => {
    const fake = createFakeTypeSafeFetch(() =>
      fakeResponse({
        body: {
          model: 'jev-2026-10-01',
          answers: {
            q1: { type: 'choice', choice: 'female', confidence: 5, probabilities: { female: 5, male: 0.1, bad: 'x' } },
            q2: { type: 'noul', noul: -3 },
            q3: { type: 'choice', choice: 'male', probabilities: { male: 0.8 } },
            q4: { type: 'choice' },
            q5: { nope: true },
            q6: 'not an object',
          },
          usage: { input_tokens: 12, output_tokens: 3 },
        },
      }),
    );
    const response = await createClient(fake.fetchImpl).systemOne('state', {});
    expect(response.model).toBe('jev-2026-10-01');
    expect(response.answers.q1).toEqual({
      type: 'choice',
      choice: 'female',
      confidence: 1,
      probabilities: { female: 5, male: 0.1 },
    });
    expect(response.answers.q2).toEqual({ type: 'noul', noul: 0 });
    // Missing confidence falls back to the probability of the chosen option.
    expect(response.answers.q3).toMatchObject({ type: 'choice', choice: 'male', confidence: 0.8 });
    // Answers without a usable choice/type are dropped, not invented.
    expect(response.answers.q4).toBeUndefined();
    expect(response.answers.q5).toBeUndefined();
    expect(response.answers.q6).toBeUndefined();
    expect(response.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  it('defaults model/usage fields when the response omits them', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ body: { answers: {} } }));
    const response = await createClient(fake.fetchImpl).systemOne('state', {});
    expect(response.model).toBe('');
    expect(response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('accepts an XSSI-prefixed JSON body', async () => {
    const fake = createFakeTypeSafeFetch(() =>
      fakeResponse({ body: 'for (;;);' + JSON.stringify({ model: 'jev-x', answers: {}, usage: { input_tokens: 1, output_tokens: 2 } }) }),
    );
    const response = await createClient(fake.fetchImpl).systemOne('state', {});
    expect(response.model).toBe('jev-x');
    expect(response.usage.output_tokens).toBe(2);
  });
});

describe('TypeSafe client configuration', () => {
  it('rejects an empty base URL', () => {
    expect(() => createClient(createFakeTypeSafeFetch(() => fakeResponse()).fetchImpl, { baseUrl: '   ' })).toThrow(
      /base URL is empty/,
    );
  });

  it('rejects a missing API key', () => {
    expect(() => createClient(createFakeTypeSafeFetch(() => fakeResponse()).fetchImpl, { apiKey: '  ' })).toThrow(
      /API key is required/,
    );
  });

  it('rejects an empty model', () => {
    expect(() => createClient(createFakeTypeSafeFetch(() => fakeResponse()).fetchImpl, { model: '' })).toThrow(
      /model name is required/,
    );
  });

  it('normalizes a negative retry budget to a single attempt', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ status: 500 }));
    const error = await catchTypeSafeError(createClient(fake.fetchImpl, { maxRetries: -4 }).systemOne('s', {}));
    expect(error.status).toBe(500);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('TypeSafe client retries and error mapping', () => {
  it('does not retry a 401 auth failure', async () => {
    const fake = createFakeTypeSafeFetch(() =>
      fakeResponse({ status: 401, body: { detail: 'invalid key apikey_test_key' } }),
    );
    const error = await catchTypeSafeError(createClient(fake.fetchImpl, { maxRetries: 3 }).systemOne('s', {}));
    expect(error).toBeInstanceOf(TypeSafeApiError);
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(error.message).toContain('HTTP 401');
    // The key must never be echoed back, even when the server body contains it.
    expect(error.message).not.toContain('apikey_test_key');
    expect(error.message).toContain('<redacted>');
    expect(error.detail).not.toContain('apikey_test_key');
  });

  it('does not retry a 400 bad request', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ status: 400, body: { detail: 'bad request' } }));
    const error = await catchTypeSafeError(createClient(fake.fetchImpl, { maxRetries: 2 }).systemOne('s', {}));
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(error.message).toBe('HTTP 400: bad request');
  });

  it.each([408, 425, 429, 500, 503])('retries HTTP %d once and then succeeds', async status => {
    const fake = createFakeTypeSafeFetch((_call, index) =>
      index === 0 ? fakeResponse({ status }) : typeSafeSystemOneResponse({ answers: {} }),
    );
    const sleep = recordingSleep();
    const client = createClient(fake.fetchImpl, { maxRetries: 1 }, { sleep: sleep.sleep, random: () => 0 });
    await expect(client.systemOne('s', {})).resolves.toMatchObject({ model: 'jev-test-model' });
    expect(fake.calls).toHaveLength(2);
    expect(sleep.sleeps).toEqual([500]);
  });

  it('honors the Retry-After header', async () => {
    const fake = createFakeTypeSafeFetch((_call, index) =>
      index === 0
        ? fakeResponse({ status: 429, headers: { 'retry-after': '2' } })
        : typeSafeSystemOneResponse({ answers: {} }),
    );
    const sleep = recordingSleep();
    await createClient(fake.fetchImpl, { maxRetries: 1 }, { sleep: sleep.sleep, random: () => 1 }).systemOne('s', {});
    expect(sleep.sleeps).toEqual([2000]);
  });

  it('caps an absurd Retry-After value', async () => {
    const fake = createFakeTypeSafeFetch((_call, index) =>
      index === 0
        ? fakeResponse({ status: 429, headers: { 'retry-after': '999' } })
        : typeSafeSystemOneResponse({ answers: {} }),
    );
    const sleep = recordingSleep();
    await createClient(fake.fetchImpl, { maxRetries: 1 }, { sleep: sleep.sleep }).systemOne('s', {});
    expect(sleep.sleeps).toEqual([TYPESAFE_RETRY_AFTER_MAX_MS]);
  });

  it('retries network failures with exponential backoff and surfaces a typed error', async () => {
    const fake = createFakeTypeSafeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const sleep = recordingSleep();
    const error = await catchTypeSafeError(
      createClient(fake.fetchImpl, { maxRetries: 2 }, { sleep: sleep.sleep, random: () => 1 }).systemOne('s', {}),
    );
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.detail).toBe('network');
    expect(error.message).toBe('Could not reach TypeSafe (network error or timeout).');
    expect(fake.calls).toHaveLength(3);
    expect(sleep.sleeps).toEqual([625, 1250]);
  });

  it('exhausts its retry budget on persistent 5xx and reports retryable', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ status: 503 }));
    const sleep = recordingSleep();
    const error = await catchTypeSafeError(
      createClient(fake.fetchImpl, { maxRetries: 1 }, { sleep: sleep.sleep, random: () => 0 }).systemOne('s', {}),
    );
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('HTTP 503');
    expect(error.detail).toBe('HTTP 503');
    expect(fake.calls).toHaveLength(2);
  });

  it('caps the retry budget at five retries', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ status: 500 }));
    const sleep = recordingSleep();
    await catchTypeSafeError(
      createClient(fake.fetchImpl, { maxRetries: 99 }, { sleep: sleep.sleep, random: () => 0 }).systemOne('s', {}),
    );
    expect(fake.calls).toHaveLength(6);
    expect(sleep.sleeps).toHaveLength(5);
  });

  it('redacts keys from structured server error details', async () => {
    const fake = createFakeTypeSafeFetch(() =>
      fakeResponse({ status: 403, body: { detail: { message: 'key apikey_leaked_value is revoked' } } }),
    );
    const error = await catchTypeSafeError(createClient(fake.fetchImpl).systemOne('s', {}));
    expect(error.status).toBe(403);
    expect(error.message).not.toContain('apikey_leaked_value');
    expect(error.message).toContain('<redacted>');
  });

  it('reports an opaque body without echoing it', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ status: 502, body: '<html>gateway</html>' }));
    const error = await catchTypeSafeError(createClient(fake.fetchImpl).systemOne('s', {}));
    expect(error.message).toBe('HTTP 502');
    expect(error.message).not.toContain('gateway');
  });
});

describe('TypeSafe client timeout handling', () => {
  it('aborts a hanging request after the clamped minimum timeout', async () => {
    vi.useFakeTimers();
    try {
      const client = createClient(hangingFetch(), { requestTimeoutMs: 20 });
      // Attach the rejection handler before advancing timers so the abort is
      // never reported as an unhandled rejection.
      const settled = catchTypeSafeError(client.systemOne('s', {}));
      await vi.advanceTimersByTimeAsync(1000);
      const error = await settled;
      expect(error.status).toBeNull();
      expect(error.retryable).toBe(true);
      expect(error.detail).toBe('timeout');
      expect(error.message).toBe('TypeSafe request failed: Timed out after 1000ms.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the default timeout for unusable values', async () => {
    vi.useFakeTimers();
    try {
      const client = createClient(hangingFetch(), { requestTimeoutMs: 0 });
      const settled = catchTypeSafeError(client.systemOne('s', {}));
      await vi.advanceTimersByTimeAsync(TYPESAFE_DEFAULT_TIMEOUT_MS);
      const error = await settled;
      expect(error.retryable).toBe(true);
      expect(error.message).toContain(`Timed out after ${TYPESAFE_DEFAULT_TIMEOUT_MS}ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an aborted request once before surfacing the timeout', async () => {
    const abortingFetch = vi.fn(async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    });
    const sleep = recordingSleep();
    const error = await catchTypeSafeError(
      createClient(abortingFetch as unknown as typeof fetch, { requestTimeoutMs: 1000, maxRetries: 1 }, {
        sleep: sleep.sleep,
        random: () => 0,
      }).systemOne('s', {}),
    );
    expect(error.detail).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('TypeSafe request failed: Timed out after 1000ms.');
    expect(abortingFetch).toHaveBeenCalledTimes(2);
    expect(sleep.sleeps).toEqual([500]);
  });
});

describe('TypeSafe client response validation', () => {
  it('rejects invalid JSON without retrying', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ body: 'this is not json' }));
    const error = await catchTypeSafeError(createClient(fake.fetchImpl, { maxRetries: 2 }).systemOne('s', {}));
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('TypeSafe responded with invalid JSON.');
    expect(fake.calls).toHaveLength(1);
  });

  it('rejects a response without an answers object', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ body: { model: 'jev-x' } }));
    const error = await catchTypeSafeError(createClient(fake.fetchImpl).systemOne('s', {}));
    expect(error.message).toBe('TypeSafe response is missing "answers".');
    expect(error.retryable).toBe(false);
  });

  it('parseTypeSafeResponse rejects non-object payloads', () => {
    expect(() => parseTypeSafeResponse(null)).toThrow(TypeSafeApiError);
    expect(() => parseTypeSafeResponse([])).toThrow(/missing "answers"/);
    expect(() => parseTypeSafeResponse('answers')).toThrow(/missing "answers"/);
    expect(() => parseTypeSafeResponse({})).toThrow(/missing "answers"/);
  });

  it('parseTypeSafeResponse clamps confidence and fills probabilities', () => {
    const parsed = parseTypeSafeResponse({
      answers: {
        low: { type: 'choice', choice: 'male', confidence: -1 },
        high: { type: 'choice', choice: 'female', confidence: 42 },
        fromProbability: { type: 'choice', choice: 'machine', probabilities: { machine: 0.6 } },
        missing: { type: 'noul', noul: 'yes' },
      },
    });
    expect(parsed.answers.low).toMatchObject({ confidence: 0, probabilities: {} });
    expect(parsed.answers.high).toMatchObject({ confidence: 1 });
    expect(parsed.answers.fromProbability).toMatchObject({ confidence: 0.6 });
    expect(parsed.answers.missing).toBeUndefined();
  });
});

describe('TypeSafe client listModels', () => {
  it('fetches the model list with GET and bearer auth', async () => {
    const fake = createFakeTypeSafeFetch(() => typeSafeModelsResponse(['jev-latest', 'jev-mini']));
    const models = await createClient(fake.fetchImpl).listModels();
    expect(models).toEqual(['jev-latest', 'jev-mini']);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe(`https://api.typesafe.test${TYPESAFE_MODELS_PATH}`);
    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].headers.authorization).toBe('Bearer apikey_test_key');
    expect(fake.calls[0].body).toEqual({});
  });

  it('ignores malformed model entries', async () => {
    const fake = createFakeTypeSafeFetch(() =>
      fakeResponse({
        body: { models: [{ name: 'jev-latest' }, { nope: true }, 'string-entry', { name: 42 }, { name: 'jev-mini' }] },
      }),
    );
    await expect(createClient(fake.fetchImpl).listModels()).resolves.toEqual(['jev-latest', 'jev-mini']);
  });

  it('rejects an unexpected model list shape', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ body: { data: [] } }));
    const error = await catchTypeSafeError(createClient(fake.fetchImpl).listModels());
    expect(error.message).toBe('TypeSafe returned an unexpected model list.');
    expect(error.retryable).toBe(false);
  });

  it('retries a 429 and then succeeds', async () => {
    const fake = createFakeTypeSafeFetch((_call, index) =>
      index === 0 ? fakeResponse({ status: 429 }) : typeSafeModelsResponse(['jev-latest']),
    );
    const sleep = recordingSleep();
    const models = await createClient(fake.fetchImpl, { maxRetries: 1 }, { sleep: sleep.sleep, random: () => 0 }).listModels();
    expect(models).toEqual(['jev-latest']);
    expect(fake.calls).toHaveLength(2);
  });
});

describe('buildGenderChoiceCriteria', () => {
  it('builds exactly the five category criteria', () => {
    const criteria = buildGenderChoiceCriteria({
      female: 'f',
      male: 'm',
      machine: 'bot',
      organization: 'org',
      ambiguous: 'unsure',
    });
    expect(criteria).toEqual({ female: 'f', male: 'm', machine: 'bot', organization: 'org', ambiguous: 'unsure' });
  });
});

describe('TypeSafe client provenance helpers', () => {
  it('sends exactly one System One request per call and never leaks the key in errors', async () => {
    const fake = createFakeTypeSafeFetch(() => fakeResponse({ status: 500, body: { detail: 'upstream exploded' } }));
    const error = await catchTypeSafeError(
      createClient(fake.fetchImpl, { maxRetries: 0 }, {}).systemOne({ state: 1 }, { question_1: CHOICE_QUESTION }),
    );
    expect(fake.calls[0].url).toBe(`https://api.typesafe.test${TYPESAFE_SYSTEMONE_PATH}`);
    expect(error.message).not.toContain('apikey_test_key');
    expect(error.message).toContain('HTTP 500');
  });

  it('never places the api key in the request body', async () => {
    const fake = createFakeTypeSafeFetch(() =>
      typeSafeSystemOneResponse({ answers: { probe: noulAnswer(1) } }),
    );
    await createClient(fake.fetchImpl).systemOne('state', { probe: { type: 'noul', instructions: 'is it blue?' } });
    const body = JSON.stringify(fake.calls[0].body);
    expect(body).not.toContain('apikey_test_key');
  });
});
