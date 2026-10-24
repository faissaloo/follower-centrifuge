/**
 * Minimal fetch-based client for TypeSafe AI's "Jev" System One decision API.
 *
 * Unlike an OpenAI chat API, Jev answers structured questions about a single
 * piece of state: you send `{ model, state, questions }` and receive typed
 * answers (`choice`, `score`, `noul`, `box`). The gender classifier uses one
 * `choice` question per account, grouped into a single request.
 *
 * Same transport discipline as the DeepSeek client:
 *  - injectable fetch/sleep/clock so tests never touch the network;
 *  - AbortController timeouts;
 *  - retries with exponential backoff + jitter for transient failures
 *    (network, timeout, HTTP 408/425/429/5xx), `Retry-After` respected;
 *  - non-transient 4xx fail fast;
 *  - error messages never include the API key or request bodies.
 */

export const TYPESAFE_SYSTEMONE_PATH = '/v1/systemone';
export const TYPESAFE_RETRY_BASE_DELAY_MS = 500;
export const TYPESAFE_RETRY_MAX_DELAY_MS = 8000;
export const TYPESAFE_RETRY_AFTER_MAX_MS = 30000;
export const TYPESAFE_DEFAULT_TIMEOUT_MS = 30000;
export const TYPESAFE_MODELS_PATH = '/v1/models';

export interface TypeSafeClientConfig {
  /** Base URL, e.g. `https://api.typesafe.ai`; `/v1/systemone` is appended. */
  readonly baseUrl: string;
  /** API key (`apikey_...`). Required. */
  readonly apiKey: string;
  /** Model name or alias, e.g. `jev-latest`. */
  readonly model: string;
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Retries for transient failures (0 = single attempt). */
  readonly maxRetries: number;
}

export interface TypeSafeClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

/** A `choice` question: one option from `criteria`. */
export interface TypeSafeChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Record<string, string>;
}

/** A yes/no question. */
export interface TypeSafeNoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
}

export type TypeSafeQuestion = TypeSafeChoiceQuestion | TypeSafeNoulQuestion;

export interface TypeSafeUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface TypeSafeChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

export interface TypeSafeNoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

export type TypeSafeAnswer = TypeSafeChoiceAnswer | TypeSafeNoulAnswer;

export interface TypeSafeResponse {
  /** Model that actually answered (may differ from the requested alias). */
  readonly model: string;
  readonly answers: Readonly<Record<string, TypeSafeAnswer | undefined>>;
  readonly usage: TypeSafeUsage;
}

/** Typed failure from the TypeSafe transport. */
export class TypeSafeApiError extends Error {
  /** HTTP status, or null for network/timeout failures. */
  readonly status: number | null;
  /** Whether retrying the same request could succeed. */
  readonly retryable: boolean;
  /** Safe, short server-provided detail (never request bodies or keys). */
  readonly detail: string;

  constructor(message: string, details: { status: number | null; retryable: boolean; detail?: string }) {
    super(message);
    this.name = 'TypeSafeApiError';
    this.status = details.status;
    this.retryable = details.retryable;
    this.detail = details.detail === undefined ? '' : details.detail;
    Object.setPrototypeOf(this, TypeSafeApiError.prototype);
  }
}

export interface TypeSafeClient {
  readonly model: string;
  /** Ask all questions about `state` in one System One request. */
  systemOne(
    state: unknown,
    questions: Record<string, TypeSafeQuestion>,
  ): Promise<TypeSafeResponse>;
  /** Fetch the model list (used by the settings connection probe). */
  listModels(): Promise<readonly string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampTimeout(value: number): number {
  if (!isFinite(value) || value <= 0) {
    return TYPESAFE_DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(120000, Math.floor(value)));
}

function retryDelayMs(attempt: number, random: () => number): number {
  const exponential = TYPESAFE_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(TYPESAFE_RETRY_MAX_DELAY_MS, exponential);
  const jitter = capped * 0.25 * random();
  return Math.floor(capped + jitter);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null) {
    return null;
  }
  const seconds = Number(headerValue);
  if (isFinite(seconds) && seconds >= 0) {
    return Math.min(TYPESAFE_RETRY_AFTER_MAX_MS, Math.floor(seconds * 1000));
  }
  return null;
}

/** Short, safe description of an error response (no bodies or keys). */
function describeServerError(status: number, body: string): string {
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const raw = parsed.detail;
      if (typeof raw === 'string') {
        detail = raw;
      } else if (isRecord(raw) && typeof raw.message === 'string') {
        detail = raw.message;
      }
    }
  } catch {
    detail = '';
  }
  const safeDetail = detail.replace(/apikey_[A-Za-z0-9_-]+/g, '<redacted>').slice(0, 200);
  return safeDetail === '' ? `HTTP ${status}` : `HTTP ${status}: ${safeDetail}`;
}

function parseResponseBody(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^for \(;;\);/, ''));
  } catch {
    throw new TypeSafeApiError('TypeSafe responded with invalid JSON.', { status: null, retryable: false });
  }
}

/** Validate the untrusted response shape and narrow the answer types. */
export function parseTypeSafeResponse(value: unknown): TypeSafeResponse {
  if (!isRecord(value) || !isRecord(value.answers)) {
    throw new TypeSafeApiError('TypeSafe response is missing "answers".', { status: null, retryable: false });
  }
  const model = typeof value.model === 'string' ? value.model : '';
  const rawUsage = isRecord(value.usage) ? value.usage : {};
  const input = typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : 0;
  const output = typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : 0;
  const answers: Record<string, TypeSafeAnswer | undefined> = {};
  for (const key of Object.keys(value.answers)) {
    const raw = value.answers[key];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      continue;
    }
    if (raw.type === 'choice' && typeof raw.choice === 'string') {
      const probabilities: Record<string, number> = {};
      if (isRecord(raw.probabilities)) {
        for (const probabilityKey of Object.keys(raw.probabilities)) {
          const probability = (raw.probabilities)[probabilityKey];
          if (typeof probability === 'number' && isFinite(probability)) {
            probabilities[probabilityKey] = probability;
          }
        }
      }
      const confidenceRaw = raw.confidence;
      const confidence =
        typeof confidenceRaw === 'number' && isFinite(confidenceRaw)
          ? Math.max(0, Math.min(1, confidenceRaw))
          : Object.prototype.hasOwnProperty.call(probabilities, raw.choice)
            ? probabilities[raw.choice]
            : 0;
      answers[key] = { type: 'choice', choice: raw.choice, confidence, probabilities };
      continue;
    }
    if (raw.type === 'noul' && typeof raw.noul === 'number' && isFinite(raw.noul)) {
      answers[key] = { type: 'noul', noul: Math.max(0, Math.min(1, raw.noul)) };
    }
  }
  return { model, answers, usage: { input_tokens: input, output_tokens: output } };
}

export function createTypeSafeClient(config: TypeSafeClientConfig, deps: TypeSafeClientDeps = {}): TypeSafeClient {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  if (baseUrl === '') {
    throw new TypeSafeApiError('The TypeSafe base URL is empty.', { status: null, retryable: false });
  }
  if (apiKey === '') {
    throw new TypeSafeApiError('A TypeSafe API key is required.', { status: null, retryable: false });
  }
  if (model === '') {
    throw new TypeSafeApiError('A TypeSafe model name is required.', { status: null, retryable: false });
  }
  const fetchImpl: typeof fetch | undefined = deps.fetchImpl;
  const sleep = deps.sleep !== undefined ? deps.sleep : (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const random = deps.random !== undefined ? deps.random : () => Math.random();
  const timeoutMs = clampTimeout(config.requestTimeoutMs);
  const maxRetries = isFinite(config.maxRetries) ? Math.max(0, Math.min(5, Math.floor(config.maxRetries))) : 0;

  async function requestJson(path: string, body: unknown | null): Promise<{ status: number; body: string; retryAfterMs: number | null }> {
    const fetchFn: typeof fetch = fetchImpl !== undefined ? fetchImpl : fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${baseUrl}${path}`, {
        method: body === null ? 'GET' : 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetries<T>(
    label: string,
    operation: () => Promise<{ status: number; body: string; retryAfterMs: number | null }>,
    parse: (response: { status: number; body: string }) => T,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      let response: { status: number; body: string; retryAfterMs: number | null };
      try {
        response = await operation();
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        const transient = aborted || (error instanceof TypeError && /fetch|network|timeout/i.test(error.message));
        if (transient && attempt <= maxRetries) {
          await sleep(retryDelayMs(attempt, random));
          continue;
        }
        const relayHint =
          error instanceof Error && /relay|npm run proxy/i.test(error.message) ? ` ${error.message}` : '';
        throw new TypeSafeApiError(
          aborted
            ? `${label}Timed out after ${timeoutMs}ms.`
            : `Could not reach TypeSafe (network error or timeout).${relayHint}`,
          { status: null, retryable: transient, detail: aborted ? 'timeout' : 'network' },
        );
      }
      if (response.status >= 200 && response.status < 300) {
        return parse(response);
      }
      const transient = isRetryableStatus(response.status);
      if (transient && attempt <= maxRetries) {
        const delay = response.retryAfterMs !== null ? response.retryAfterMs : retryDelayMs(attempt, random);
        await sleep(delay);
        continue;
      }
      throw new TypeSafeApiError(describeServerError(response.status, response.body), {
        status: response.status,
        retryable: transient,
        detail: describeServerError(response.status, response.body),
      });
    }
  }

  return {
    model,
    async systemOne(state: unknown, questions: Record<string, TypeSafeQuestion>): Promise<TypeSafeResponse> {
      const payload = { model, state, questions };
      return withRetries(
        'TypeSafe request failed: ',
        () => requestJson(TYPESAFE_SYSTEMONE_PATH, payload),
        response => {
          const parsed = parseResponseBody(response.body);
          return parseTypeSafeResponse(parsed);
        },
      );
    },
    async listModels(): Promise<readonly string[]> {
      return withRetries(
        'TypeSafe connection test failed: ',
        () => requestJson(TYPESAFE_MODELS_PATH, null),
        response => {
          const parsed = parseResponseBody(response.body);
          if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
            throw new TypeSafeApiError('TypeSafe returned an unexpected model list.', {
              status: null,
              retryable: false,
            });
          }
          const models: string[] = [];
          for (const entry of parsed.models) {
            if (isRecord(entry) && typeof entry.name === 'string') {
              models.push(entry.name);
            }
          }
          return models;
        },
      );
    },
  };
}

/** Build the criteria map used for the five-category gender question. */
export function buildGenderChoiceCriteria(labels: {
  readonly female: string;
  readonly male: string;
  readonly machine: string;
  readonly organization: string;
  readonly ambiguous: string;
}): Record<string, string> {
  return {
    female: labels.female,
    male: labels.male,
    machine: labels.machine,
    organization: labels.organization,
    ambiguous: labels.ambiguous,
  };
}
