/**
 * Browser-side WebSocket relay transport for the classifier APIs.
 *
 * Instagram's page Content-Security-Policy blocks cross-origin `fetch`/XHR to
 * `api.typesafe.ai` and `api.deepseek.com`, but it explicitly allows
 * `ws://localhost:*`. When the audit script runs on instagram.com we therefore
 * send the same HTTP request through the bundled local proxy's WebSocket relay
 * (`npm run proxy`), which forwards it over HTTPS and returns the response.
 *
 * The relay is intentionally tiny: one WebSocket per HTTP request, JSON
 * envelope in, JSON envelope out. It never opens a connection unless the
 * transport policy says the relay is needed, so localhost previews and tests
 * keep talking to their injected fakes directly.
 */
import { ClassifierRelayMode, DEFAULT_RELAY_URL, DEFAULT_WSS_RELAY_URL, DeepSeekConfig } from '../model/deepseek-config';

/** Minimal structural WebSocket interface so tests can inject a fake. */
export interface RelaySocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type RelaySocketFactory = (url: string) => RelaySocketLike;

export interface RelayFetchOptions {
  readonly relayUrl: string;
  /** Tried in order when the previous relay URL is unreachable (e.g. the WSS relay for Firefox). */
  readonly fallbackRelayUrls?: readonly string[];
  readonly socketFactory?: RelaySocketFactory;
  readonly timeoutMs?: number;
}

/** Raised when the local relay cannot be reached or returns an error. */
export class ClassifierRelayError extends Error {
  readonly code: 'unreachable' | 'timeout' | 'relay-error' | 'aborted';

  constructor(message: string, code: ClassifierRelayError['code']) {
    super(message);
    this.name = 'ClassifierRelayError';
    this.code = code;
    Object.setPrototypeOf(this, ClassifierRelayError.prototype);
  }
}

function defaultSocketFactory(): RelaySocketFactory | null {
  const candidate: unknown = typeof WebSocket === 'undefined' ? undefined : WebSocket;
  if (typeof candidate !== 'function') {
    return null;
  }
  return (targetUrl: string) => new (candidate as new (socketUrl: string) => RelaySocketLike)(targetUrl);
}

/** True for instagram.com and its subdomains. */
export function isInstagramHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'instagram.com' || normalized.endsWith('.instagram.com');
}

/** True when the page CSP will block direct classifier fetch calls. */
export function shouldUseRelay(config: Pick<DeepSeekConfig, 'relayMode'>, hostname: string | undefined): boolean {
  if (config.relayMode === 'relay') {
    return true;
  }
  if (config.relayMode === 'direct') {
    return false;
  }
  return typeof hostname === 'string' && isInstagramHostname(hostname);
}

function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined || !isFinite(value) || value < 1000) {
    return 45000;
  }
  return Math.floor(Math.min(value, 120000));
}

function isFirefoxBrowser(): boolean {
  try {
    return typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);
  } catch {
    return false;
  }
}

function relayNotRunningMessage(relayUrl: string): string {
  const firefoxHint = isFirefoxBrowser()
    ? ' Firefox needs the local relay CA trusted: run `npm run trust:relay` (the proxy does this automatically on startup when it can), then restart Firefox once. No certificate dialog is needed.'
    : '';
  return (
    `Could not reach the local relay at ${relayUrl}. Start it with \`npm run proxy\` in the project folder, ` +
    'then retry the scan. Instagram blocks direct classifier API calls (CSP), so the relay is required on instagram.com.' +
    firefoxHint
  );
}

interface RelayResponseMessage {
  readonly kind: 'http-response';
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}


function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) {
    return record;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, name) => {
      record[name] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      record[String(pair[0])] = String(pair[1]);
    }
    return record;
  }
  for (const name of Object.keys(headers)) {
    const value = (headers as Record<string, unknown>)[name];
    if (typeof value === 'string') {
      record[name] = value;
    }
  }
  return record;
}

function makeResponse(message: RelayResponseMessage): Response {
  const headerMap = new Map<string, string>();
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    headerMap.set(name.toLowerCase(), value);
  }
  const status = isFinite(message.status) ? Math.max(0, Math.floor(message.status)) : 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
      has: (name: string) => headerMap.has(name.toLowerCase()),
      forEach: (callback: (value: string, name: string) => void) => {
        headerMap.forEach((value, name) => callback(value, name));
      },
    },
    text: async () => message.body,
    json: async () => JSON.parse(message.body) as unknown,
  } as unknown as Response;
}

/** Relay endpoints to try, secure-first on HTTPS pages (Firefox upgrades ws://). */
export function relayUrlCandidates(
  config: Pick<DeepSeekConfig, 'relayUrl'>,
  securePage: boolean = typeof location !== 'undefined' && location.protocol === 'https:',
): string[] {
  const configured = config.relayUrl.trim() === '' ? DEFAULT_RELAY_URL : config.relayUrl.trim();
  const secure = [DEFAULT_WSS_RELAY_URL, configured].filter((value, index, list) => list.indexOf(value) === index);
  const plain = [configured, DEFAULT_WSS_RELAY_URL].filter((value, index, list) => list.indexOf(value) === index);
  return securePage ? secure : plain;
}

/** Result of the launch-screen relay preflight. */
export interface RelayProbeResult {
  readonly ok: boolean;
  readonly relayUrl?: string;
  readonly message: string;
}

async function probeRelaySocket(
  socketFactory: RelaySocketFactory,
  url: string,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  return new Promise(resolve => {
    let settled = false;
    let socket: RelaySocketLike;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: { readonly ok: boolean; readonly message: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(result);
    };
    timer = setTimeout(
      () => finish({ ok: false, message: `timed out after ${timeoutMs} ms` }),
      timeoutMs,
    );
    try {
      socket = socketFactory(url);
    } catch {
      finish({ ok: false, message: 'this browser could not open a WebSocket' });
      return;
    }
    socket.onopen = () => finish({ ok: true, message: 'connected' });
    socket.onerror = () => finish({ ok: false, message: 'connection was refused or the local certificate was not trusted' });
    socket.onclose = () => finish({ ok: false, message: 'connection closed before it was ready' });
  });
}

/**
 * Launch-screen preflight: confirm the bundled local relay is actually running
 * (and, for Firefox, that the local CA is trusted) before a scan is allowed to
 * start. Tries the secure endpoint first on HTTPS pages.
 */
export async function probeRelayConnection(options: {
  readonly relayUrl: string;
  readonly fallbackRelayUrls?: readonly string[];
  readonly socketFactory?: RelaySocketFactory;
  readonly timeoutMs?: number;
}): Promise<RelayProbeResult> {
  const socketFactory = options.socketFactory ?? defaultSocketFactory();
  if (socketFactory === null) {
    return {
      ok: false,
      message: 'This browser does not expose WebSocket, so the local relay cannot be used.',
    };
  }
  const timeoutMs = Math.min(resolveTimeoutMs(options.timeoutMs), 5000);
  const candidates: string[] = [];
  for (const candidate of [options.relayUrl.trim(), ...(options.fallbackRelayUrls ?? [])]) {
    if (candidate !== '' && candidates.indexOf(candidate) === -1) {
      candidates.push(candidate);
    }
  }
  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = await probeRelaySocket(socketFactory, candidate, timeoutMs);
    if (result.ok) {
      return { ok: true, relayUrl: candidate, message: 'connected' };
    }
    failures.push(`${candidate} (${result.message})`);
  }
  return {
    ok: false,
    message:
      'Could not reach the local relay. Start it with `npm run proxy` in the project folder and keep that window open, then retry. ' +
      'Firefox: fully restart the browser after installing the local CA (`npm run trust:relay`). ' +
      (failures.length > 0 ? `Tried: ${failures.join('; ')}.` : ''),
  };
}

/**
 * Build a `fetch`-compatible function that tunnels JSON HTTP requests through
 * the local WebSocket relay. Errors are actionable and never echo API keys.
 */
export function createRelayFetch(options: RelayFetchOptions): typeof fetch {
  const configuredRelayUrl = options.relayUrl.trim() === '' ? DEFAULT_RELAY_URL : options.relayUrl.trim();
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const socketFactory = options.socketFactory ?? defaultSocketFactory();
  const fallbackRelayUrls = options.fallbackRelayUrls ?? [];
  const relayUrls: string[] = [];
  for (const candidate of [configuredRelayUrl, ...fallbackRelayUrls]) {
    const trimmed = candidate.trim();
    if (trimmed !== '' && relayUrls.indexOf(trimmed) === -1) {
      relayUrls.push(trimmed);
    }
  }

  function fetchViaRelay(relayUrl: string, url: string, init: RequestInit | undefined): Promise<Response> {
    if (socketFactory === null) {
      return Promise.reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable'));
    }
    const headers = normalizeHeaders(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let socket: RelaySocketLike;
      try {
        socket = socketFactory(relayUrl);
      } catch {
        reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable'));
        return;
      }

      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        action();
      };

      timer = setTimeout(() => {
        finish(() => reject(new ClassifierRelayError(`The local relay at ${relayUrl} timed out after ${timeoutMs} ms.`, 'timeout')));
      }, timeoutMs);

      const signal = init?.signal ?? null;
      if (signal !== null) {
        if (signal.aborted) {
          finish(() => reject(new ClassifierRelayError('Relay request aborted.', 'aborted')));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            finish(() => reject(new ClassifierRelayError('Relay request aborted.', 'aborted')));
          },
          { once: true },
        );
      }

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({ kind: 'http', url, method: init?.method ?? 'POST', headers, body }));
        } catch {
          finish(() => reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable')));
        }
      };

      socket.onmessage = event => {
        let message: unknown;
        try {
          message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
          finish(() => reject(new ClassifierRelayError('The local relay returned an invalid response.', 'relay-error')));
          return;
        }
        if (typeof message !== 'object' || message === null) {
          finish(() => reject(new ClassifierRelayError('The local relay returned an invalid response.', 'relay-error')));
          return;
        }
        const record = message as Record<string, unknown>;
        if (record.kind === 'http-response') {
          finish(() => resolve(makeResponse(record as unknown as RelayResponseMessage)));
          return;
        }
        const errorMessage = typeof record.message === 'string' ? record.message : 'The local relay request failed.';
        finish(() => reject(new ClassifierRelayError(errorMessage, 'relay-error')));
      };

      socket.onerror = () => {
        finish(() => reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable')));
      };

      socket.onclose = () => {
        if (!settled) {
          finish(() => reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable')));
        }
      };
    });
  }

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const failures: string[] = [];
    for (let index = 0; index < relayUrls.length; index += 1) {
      const relayUrl = relayUrls[index];
      try {
        return await fetchViaRelay(relayUrl, url, init);
      } catch (error) {
        const isLast = index === relayUrls.length - 1;
        const relayError = error instanceof ClassifierRelayError ? error : new ClassifierRelayError(String(error), 'relay-error');
        failures.push(`${relayUrl}: ${relayError.message}`);
        const canFallBack =
          !isLast && (relayError.code === 'unreachable' || (relayError.code === 'timeout' && index === 0));
        if (!canFallBack) {
          throw relayError;
        }
        if (isFirefoxBrowser() && relayError.code === 'unreachable') {
          failures.push(
            'Firefox note: if the secure relay is rejected, run `npm run trust:relay` and restart Firefox once.',
          );
        }
      }
    }
    throw new ClassifierRelayError(
      failures.length === 0
        ? relayNotRunningMessage(configuredRelayUrl)
        : `Could not reach any local relay. ${failures.join(' | ')}`,
      'unreachable',
    );
  }) as typeof fetch;
}


/**
 * Fetch an image through the local relay and return a `data:` URL. Used for
 * Instagram profile photos (the browser cannot read the CDN directly because of
 * CORS, and DeepSeek cannot download external URLs reliably).
 */
export async function fetchImageDataUrlViaRelay(
  relayUrl: string,
  imageUrl: string,
  options: { readonly socketFactory?: RelaySocketFactory; readonly timeoutMs?: number } = {},
): Promise<string> {
  const socketFactory = options.socketFactory ?? defaultSocketFactory();
  if (socketFactory === null) {
    throw new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable');
  }
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: RelaySocketLike;
    try {
      socket = socketFactory(relayUrl);
    } catch {
      reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable'));
      return;
    }
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      action();
    };
    timer = setTimeout(() => finish(() => reject(new ClassifierRelayError('Image relay timed out.', 'timeout'))), timeoutMs);
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ kind: 'fetch-image', id: 'image-1', url: imageUrl }));
      } catch {
        finish(() => reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable')));
      }
    };
    socket.onmessage = event => {
      let message: unknown;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        finish(() => reject(new ClassifierRelayError('Invalid image relay response.', 'relay-error')));
        return;
      }
      if (typeof message !== 'object' || message === null) {
        finish(() => reject(new ClassifierRelayError('Invalid image relay response.', 'relay-error')));
        return;
      }
      const record = message as Record<string, unknown>;
      if (record.kind === 'image-response' && typeof record.base64 === 'string') {
        const mime = typeof record.mimeType === 'string' ? record.mimeType : 'image/jpeg';
        finish(() => resolve(`data:${mime};base64,${record.base64}`));
        return;
      }
      finish(() => reject(new ClassifierRelayError('Could not fetch the profile image through the relay.', 'relay-error')));
    };
    socket.onerror = () => finish(() => reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable')));
    socket.onclose = () => {
      if (!settled) {
        finish(() => reject(new ClassifierRelayError(relayNotRunningMessage(relayUrl), 'unreachable')));
      }
    };
  });
}

/** Current page hostname, or undefined outside a browser/test environment. */
export function currentHostname(): string | undefined {
  try {
    return typeof location === 'undefined' ? undefined : location.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Pick the transport the classifier clients should use: an explicitly injected
 * fetch (tests, other callers) wins; otherwise use the relay when policy says so.
 */
export function resolveClassifierFetch(
  config: Pick<DeepSeekConfig, 'relayMode' | 'relayUrl' | 'requestTimeoutMs'>,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly webSocketFactory?: RelaySocketFactory;
    readonly hostname?: string;
  } = {},
): typeof fetch | undefined {
  if (options.fetchImpl !== undefined) {
    return options.fetchImpl;
  }
  const hostname = options.hostname ?? currentHostname();
  if (!shouldUseRelay(config, hostname)) {
    return undefined;
  }
  const candidates = relayUrlCandidates(config);
  return createRelayFetch({
    relayUrl: candidates[0],
    fallbackRelayUrls: candidates.slice(1),
    socketFactory: options.webSocketFactory,
    timeoutMs: config.requestTimeoutMs,
  });
}

/** True when the classifier will go through the relay on this page. */
export function relayWillBeUsed(
  config: Pick<DeepSeekConfig, 'relayMode'>,
  options: { readonly fetchImpl?: typeof fetch; readonly hostname?: string } = {},
): boolean {
  if (options.fetchImpl !== undefined) {
    return false;
  }
  return shouldUseRelay(config, options.hostname ?? currentHostname());
}

export type { ClassifierRelayMode };
