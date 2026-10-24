/**
 * Configuration for the name-based gender classifier.
 *
 * Two hosted providers are supported, plus a fully offline demo classifier:
 *  - TypeSafe AI "Jev" (`POST /v1/systemone`, structured choice questions) is
 *    the primary provider: cheap, fast and returns per-category probabilities;
 *  - DeepSeek (OpenAI-compatible chat completions) is the fallback provider;
 *  - `demo` is a deterministic offline classifier used for previews.
 *
 * Secrets are handled carefully:
 *  - the normal/public build embeds NO keys, so GitHub Pages users can bring
 *    their own credentials through the settings screen (sessionStorage only);
 *  - the optional local keyed build (`npm run build:local-key`) compiles keys
 *    read from gitignored files into a gitignored script;
 *  - the DeepSeek proxy mode keeps even the fallback key outside the browser.
 */

/** Which hosted/offline provider is used first. */
export type ClassifierProvider = 'typesafe' | 'deepseek' | 'demo';

/** Legacy name for the DeepSeek transport mode (kept for compatibility). */
export type GenderProviderMode = 'proxy' | 'direct' | 'demo';

/**
 * How the browser reaches the classifier APIs.
 *
 * Instagram's page CSP (`connect-src`) blocks direct fetch/XHR to both
 * providers, but explicitly allows `ws://localhost:*`. `auto` therefore routes
 * classifier requests through the bundled local WebSocket relay when the script
 * runs on instagram.com, and calls the APIs directly on any other origin.
 */
export type ClassifierRelayMode = 'auto' | 'relay' | 'direct';

/**
 * Keys compiled into the optional local keyed build (empty strings in the
 * normal/public build). Guarded because Vitest has no DefinePlugin.
 */
const compiledTypeSafeKey: string =
  typeof __IU_EMBEDDED_TYPESAFE_KEY__ === 'undefined' ? '' : __IU_EMBEDDED_TYPESAFE_KEY__;
const compiledDeepSeekKey: string =
  typeof __IU_EMBEDDED_DEEPSEEK_KEY__ === 'undefined' ? '' : __IU_EMBEDDED_DEEPSEEK_KEY__;

export const EMBEDDED_TYPESAFE_API_KEY: string = compiledTypeSafeKey.trim();
export const EMBEDDED_DEEPSEEK_API_KEY: string = compiledDeepSeekKey.trim();
export const HAS_EMBEDDED_TYPESAFE_KEY: boolean = EMBEDDED_TYPESAFE_API_KEY !== '';
export const HAS_EMBEDDED_DEEPSEEK_KEY: boolean = EMBEDDED_DEEPSEEK_API_KEY !== '';

export interface DeepSeekConfig {
  /** Primary classifier provider. */
  readonly provider: ClassifierProvider;
  /** When TypeSafe is primary and fails, fall back to DeepSeek (if configured). */
  readonly fallbackToDeepSeek: boolean;

  /** TypeSafe API base URL; `/v1/systemone` is appended. */
  readonly typesafeBaseUrl: string;
  /** TypeSafe model name, e.g. `jev-latest`. */
  readonly typesafeModel: string;
  /** TypeSafe API key (direct browser / embedded build only). Never persisted to localStorage. */
  readonly typesafeApiKey: string;

  /** DeepSeek transport: local proxy vs direct browser calls vs demo. */
  readonly mode: GenderProviderMode;
  /** Base URL of the bundled local proxy; chat completions live at `${url}/v1/chat/completions`. */
  readonly proxyBaseUrl: string;
  /** Base URL when talking to DeepSeek directly from the browser. */
  readonly directBaseUrl: string;
  /** DeepSeek model name, e.g. `deepseek-chat`. */
  readonly model: string;
  /** Transient DeepSeek API key (direct mode only). Never persisted to localStorage. */
  readonly apiKey: string;

  /** How many accounts are sent per model request. */
  readonly batchSize: number;
  /** Per-request timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Number of retries for transient failures (429 / 5xx / network / timeout). */
  readonly maxRetries: number;

  /** Include public profile photos in the classification (vision pass). */
  readonly includeProfilePhotos: boolean;
  /** Vision-capable DeepSeek model used for the photo pass. */
  readonly visionModel: string;

  /** Transport used to reach the classifier APIs (CSP workaround on Instagram). */
  readonly relayMode: ClassifierRelayMode;
  /** Local proxy WebSocket relay URL (advanced; rarely changed). */
  readonly relayUrl: string;
}

export const DEEPSEEK_CONFIG_STORAGE_KEY = 'iu_deepseek-config';
export const DEEPSEEK_API_KEY_SESSION_KEY = 'iu_deepseek-api-key';
export const TYPESAFE_API_KEY_SESSION_KEY = 'iu_typesafe-api-key';
export const GENDER_CACHE_STORAGE_KEY = 'iu_gender-cache';

/** Bump when the classification prompt/parsing semantics change (cache key). */
export const GENDER_PROMPT_VERSION = 'v3';

/** Local WebSocket relay used on instagram.com because the page CSP blocks direct fetch. */
export const DEFAULT_RELAY_URL = 'ws://localhost:8787/ws';
/**
 * Secure fallback relay. Instagram's `upgrade-insecure-requests` turns
 * ws://localhost into wss://localhost in Firefox, so the browser also tries
 * this HTTPS relay and tells the user how to accept its one-time local cert.
 */
export const DEFAULT_WSS_RELAY_URL = 'wss://localhost:8788/ws';
export const DEEPSEEK_PROXY_DEFAULT_PORT = 8787;
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
/** Vision-capable DeepSeek model used for the profile-photo pass. */
export const DEEPSEEK_DEFAULT_VISION_MODEL = 'deepseek-flash';

export const DEFAULT_DEEPSEEK_CONFIG: DeepSeekConfig = {
  provider: 'typesafe',
  fallbackToDeepSeek: true,
  typesafeBaseUrl: TYPESAFE_DEFAULT_BASE_URL,
  typesafeModel: TYPESAFE_DEFAULT_MODEL,
  typesafeApiKey: '',
  mode: 'proxy',
  proxyBaseUrl: `http://127.0.0.1:${DEEPSEEK_PROXY_DEFAULT_PORT}`,
  directBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  batchSize: 25,
  requestTimeoutMs: 30000,
  maxRetries: 2,
  includeProfilePhotos: true,
  visionModel: DEEPSEEK_DEFAULT_VISION_MODEL,
  relayMode: 'auto',
  relayUrl: DEFAULT_RELAY_URL,
};

export const MIN_CLASSIFY_BATCH_SIZE = 1;
export const MAX_CLASSIFY_BATCH_SIZE = 50;
