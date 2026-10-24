import { describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_RETRY_BASE_DELAY_MS,
  DeepSeekApiError,
  DeepSeekChatClient,
  DeepSeekChatClientConfig,
  DeepSeekChatClientDeps,
  createDeepSeekChatClient,
  resolveChatCompletionsUrl,
} from '../../src/utils/deepseek-client';
import { chatCompletionResponse, chatMessages, createFakeChatFetch, fakeResponse } from './test-helpers';

const BASE_CONFIG: DeepSeekChatClientConfig = {
  baseUrl: 'http://127.0.0.1:8787',
  apiKey: '',
  model: 'deepseek-chat',
  requestTimeoutMs: 5000,
  maxRetries: 0,
};

function createClient(
  fetchImpl: typeof fetch,
  overrides: Partial<DeepSeekChatClientConfig> = {},
  deps: Omit<DeepSeekChatClientDeps, 'fetchImpl'> = {},
): DeepSeekChatClient {
  return createDeepSeekChatClient({ ...BASE_CONFIG, ...overrides }, { fetchImpl, ...deps });
}

async function catchError(promise: Promise<unknown>): Promise<DeepSeekApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeepSeekApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the promise to reject with a DeepSeekApiError');
}

function hangingFetch(): typeof fetch {
  const mock = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init === undefined ? null : init.signal;
        if (signal !== undefined && signal !== null) {
          signal.addEventListener('abort', () => {
            reject(new Error('request aborted by the client'));
          });
        }
      }),
  );
  return mock as unknown as typeof fetch;
}

describe('DeepSeek chat client request shape', () => {
  it('posts to the chat completions endpoint with a JSON body', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('hello'));
    const client = createClient(fake.fetchImpl, { baseUrl: 'http://127.0.0.1:8787///' });
    await expect(client.chatCompletion(chatMessages())).resolves.toBe('hello');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.url).toBe('http://127.0.0.1:8787/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body.model).toBe('deepseek-chat');
    expect(call.body.temperature).toBe(0);
    expect(call.body.stream).toBe(false);
    expect(call.body.response_format).toEqual({ type: 'json_object' });
    expect(call.body.messages).toEqual([
      { role: 'system', content: 'classify' },
      { role: 'user', content: 'accounts' },
    ]);
  });

  it('omits the Authorization header when the API key is empty', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('ok'));
    const client = createClient(fake.fetchImpl, { apiKey: '   ' });
    await client.chatCompletion(chatMessages());
    expect(Object.keys(fake.calls[0].headers)).not.toContain('authorization');
  });

  it('sends a trimmed Bearer token when an API key is configured', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('ok'));
    const client = createClient(fake.fetchImpl, { apiKey: '  sk-test-key  ' });
    await client.chatCompletion(chatMessages());
    expect(fake.calls[0].headers.authorization).toBe('Bearer sk-test-key');
  });

  it('trims the model name before sending it', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('ok'));
    const client = createClient(fake.fetchImpl, { model: '  deepseek-reasoner ' });
    await client.chatCompletion(chatMessages());
    expect(fake.calls[0].body.model).toBe('deepseek-reasoner');
    expect(client.model).toBe('deepseek-reasoner');
  });

  it('exposes resolveChatCompletionsUrl and trims trailing slashes', () => {
    expect(resolveChatCompletionsUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787/v1/chat/completions');
    expect(resolveChatCompletionsUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/v1/chat/completions');
  });
});

describe('DeepSeek chat client error handling', () => {
  it('does not retry a 401 and reports status/retryable/attempts', async () => {
    const fake = createFakeChatFetch(() =>
      fakeResponse({ status: 401, body: { error: { message: 'Authentication Fails, Your api key is invalid' } } }),
    );
    const client = createClient(fake.fetchImpl, { maxRetries: 3 });
    const error = await catchError(client.chatCompletion(chatMessages()));
    expect(error).toBeInstanceOf(DeepSeekApiError);
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(error.attempts).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).toContain('Authentication Fails');
  });

  it('does not retry a malformed 4xx payload but still reports the status', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 400, body: '<html>bad request</html>' }));
    const client = createClient(fake.fetchImpl, { maxRetries: 2 });
    const error = await catchError(client.chatCompletion(chatMessages()));
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([408, 425, 429, 500, 503])('retries HTTP %d once and then succeeds', async status => {
    const fake = createFakeChatFetch((_call, index) =>
      index === 0 ? fakeResponse({ status }) : chatCompletionResponse('recovered'),
    );
    const sleeps: number[] = [];
    const client = createClient(
      fake.fetchImpl,
      { maxRetries: 1 },
      {
        sleep: async milliseconds => {
          sleeps.push(milliseconds);
        },
        random: () => 1,
      },
    );
    await expect(client.chatCompletion(chatMessages())).resolves.toBe('recovered');
    expect(fake.calls).toHaveLength(2);
    expect(sleeps).toEqual([DEEPSEEK_RETRY_BASE_DELAY_MS]);
  });

  it('retries network failures and surfaces a typed error when they persist', async () => {
    const fake = createFakeChatFetch(() => {
      throw new TypeError('network down');
    });
    const sleeps: number[] = [];
    const client = createClient(
      fake.fetchImpl,
      { maxRetries: 2 },
      {
        sleep: async milliseconds => {
          sleeps.push(milliseconds);
        },
        random: () => 1,
      },
    );
    const error = await catchError(client.chatCompletion(chatMessages()));
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.attempts).toBe(3);
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(error.message).toContain('network error');
  });

  it('uses the server Retry-After header when present', async () => {
    const fake = createFakeChatFetch((_call, index) =>
      index === 0 ? fakeResponse({ status: 429, headers: { 'retry-after': '2' } }) : chatCompletionResponse('ok'),
    );
    const sleeps: number[] = [];
    const client = createClient(
      fake.fetchImpl,
      { maxRetries: 1 },
      {
        sleep: async milliseconds => {
          sleeps.push(milliseconds);
        },
        random: () => 0,
      },
    );
    await client.chatCompletion(chatMessages());
    expect(sleeps).toEqual([2000]);
  });

  it('reports total elapsed time from the injected clock', async () => {
    const times: Array<number | undefined> = [1000, 1037];
    let clockIndex = 0;
    const fake = createFakeChatFetch(() => fakeResponse({ status: 401 }));
    const client = createClient(fake.fetchImpl, {}, {
      now: () => {
        const value = times[clockIndex];
        clockIndex++;
        return value === undefined ? 1037 : value;
      },
    });
    const error = await catchError(client.chatCompletion(chatMessages()));
    expect(error.elapsedMs).toBe(37);
  });
});

describe('DeepSeek chat client timeouts and aborts', () => {
  it('aborts a hanging request and reports a retryable timeout', async () => {
    const client = createClient(hangingFetch(), { requestTimeoutMs: 20 });
    const error = await catchError(client.chatCompletion(chatMessages()));
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('timed out after 20 ms');
  });

  it('does not call the network when the external signal is already aborted', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('never'));
    const client = createClient(fake.fetchImpl);
    const controller = new AbortController();
    controller.abort();
    const error = await catchError(client.chatCompletion(chatMessages(), { signal: controller.signal }));
    expect(error.retryable).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(error.message).toContain('aborted');
  });

  it('stops retrying when the external signal aborts mid-flight', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 500 }));
    const controller = new AbortController();
    const client = createClient(fake.fetchImpl, { maxRetries: 5 }, {
      sleep: async () => {
        controller.abort();
      },
      random: () => 0,
    });
    const error = await catchError(client.chatCompletion(chatMessages(), { signal: controller.signal }));
    expect(error.retryable).toBe(true);
    expect(fake.calls.length).toBeLessThan(6);
  });
});

describe('DeepSeek chat client response validation', () => {
  it('rejects a 200 response that is not JSON', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ body: 'this is not json' }));
    const error = await catchError(createClient(fake.fetchImpl).chatCompletion(chatMessages()));
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('not valid JSON');
    expect(fake.calls).toHaveLength(1);
  });

  it('rejects a 200 response without choices', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ body: { choices: [] } }));
    const error = await catchError(createClient(fake.fetchImpl).chatCompletion(chatMessages()));
    expect(error.message).toContain('choices');
  });

  it('rejects a 200 response with empty assistant content', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('   '));
    const error = await catchError(createClient(fake.fetchImpl).chatCompletion(chatMessages()));
    expect(error.message).toContain('empty assistant message');
  });

  it('does not call the network for invalid messages', async () => {
    const fake = createFakeChatFetch(() => chatCompletionResponse('never'));
    const client = createClient(fake.fetchImpl);
    await expect(client.chatCompletion([])).rejects.toBeInstanceOf(DeepSeekApiError);
    const invalidRole = [{ role: 'tool', content: 'x' }] as unknown as Parameters<DeepSeekChatClient['chatCompletion']>[0];
    await expect(client.chatCompletion(invalidRole)).rejects.toBeInstanceOf(DeepSeekApiError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('DeepSeek chat client configuration', () => {
  it('rejects an empty base URL at creation time', () => {
    expect(() => createClient(createFakeChatFetch(() => fakeResponse()).fetchImpl, { baseUrl: '   ' })).toThrow(
      /base URL is empty/,
    );
  });

  it('rejects an empty model at creation time', () => {
    expect(() => createClient(createFakeChatFetch(() => fakeResponse()).fetchImpl, { model: '' })).toThrow(
      /model name is empty/,
    );
  });

  it('fails clearly when no fetch implementation exists', () => {
    vi.stubGlobal('fetch', undefined);
    expect(() => createDeepSeekChatClient(BASE_CONFIG)).toThrow(DeepSeekApiError);
  });

  it('normalizes a negative retry configuration to zero retries', async () => {
    const fake = createFakeChatFetch(() => fakeResponse({ status: 500 }));
    const client = createClient(fake.fetchImpl, { maxRetries: -4 });
    const error = await catchError(client.chatCompletion(chatMessages()));
    expect(error.attempts).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });
});
