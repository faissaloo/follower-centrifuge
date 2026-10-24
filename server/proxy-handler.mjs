/**
 * Zero-dependency local proxy for the DeepSeek chat completions API.
 *
 * Why a proxy? The app is a console script pasted into an authenticated
 * instagram.com tab. Holding a paid API key there is dangerous (any script on
 * the page can read it) and DeepSeek's CORS policy does not allow browser
 * calls. This proxy runs on the user's machine, binds to loopback only and
 * injects the key server-side so it never reaches the browser:
 *
 *   browser (instagram.com tab)  ->  http://127.0.0.1:8787/v1/chat/completions
 *                                       |
 *                                       +-- POST https://api.deepseek.com/v1/chat/completions
 *                                           Authorization: Bearer $DEEPSEEK_API_KEY
 *
 * Security properties enforced here:
 *  - listens on 127.0.0.1 only (see deepseek-proxy.mjs) and forwards exactly
 *    two paths: GET /health and POST /v1/chat/completions;
 *  - CORS allowlist (env CORS_ORIGINS) so a random website cannot use the
 *    local proxy as a free DeepSeek relay;
 *  - request bodies are capped (100 KB) and validated (JSON object with a
 *    messages array, streaming refused);
 *  - the API key is never logged, never echoed and stripped from error output;
 *    request/response bodies are never logged either;
 *  - upstream timeouts (60 s) and network failures are relayed as clean JSON
 *    errors instead of crashing the process.
 *
 * The handler takes its environment, clock and fetch implementation by
 * injection so it can be tested against an ephemeral local HTTP server without
 * any real network access.
 */
import { Buffer } from 'node:buffer';

/** Origins allowed to call the proxy when CORS_ORIGINS is not configured. */
export const DEFAULT_CORS_ORIGINS = [
  'https://www.instagram.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
];

/** Upstream DeepSeek API base URL used when DEEPSEEK_BASE_URL is unset. */
export const DEFAULT_UPSTREAM_BASE_URL = 'https://api.deepseek.com';
/** Maximum accepted request body size in bytes. */
export const MAX_REQUEST_BODY_BYTES = 100 * 1024;
/** Upstream request timeout in milliseconds. */
export const UPSTREAM_TIMEOUT_MS = 60000;
/** The only forwarded API path. */
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
/** Liveness endpoint. */
export const HEALTH_PATH = '/health';
/** Raw origin-header allowlist entry that means "allow every origin". */
export const WILDCARD_ORIGIN = '*';

/**
 * Parse the comma-separated CORS_ORIGINS env var. Falls back to the default
 * allowlist when the variable is missing or empty.
 */
export function parseCorsOrigins(rawValue) {
  const fallback = DEFAULT_CORS_ORIGINS.slice();
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return fallback;
  }
  const origins = [];
  for (const part of rawValue.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '' && origins.indexOf(trimmed) === -1) {
      origins.push(trimmed);
    }
  }
  return origins.length > 0 ? origins : fallback;
}

function readEnvString(env, name) {
  if (typeof env !== 'object' || env === null) {
    return '';
  }
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function resolveUpstreamBaseUrl(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return DEFAULT_UPSTREAM_BASE_URL;
  }
  const candidate = rawValue.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_UPSTREAM_BASE_URL;
    }
    return candidate;
  } catch {
    return DEFAULT_UPSTREAM_BASE_URL;
  }
}

function normalizeTimeoutMs(value) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) {
    return UPSTREAM_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function resolveDefaultFetch() {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one request header as a trimmed string (Node gives lowercase keys). */
function readRequestHeader(req, name) {
  if (typeof req !== 'object' || req === null || typeof req.headers !== 'object' || req.headers === null) {
    return '';
  }
  const value = req.headers[name];
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0].trim();
  }
  return '';
}

function logProxyError(logger, message) {
  try {
    if (logger !== null && typeof logger === 'object' && typeof logger.error === 'function') {
      // Only fixed, non-sensitive strings are logged: never keys or bodies.
      logger.error(`deepseek-proxy: ${message}`);
    }
  } catch {
    // Logging must never crash the proxy.
  }
}

function sendBody(res, status, body, contentType, extraHeaders) {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  const headers = Object.assign(
    {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    extraHeaders,
  );
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload, extraHeaders) {
  sendBody(res, status, JSON.stringify(payload), 'application/json; charset=utf-8', extraHeaders);
}

function sendPreflight(res, corsHeaders) {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  res.writeHead(
    204,
    Object.assign(
      {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      },
      corsHeaders,
    ),
  );
  res.end();
}

function errorPayload(message, type) {
  return { error: { message, type } };
}

/** Path part of the request URL, without query string. */
function requestPath(req) {
  const rawUrl = typeof req.url === 'string' ? req.url : '/';
  const queryIndex = rawUrl.indexOf('?');
  const pathPart = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  return pathPart === '' ? '/' : pathPart;
}

const BODY_TOO_LARGE = 'body-too-large';
const BODY_ABORTED = 'body-aborted';

/** Collect the request body, rejecting anything larger than `maxBytes`. */
function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    }

    function settle(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error !== null) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    function onData(chunk) {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        settle(Object.assign(new Error('Request body is too large.'), { code: BODY_TOO_LARGE }));
        // Drain the rest so the client can still receive the 413 response.
        req.resume();
        return;
      }
      chunks.push(buffer);
    }

    function onEnd() {
      settle(null, Buffer.concat(chunks).toString('utf8'));
    }

    function onError(error) {
      settle(error);
    }

    function onAborted() {
      settle(Object.assign(new Error('Request aborted.'), { code: BODY_ABORTED }));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** Read an upstream fetch response body as text (never throws). */
async function readUpstreamText(upstream) {
  try {
    if (typeof upstream.text === 'function') {
      return await upstream.text();
    }
    return '';
  } catch {
    return '';
  }
}

function getUpstreamHeader(upstream, name) {
  if (typeof upstream !== 'object' || upstream === null || typeof upstream.headers !== 'object' || upstream.headers === null) {
    return null;
  }
  const headers = upstream.headers;
  if (typeof headers.get !== 'function') {
    return null;
  }
  try {
    const value = headers.get(name);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Handle POST /v1/chat/completions: validate the body, inject the key and
 * relay the upstream status/body back to the browser.
 */
async function handleChatCompletion(req, res, context) {
  const { apiKey, completionUrl, corsHeaders, fetchImpl, logger, timeoutMs } = context;
  if (typeof fetchImpl !== 'function') {
    sendJson(
      res,
      500,
      errorPayload('Proxy cannot reach DeepSeek: no fetch implementation is available on this Node version.', 'configuration_error'),
      corsHeaders,
    );
    return;
  }
  const appAuthorization = readRequestHeader(req, 'authorization');
  if (appAuthorization === '' && apiKey === '') {
    sendJson(
      res,
      500,
      errorPayload(
        'Proxy is not configured: set DEEPSEEK_API_KEY in the environment before starting the proxy.',
        'configuration_error',
      ),
      corsHeaders,
    );
    return;
  }

  let rawBody;
  try {
    rawBody = await readRequestBody(req, MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? error.code : undefined;
    if (code === BODY_TOO_LARGE) {
      sendJson(res, 413, errorPayload('Request body is too large.', 'body_too_large'), corsHeaders);
      return;
    }
    if (code === BODY_ABORTED) {
      if (!res.writableEnded) {
        res.destroy();
      }
      return;
    }
    sendJson(res, 400, errorPayload('Could not read the request body.', 'invalid_request'), corsHeaders);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, errorPayload('Request body must be valid JSON.', 'invalid_request'), corsHeaders);
    return;
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    sendJson(
      res,
      400,
      errorPayload('Request body must be a JSON object with a non-empty "messages" array.', 'invalid_request'),
      corsHeaders,
    );
    return;
  }
  if (payload.stream === true) {
    sendJson(res, 400, errorPayload('Streaming responses are not supported by this proxy.', 'invalid_request'), corsHeaders);
    return;
  }

  const authorization = appAuthorization !== '' ? appAuthorization : `Bearer ${apiKey}`;
  const controller = new AbortController();
  const requestState = { timedOut: false };
  const timer = setTimeout(() => {
    requestState.timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  let upstream;
  try {
    upstream = await fetchImpl(completionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authorization,
      },
      body: rawBody,
      signal: controller.signal,
    });
  } catch {
    if (requestState.timedOut) {
      logProxyError(logger, 'upstream request timed out');
      sendJson(res, 504, errorPayload('DeepSeek request timed out.', 'upstream_timeout'), corsHeaders);
    } else {
      logProxyError(logger, 'upstream request failed');
      sendJson(res, 502, errorPayload('Could not reach DeepSeek.', 'upstream_error'), corsHeaders);
    }
    return;
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await readUpstreamText(upstream);
  const upstreamStatus = typeof upstream.status === 'number' ? upstream.status : 502;
  const upstreamContentType = getUpstreamHeader(upstream, 'content-type');
  const contentType =
    typeof upstreamContentType === 'string' && upstreamContentType !== ''
      ? upstreamContentType
      : 'application/json; charset=utf-8';
  sendBody(res, upstreamStatus, bodyText, contentType, corsHeaders);
}

/**
 * Create a Node `http` request handler.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] Environment map
 *   (usually `process.env`): CORS_ORIGINS, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL.
 * @param {typeof fetch} [options.fetchImpl] Injected upstream transport
 *   (MUST be a fake in tests; never let tests reach the real network).
 * @param {() => number} [options.now] Injected clock for /health timestamps.
 * @param {number} [options.timeoutMs] Upstream timeout override (tests).
 * @param {{ error?: (message: string) => void }} [options.logger] Logger sink
 *   that only ever receives fixed, non-sensitive messages.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createProxyHandler(options = {}) {
  const env = isPlainObject(options.env) ? options.env : {};
  const logger = isPlainObject(options.logger) ? options.logger : console;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const fetchImpl = options.fetchImpl !== undefined ? options.fetchImpl : resolveDefaultFetch();
  const allowedOrigins = new Set(parseCorsOrigins(env.CORS_ORIGINS));
  const allowAnyOrigin = allowedOrigins.has(WILDCARD_ORIGIN);
  const apiKey = readEnvString(env, 'DEEPSEEK_API_KEY');
  const upstreamBaseUrl = resolveUpstreamBaseUrl(env.DEEPSEEK_BASE_URL);
  const completionUrl = `${upstreamBaseUrl}${CHAT_COMPLETIONS_PATH}`;

  function corsFor(origin) {
    const headers = { Vary: 'Origin' };
    if (origin === null) {
      // Non-browser caller (curl, tests): nothing to restrict.
      return { allowed: true, headers };
    }
    const allowed = allowAnyOrigin || allowedOrigins.has(origin);
    if (!allowed) {
      return { allowed: false, headers };
    }
    headers['Access-Control-Allow-Origin'] = allowAnyOrigin ? WILDCARD_ORIGIN : origin;
    return { allowed: true, headers };
  }

  async function route(req, res) {
    const rawOrigin = readRequestHeader(req, 'origin');
    const origin = rawOrigin === '' ? null : rawOrigin;
    const cors = corsFor(origin);
    if (!cors.allowed) {
      sendJson(res, 403, errorPayload('Origin is not allowed by this proxy.', 'cors_error'), cors.headers);
      return;
    }
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
    const path = requestPath(req);

    if (path === HEALTH_PATH) {
      if (method === 'OPTIONS') {
        sendPreflight(res, cors.headers);
        return;
      }
      if (method !== 'GET') {
        sendJson(res, 405, errorPayload('Method not allowed. Use GET.', 'method_not_allowed'), Object.assign({ Allow: 'GET' }, cors.headers));
        return;
      }
      sendJson(
        res,
        200,
        {
          status: 'ok',
          service: 'deepseek-proxy',
          keyConfigured: apiKey !== '',
          upstreamBaseUrl,
          time: new Date(now()).toISOString(),
        },
        cors.headers,
      );
      return;
    }

    if (path === CHAT_COMPLETIONS_PATH) {
      if (method === 'OPTIONS') {
        sendPreflight(res, cors.headers);
        return;
      }
      if (method !== 'POST') {
        sendJson(
          res,
          405,
          errorPayload('Method not allowed. Use POST.', 'method_not_allowed'),
          Object.assign({ Allow: 'POST, OPTIONS' }, cors.headers),
        );
        return;
      }
      await handleChatCompletion(req, res, {
        apiKey,
        completionUrl,
        corsHeaders: cors.headers,
        fetchImpl,
        logger,
        timeoutMs,
      });
      return;
    }

    sendJson(res, 404, errorPayload('Not found.', 'not_found'), cors.headers);
  }

  return function proxyHandler(req, res) {
    route(req, res).catch(() => {
      logProxyError(logger, 'unexpected error while handling a request');
      sendJson(res, 500, errorPayload('Internal proxy error.', 'internal_error'), {});
    });
  };
}
