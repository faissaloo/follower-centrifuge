import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
  DEFAULT_TIME_BETWEEN_UNFOLLOWS,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
  DEFAULT_USERS_PER_SEARCH_CYCLE,
} from '../../src/constants/constants';
import { DEFAULT_DEEPSEEK_CONFIG, DeepSeekConfig } from '../../src/model/deepseek-config';
import { Timings } from '../../src/model/timings';
import { SettingMenu, SettingMenuProps } from '../../src/components/SettingMenu';

afterEach(cleanup);

const TIMINGS: Timings = {
  timeBetweenSearchCycles: DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
  timeToWaitAfterFiveSearchCycles: DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
  timeBetweenUnfollows: DEFAULT_TIME_BETWEEN_UNFOLLOWS,
  timeToWaitAfterFiveUnfollows: DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
  usersPerSearchCycle: DEFAULT_USERS_PER_SEARCH_CYCLE,
};

function settingsProps(overrides: Partial<SettingMenuProps> = {}): SettingMenuProps {
  return {
    lang: 'en',
    onClose: vi.fn(),
    onLanguageChange: vi.fn(),
    timings: TIMINGS,
    onSaveTimings: vi.fn(),
    deepSeekConfig: DEFAULT_DEEPSEEK_CONFIG,
    onSaveDeepSeekConfig: vi.fn(),
    onTestConnection: vi.fn(async () => ({ ok: true, message: 'pong' })),
    whitelistedUsers: [],
    onWhitelistUpdate: vi.fn(),
    ...overrides,
  };
}

function renderSettings(overrides: Partial<SettingMenuProps> = {}) {
  const props = settingsProps(overrides);
  return render(<SettingMenu {...props} />);
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Save settings' });
}

function submitForm(): void {
  fireEvent.submit(screen.getByRole('dialog'));
}

describe('SettingMenu', () => {
  it('renders pacing and DeepSeek sections with the current values', () => {
    renderSettings();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Instagram pacing')).toBeTruthy();
    expect(screen.getByText('DeepSeek classifier (fallback / alternative)')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Time between list requests').value).toBe(
      String(DEFAULT_TIME_BETWEEN_SEARCH_CYCLES),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Accounts per request').value).toBe(
      String(DEFAULT_DEEPSEEK_CONFIG.batchSize),
    );
    expect(saveButton().disabled).toBe(false);
  });

  it('saves edited timings and config, then closes', () => {
    const onSaveTimings = vi.fn();
    const onSaveDeepSeekConfig = vi.fn();
    const onClose = vi.fn();
    renderSettings({ onSaveTimings, onSaveDeepSeekConfig, onClose });
    fireEvent.input(screen.getByLabelText('Time between list requests'), { target: { value: '2500' } });
    fireEvent.input(screen.getByLabelText('Accounts per request'), { target: { value: '10' } });
    submitForm();
    expect(onSaveTimings).toHaveBeenCalledTimes(1);
    expect(onSaveTimings.mock.calls[0][0].timeBetweenSearchCycles).toBe(2500);
    expect(onSaveDeepSeekConfig).toHaveBeenCalledTimes(1);
    expect(onSaveDeepSeekConfig.mock.calls[0][0].batchSize).toBe(10);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks saving and shows an error for an out-of-range timing', () => {
    const onSaveTimings = vi.fn();
    renderSettings({ onSaveTimings });
    fireEvent.input(screen.getByLabelText('Time between list requests'), { target: { value: '0' } });
    expect(screen.getByText('Use a value between 500 and 999999.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    submitForm();
    expect(onSaveTimings).not.toHaveBeenCalled();
  });

  it('shows proxy configuration by default and hides the API key', () => {
    renderSettings();
    expect(screen.getByLabelText('Proxy base URL')).toBeTruthy();
    expect(screen.queryByLabelText('DeepSeek API key')).toBeNull();
  });

  it('switches to direct mode: shows URL, API key and the session-only warning', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Connection mode'), { target: { value: 'direct' } });
    expect(screen.getByLabelText('DeepSeek API base URL')).toBeTruthy();
    const apiKey = screen.getByLabelText<HTMLInputElement>('DeepSeek API key');
    expect(apiKey.type).toBe('password');
    expect(screen.getByText(/never written to localStorage/)).toBeTruthy();
    expect(screen.getByText(/exposes your API key to the page/)).toBeTruthy();
  });

  it('requires an API key in direct mode', () => {
    const onSaveDeepSeekConfig = vi.fn();
    renderSettings({ onSaveDeepSeekConfig });
    fireEvent.change(screen.getByLabelText('Connection mode'), { target: { value: 'direct' } });
    expect(screen.getByText('Direct mode needs an API key.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    submitForm();
    expect(onSaveDeepSeekConfig).not.toHaveBeenCalled();
    fireEvent.input(screen.getByLabelText('DeepSeek API key'), { target: { value: 'sk-test' } });
    expect(saveButton().disabled).toBe(false);
    submitForm();
    expect(onSaveDeepSeekConfig.mock.calls[0][0].apiKey).toBe('sk-test');
  });

  it('validates the proxy URL', () => {
    renderSettings();
    fireEvent.input(screen.getByLabelText('Proxy base URL'), { target: { value: 'not-a-url' } });
    expect(screen.getByText('Enter a valid http(s) URL.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('validates the classification batch size range', () => {
    renderSettings();
    fireEvent.input(screen.getByLabelText('Accounts per request'), { target: { value: '500' } });
    expect(screen.getByText('Use a value between 1 and 50.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('hides transport fields in demo mode and explains the offline classifier', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Connection mode'), { target: { value: 'demo' } });
    expect(screen.getByText(/classifies names offline/)).toBeTruthy();
    expect(screen.queryByLabelText('Proxy base URL')).toBeNull();
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('tests the connection through the injected callback and shows success', async () => {
    const config = { ...DEFAULT_DEEPSEEK_CONFIG, proxyBaseUrl: 'http://127.0.0.1:9999' };
    const onTestConnection = vi.fn(async (_config: DeepSeekConfig) => ({ ok: true, message: 'pong' }));
    renderSettings({ deepSeekConfig: config, onTestConnection });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    const result = await screen.findByText('Connection OK: pong');
    expect(result.getAttribute('role')).toBe('status');
    expect(onTestConnection).toHaveBeenCalledTimes(1);
    expect(onTestConnection.mock.calls[0][0].proxyBaseUrl).toBe('http://127.0.0.1:9999');
  });

  it('shows a failure message when the connection test fails', async () => {
    const onTestConnection = vi.fn(async () => ({ ok: false, message: 'proxy unreachable' }));
    renderSettings({ onTestConnection });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection failed: proxy unreachable')).toBeTruthy();
  });

  it('handles a rejected connection test without crashing', async () => {
    const onTestConnection = vi.fn(async () => {
      throw new Error('boom');
    });
    renderSettings({ onTestConnection });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection failed: unexpected error.')).toBeTruthy();
  });

  it('disables the connection test while the config is invalid', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Connection mode'), { target: { value: 'direct' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Test connection' }).disabled).toBe(true);
  });

  it('closes without saving on cancel', () => {
    const onClose = vi.fn();
    const onSaveTimings = vi.fn();
    const onSaveDeepSeekConfig = vi.fn();
    renderSettings({ onClose, onSaveTimings, onSaveDeepSeekConfig });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaveTimings).not.toHaveBeenCalled();
    expect(onSaveDeepSeekConfig).not.toHaveBeenCalled();
  });

  it('configures TypeSafe Jev as the primary provider by default', () => {
    renderSettings();
    const provider = screen.getByLabelText<HTMLSelectElement>('Primary provider');
    expect(provider.value).toBe('typesafe');
    expect(screen.getByLabelText('TypeSafe API key')).toBeTruthy();
    expect(screen.getByLabelText('TypeSafe model')).toBeTruthy();
    expect(screen.getByLabelText('TypeSafe base URL')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Fall back to DeepSeek if Jev fails').checked).toBe(true);
  });

  it('saves the provider, fallback and TypeSafe fields', () => {
    const onSaveDeepSeekConfig = vi.fn();
    renderSettings({ onSaveDeepSeekConfig });
    fireEvent.input(screen.getByLabelText('TypeSafe API key'), { target: { value: 'apikey_test' } });
    fireEvent.input(screen.getByLabelText('TypeSafe model'), { target: { value: 'jev-latest' } });
    fireEvent.input(screen.getByLabelText('TypeSafe base URL'), { target: { value: 'https://api.typesafe.ai' } });
    fireEvent.click(screen.getByLabelText('Fall back to DeepSeek if Jev fails'));
    submitForm();
    expect(onSaveDeepSeekConfig).toHaveBeenCalledTimes(1);
    const config = onSaveDeepSeekConfig.mock.calls[0][0] as DeepSeekConfig;
    expect(config.provider).toBe('typesafe');
    expect(config.fallbackToDeepSeek).toBe(false);
    expect(config.typesafeApiKey).toBe('apikey_test');
    expect(config.typesafeModel).toBe('jev-latest');
    expect(config.typesafeBaseUrl).toBe('https://api.typesafe.ai');
  });

  it('switches to DeepSeek primary and hides the TypeSafe fields', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Primary provider'), { target: { value: 'deepseek' } });
    expect(screen.queryByLabelText('TypeSafe API key')).toBeNull();
    expect(screen.getByLabelText('Connection mode')).toBeTruthy();
  });

  it('offers the offline demo classifier as a provider', () => {
    renderSettings();
    fireEvent.change(screen.getByLabelText('Primary provider'), { target: { value: 'demo' } });
    expect(screen.queryByLabelText('TypeSafe API key')).toBeNull();
    expect(screen.getAllByText(/offline/i).length).toBeGreaterThan(0);
  });

  it('shows the local relay transport used on instagram.com', () => {
    renderSettings();
    expect(screen.getByLabelText<HTMLSelectElement>('Classifier transport').value).toBe('auto');
    expect(screen.getByLabelText<HTMLInputElement>('Local relay URL').value).toBe('ws://localhost:8787/ws');
    expect(screen.getByText(/Instagram blocks direct API calls/)).toBeTruthy();
  });

  it('saves relay transport settings and validates the URL', () => {
    const onSaveDeepSeekConfig = vi.fn();
    renderSettings({ onSaveDeepSeekConfig });
    fireEvent.change(screen.getByLabelText('Classifier transport'), { target: { value: 'relay' } });
    fireEvent.input(screen.getByLabelText('Local relay URL'), { target: { value: 'ws://localhost:9999/custom' } });
    submitForm();
    expect(onSaveDeepSeekConfig).toHaveBeenCalledTimes(1);
    const config = onSaveDeepSeekConfig.mock.calls[0][0] as DeepSeekConfig;
    expect(config.relayMode).toBe('relay');
    expect(config.relayUrl).toBe('ws://localhost:9999/custom');

    cleanup();
    renderSettings();
    fireEvent.change(screen.getByLabelText('Classifier transport'), { target: { value: 'relay' } });
    fireEvent.input(screen.getByLabelText('Local relay URL'), { target: { value: 'http://not-a-ws-url' } });
    expect(screen.getByText('Enter a valid ws:// or wss:// relay URL.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Test connection' }).disabled).toBe(true);
  });

  it('configures profile-photo classification with names', () => {
    const onSaveDeepSeekConfig = vi.fn();
    renderSettings({ onSaveDeepSeekConfig });
    expect(screen.getByLabelText<HTMLInputElement>('Include profile photos').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Vision model').value).toBe('deepseek-flash');
    fireEvent.input(screen.getByLabelText('Vision model'), { target: { value: 'deepseek-flash' } });
    fireEvent.click(screen.getByLabelText('Include profile photos'));
    expect(screen.queryByLabelText('Vision model')).toBeNull();
    submitForm();
    const config = onSaveDeepSeekConfig.mock.calls[0][0] as DeepSeekConfig;
    expect(config.includeProfilePhotos).toBe(false);
    expect(config.visionModel).toBe('deepseek-flash');
  });

  it('reveals the whitelist manager on demand', () => {
    renderSettings({ whitelistedUsers: [] });
    expect(screen.queryByText('Protected list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage protected accounts' }));
    expect(screen.getByText('Protected list')).toBeTruthy();
    expect(screen.getByText(/No protected accounts yet/)).toBeTruthy();
  });

  it('renders the classifier settings in Spanish', () => {
    renderSettings({ lang: 'es' });
    expect(screen.getByText('Clasificador de nombres')).toBeTruthy();
    expect(screen.getByLabelText('Proveedor principal')).toBeTruthy();
    expect(screen.queryByLabelText('Buscando')).toBeNull();
  });

  it('switches the interface language from settings', () => {
    const onLanguageChange = vi.fn();
    renderSettings({ onLanguageChange });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'es' } });
    expect(onLanguageChange).toHaveBeenCalledWith('es');
  });

  it('renders in Spanish', () => {
    renderSettings({ lang: 'es' });
    expect(screen.getByText('Ajustes')).toBeTruthy();
    expect(screen.getByText('Clasificador DeepSeek (respaldo / alternativa)')).toBeTruthy();
  });

  it('never performs network requests (the connection test is injected)', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
