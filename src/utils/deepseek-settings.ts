import {
  ClassifierProvider,
  ClassifierRelayMode,
  DEFAULT_DEEPSEEK_CONFIG,
  DEEPSEEK_API_KEY_SESSION_KEY,
  DEEPSEEK_CONFIG_STORAGE_KEY,
  DeepSeekConfig,
  EMBEDDED_DEEPSEEK_API_KEY,
  EMBEDDED_TYPESAFE_API_KEY,
  HAS_EMBEDDED_DEEPSEEK_KEY,
  HAS_EMBEDDED_TYPESAFE_KEY,
  MAX_CLASSIFY_BATCH_SIZE,
  MIN_CLASSIFY_BATCH_SIZE,
  TYPESAFE_API_KEY_SESSION_KEY,
} from '../model/deepseek-config';

/**
 * DeepSeek settings persistence.
 *
 * Threat model: the browser app is a console-pasted script that already runs
 * inside an authenticated instagram.com tab. Persisting a paid API key in
 * localStorage makes it readable by any script on the page and by anybody with
 * disk access, so:
 *   - the key is only ever kept in sessionStorage for the current tab;
 *   - everything else is validated and persisted in localStorage;
 *   - the default transport is the local proxy, where the key never enters the
 *     browser at all.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !isFinite(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function readMode(source: Record<string, unknown>): DeepSeekConfig['mode'] {
  const value = source.mode;
  return value === 'proxy' || value === 'direct' || value === 'demo' ? value : DEFAULT_DEEPSEEK_CONFIG.mode;
}

function readRelayMode(source: Record<string, unknown>): ClassifierRelayMode {
  const value = source.relayMode;
  return value === 'relay' || value === 'direct' || value === 'auto' ? value : DEFAULT_DEEPSEEK_CONFIG.relayMode;
}

function readProvider(source: Record<string, unknown>): ClassifierProvider {
  const value = source.provider;
  return value === 'typesafe' || value === 'deepseek' || value === 'demo' ? value : DEFAULT_DEEPSEEK_CONFIG.provider;
}

function readBooleanFlag(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Validate untrusted (persisted) config and merge it over the defaults. */
export function parseDeepSeekConfig(value: unknown): DeepSeekConfig {
  if (!isRecord(value)) {
    return { ...DEFAULT_DEEPSEEK_CONFIG };
  }
  return {
    provider: readProvider(value),
    fallbackToDeepSeek: readBooleanFlag(value, 'fallbackToDeepSeek', DEFAULT_DEEPSEEK_CONFIG.fallbackToDeepSeek),
    typesafeBaseUrl: readString(value, 'typesafeBaseUrl', DEFAULT_DEEPSEEK_CONFIG.typesafeBaseUrl),
    typesafeModel: readString(value, 'typesafeModel', DEFAULT_DEEPSEEK_CONFIG.typesafeModel),
    typesafeApiKey: '',
    mode: readMode(value),
    proxyBaseUrl: readString(value, 'proxyBaseUrl', DEFAULT_DEEPSEEK_CONFIG.proxyBaseUrl),
    directBaseUrl: readString(value, 'directBaseUrl', DEFAULT_DEEPSEEK_CONFIG.directBaseUrl),
    model: readString(value, 'model', DEFAULT_DEEPSEEK_CONFIG.model),
    apiKey: '',
    batchSize: Math.round(readNumber(value, 'batchSize', DEFAULT_DEEPSEEK_CONFIG.batchSize, MIN_CLASSIFY_BATCH_SIZE, MAX_CLASSIFY_BATCH_SIZE)),
    requestTimeoutMs: Math.round(readNumber(value, 'requestTimeoutMs', DEFAULT_DEEPSEEK_CONFIG.requestTimeoutMs, 1000, 120000)),
    maxRetries: Math.round(readNumber(value, 'maxRetries', DEFAULT_DEEPSEEK_CONFIG.maxRetries, 0, 5)),
    includeProfilePhotos: readBooleanFlag(value, 'includeProfilePhotos', DEFAULT_DEEPSEEK_CONFIG.includeProfilePhotos),
    visionModel: readString(value, 'visionModel', DEFAULT_DEEPSEEK_CONFIG.visionModel).trim(),
    relayMode: readRelayMode(value),
    relayUrl: readString(value, 'relayUrl', DEFAULT_DEEPSEEK_CONFIG.relayUrl).trim(),
  };
}

/** Config shape safe to persist: the API key is stripped. */
export type PersistedDeepSeekConfig = Omit<DeepSeekConfig, 'apiKey' | 'typesafeApiKey'>;

export function sanitizeConfigForStorage(config: DeepSeekConfig): PersistedDeepSeekConfig {
  return {
    provider: config.provider,
    fallbackToDeepSeek: config.fallbackToDeepSeek,
    typesafeBaseUrl: config.typesafeBaseUrl,
    typesafeModel: config.typesafeModel,
    mode: config.mode,
    proxyBaseUrl: config.proxyBaseUrl,
    directBaseUrl: config.directBaseUrl,
    model: config.model,
    batchSize: config.batchSize,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    includeProfilePhotos: config.includeProfilePhotos,
    visionModel: config.visionModel,
    relayMode: config.relayMode,
    relayUrl: config.relayUrl,
  };
}

export function loadPersistedDeepSeekConfig(): DeepSeekConfig {
  try {
    const raw = localStorage.getItem(DEEPSEEK_CONFIG_STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_DEEPSEEK_CONFIG };
    }
    return parseDeepSeekConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DEEPSEEK_CONFIG };
  }
}

export function loadDeepSeekApiKey(): string {
  try {
    return sessionStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

export function loadTypeSafeApiKey(): string {
  try {
    return sessionStorage.getItem(TYPESAFE_API_KEY_SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

function hasStoredDeepSeekConfig(): boolean {
  try {
    return localStorage.getItem(DEEPSEEK_CONFIG_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Apply build-time embedded provider keys to a loaded config.
 *
 * Rules:
 *  - normal/public build embeds no keys -> config unchanged (users configure
 *    their own credentials in the GitHub Pages deployment);
 *  - local keyed build with no saved settings -> TypeSafe Jev primary with the
 *    embedded key, DeepSeek embedded as fallback, zero setup needed;
 *  - explicit saved preferences are respected; embedded keys only fill blanks.
 */
export function applyEmbeddedKeys(
  config: DeepSeekConfig,
  embedded: { readonly typesafeKey: string; readonly deepseekKey: string },
  hasStoredConfig: boolean,
): DeepSeekConfig {
  const typesafeKey = embedded.typesafeKey.trim();
  const deepseekKey = embedded.deepseekKey.trim();
  if (typesafeKey === '' && deepseekKey === '') {
    return config;
  }
  if (!hasStoredConfig) {
    const next: DeepSeekConfig = { ...config };
    if (typesafeKey !== '') {
      return {
        ...next,
        provider: 'typesafe',
        fallbackToDeepSeek: deepseekKey !== '',
        typesafeApiKey: typesafeKey,
        mode: 'direct',
        apiKey: deepseekKey,
      };
    }
    return {
      ...next,
      provider: 'deepseek',
      fallbackToDeepSeek: false,
      mode: 'direct',
      apiKey: deepseekKey,
    };
  }
  let next = config;
  if (typesafeKey !== '' && next.typesafeApiKey === '') {
    next = { ...next, typesafeApiKey: typesafeKey };
  }
  if (deepseekKey !== '' && next.mode === 'direct' && next.apiKey === '') {
    next = { ...next, apiKey: deepseekKey };
  }
  return next;
}

/** Back-compat helper for the DeepSeek-only embedded key (unit-tested). */
export function applyEmbeddedKey(
  config: DeepSeekConfig,
  embeddedKey: string,
  hasStoredConfig: boolean,
): DeepSeekConfig {
  return applyEmbeddedKeys(config, { typesafeKey: '', deepseekKey: embeddedKey }, hasStoredConfig);
}

export function loadDeepSeekConfig(): DeepSeekConfig {
  const storedConfig: DeepSeekConfig = {
    ...loadPersistedDeepSeekConfig(),
    apiKey: loadDeepSeekApiKey(),
    typesafeApiKey: loadTypeSafeApiKey(),
  };
  return applyEmbeddedKeys(
    storedConfig,
    { typesafeKey: EMBEDDED_TYPESAFE_API_KEY, deepseekKey: EMBEDDED_DEEPSEEK_API_KEY },
    hasStoredDeepSeekConfig(),
  );
}

export function saveDeepSeekApiKey(apiKey: string): void {
  try {
    if (apiKey === '') {
      sessionStorage.removeItem(DEEPSEEK_API_KEY_SESSION_KEY);
    } else {
      sessionStorage.setItem(DEEPSEEK_API_KEY_SESSION_KEY, apiKey);
    }
  } catch {
    // sessionStorage can be unavailable (privacy mode); the key then lives in memory only.
  }
}

export function saveTypeSafeApiKey(apiKey: string): void {
  try {
    if (apiKey === '') {
      sessionStorage.removeItem(TYPESAFE_API_KEY_SESSION_KEY);
    } else {
      sessionStorage.setItem(TYPESAFE_API_KEY_SESSION_KEY, apiKey);
    }
  } catch {
    // Session storage can be unavailable; the key then lives in memory only.
  }
}

export function saveDeepSeekConfig(config: DeepSeekConfig): void {
  try {
    localStorage.setItem(DEEPSEEK_CONFIG_STORAGE_KEY, JSON.stringify(sanitizeConfigForStorage(config)));
  } catch {
    // Ignore storage failures; the in-memory config still works for this session.
  }
  // Keys compiled into the local keyed build are never copied into storage;
  // browser-entered keys are only kept while the matching provider is selected.
  const typeSafeKeyIsEmbedded = HAS_EMBEDDED_TYPESAFE_KEY && config.typesafeApiKey === EMBEDDED_TYPESAFE_API_KEY;
  const deepseekKeyIsEmbedded = HAS_EMBEDDED_DEEPSEEK_KEY && config.apiKey === EMBEDDED_DEEPSEEK_API_KEY;
  saveTypeSafeApiKey(config.provider === 'typesafe' && !typeSafeKeyIsEmbedded ? config.typesafeApiKey : '');
  saveDeepSeekApiKey(config.mode === 'direct' && !deepseekKeyIsEmbedded ? config.apiKey : '');
}

export function clearDeepSeekConfig(): void {
  try {
    localStorage.removeItem(DEEPSEEK_CONFIG_STORAGE_KEY);
    sessionStorage.removeItem(DEEPSEEK_API_KEY_SESSION_KEY);
    sessionStorage.removeItem(TYPESAFE_API_KEY_SESSION_KEY);
  } catch {
    // Ignore.
  }
}
