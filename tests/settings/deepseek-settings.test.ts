import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEmbeddedKey,
  applyEmbeddedKeys,
  clearDeepSeekConfig,
  loadDeepSeekApiKey,
  loadDeepSeekConfig,
  loadPersistedDeepSeekConfig,
  loadTypeSafeApiKey,
  parseDeepSeekConfig,
  sanitizeConfigForStorage,
  saveDeepSeekApiKey,
  saveDeepSeekConfig,
  saveTypeSafeApiKey,
} from '../../src/utils/deepseek-settings';
import {
  DEFAULT_DEEPSEEK_CONFIG,
  DEEPSEEK_API_KEY_SESSION_KEY,
  DEEPSEEK_CONFIG_STORAGE_KEY,
  EMBEDDED_DEEPSEEK_API_KEY,
  EMBEDDED_TYPESAFE_API_KEY,
  HAS_EMBEDDED_DEEPSEEK_KEY,
  HAS_EMBEDDED_TYPESAFE_KEY,
  TYPESAFE_API_KEY_SESSION_KEY,
} from '../../src/model/deepseek-config';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('embedded provider keys (public build)', () => {
  it('ships no embedded keys in the normal/public build', () => {
    expect(EMBEDDED_TYPESAFE_API_KEY).toBe('');
    expect(EMBEDDED_DEEPSEEK_API_KEY).toBe('');
    expect(HAS_EMBEDDED_TYPESAFE_KEY).toBe(false);
    expect(HAS_EMBEDDED_DEEPSEEK_KEY).toBe(false);
  });

  it('keeps the two embedded-key flags independent', () => {
    const typesafeKey = 'apikey_typesafe_build_key';
    const deepseekKey = 'sk-deepseek-build-key';
    const both = applyEmbeddedKeys(
      { ...DEFAULT_DEEPSEEK_CONFIG, mode: 'proxy', provider: 'typesafe' },
      { typesafeKey, deepseekKey },
      false,
    );
    expect(both.provider).toBe('typesafe');
    expect(both.typesafeApiKey).toBe(typesafeKey);
    expect(both.apiKey).toBe(deepseekKey);
    expect(both.fallbackToDeepSeek).toBe(true);
    expect(both.mode).toBe('direct');
  });
});

describe('applyEmbeddedKeys (local keyed build)', () => {
  it('leaves the config untouched when the build embeds no keys', () => {
    const config = { ...DEFAULT_DEEPSEEK_CONFIG, mode: 'proxy' as const };
    expect(applyEmbeddedKeys(config, { typesafeKey: '', deepseekKey: '' }, false)).toBe(config);
    expect(applyEmbeddedKeys(config, { typesafeKey: '   ', deepseekKey: '  ' }, true)).toEqual(config);
  });

  it('enables TypeSafe Jev with the DeepSeek fallback on a fresh profile', () => {
    const merged = applyEmbeddedKeys(
      { ...DEFAULT_DEEPSEEK_CONFIG },
      { typesafeKey: 'apikey_embedded_ts', deepseekKey: 'sk-embedded-ds' },
      false,
    );
    expect(merged.provider).toBe('typesafe');
    expect(merged.fallbackToDeepSeek).toBe(true);
    expect(merged.typesafeApiKey).toBe('apikey_embedded_ts');
    expect(merged.apiKey).toBe('sk-embedded-ds');
    expect(merged.mode).toBe('direct');
    expect(merged.typesafeBaseUrl).toBe(DEFAULT_DEEPSEEK_CONFIG.typesafeBaseUrl);
    expect(merged.typesafeModel).toBe(DEFAULT_DEEPSEEK_CONFIG.typesafeModel);
  });

  it('enables the DeepSeek provider alone when only its key is embedded', () => {
    const merged = applyEmbeddedKeys(
      { ...DEFAULT_DEEPSEEK_CONFIG },
      { typesafeKey: '', deepseekKey: 'sk-embedded-ds' },
      false,
    );
    expect(merged.provider).toBe('deepseek');
    expect(merged.fallbackToDeepSeek).toBe(false);
    expect(merged.mode).toBe('direct');
    expect(merged.apiKey).toBe('sk-embedded-ds');
    expect(merged.typesafeApiKey).toBe('');
  });

  it('enables TypeSafe alone (no fallback) when only its key is embedded', () => {
    const merged = applyEmbeddedKeys(
      { ...DEFAULT_DEEPSEEK_CONFIG },
      { typesafeKey: 'apikey_embedded_ts', deepseekKey: '' },
      false,
    );
    expect(merged.provider).toBe('typesafe');
    expect(merged.fallbackToDeepSeek).toBe(false);
    expect(merged.mode).toBe('direct');
    expect(merged.typesafeApiKey).toBe('apikey_embedded_ts');
    expect(merged.apiKey).toBe('');
  });

  it('fills a blank TypeSafe key in saved settings without changing saved preferences', () => {
    const saved = {
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'typesafe' as const,
      fallbackToDeepSeek: false,
      mode: 'proxy' as const,
      typesafeApiKey: '',
    };
    const merged = applyEmbeddedKeys(saved, { typesafeKey: 'apikey_embedded_ts', deepseekKey: 'sk-embedded-ds' }, true);
    expect(merged.provider).toBe('typesafe');
    expect(merged.fallbackToDeepSeek).toBe(false);
    expect(merged.mode).toBe('proxy');
    expect(merged.typesafeApiKey).toBe('apikey_embedded_ts');
    // A proxy-mode profile never needs a browser-side DeepSeek key.
    expect(merged.apiKey).toBe('');
  });

  it('fills a blank DeepSeek key for a saved direct-mode profile', () => {
    const saved = {
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'deepseek' as const,
      mode: 'direct' as const,
      apiKey: '',
      typesafeApiKey: '',
    };
    const merged = applyEmbeddedKeys(saved, { typesafeKey: '', deepseekKey: 'sk-embedded-ds' }, true);
    expect(merged.provider).toBe('deepseek');
    expect(merged.mode).toBe('direct');
    expect(merged.apiKey).toBe('sk-embedded-ds');
  });

  it('never overwrites keys the user entered', () => {
    const saved = {
      ...DEFAULT_DEEPSEEK_CONFIG,
      mode: 'direct' as const,
      apiKey: 'sk-user',
      typesafeApiKey: 'apikey_user',
    };
    const merged = applyEmbeddedKeys(saved, { typesafeKey: 'apikey_embedded_ts', deepseekKey: 'sk-embedded-ds' }, true);
    expect(merged.apiKey).toBe('sk-user');
    expect(merged.typesafeApiKey).toBe('apikey_user');
  });

  it('trims embedded keys before applying them', () => {
    const merged = applyEmbeddedKeys(
      { ...DEFAULT_DEEPSEEK_CONFIG },
      { typesafeKey: '  apikey_embedded_ts  ', deepseekKey: '  sk-embedded-ds  ' },
      false,
    );
    expect(merged.typesafeApiKey).toBe('apikey_embedded_ts');
    expect(merged.apiKey).toBe('sk-embedded-ds');
  });
});

describe('applyEmbeddedKey (legacy DeepSeek-only helper)', () => {
  it('leaves the config untouched when the build has no embedded key', () => {
    const config = { ...DEFAULT_DEEPSEEK_CONFIG, mode: 'proxy' as const };
    expect(applyEmbeddedKey(config, '', false)).toBe(config);
    expect(applyEmbeddedKey(config, '   ', true)).toEqual(config);
  });

  it('defaults to the DeepSeek provider in direct mode on a fresh profile', () => {
    const merged = applyEmbeddedKey({ ...DEFAULT_DEEPSEEK_CONFIG }, 'sk-embedded', false);
    expect(merged.mode).toBe('direct');
    expect(merged.provider).toBe('deepseek');
    expect(merged.fallbackToDeepSeek).toBe(false);
    expect(merged.apiKey).toBe('sk-embedded');
  });

  it('resumes direct mode with the embedded key when a saved direct config has no key', () => {
    const merged = applyEmbeddedKey({ ...DEFAULT_DEEPSEEK_CONFIG, mode: 'direct', apiKey: '' }, 'sk-embedded', true);
    expect(merged.mode).toBe('direct');
    expect(merged.apiKey).toBe('sk-embedded');
  });

  it('keeps a user-entered direct key over the embedded one', () => {
    const merged = applyEmbeddedKey(
      { ...DEFAULT_DEEPSEEK_CONFIG, mode: 'direct', apiKey: 'sk-user' },
      'sk-embedded',
      true,
    );
    expect(merged.apiKey).toBe('sk-user');
  });

  it('respects an explicit saved proxy/demo preference', () => {
    const proxy = applyEmbeddedKey({ ...DEFAULT_DEEPSEEK_CONFIG, mode: 'proxy', apiKey: '' }, 'sk-embedded', true);
    expect(proxy.mode).toBe('proxy');
    expect(proxy.apiKey).toBe('');
    const demo = applyEmbeddedKey({ ...DEFAULT_DEEPSEEK_CONFIG, mode: 'demo', apiKey: '' }, 'sk-embedded', true);
    expect(demo.mode).toBe('demo');
  });
});

describe('parseDeepSeekConfig', () => {
  it('returns defaults (with empty keys) for non-object input', () => {
    expect(parseDeepSeekConfig(null)).toEqual({ ...DEFAULT_DEEPSEEK_CONFIG, apiKey: '', typesafeApiKey: '' });
    expect(parseDeepSeekConfig('nope')).toEqual({ ...DEFAULT_DEEPSEEK_CONFIG, apiKey: '', typesafeApiKey: '' });
    expect(parseDeepSeekConfig([1, 2, 3])).toEqual({ ...DEFAULT_DEEPSEEK_CONFIG, apiKey: '', typesafeApiKey: '' });
  });

  it('keeps valid provider, fallback, TypeSafe and DeepSeek transport values', () => {
    const parsed = parseDeepSeekConfig({
      provider: 'deepseek',
      fallbackToDeepSeek: false,
      typesafeBaseUrl: 'https://typesafe.example',
      typesafeModel: 'jev-mini',
      mode: 'direct',
      proxyBaseUrl: 'http://localhost:9999',
      directBaseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      batchSize: 10,
      requestTimeoutMs: 5000,
      maxRetries: 1,
    });
    expect(parsed.provider).toBe('deepseek');
    expect(parsed.fallbackToDeepSeek).toBe(false);
    expect(parsed.typesafeBaseUrl).toBe('https://typesafe.example');
    expect(parsed.typesafeModel).toBe('jev-mini');
    expect(parsed.mode).toBe('direct');
    expect(parsed.model).toBe('deepseek-reasoner');
    expect(parsed.batchSize).toBe(10);
  });

  it('drops both untrusted API keys from persisted data', () => {
    const parsed = parseDeepSeekConfig({
      apiKey: 'sk-should-be-dropped',
      typesafeApiKey: 'apikey_should_be_dropped',
    });
    expect(parsed.apiKey).toBe('');
    expect(parsed.typesafeApiKey).toBe('');
  });

  it('rejects unknown providers and modes', () => {
    expect(parseDeepSeekConfig({ provider: 'hacked' }).provider).toBe(DEFAULT_DEEPSEEK_CONFIG.provider);
    expect(parseDeepSeekConfig({ mode: 'hacked' }).mode).toBe(DEFAULT_DEEPSEEK_CONFIG.mode);
    expect(parseDeepSeekConfig({ fallbackToDeepSeek: 'yes' }).fallbackToDeepSeek).toBe(
      DEFAULT_DEEPSEEK_CONFIG.fallbackToDeepSeek,
    );
  });

  it('clamps numeric ranges', () => {
    const parsed = parseDeepSeekConfig({ batchSize: 0, requestTimeoutMs: 1, maxRetries: 99 });
    expect(parsed.batchSize).toBe(1);
    expect(parsed.requestTimeoutMs).toBe(1000);
    expect(parsed.maxRetries).toBe(5);
  });

  it('ignores non-numeric numerics', () => {
    const parsed = parseDeepSeekConfig({ batchSize: 'lots', requestTimeoutMs: NaN, maxRetries: {} });
    expect(parsed.batchSize).toBe(DEFAULT_DEEPSEEK_CONFIG.batchSize);
    expect(parsed.requestTimeoutMs).toBe(DEFAULT_DEEPSEEK_CONFIG.requestTimeoutMs);
    expect(parsed.maxRetries).toBe(DEFAULT_DEEPSEEK_CONFIG.maxRetries);
  });
});

describe('save/load persistence', () => {
  it('never persists either API key to localStorage', () => {
    saveDeepSeekConfig({
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'typesafe',
      mode: 'direct',
      typesafeApiKey: 'apikey-secret',
      apiKey: 'sk-secret',
    });
    const raw = localStorage.getItem(DEEPSEEK_CONFIG_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('apikey-secret');
    expect(raw).not.toContain('sk-secret');
    const persisted = JSON.parse(raw);
    expect(persisted.apiKey).toBeUndefined();
    expect(persisted.typesafeApiKey).toBeUndefined();
    // The session keys live in sessionStorage, never localStorage.
    expect(localStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(TYPESAFE_API_KEY_SESSION_KEY)).toBeNull();
  });

  it('persists provider/fallback/TypeSafe settings to localStorage', () => {
    saveDeepSeekConfig({
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'deepseek',
      fallbackToDeepSeek: false,
      typesafeModel: 'jev-mini',
      typesafeBaseUrl: 'https://typesafe.example',
    });
    const stored = loadPersistedDeepSeekConfig();
    expect(stored.provider).toBe('deepseek');
    expect(stored.fallbackToDeepSeek).toBe(false);
    expect(stored.typesafeModel).toBe('jev-mini');
    expect(stored.typesafeBaseUrl).toBe('https://typesafe.example');
  });

  it('keeps the TypeSafe key in sessionStorage only while TypeSafe is selected', () => {
    saveDeepSeekConfig({
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'typesafe',
      mode: 'proxy',
      typesafeApiKey: 'apikey-ts',
    });
    expect(sessionStorage.getItem(TYPESAFE_API_KEY_SESSION_KEY)).toBe('apikey-ts');
    expect(sessionStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY)).toBeNull();
  });

  it('keeps a direct-mode DeepSeek fallback key in sessionStorage', () => {
    saveDeepSeekConfig({
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'typesafe',
      fallbackToDeepSeek: true,
      mode: 'direct',
      typesafeApiKey: 'apikey-ts',
      apiKey: 'sk-deepseek',
    });
    expect(sessionStorage.getItem(TYPESAFE_API_KEY_SESSION_KEY)).toBe('apikey-ts');
    expect(sessionStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY)).toBe('sk-deepseek');
  });

  it('drops the TypeSafe key when another provider is saved', () => {
    saveTypeSafeApiKey('apikey-leftover');
    saveDeepSeekConfig({ ...DEFAULT_DEEPSEEK_CONFIG, provider: 'deepseek', mode: 'direct', apiKey: 'sk-ds' });
    expect(sessionStorage.getItem(TYPESAFE_API_KEY_SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY)).toBe('sk-ds');
  });

  it('drops a stale browser-side DeepSeek key when proxy or demo mode is saved', () => {
    saveDeepSeekApiKey('sk-leftover');
    saveDeepSeekConfig({ ...DEFAULT_DEEPSEEK_CONFIG, provider: 'deepseek', mode: 'proxy', apiKey: 'sk-leftover' });
    expect(sessionStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY)).toBeNull();
    saveDeepSeekApiKey('sk-leftover-2');
    saveDeepSeekConfig({ ...DEFAULT_DEEPSEEK_CONFIG, mode: 'demo', apiKey: 'sk-leftover-2' });
    expect(sessionStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY)).toBeNull();
  });

  it('round-trips a saved config including both session keys', () => {
    const config = {
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'typesafe' as const,
      fallbackToDeepSeek: true,
      mode: 'direct' as const,
      model: 'deepseek-reasoner',
      apiKey: 'sk-live',
      typesafeApiKey: 'apikey-live',
      batchSize: 12,
    };
    saveDeepSeekConfig(config);
    expect(loadDeepSeekConfig()).toEqual(config);
    expect(loadDeepSeekApiKey()).toBe('sk-live');
    expect(loadTypeSafeApiKey()).toBe('apikey-live');
  });

  it('round-trips a proxy-mode config without any browser-side keys', () => {
    const config = { ...DEFAULT_DEEPSEEK_CONFIG, provider: 'typesafe' as const, mode: 'proxy' as const };
    saveDeepSeekConfig(config);
    expect(loadDeepSeekConfig()).toEqual(config);
    expect(loadDeepSeekApiKey()).toBe('');
    expect(loadTypeSafeApiKey()).toBe('');
  });

  it('returns defaults when nothing was saved', () => {
    expect(loadDeepSeekConfig()).toEqual(DEFAULT_DEEPSEEK_CONFIG);
    expect(loadPersistedDeepSeekConfig()).toEqual(DEFAULT_DEEPSEEK_CONFIG);
    expect(loadTypeSafeApiKey()).toBe('');
  });

  it('survives corrupt JSON', () => {
    localStorage.setItem(DEEPSEEK_CONFIG_STORAGE_KEY, '{not json');
    expect(loadDeepSeekConfig()).toEqual(DEFAULT_DEEPSEEK_CONFIG);
  });

  it('saves and clears the TypeSafe session key', () => {
    saveTypeSafeApiKey('apikey-1');
    expect(loadTypeSafeApiKey()).toBe('apikey-1');
    saveTypeSafeApiKey('');
    expect(loadTypeSafeApiKey()).toBe('');
    expect(sessionStorage.getItem(TYPESAFE_API_KEY_SESSION_KEY)).toBeNull();
  });

  it('clears both storages and both provider keys', () => {
    saveDeepSeekConfig({
      ...DEFAULT_DEEPSEEK_CONFIG,
      provider: 'typesafe',
      mode: 'direct',
      typesafeApiKey: 'apikey-x',
      apiKey: 'sk-x',
    });
    clearDeepSeekConfig();
    expect(localStorage.getItem(DEEPSEEK_CONFIG_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(DEEPSEEK_API_KEY_SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(TYPESAFE_API_KEY_SESSION_KEY)).toBeNull();
    expect(loadDeepSeekConfig()).toEqual(DEFAULT_DEEPSEEK_CONFIG);
  });

  it('sanitizeConfigForStorage strips both API keys but keeps everything else', () => {
    const sanitized = sanitizeConfigForStorage({
      ...DEFAULT_DEEPSEEK_CONFIG,
      apiKey: 'sk-x',
      typesafeApiKey: 'apikey-x',
      model: 'm',
      typesafeModel: 'tm',
      provider: 'deepseek',
      fallbackToDeepSeek: false,
    });
    expect(sanitized).toEqual({
      provider: 'deepseek',
      fallbackToDeepSeek: false,
      typesafeBaseUrl: DEFAULT_DEEPSEEK_CONFIG.typesafeBaseUrl,
      typesafeModel: 'tm',
      mode: DEFAULT_DEEPSEEK_CONFIG.mode,
      proxyBaseUrl: DEFAULT_DEEPSEEK_CONFIG.proxyBaseUrl,
      directBaseUrl: DEFAULT_DEEPSEEK_CONFIG.directBaseUrl,
      model: 'm',
      batchSize: DEFAULT_DEEPSEEK_CONFIG.batchSize,
      requestTimeoutMs: DEFAULT_DEEPSEEK_CONFIG.requestTimeoutMs,
      maxRetries: DEFAULT_DEEPSEEK_CONFIG.maxRetries,
      includeProfilePhotos: DEFAULT_DEEPSEEK_CONFIG.includeProfilePhotos,
      visionModel: DEFAULT_DEEPSEEK_CONFIG.visionModel,
      relayMode: DEFAULT_DEEPSEEK_CONFIG.relayMode,
      relayUrl: DEFAULT_DEEPSEEK_CONFIG.relayUrl,
    });
    expect('apiKey' in sanitized).toBe(false);
    expect('typesafeApiKey' in sanitized).toBe(false);
  });
});
