/**
 * Type declarations for `server/deepseek-proxy.mjs` (see proxy-handler.d.mts).
 */
import type { Server } from 'node:http';
import type { ProxyHandlerLogger } from './proxy-handler.mjs';

/** A running proxy instance. */
export interface RunningDeepSeekProxy {
  readonly server: Server;
  readonly servers: Server[];
  readonly host: string;
  readonly port: number;
  /** Plain WebSocket relay URL (Chrome/Edge). */
  readonly relayUrl: string;
  /** Secure WebSocket relay URL for Firefox, or null when TLS is unavailable. */
  readonly wssRelayUrl: string | null;
  /** Landing page for the one-time local certificate acceptance. */
  readonly httpsUrl: string | null;
  /** Stop listening; resolves once every server is closed. */
  close(): Promise<void>;
}

/** Options accepted by {@link startDeepSeekProxy}. */
export interface StartDeepSeekProxyOptions {
  readonly env?: Record<string, string | undefined>;
  readonly host?: string;
  readonly port?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Also serve the secure WSS relay (Firefox needs this). */
  readonly tls?: boolean;
  /** WSS/HTTPS port (default WSS_PORT/8788). */
  readonly wssPort?: number;
  /** Directory for the generated localhost certificate. */
  readonly certDir?: string;
  readonly logger?: ProxyHandlerLogger & { readonly warn?: (message: string) => void };
}

export function startDeepSeekProxy(options?: StartDeepSeekProxyOptions): Promise<RunningDeepSeekProxy>;

export const DEFAULT_HOST: string;
export const DEFAULT_PORT: number;
export const DEFAULT_WSS_PORT: number;
