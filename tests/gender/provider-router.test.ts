import { describe, expect, it } from 'vitest';
import { GenderInput } from '../../src/model/gender';
import { DeepSeekConfig } from '../../src/model/deepseek-config';
import {
  GenderClassificationError,
  createDeepSeekGenderClassifier,
  createGenderClassifier,
  createTypeSafeGenderClassifier,
  isDeepSeekConfigured,
  isTypeSafeConfigured,
} from '../../src/utils/gender-classifier';
import { relayUrlCandidates } from '../../src/utils/classifier-relay';
import {
  MemoryStorage,
  chatCompletionResponse,
  createFakeChatFetch,
  createFakeTypeSafeFetch,
  fakeResponse,
  modelResultsContent,
  routeFetchByUrl,
  testConfig,
  typeSafeConfig,
  typeSafeGenderResponseFromCall,
} from './test-helpers';

function user(id: string, username: string, fullName: string): GenderInput {
  return { id, username, fullName };
}

const USERS: readonly GenderInput[] = [
  user('u1', 'alina.w', 'Alina Wonder'),
  user('u2', 'bob.b', 'Bob Builder'),
  user('u3', 'photon.bot', 'Photon Bot'),
];

const FIVE_CATEGORY_CYCLE = ['female', 'male', 'machine', 'organization', 'ambiguous'] as const;

/** True for TypeSafe System One requests (as opposed to DeepSeek chat). */
function isSystemOneUrl(url: string): boolean {
  return url.indexOf('/v1/systemone') >= 0;
}

function chatResults(ids: readonly string[] = ['u1', 'u2', 'u3']): string {
  const rows = ids.map((id, index) => ({
    id,
    gender: index === 0 ? 'female' : index === 1 ? 'male' : 'ambiguous',
    confidence: 0.9,
    reason: 'deepseek answer',
  }));
  return modelResultsContent(rows);
}

/** A config with the DeepSeek fallback ready, TypeSafe primary selected. */
function routedConfig(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return typeSafeConfig({ fallbackToDeepSeek: true, ...overrides });
}

describe('provider configuration predicates', () => {
  it('requires a base URL, model and key for TypeSafe', () => {
    expect(isTypeSafeConfigured(testConfig({ typesafeApiKey: 'apikey' }))).toBe(true);
    expect(isTypeSafeConfigured(testConfig({ typesafeApiKey: '   ' }))).toBe(false);
    expect(isTypeSafeConfigured(testConfig({ typesafeApiKey: 'apikey', typesafeBaseUrl: ' ' }))).toBe(false);
    expect(isTypeSafeConfigured(testConfig({ typesafeApiKey: 'apikey', typesafeModel: '' }))).toBe(false);
  });

  it('understands proxy mode, direct mode and demo mode for DeepSeek', () => {
    expect(isDeepSeekConfigured(testConfig({ mode: 'demo' }))).toBe(false);
    expect(isDeepSeekConfigured(testConfig({ mode: 'proxy', proxyBaseUrl: 'http://127.0.0.1:8787' }))).toBe(true);
    expect(isDeepSeekConfigured(testConfig({ mode: 'proxy', proxyBaseUrl: '   ' }))).toBe(false);
    expect(isDeepSeekConfigured(testConfig({ mode: 'direct', apiKey: '' }))).toBe(false);
    expect(
      isDeepSeekConfigured(testConfig({ mode: 'direct', directBaseUrl: 'https://api.deepseek.test', apiKey: 'sk' })),
    ).toBe(true);
  });
});

describe('provider routing: offline demo', () => {
  it('routes provider demo to the offline classifier with no network access', async () => {
    const chat = createFakeChatFetch(() => chatCompletionResponse('should not happen'));
    const typesafe = createFakeTypeSafeFetch(() => fakeResponse({ status: 500 }));
    const classifier = createGenderClassifier(typeSafeConfig({ provider: 'demo' }), {
      fetchImpl: chat.fetchImpl,
      storage: new MemoryStorage(),
    });

    expect(classifier.source).toBe('demo');
    expect(classifier.version).toBe('demo-names:v2');
    expect(classifier.model).toBe('demo-names:v2');
    const entries = await classifier.classifyBatch(USERS);
    expect(entries).toHaveLength(3);
    expect(chat.calls).toHaveLength(0);
    expect(typesafe.calls).toHaveLength(0);
  });

  it('lets mode demo override a hosted provider selection', () => {
    const classifier = createGenderClassifier(typeSafeConfig({ provider: 'typesafe', mode: 'demo' }));
    expect(classifier.source).toBe('demo');
  });
});

describe('relay endpoint selection', () => {
  it('prefers the trusted WSS endpoint on HTTPS pages so Firefox does not upgrade ws://8787', () => {
    expect(relayUrlCandidates({ relayUrl: 'ws://localhost:8787/ws' }, true)[0]).toBe('wss://localhost:8788/ws');
    expect(relayUrlCandidates({ relayUrl: 'ws://localhost:8787/ws' }, false)[0]).toBe('ws://localhost:8787/ws');
  });
});

describe('provider routing: DeepSeek only', () => {
  it('uses the chat path and never probes TypeSafe even when a TypeSafe key is present', async () => {
    const chat = createFakeChatFetch(() => chatCompletionResponse(chatResults()));
    const typesafe = createFakeTypeSafeFetch(() => fakeResponse({ status: 500 }));
    const classifier = createGenderClassifier(
      testConfig({
        provider: 'deepseek',
        typesafeApiKey: 'apikey-leftover',
        mode: 'proxy',
        proxyBaseUrl: 'http://127.0.0.1:8787',
      }),
      { fetchImpl: chat.fetchImpl, storage: new MemoryStorage() },
    );

    expect(classifier.source).toBe('deepseek');
    expect(classifier.version).toBe('v3:deepseek:deepseek-chat:proxy');
    const entries = await classifier.classifyBatch(USERS);
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0].url).toBe('http://127.0.0.1:8787/v1/chat/completions');
    expect(typesafe.calls).toHaveLength(0);
    expect(entries.map(entry => entry.source)).toEqual(['deepseek', 'deepseek', 'deepseek']);
    expect(entries.map(entry => entry.model)).toEqual(['deepseek-chat', 'deepseek-chat', 'deepseek-chat']);
  });

  it('throws a configuration error when DeepSeek is selected but not configured', () => {
    const classifier = () =>
      createGenderClassifier(
        testConfig({ provider: 'deepseek', mode: 'direct', apiKey: '' }),
      );
    expect(classifier).toThrow(GenderClassificationError);
    expect(classifier).toThrow(/DeepSeek API key/);
  });
});

describe('provider routing: TypeSafe with DeepSeek fallback', () => {
  it('uses TypeSafe alone when the fallback is disabled', async () => {
    const typesafe = createFakeTypeSafeFetch(call =>
      typeSafeGenderResponseFromCall(call, FIVE_CATEGORY_CYCLE, 'jev-2026-10-01'),
    );
    const chat = createFakeChatFetch(() => chatCompletionResponse('should not happen'));
    const classifier = createGenderClassifier(typeSafeConfig({ fallbackToDeepSeek: false }), {
      fetchImpl: typesafe.fetchImpl,
      storage: new MemoryStorage(),
    });

    expect(classifier.source).toBe('typesafe');
    expect(classifier.version).toBe('v3:typesafe:jev-latest');
    const entries = await classifier.classifyBatch(USERS);
    expect(typesafe.calls).toHaveLength(1);
    expect(chat.calls).toHaveLength(0);
    expect(entries).toEqual([
      { id: 'u1', gender: 'female', confidence: 0.9, reason: 'Jev classified the name as female', source: 'typesafe', model: 'jev-latest' },
      { id: 'u2', gender: 'male', confidence: 0.9, reason: 'Jev classified the name as male', source: 'typesafe', model: 'jev-latest' },
      { id: 'u3', gender: 'machine', confidence: 0.9, reason: 'Jev classified the name as machine', source: 'typesafe', model: 'jev-latest' },
    ]);
  });

  it('routes provider deepseek when the TypeSafe key is missing but the fallback is active', async () => {
    const chat = createFakeChatFetch(() => chatCompletionResponse(chatResults()));
    const classifier = createGenderClassifier(
      routedConfig({ typesafeApiKey: '', mode: 'proxy', proxyBaseUrl: 'http://127.0.0.1:8787' }),
      { fetchImpl: chat.fetchImpl, storage: new MemoryStorage() },
    );

    expect(classifier.source).toBe('deepseek');
    expect(classifier.version).toBe('v3:deepseek:deepseek-chat:proxy');
    const entries = await classifier.classifyBatch(USERS);
    expect(chat.calls).toHaveLength(1);
    expect(entries.map(entry => entry.source)).toEqual(['deepseek', 'deepseek', 'deepseek']);
  });

  it('throws a configuration error when TypeSafe has no key and no fallback exists', () => {
    const classifier = () =>
      createGenderClassifier(
        typeSafeConfig({ typesafeApiKey: '', fallbackToDeepSeek: false }),
      );
    expect(classifier).toThrow(GenderClassificationError);
    expect(classifier).toThrow(/TypeSafe API key/);
  });

  it('composes primary + fallback while serving successful batches from TypeSafe', async () => {
    const typesafe = createFakeTypeSafeFetch(call =>
      typeSafeGenderResponseFromCall(call, FIVE_CATEGORY_CYCLE, 'jev-2026-10-01'),
    );
    const chat = createFakeChatFetch(() => chatCompletionResponse('should not happen'));
    const classifier = createGenderClassifier(routedConfig(), {
      fetchImpl: typesafe.fetchImpl,
      storage: new MemoryStorage(),
    });

    expect(classifier.source).toBe('typesafe');
    expect(classifier.model).toBe('jev-latest');
    expect(classifier.version).toBe('v3:typesafe:jev-latest+fallback:v3:deepseek:deepseek-chat:direct');
    const entries = await classifier.classifyBatch(USERS);
    expect(typesafe.calls).toHaveLength(1);
    expect(chat.calls).toHaveLength(0);
    // The configured alias is recorded consistently on fresh and cached entries.
    expect(entries.map(entry => entry.model)).toEqual(['jev-latest', 'jev-latest', 'jev-latest']);
  });

  it('falls back to DeepSeek when the TypeSafe request fails', async () => {
    const typesafe = createFakeTypeSafeFetch(() =>
      fakeResponse({ status: 401, body: { detail: 'bad key' } }),
    );
    const chat = createFakeChatFetch(() => chatCompletionResponse(chatResults()));
    const classifier = createGenderClassifier(routedConfig(), {
      fetchImpl: routeFetchByUrl(isSystemOneUrl, typesafe.fetchImpl, chat.fetchImpl),
      storage: new MemoryStorage(),
    });

    const entries = await classifier.classifyBatch(USERS);

    expect(typesafe.calls).toHaveLength(1);
    expect(chat.calls).toHaveLength(1);
    expect(entries.map(entry => entry.source)).toEqual(['deepseek', 'deepseek', 'deepseek']);
    expect(entries.map(entry => entry.model)).toEqual(['deepseek-chat', 'deepseek-chat', 'deepseek-chat']);
    expect(entries.map(entry => entry.gender)).toEqual(['female', 'male', 'ambiguous']);
    expect(classifier.source).toBe('typesafe');
  });

  it('falls back to DeepSeek when TypeSafe answers only some accounts', async () => {
    const typesafe = createFakeTypeSafeFetch(() => {
      // Answer only the first account: the TypeSafe provider rejects the
      // partial batch as an invalid response, so the router must fall back.
      const answers = {
        account_1: { type: 'choice', choice: 'female', confidence: 0.9, probabilities: {} },
      };
      return fakeResponse({ body: { model: 'jev-2026-10-01', answers } });
    });
    const chat = createFakeChatFetch(() => chatCompletionResponse(chatResults()));
    const classifier = createGenderClassifier(routedConfig(), {
      fetchImpl: routeFetchByUrl(isSystemOneUrl, typesafe.fetchImpl, chat.fetchImpl),
      storage: new MemoryStorage(),
    });

    const entries = await classifier.classifyBatch(USERS);
    expect(typesafe.calls).toHaveLength(1);
    expect(chat.calls).toHaveLength(1);
    expect(entries.map(entry => entry.source)).toEqual(['deepseek', 'deepseek', 'deepseek']);
  });

  it('propagates the primary error when the fallback is disabled', async () => {
    const typesafe = createFakeTypeSafeFetch(() => fakeResponse({ status: 401, body: { detail: 'bad key' } }));
    const chat = createFakeChatFetch(() => chatCompletionResponse('should not happen'));
    const classifier = createGenderClassifier(typeSafeConfig({ fallbackToDeepSeek: false }), {
      fetchImpl: typesafe.fetchImpl,
      storage: new MemoryStorage(),
    });

    const error = await classifier
      .classifyBatch(USERS)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenderClassificationError);
    const classificationError = error as GenderClassificationError;
    expect(classificationError.code).toBe('transport');
    expect(classificationError.status).toBe(401);
    expect(classificationError.retryable).toBe(false);
    expect(typesafe.calls).toHaveLength(1);
    expect(chat.calls).toHaveLength(0);
  });

  it('reports both providers failing in one typed error', async () => {
    const typesafe = createFakeTypeSafeFetch(() => fakeResponse({ status: 500 }));
    const chat = createFakeChatFetch(() => fakeResponse({ status: 401 }));
    const classifier = createGenderClassifier(routedConfig(), {
      fetchImpl: routeFetchByUrl(isSystemOneUrl, typesafe.fetchImpl, chat.fetchImpl),
      storage: new MemoryStorage(),
    });

    const error = await classifier
      .classifyBatch(USERS)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenderClassificationError);
    const classificationError = error as GenderClassificationError;
    expect(classificationError.code).toBe('transport');
    expect(classificationError.message).toContain('Primary provider failed and the fallback also failed');
    expect(classificationError.message).toContain('TypeSafe request failed');
    expect(classificationError.message).toContain('DeepSeek request failed');
    expect(typesafe.calls).toHaveLength(1);
    expect(chat.calls).toHaveLength(1);
  });

  it('serves repeat batches from the provider cache', async () => {
    const typesafe = createFakeTypeSafeFetch(call =>
      typeSafeGenderResponseFromCall(call, FIVE_CATEGORY_CYCLE, 'jev-2026-10-01'),
    );
    const classifier = createGenderClassifier(typeSafeConfig({ fallbackToDeepSeek: false }), {
      fetchImpl: typesafe.fetchImpl,
      storage: new MemoryStorage(),
    });
    const first = await classifier.classifyBatch(USERS);
    const second = await classifier.classifyBatch(USERS);
    // Cache hits re-attach the requested model alias instead of the answering
    // model name, so compare the classification semantics rather than `model`.
    expect(second.map(entry => ({ id: entry.id, gender: entry.gender, confidence: entry.confidence, source: entry.source }))).toEqual(
      first.map(entry => ({ id: entry.id, gender: entry.gender, confidence: entry.confidence, source: entry.source })),
    );
    expect(typesafe.calls).toHaveLength(1);
  });
});

describe('createTypeSafeGenderClassifier direct use', () => {
  it('rejects a partial TypeSafe answer set with an invalid-response error', async () => {
    const typesafe = createFakeTypeSafeFetch(() =>
      fakeResponse({
        body: {
          model: 'jev-2026-10-01',
          answers: { account_1: { type: 'choice', choice: 'female', confidence: 0.9, probabilities: {} } },
        },
      }),
    );
    const classifier = createTypeSafeGenderClassifier(typeSafeConfig(), {
      fetchImpl: typesafe.fetchImpl,
      storage: new MemoryStorage(),
    });
    const error = await classifier
      .classifyBatch(USERS)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenderClassificationError);
    expect((error as GenderClassificationError).code).toBe('invalid-response');
  });

  it('rejects missing TypeSafe configuration before any request', () => {
    expect(() => createTypeSafeGenderClassifier(typeSafeConfig({ typesafeApiKey: '' }))).toThrow(/API key is required/);
    expect(() => createTypeSafeGenderClassifier(typeSafeConfig({ typesafeBaseUrl: '  ' }))).toThrow(/base URL is empty/);
    expect(() => createTypeSafeGenderClassifier(typeSafeConfig({ typesafeModel: '' }))).toThrow(/model name is required/);
  });

  it('is the factory used by the legacy createDeepSeekGenderClassifier alias', () => {
    const classifier = createDeepSeekGenderClassifier(typeSafeConfig({ fallbackToDeepSeek: false }));
    expect(classifier.source).toBe('typesafe');
  });
});
