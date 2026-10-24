import React, { useState } from 'react';
import {
  ClassifierProvider,
  ClassifierRelayMode,
  DEFAULT_DEEPSEEK_CONFIG,
  DeepSeekConfig,
  GenderProviderMode,
  MAX_CLASSIFY_BATCH_SIZE,
  MIN_CLASSIFY_BATCH_SIZE,
} from '../model/deepseek-config';
import { Timings } from '../model/timings';
import { UserNode } from '../model/user';
import { Language, t } from '../utils/i18n';
import { WhitelistManager } from './WhitelistManager';
import { WarningIcon } from './icons/WarningIcon';

/** Result of a connection probe, injected by App (no network code in the UI). */
export interface DeepSeekConnectionTestResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface SettingMenuProps {
  readonly lang: Language;
  readonly onClose: () => void;
  readonly onLanguageChange: (lang: Language) => void;
  readonly timings: Timings;
  readonly onSaveTimings: (timings: Timings) => void;
  readonly deepSeekConfig: DeepSeekConfig;
  readonly onSaveDeepSeekConfig: (config: DeepSeekConfig) => void;
  /**
   * Injected connection probe, e.g. App's `testDeepSeekConnection(config)`.
   * The component itself never imports the classifier or performs network I/O.
   */
  readonly onTestConnection: (config: DeepSeekConfig) => Promise<DeepSeekConnectionTestResult>;
  readonly whitelistedUsers: readonly UserNode[];
  readonly onWhitelistUpdate: (users: readonly UserNode[]) => void;
}

interface TimingField {
  readonly key: 'timeBetweenSearchCycles' | 'timeToWaitAfterFiveSearchCycles' | 'timeBetweenUnfollows' | 'timeToWaitAfterFiveUnfollows' | 'usersPerSearchCycle';
  readonly labelKey:
    | 'timeBetweenSearchCycles'
    | 'timeToWaitAfterFiveCycles'
    | 'timeBetweenUnfollows'
    | 'timeToWaitAfterFiveUnfollows'
    | 'usersPerSearchCycle';
  readonly min: number;
  readonly max: number;
}

const TIMING_FIELDS: readonly TimingField[] = [
  { key: 'timeBetweenSearchCycles', labelKey: 'timeBetweenSearchCycles', min: 500, max: 999999 },
  { key: 'timeToWaitAfterFiveSearchCycles', labelKey: 'timeToWaitAfterFiveCycles', min: 4000, max: 999999 },
  { key: 'timeBetweenUnfollows', labelKey: 'timeBetweenUnfollows', min: 1000, max: 999999 },
  { key: 'timeToWaitAfterFiveUnfollows', labelKey: 'timeToWaitAfterFiveUnfollows', min: 70000, max: 999999 },
  { key: 'usersPerSearchCycle', labelKey: 'usersPerSearchCycle', min: 1, max: 200 },
];

interface DeepSeekDraft {
  readonly provider: ClassifierProvider;
  readonly relayMode: ClassifierRelayMode;
  readonly relayUrl: string;
  readonly includeProfilePhotos: boolean;
  readonly visionModel: string;
  readonly fallbackToDeepSeek: boolean;
  readonly typesafeBaseUrl: string;
  readonly typesafeModel: string;
  readonly typesafeApiKey: string;
  readonly mode: GenderProviderMode;
  readonly proxyBaseUrl: string;
  readonly directBaseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly batchSize: string;
  readonly requestTimeoutMs: string;
  readonly maxRetries: string;
}

type ConnectionTestState =
  | { readonly status: 'idle' }
  | { readonly status: 'testing' }
  | { readonly status: 'done'; readonly ok: boolean; readonly message: string };

function integerValue(raw: string): number {
  if (raw.trim() === '') {
    return NaN;
  }
  const value = Number(raw);
  return isFinite(value) && Math.floor(value) === value ? value : NaN;
}

function isRelayUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function numericOr(raw: string, fallback: number): number {
  const value = integerValue(raw);
  return isFinite(value) ? value : fallback;
}

function draftFromConfig(config: DeepSeekConfig): DeepSeekDraft {
  return {
    provider: config.provider,
    relayMode: config.relayMode,
    relayUrl: config.relayUrl,
    includeProfilePhotos: config.includeProfilePhotos,
    visionModel: config.visionModel,
    fallbackToDeepSeek: config.fallbackToDeepSeek,
    typesafeBaseUrl: config.typesafeBaseUrl,
    typesafeModel: config.typesafeModel,
    typesafeApiKey: config.typesafeApiKey,
    mode: config.mode,
    proxyBaseUrl: config.proxyBaseUrl,
    directBaseUrl: config.directBaseUrl,
    model: config.model,
    apiKey: config.apiKey,
    batchSize: String(config.batchSize),
    requestTimeoutMs: String(config.requestTimeoutMs),
    maxRetries: String(config.maxRetries),
  };
}

/**
 * Settings modal: Instagram pacing timings plus the DeepSeek classifier
 * configuration and the protected-list manager.
 *
 * Values are edited locally and only handed to App on Save/Cancel; the
 * connection test is delegated to the injected `onTestConnection` callback so
 * no network code lives in the UI layer.
 */
export const SettingMenu = ({
  lang,
  onClose,
  onLanguageChange,
  timings,
  onSaveTimings,
  deepSeekConfig,
  onSaveDeepSeekConfig,
  onTestConnection,
  whitelistedUsers,
  onWhitelistUpdate,
}: SettingMenuProps) => {
  const [timingValues, setTimingValues] = useState<Record<TimingField['key'], string>>(() => ({
    timeBetweenSearchCycles: String(timings.timeBetweenSearchCycles),
    timeToWaitAfterFiveSearchCycles: String(timings.timeToWaitAfterFiveSearchCycles),
    timeBetweenUnfollows: String(timings.timeBetweenUnfollows),
    timeToWaitAfterFiveUnfollows: String(timings.timeToWaitAfterFiveUnfollows),
    usersPerSearchCycle: String(timings.usersPerSearchCycle === undefined ? 50 : timings.usersPerSearchCycle),
  }));
  const [draft, setDraft] = useState<DeepSeekDraft>(() => draftFromConfig(deepSeekConfig));
  const [showWhitelist, setShowWhitelist] = useState(false);
  const [testState, setTestState] = useState<ConnectionTestState>({ status: 'idle' });

  const timingErrors: Record<string, string | undefined> = {};
  for (const field of TIMING_FIELDS) {
    const parsed = integerValue(timingValues[field.key]);
    if (!isFinite(parsed) || parsed < field.min || parsed > field.max) {
      timingErrors[field.key] = t(lang, 'validationTimingRange', field.min, field.max);
    }
  }
  const timingsValid = TIMING_FIELDS.every(field => timingErrors[field.key] === undefined);

  const sharedErrors: Record<string, string | undefined> = {};
  {
    const batch = integerValue(draft.batchSize);
    if (!isFinite(batch) || batch < MIN_CLASSIFY_BATCH_SIZE || batch > MAX_CLASSIFY_BATCH_SIZE) {
      sharedErrors.batchSize = t(lang, 'validationTimingRange', MIN_CLASSIFY_BATCH_SIZE, MAX_CLASSIFY_BATCH_SIZE);
    }
    const retries = integerValue(draft.maxRetries);
    if (!isFinite(retries) || retries < 0 || retries > 5) {
      sharedErrors.maxRetries = t(lang, 'validationTimingRange', 0, 5);
    }
    const timeout = integerValue(draft.requestTimeoutMs);
    if (!isFinite(timeout) || timeout < 1000 || timeout > 120000) {
      sharedErrors.requestTimeoutMs = t(lang, 'validationTimingRange', 1000, 120000);
    }
  }

  const typeSafeErrors: Record<string, string | undefined> = {};
  const typeSafeInUse = draft.provider === 'typesafe' && draft.mode !== 'demo';
  if (typeSafeInUse) {
    if (!isHttpUrl(draft.typesafeBaseUrl)) {
      typeSafeErrors.typesafeBaseUrl = t(lang, 'validationTypeSafeUrl');
    }
    if (draft.typesafeModel.trim() === '') {
      typeSafeErrors.typesafeModel = t(lang, 'validationTypeSafeModel');
    }
  }

  if (draft.includeProfilePhotos && draft.visionModel.trim() === '') {
    typeSafeErrors.visionModel = t(lang, 'validationModel');
  }
  if (draft.relayMode !== 'direct' && !isRelayUrl(draft.relayUrl)) {
    typeSafeErrors.relayUrl = t(lang, 'validationRelayUrl');
  }

  const deepSeekInUse =
    draft.mode !== 'demo' &&
    (draft.provider === 'deepseek' || (draft.provider === 'typesafe' && draft.fallbackToDeepSeek));
  const deepSeekErrors: Record<string, string | undefined> = {};
  if (deepSeekInUse) {
    if (draft.model.trim() === '') {
      deepSeekErrors.model = t(lang, 'validationModel');
    }
    if (draft.mode === 'proxy' && !isHttpUrl(draft.proxyBaseUrl)) {
      deepSeekErrors.proxyBaseUrl = t(lang, 'validationUrl');
    }
    if (draft.mode === 'direct') {
      if (!isHttpUrl(draft.directBaseUrl)) {
        deepSeekErrors.directBaseUrl = t(lang, 'validationUrl');
      }
      if (draft.apiKey.trim() === '') {
        deepSeekErrors.apiKey = t(lang, 'validationApiKey');
      }
    }
  }
  const classifierValid =
    Object.keys(sharedErrors).length === 0 &&
    Object.keys(typeSafeErrors).length === 0 &&
    Object.keys(deepSeekErrors).length === 0;
  const formValid = timingsValid && classifierValid;

  const buildTimings = (): Timings => ({
    timeBetweenSearchCycles: Number(timingValues.timeBetweenSearchCycles),
    timeToWaitAfterFiveSearchCycles: Number(timingValues.timeToWaitAfterFiveSearchCycles),
    timeBetweenUnfollows: Number(timingValues.timeBetweenUnfollows),
    timeToWaitAfterFiveUnfollows: Number(timingValues.timeToWaitAfterFiveUnfollows),
    usersPerSearchCycle: Number(timingValues.usersPerSearchCycle),
  });

  const buildConfig = (): DeepSeekConfig => ({
    ...deepSeekConfig,
    provider: draft.provider,
    relayMode: draft.relayMode,
    relayUrl: draft.relayUrl.trim(),
    includeProfilePhotos: draft.includeProfilePhotos,
    visionModel: draft.visionModel.trim(),
    fallbackToDeepSeek: draft.fallbackToDeepSeek,
    typesafeBaseUrl: draft.typesafeBaseUrl.trim(),
    typesafeModel: draft.typesafeModel.trim(),
    typesafeApiKey: draft.typesafeApiKey,
    mode: draft.mode,
    proxyBaseUrl: draft.proxyBaseUrl.trim(),
    directBaseUrl: draft.directBaseUrl.trim(),
    model: draft.model.trim(),
    apiKey: draft.apiKey,
    batchSize: numericOr(draft.batchSize, DEFAULT_DEEPSEEK_CONFIG.batchSize),
    requestTimeoutMs: numericOr(draft.requestTimeoutMs, DEFAULT_DEEPSEEK_CONFIG.requestTimeoutMs),
    maxRetries: numericOr(draft.maxRetries, DEFAULT_DEEPSEEK_CONFIG.maxRetries),
  });

  const updateDraft = (patch: Partial<DeepSeekDraft>): void => {
    setDraft(current => ({ ...current, ...patch }));
    setTestState({ status: 'idle' });
  };

  const handleTestConnection = async (): Promise<void> => {
    if (!classifierValid) {
      return;
    }
    setTestState({ status: 'testing' });
    try {
      const result = await onTestConnection(buildConfig());
      setTestState({ status: 'done', ok: result.ok, message: result.message });
    } catch {
      setTestState({ status: 'done', ok: false, message: '' });
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!formValid) {
      return;
    }
    onSaveTimings(buildTimings());
    onSaveDeepSeekConfig(buildConfig());
    onClose();
  };

  return (
    <div className='wa-dialog-backdrop'>
      <form
        className='wa-dialog wa-dialog--settings'
        role='dialog'
        aria-modal='true'
        aria-labelledby='wa-settings-title'
        noValidate
        onSubmit={handleSubmit}
      >
        <header className='wa-dialog__header'>
          <h2 id='wa-settings-title'>{t(lang, 'settingsTitle')}</h2>
          <button type='button' className='wa-btn wa-btn--icon' aria-label={t(lang, 'close')} title={t(lang, 'close')} onClick={onClose}>
            &times;
          </button>
        </header>

        <div className='wa-settings__body'>
          <hr className='wa-settings__divider' />

          <section className='wa-settings__section' aria-labelledby='wa-settings-pacing'>
            <h3 id='wa-settings-pacing'>{t(lang, 'pacingSection')}</h3>
            <p className='wa-panel__meta'>{t(lang, 'pacingIntro')}</p>
            {TIMING_FIELDS.map(field => (
              <div className='wa-field' key={field.key}>
                <label className='wa-field__label' htmlFor={`wa-timing-${field.key}`}>
                  {t(lang, field.labelKey)}
                </label>
                <div className='wa-field__control'>
                  <input
                    id={`wa-timing-${field.key}`}
                    type='number'
                    className='wa-input'
                    min={field.min}
                    max={field.max}
                    value={timingValues[field.key]}
                    aria-invalid={timingErrors[field.key] !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      setTimingValues(current => ({ ...current, [field.key]: event.currentTarget.value }))
                    }
                  />
                  <span className='wa-field__unit'>
                    {field.key === 'usersPerSearchCycle' ? t(lang, 'unitAccounts') : t(lang, 'unitMs')}
                  </span>
                </div>
                {timingErrors[field.key] !== undefined && <span className='wa-field__error'>{timingErrors[field.key]}</span>}
              </div>
            ))}
            <label className='wa-field'>
              <span className='wa-field__label'>{t(lang, 'language')}</span>
              <select
                className='wa-select'
                aria-label={t(lang, 'language')}
                value={lang}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                  onLanguageChange(event.currentTarget.value === 'es' ? 'es' : 'en')
                }
              >
                <option value='en'>{t(lang, 'languageEnglish')}</option>
                <option value='es'>{t(lang, 'languageSpanish')}</option>
              </select>
            </label>
            <p className='wa-banner wa-banner--warning' role='note'>
              <WarningIcon />
              <span>
                <strong>{t(lang, 'warningPrefix')}</strong> {t(lang, 'timingsWarning')} {t(lang, 'settingsWarning2')}
              </span>
            </p>
          </section>

          <hr className='wa-settings__divider' />

          <section className='wa-settings__section' aria-labelledby='wa-settings-classifier'>
            <h3 id='wa-settings-classifier'>{t(lang, 'classifierSection')}</h3>
            <p className='wa-panel__meta'>{t(lang, 'classifierIntro')}</p>

            <label className='wa-field'>
              <span className='wa-field__label'>{t(lang, 'classifierProvider')}</span>
              <select
                id='wa-classifier-provider'
                className='wa-select'
                aria-label={t(lang, 'classifierProvider')}
                value={draft.provider}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                  const next = event.currentTarget.value;
                  updateDraft({
                    provider: next === 'deepseek' ? 'deepseek' : next === 'demo' ? 'demo' : 'typesafe',
                  });
                }}
              >
                <option value='typesafe'>{t(lang, 'providerTypeSafeOption')}</option>
                <option value='deepseek'>{t(lang, 'providerDeepSeekOption')}</option>
                <option value='demo'>{t(lang, 'providerDemoOption')}</option>
              </select>
            </label>

            {draft.provider === 'typesafe' && draft.mode !== 'demo' && (
              <>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-typesafe-api-key'>
                    {t(lang, 'typeSafeApiKeyLabel')}
                  </label>
                  <input
                    id='wa-typesafe-api-key'
                    type='password'
                    className='wa-input'
                    autoComplete='off'
                    placeholder={t(lang, 'typeSafeApiKeyPlaceholder')}
                    value={draft.typesafeApiKey}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      updateDraft({ typesafeApiKey: event.currentTarget.value })
                    }
                  />
                  <p className='wa-field__hint'>{t(lang, 'typeSafeKeySessionNote')}</p>
                </div>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-typesafe-model'>
                    {t(lang, 'typeSafeModelLabel')}
                  </label>
                  <input
                    id='wa-typesafe-model'
                    type='text'
                    className='wa-input'
                    value={draft.typesafeModel}
                    aria-invalid={typeSafeErrors.typesafeModel !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      updateDraft({ typesafeModel: event.currentTarget.value })
                    }
                  />
                  {typeSafeErrors.typesafeModel !== undefined && (
                    <span className='wa-field__error'>{typeSafeErrors.typesafeModel}</span>
                  )}
                </div>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-typesafe-base-url'>
                    {t(lang, 'typeSafeBaseUrlLabel')}
                  </label>
                  <input
                    id='wa-typesafe-base-url'
                    type='url'
                    className='wa-input'
                    value={draft.typesafeBaseUrl}
                    aria-invalid={typeSafeErrors.typesafeBaseUrl !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      updateDraft({ typesafeBaseUrl: event.currentTarget.value })
                    }
                  />
                  {typeSafeErrors.typesafeBaseUrl !== undefined && (
                    <span className='wa-field__error'>{typeSafeErrors.typesafeBaseUrl}</span>
                  )}
                </div>
                <label className='wa-checkbox'>
                  <input
                    id='wa-classifier-fallback'
                    type='checkbox'
                    checked={draft.fallbackToDeepSeek}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      updateDraft({ fallbackToDeepSeek: event.currentTarget.checked })
                    }
                  />
                  <span>{t(lang, 'fallbackToDeepSeekLabel')}</span>
                </label>
                <p className='wa-field__hint'>{t(lang, 'fallbackToDeepSeekHint')}</p>
              </>
            )}
            <label className='wa-checkbox'>
              <input
                type='checkbox'
                checked={draft.includeProfilePhotos}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  updateDraft({ includeProfilePhotos: event.currentTarget.checked })
                }
              />
              <span>{t(lang, 'includePhotosLabel')}</span>
            </label>
            <p className='wa-field__hint'>{t(lang, 'includePhotosHint')}</p>
            {draft.includeProfilePhotos && (
              <div className='wa-field'>
                <label className='wa-field__label' htmlFor='wa-vision-model'>
                  {t(lang, 'visionModelLabel')}
                </label>
                <input
                  id='wa-vision-model'
                  type='text'
                  className='wa-input'
                  value={draft.visionModel}
                  aria-invalid={typeSafeErrors.visionModel !== undefined}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ visionModel: event.currentTarget.value })}
                />
                {typeSafeErrors.visionModel !== undefined && <span className='wa-field__error'>{typeSafeErrors.visionModel}</span>}
              </div>
            )}

            <hr className='wa-settings__divider' />
            <h4 className='wa-settings__subtitle'>{t(lang, 'relayModeLabel')}</h4>
            <label className='wa-field'>
              <span className='wa-field__label'>{t(lang, 'relayModeLabel')}</span>
              <select
                className='wa-select'
                aria-label={t(lang, 'relayModeLabel')}
                value={draft.relayMode}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                  const next = event.currentTarget.value;
                  updateDraft({ relayMode: next === 'relay' ? 'relay' : next === 'direct' ? 'direct' : 'auto' });
                }}
              >
                <option value='auto'>{t(lang, 'relayAutoOption')}</option>
                <option value='relay'>{t(lang, 'relayRelayOption')}</option>
                <option value='direct'>{t(lang, 'relayDirectOption')}</option>
              </select>
            </label>
            {draft.relayMode !== 'direct' && (
              <div className='wa-field'>
                <label className='wa-field__label' htmlFor='wa-relay-url'>
                  {t(lang, 'relayUrlLabel')}
                </label>
                <input
                  id='wa-relay-url'
                  type='text'
                  className='wa-input'
                  value={draft.relayUrl}
                  aria-invalid={typeSafeErrors.relayUrl !== undefined}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ relayUrl: event.currentTarget.value })}
                />
                {typeSafeErrors.relayUrl !== undefined && <span className='wa-field__error'>{typeSafeErrors.relayUrl}</span>}
                <p className='wa-field__hint'>{t(lang, 'relayHint')}</p>
              </div>
            )}

            {draft.provider === 'deepseek' && draft.mode !== 'demo' && (
              <p className='wa-panel__meta'>{t(lang, 'deepseekIntro')}</p>
            )}
            {draft.provider === 'demo' && <p className='wa-panel__meta'>{t(lang, 'modeDemoNote')}</p>}
          </section>

          <hr className='wa-settings__divider' />

          <section className='wa-settings__section' aria-labelledby='wa-settings-deepseek'>
            <h3 id='wa-settings-deepseek'>{t(lang, 'deepseekSection')}</h3>
            <p className='wa-panel__meta'>{t(lang, 'deepseekIntro')}</p>

            <label className='wa-field'>
              <span className='wa-field__label'>{t(lang, 'deepseekMode')}</span>
              <select
                id='wa-deepseek-mode'
                className='wa-select'
                value={draft.mode}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                  const next = event.currentTarget.value;
                  updateDraft({ mode: next === 'direct' ? 'direct' : next === 'demo' ? 'demo' : 'proxy' });
                }}
              >
                <option value='proxy'>{t(lang, 'modeProxyOption')}</option>
                <option value='direct'>{t(lang, 'modeDirectOption')}</option>
                <option value='demo'>{t(lang, 'modeDemoOption')}</option>
              </select>
            </label>

            {draft.mode === 'proxy' && (
              <>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-deepseek-proxy'>
                    {t(lang, 'proxyBaseUrl')}
                  </label>
                  <input
                    id='wa-deepseek-proxy'
                    type='url'
                    className='wa-input'
                    value={draft.proxyBaseUrl}
                    aria-invalid={deepSeekErrors.proxyBaseUrl !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ proxyBaseUrl: event.currentTarget.value })}
                  />
                  {deepSeekErrors.proxyBaseUrl !== undefined && <span className='wa-field__error'>{deepSeekErrors.proxyBaseUrl}</span>}
                </div>
                <p className='wa-panel__meta'>{t(lang, 'proxyHint')}</p>
              </>
            )}

            {draft.mode === 'direct' && (
              <>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-deepseek-direct'>
                    {t(lang, 'directBaseUrl')}
                  </label>
                  <input
                    id='wa-deepseek-direct'
                    type='url'
                    className='wa-input'
                    value={draft.directBaseUrl}
                    aria-invalid={deepSeekErrors.directBaseUrl !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ directBaseUrl: event.currentTarget.value })}
                  />
                  {deepSeekErrors.directBaseUrl !== undefined && <span className='wa-field__error'>{deepSeekErrors.directBaseUrl}</span>}
                </div>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-deepseek-api-key'>
                    {t(lang, 'apiKeyLabel')}
                  </label>
                  <input
                    id='wa-deepseek-api-key'
                    type='password'
                    className='wa-input'
                    autoComplete='off'
                    placeholder={t(lang, 'apiKeyPlaceholder')}
                    value={draft.apiKey}
                    aria-invalid={deepSeekErrors.apiKey !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ apiKey: event.currentTarget.value })}
                  />
                  {deepSeekErrors.apiKey !== undefined && <span className='wa-field__error'>{deepSeekErrors.apiKey}</span>}
                  <p className='wa-field__hint'>{t(lang, 'apiKeySessionNote')}</p>
                </div>
                <p className='wa-banner wa-banner--warning'>
                  <WarningIcon />
                  <span>{t(lang, 'directModeWarning')}</span>
                </p>
              </>
            )}

            {draft.mode === 'demo' && <p className='wa-panel__meta'>{t(lang, 'modeDemoNote')}</p>}

            {draft.mode !== 'demo' && (
              <>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-deepseek-model'>
                    {t(lang, 'modelLabel')}
                  </label>
                  <input
                    id='wa-deepseek-model'
                    type='text'
                    className='wa-input'
                    value={draft.model}
                    aria-invalid={deepSeekErrors.model !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ model: event.currentTarget.value })}
                  />
                  {deepSeekErrors.model !== undefined && <span className='wa-field__error'>{deepSeekErrors.model}</span>}
                </div>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-deepseek-batch'>
                    {t(lang, 'batchSize')}
                  </label>
                  <input
                    id='wa-deepseek-batch'
                    type='number'
                    className='wa-input'
                    min={MIN_CLASSIFY_BATCH_SIZE}
                    max={MAX_CLASSIFY_BATCH_SIZE}
                    value={draft.batchSize}
                    aria-invalid={sharedErrors.batchSize !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ batchSize: event.currentTarget.value })}
                  />
                  {sharedErrors.batchSize !== undefined && <span className='wa-field__error'>{sharedErrors.batchSize}</span>}
                </div>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-deepseek-retries'>
                    {t(lang, 'maxRetries')}
                  </label>
                  <input
                    id='wa-deepseek-retries'
                    type='number'
                    className='wa-input'
                    min={0}
                    max={5}
                    value={draft.maxRetries}
                    aria-invalid={sharedErrors.maxRetries !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ maxRetries: event.currentTarget.value })}
                  />
                  {sharedErrors.maxRetries !== undefined && <span className='wa-field__error'>{sharedErrors.maxRetries}</span>}
                </div>
                <div className='wa-field'>
                  <label className='wa-field__label' htmlFor='wa-deepseek-timeout'>
                    {t(lang, 'requestTimeoutMs')}
                  </label>
                  <input
                    id='wa-deepseek-timeout'
                    type='number'
                    className='wa-input'
                    min={1000}
                    max={120000}
                    value={draft.requestTimeoutMs}
                    aria-invalid={sharedErrors.requestTimeoutMs !== undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => updateDraft({ requestTimeoutMs: event.currentTarget.value })}
                  />
                  {sharedErrors.requestTimeoutMs !== undefined && <span className='wa-field__error'>{sharedErrors.requestTimeoutMs}</span>}
                </div>

                <div className='wa-settings__test'>
                  <button
                    type='button'
                    className='wa-btn wa-btn--ghost'
                    onClick={handleTestConnection}
                    disabled={!classifierValid || testState.status === 'testing'}
                  >
                    {testState.status === 'testing' ? t(lang, 'testingConnection') : t(lang, 'testConnection')}
                  </button>
                  <span className='wa-panel__meta'>{t(lang, 'testConnectionHint')}</span>
                  {testState.status === 'done' && (
                    <span
                      className={`wa-test-result wa-test-result--${testState.ok ? 'ok' : 'error'}`}
                      role='status'
                    >
                      {testState.ok
                        ? t(lang, 'testConnectionOk', testState.message)
                        : testState.message === ''
                          ? t(lang, 'testConnectionUnexpected')
                          : t(lang, 'testConnectionFailed', testState.message)}
                    </span>
                  )}
                </div>
              </>
            )}
          </section>

          <hr className='wa-settings__divider' />

          <section className='wa-settings__section' aria-labelledby='wa-settings-whitelist'>
            <h3 id='wa-settings-whitelist'>{t(lang, 'whitelistSection')}</h3>
            <button
              type='button'
              className='wa-btn wa-btn--ghost'
              aria-expanded={showWhitelist}
              onClick={() => setShowWhitelist(!showWhitelist)}
            >
              {showWhitelist ? t(lang, 'hideWhitelist') : t(lang, 'manageWhitelist')}
            </button>
            {showWhitelist && (
              <WhitelistManager whitelistedUsers={whitelistedUsers} onWhitelistUpdate={onWhitelistUpdate} lang={lang} />
            )}
          </section>
        </div>

        <footer className='wa-dialog__actions'>
          <button type='button' className='wa-btn wa-btn--ghost' onClick={onClose}>
            {t(lang, 'cancel')}
          </button>
          <button type='submit' className='wa-btn wa-btn--primary' disabled={!formValid}>
            {t(lang, 'saveSettings')}
          </button>
        </footer>
      </form>
    </div>
  );
};
