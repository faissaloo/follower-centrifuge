/**
 * Minimal fetch-based client for DeepSeek's OpenAI-compatible chat API.
 *
 * Design goals:
 *  - the caller (the gender classifier) only ever sees a completion string or a
 *    typed {@link DeepSeekApiError}; details of the HTTP transport, retries and
 *    timeouts stay here;
 *  - transient failures (network, timeout, HTTP 408/425/429/5xx) are retried
 *    with exponential backoff plus jitter, using an injected `sleep` so tests
 *    never wait in real time;
 *  - non-transient failures (other 4xx, malformed responses) fail fast so a
 *    bad API key or a wrong URL does not burn retries and money;
 *  - the Authorization header is only sent when an API key is configured: in
 *    proxy mode the key stays in the local proxy process, never in the browser;
 *  - error messages never contain the API key, request bodies or response
 *    bodies of the model.
 *
 * Everything is injectable: `fetchImpl`, `sleep`, `now` and `random`.
 */

/** Path appended to the configured base URL. */
export const DEEPSEEK_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
/** First retry delay before jitter (doubles per attempt). */
export const DEEPSEEK_RETRY_BASE_DELAY_MS = 500;
/** Maximum delay for a single retry (including server-provided Retry-After). */
export const DEEPSEEK_RETRY_MAX_DELAY_MS = 8000;
/** Hard cap for server-provided Retry-After values. */
export const DEEPSEEK_RETRY_AFTER_MAX_MS = 30000;
/** Default per-request timeout when the config value is unusable. */
export const DEEPSEEK_DEFAULT_TIMEOUT_MS = 30000;

export type DeepSeekChatRole = 'system' | 'user' | 'assistant';

/** Text content block for multimodal user messages. */
export interface DeepSeekTextPart {
  readonly type: 'text';
  readonly text: string;
}

/** Public image reference (never inline profile photos; URLs only). */
export interface DeepSeekImagePart {
  readonly type: 'image_url';
  readonly image_url: {
    readonly url: string;
    readonly detail?: 'low' | 'high' | 'auto' | 'original';
  };
}

export type DeepSeekContentPart = DeepSeekTextPart | DeepSeekImagePart;

/** One chat message in the OpenAI-compatible format. */
export interface DeepSeekChatMessage {
  readonly role: DeepSeekChatRole;
  readonly content: string | readonly DeepSeekContentPart[];
}


/** Configuration needed to talk to a DeepSeek-compatible endpoint. */
export interface DeepSeekChatClientConfig {
  /** Proxy URL or `https://api.deepseek.com`; chat path is appended. */
  readonly baseUrl: string;
  /** API key; empty string means "do not send an Authorization header". */
  readonly apiKey: string;
  /** Model name, e.g. `deepseek-chat`. */
  readonly model: string;
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Number of retries for transient failures (0 = single attempt). */
  readonly maxRetries: number;
}

/** Injected transport/clock dependencies; all optional. */
export interface DeepSeekChatClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

/** Optional per-call settings. */
export interface DeepSeekChatCompletionOptions {
  /** External abort signal (user cancelled the audit, page unloading, ...). */
  readonly signal?: AbortSignal;
}

/** The client surface consumed by the classifier. */
export interface DeepSeekChatClient {
  readonly model: string;
  /** One chat completion; resolves with the assistant message content. */
  chatCompletion(
    messages: readonly DeepSeekChatMessage[],
    options?: DeepSeekChatCompletionOptions,
  ): Promise<string>;
}

/** Extra details carried by {@link DeepSeekApiError}. */
export interface DeepSeekApiErrorDetails {
  /** HTTP status, or null for network/timeout/abort failures. */
  readonly status?: number | null;
  /** Whether retrying the same request could succeed. */
  readonly retryable?: boolean;
  /** Server-requested delay parsed from Retry-After, when present. */
  readonly retryAfterMs?: number;
  /** Number of HTTP attempts made before the error was raised. */
  readonly attempts?: number;
  /** Total elapsed time across attempts, from the injected clock. */
  readonly elapsedMs?: number;
  /** Underlying error, when there is one (never surfaced verbatim to users). */
  readonly cause?: unknown;
}

/** Typed transport error. Never contains the API key or message contents. */
export class DeepSeekApiError extends Error {
  /** HTTP status, or null for network/timeout/abort failures. */
  readonly status: number | null;
  /** Whether the failed request was retryable in principle. */
  readonly retryable: boolean;
  /** Server-requested retry delay in milliseconds, if it sent one. */
  readonly retryAfterMs: number | null;
  /** Number of HTTP attempts made. */
  readonly attempts: number;
  /** Total elapsed milliseconds across attempts. */
  readonly elapsedMs: number;

  constructor(message: string, details: DeepSeekApiErrorDetails = {}) {
    super(message);
    this.name = 'DeepSeekApiError';
    this.status = details.status === undefined ? null : details.status;
    this.retryable = details.retryable === true;
    this.retryAfterMs = details.retryAfterMs === undefined ? null : details.retryAfterMs;
    this.attempts = details.attempts === undefined ? 1 : details.attempts;
    this.elapsedMs = details.elapsedMs === undefined ? 0 : details.elapsedMs;
    // The project compiles to ES5; restore the prototype chain for `instanceof`.
    Object.setPrototypeOf(this, DeepSeekApiError.prototype);
  }
}

interface DeepSeekChatRequestBody {
  readonly model: string;
  readonly messages: readonly DeepSeekChatMessage[];
  readonly temperature: number;
  readonly response_format: { readonly type: 'json_object' };
  readonly stream: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateContentParts(content: unknown): readonly DeepSeekContentPart[] {
  if (!Array.isArray(content) || content.length === 0) {
    throw new DeepSeekApiError('Chat message content must be a non-empty string or an array of content parts.', {
      retryable: false,
    });
  }
  const parts: DeepSeekContentPart[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      throw new DeepSeekApiError('Chat content parts must be objects.', { retryable: false });
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') {
        throw new DeepSeekApiError('Text content parts need a text string.', { retryable: false });
      }
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const imageUrl = part.image_url;
      if (!isRecord(imageUrl) || typeof imageUrl.url !== 'string' || imageUrl.url.trim() === '') {
        throw new DeepSeekApiError('Image content parts need an image_url.url string.', { retryable: false });
      }
      const url = imageUrl.url.trim();
      if (!/^https?:\/\//.test(url) && !/^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(url)) {
        throw new DeepSeekApiError('Image URLs must be public http(s) URLs or image data URLs.', { retryable: false });
      }
      const detailRaw = imageUrl.detail;
      const detail =
        detailRaw === 'low' || detailRaw === 'high' || detailRaw === 'auto' || detailRaw === 'original'
          ? detailRaw
          : undefined;
      parts.push(detail === undefined ? { type: 'image_url', image_url: { url } } : { type: 'image_url', image_url: { url, detail } });
      continue;
    }
    throw new DeepSeekApiError('Unsupported chat content part type.', { retryable: false });
  }
  return parts;
}

function clampUnit(value: number): number {
  if (!isFinite(value)) {
    return 0.5;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizeTimeoutMs(value: number): number {
  if (!isFinite(value) || value < 1) {
    return DEEPSEEK_DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function normalizeMaxRetries(value: number): number {
  if (!isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** `${baseUrl without trailing slashes}/v1/chat/completions`. */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return `${trimmed}${DEEPSEEK_CHAT_COMPLETIONS_PATH}`;
}

function resolveFetchImplementation(explicitFetch: typeof fetch | undefined): typeof fetch {
  if (explicitFetch !== undefined) {
    return explicitFetch;
  }
  const candidate: unknown = fetch;
  if (typeof candidate !== 'function') {
    throw new DeepSeekApiError('No fetch implementation is available in this environment.', {
      retryable: false,
    });
  }
  return candidate as typeof fetch;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

function shortenApiMessage(value: string): string | null {
  const collapsed = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, 240);
  return collapsed === '' ? null : collapsed;
}

/** Pull a human-readable detail out of a DeepSeek error body (best effort). */
function extractApiErrorMessage(bodyText: string): string | null {
  if (bodyText === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const errorValue = parsed.error;
  if (isRecord(errorValue) && typeof errorValue.message === 'string') {
    return shortenApiMessage(errorValue.message);
  }
  if (typeof parsed.message === 'string') {
    return shortenApiMessage(parsed.message);
  }
  return null;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!isRecord(headers)) {
    return null;
  }
  const getter = headers.get;
  if (typeof getter !== 'function') {
    return null;
  }
  try {
    const value = (getter as (headerName: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function parseRetryAfterMs(headers: unknown, now: () => number): number | null {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null) {
    return null;
  }
  const seconds = Number(raw);
  if (isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), DEEPSEEK_RETRY_AFTER_MAX_MS);
  }
  const retryAt = Date.parse(raw);
  if (isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - now()), DEEPSEEK_RETRY_AFTER_MAX_MS);
  }
  return null;
}

function isRetryableStatus(status: number): boolean {
  // 408 Request Timeout, 425 Too Early, 429 Too Many Requests, 5xx server errors.
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

async function readResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text;
  } catch {
    return '';
  }
}

function buildHttpError(status: number, bodyText: string, headers: unknown, now: () => number): DeepSeekApiError {
  const retryable = isRetryableStatus(status);
  const detail = extractApiErrorMessage(bodyText);
  const message = detail === null ? `DeepSeek API error (HTTP ${status}).` : `DeepSeek API error (HTTP ${status}): ${detail}`;
  const retryAfterMs = parseRetryAfterMs(headers, now);
  if (retryAfterMs === null) {
    return new DeepSeekApiError(message, { status, retryable });
  }
  return new DeepSeekApiError(message, { status, retryable, retryAfterMs });
}

/**
 * Validate a 200 response body and extract the assistant message content.
 * Malformed successful responses are treated as non-retryable: retrying cannot
 * fix a contract violation and would bill another completion.
 */
function parseChatCompletionContent(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new DeepSeekApiError('DeepSeek returned a response that is not valid JSON.', {
      retryable: false,
    });
  }
  if (!isRecord(parsed)) {
    throw new DeepSeekApiError('DeepSeek returned an unexpected response shape.', { retryable: false });
  }
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new DeepSeekApiError('DeepSeek response did not contain any choices.', { retryable: false });
  }
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    throw new DeepSeekApiError('DeepSeek returned an unexpected choice shape.', { retryable: false });
  }
  const message = firstChoice.message;
  if (!isRecord(message)) {
    throw new DeepSeekApiError('DeepSeek response did not contain an assistant message.', { retryable: false });
  }
  const content = message.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new DeepSeekApiError('DeepSeek returned an empty assistant message.', { retryable: false });
  }
  return content;
}

function validateMessages(messages: readonly unknown[]): DeepSeekChatMessage[] {
  if (messages.length === 0) {
    throw new DeepSeekApiError('At least one chat message is required.', { retryable: false });
  }
  const validated: DeepSeekChatMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      throw new DeepSeekApiError('Chat messages must be objects with a role and content.', { retryable: false });
    }
    const role = message.role;
    const content = message.content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new DeepSeekApiError('Chat message role must be system, user or assistant.', { retryable: false });
    }
    if (typeof content === 'string') {
      validated.push({ role, content });
      continue;
    }
    if (role !== 'user') {
      throw new DeepSeekApiError('Only user messages may carry image content parts.', { retryable: false });
    }
    validated.push({ role, content: validateContentParts(content) });
  }
  return validated;
}

/**
 * Exponential backoff with jitter: attempt 1 waits
 * `base * 2^0 * jitter`, attempt 2 `base * 2^1 * jitter`, capped at
 * {@link DEEPSEEK_RETRY_MAX_DELAY_MS}. The jitter factor is in [0.5, 1.0], so
 * the delay is always within half of the nominal value. A server Retry-After
 * wins over the local schedule.
 */
function computeRetryDelayMs(attempt: number, retryAfterMs: number | null, random: () => number): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, DEEPSEEK_RETRY_AFTER_MAX_MS);
  }
  const nominal = Math.min(DEEPSEEK_RETRY_MAX_DELAY_MS, DEEPSEEK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
  const jitter = 0.5 + 0.5 * clampUnit(random());
  return Math.round(nominal * jitter);
}

function toDeepSeekApiError(error: unknown): DeepSeekApiError {
  if (error instanceof DeepSeekApiError) {
    return error;
  }
  const message = error instanceof Error ? `DeepSeek request failed: ${error.message}` : 'DeepSeek request failed.';
  return new DeepSeekApiError(message, { retryable: true, cause: error });
}

/**
 * Create a chat client. `deps` must supply a fake `fetchImpl` and `sleep` in
 * tests; production callers pass nothing.
 */
export function createDeepSeekChatClient(
  config: DeepSeekChatClientConfig,
  deps: DeepSeekChatClientDeps = {},
): DeepSeekChatClient {
  const baseUrl = config.baseUrl.trim();
  if (baseUrl === '') {
    throw new DeepSeekApiError('DeepSeek base URL is empty.', { retryable: false });
  }
  const model = config.model.trim();
  if (model === '') {
    throw new DeepSeekApiError('DeepSeek model name is empty.', { retryable: false });
  }
  const url = resolveChatCompletionsUrl(baseUrl);
  const apiKey = config.apiKey.trim();
  const timeoutMs = normalizeTimeoutMs(config.requestTimeoutMs);
  const maxRetries = normalizeMaxRetries(config.maxRetries);
  const fetchImpl = resolveFetchImplementation(deps.fetchImpl);
  const sleep = deps.sleep !== undefined ? deps.sleep : defaultSleep;
  const now = deps.now !== undefined ? deps.now : () => Date.now();
  const random = deps.random !== undefined ? deps.random : () => Math.random();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (apiKey !== '') {
    // Proxy mode deliberately leaves apiKey empty so the key stays server-side.
    headers.Authorization = `Bearer ${apiKey}`;
  }

  function buildRequestBody(messages: readonly DeepSeekChatMessage[]): string {
    const payload: DeepSeekChatRequestBody = {
      model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
      stream: false,
    };
    return JSON.stringify(payload);
  }

  async function requestOnce(
    messages: readonly DeepSeekChatMessage[],
    externalSignal: AbortSignal | undefined,
  ): Promise<string> {
    if (externalSignal !== undefined && externalSignal.aborted) {
      throw new DeepSeekApiError('DeepSeek request was aborted before it started.', { retryable: false });
    }
    const controller = new AbortController();
    // Tracked via an object property: TypeScript would otherwise narrow a plain
    // `let timedOut = false` to a literal inside this closure and flag the
    // later check as unreachable.
    const requestState: { timedOut: boolean } = { timedOut: false };
    const timerId = setTimeout(() => {
      requestState.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = (): void => {
      controller.abort();
    };
    if (externalSignal !== undefined) {
      externalSignal.addEventListener('abort', onExternalAbort);
    }
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: buildRequestBody(messages),
          signal: controller.signal,
        });
      } catch (error) {
        if (requestState.timedOut) {
          throw new DeepSeekApiError(`DeepSeek request timed out after ${timeoutMs} ms.`, {
            retryable: true,
            cause: error,
          });
        }
        if (externalSignal !== undefined && externalSignal.aborted) {
          throw new DeepSeekApiError('DeepSeek request was aborted.', {
            retryable: false,
            cause: error,
          });
        }
        const relayHint =
          error instanceof Error && /relay|npm run proxy/i.test(error.message) ? ` ${error.message}` : '';
        throw new DeepSeekApiError(`Could not reach DeepSeek (network error).${relayHint}`, {
          retryable: true,
          cause: error,
        });
      }
      const bodyText = await readResponseText(response);
      if (!response.ok) {
        throw buildHttpError(response.status, bodyText, response.headers, now);
      }
      return parseChatCompletionContent(bodyText);
    } finally {
      clearTimeout(timerId);
      if (externalSignal !== undefined) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async function chatCompletion(
    messages: readonly DeepSeekChatMessage[],
    options: DeepSeekChatCompletionOptions = {},
  ): Promise<string> {
    const validated = validateMessages(messages);
    const startedAt = now();
    const maxAttempts = maxRetries + 1;
    let attempt = 0;
    let lastError: DeepSeekApiError | null = null;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        return await requestOnce(validated, options.signal);
      } catch (error) {
        const apiError = toDeepSeekApiError(error);
        lastError = apiError;
        const externallyAborted = options.signal !== undefined && options.signal.aborted;
        if (!apiError.retryable || externallyAborted || attempt >= maxAttempts) {
          break;
        }
        await sleep(computeRetryDelayMs(attempt, apiError.retryAfterMs, random));
        if (options.signal !== undefined && options.signal.aborted) {
          break;
        }
      }
    }
    const failure =
      lastError === null
        ? new DeepSeekApiError('DeepSeek request failed.', { retryable: false })
        : lastError;
    throw new DeepSeekApiError(failure.message, {
      status: failure.status,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs === null ? undefined : failure.retryAfterMs,
      attempts: attempt,
      elapsedMs: Math.max(0, now() - startedAt),
      cause: failure,
    });
  }

  return { model, chatCompletion };
}
