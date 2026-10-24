/**
 * Type declarations for `server/proxy-handler.mjs` so the TypeScript test
 * suite can import the zero-dependency proxy handler without `allowJs`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Logger sink accepted by the handler; only fixed, non-sensitive messages arrive. */
export interface ProxyHandlerLogger {
  readonly error?: (message: string) => void;
}

/** Options accepted by {@link createProxyHandler}. */
export interface ProxyHandlerDeps {
  /** Environment map (usually process.env): CORS_ORIGINS, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL. */
  readonly env?: Record<string, string | undefined>;
  /** Injected upstream transport; tests MUST pass a fake. */
  readonly fetchImpl?: typeof fetch;
  /** Injected clock for /health timestamps. */
  readonly now?: () => number;
  /** Upstream timeout override in milliseconds (tests). */
  readonly timeoutMs?: number;
  /** Logger sink for non-sensitive error messages. */
  readonly logger?: ProxyHandlerLogger;
}

/** Node http request handler returned by {@link createProxyHandler}. */
export type ProxyHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function createProxyHandler(deps?: ProxyHandlerDeps): ProxyHandler;

/** Parse the comma-separated CORS_ORIGINS value into a deduplicated list. */
export function parseCorsOrigins(rawValue: unknown): readonly string[];

export const DEFAULT_CORS_ORIGINS: readonly string[];
export const DEFAULT_UPSTREAM_BASE_URL: string;
export const MAX_REQUEST_BODY_BYTES: number;
export const UPSTREAM_TIMEOUT_MS: number;
export const CHAT_COMPLETIONS_PATH: string;
export const HEALTH_PATH: string;
export const WILDCARD_ORIGIN: string;
