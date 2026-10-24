/**
 * App <-> SettingMenu wiring for the DeepSeek connection probe.
 *
 * The classifier module is partially mocked so the probe is observable without
 * any network; everything else (App state, settings persistence, dialog) is real.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { DeepSeekConfig } from '../../src/model/deepseek-config';

const classifierMocks = vi.hoisted(() => ({
  testDeepSeekConnection: vi.fn(async (_config: DeepSeekConfig) => ({
    ok: true,
    message: 'mocked-ok',
  })),
}));

vi.mock('../../src/utils/gender-classifier', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/gender-classifier')>();
  return { ...actual, testDeepSeekConnection: classifierMocks.testDeepSeekConnection };
});

import { App } from '../../src/App';
import { t, TranslationKey } from '../../src/utils/i18n';
import { expectNoNetworkCalls } from './network-assertions';

function text(key: TranslationKey, ...args: Array<string | number>): string {
  return t('en', key, ...args);
}

describe('App settings wiring', () => {
  it('passes the current config to the injected connection probe and shows its result', async () => {
    render(<App demoMode autoLoadDemo />);
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(screen.getByRole('button', { name: text('openSettings') }));
    await screen.findByText(text('settingsTitle'));

    fireEvent.click(screen.getByRole('button', { name: text('testConnection') }));
    await waitFor(() => expect(screen.getByText(text('testConnectionOk', 'mocked-ok'))).toBeTruthy());

    expect(classifierMocks.testDeepSeekConnection).toHaveBeenCalledTimes(1);
    const config = classifierMocks.testDeepSeekConnection.mock.calls[0][0];
    expect(config.mode).toBe('proxy');
    expect(config.proxyBaseUrl).toBe('http://127.0.0.1:8787');
    expect(config.model).toBe('deepseek-chat');
    expect(config.apiKey).toBe('');
    expectNoNetworkCalls();
  });

  it('keeps the API key out of localStorage when saved in direct mode', async () => {
    render(<App demoMode autoLoadDemo />);
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(screen.getByRole('button', { name: text('openSettings') }));
    await screen.findByText(text('settingsTitle'));

    const modeSelect = document.getElementById('wa-deepseek-mode') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: 'direct' } });
    const keyInput = document.getElementById('wa-deepseek-api-key') as HTMLInputElement | null;
    expect(keyInput).not.toBeNull();
    fireEvent.input(keyInput!, { target: { value: 'sk-super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: text('saveSettings') }));

    const stored = localStorage.getItem('iu_deepseek-config') ?? '';
    expect(stored).toContain('"mode":"direct"');
    expect(stored).not.toContain('sk-super-secret');
    expect(sessionStorage.getItem('iu_deepseek-api-key')).toBe('sk-super-secret');
    expectNoNetworkCalls();
  });
  it('clears the browser-side key when switching from direct back to proxy mode', async () => {
    render(<App demoMode autoLoadDemo />);
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(screen.getByRole('button', { name: text('openSettings') }));
    await screen.findByText(text('settingsTitle'));

    const modeSelect = document.getElementById('wa-deepseek-mode') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: 'direct' } });
    const keyInput = document.getElementById('wa-deepseek-api-key') as HTMLInputElement;
    fireEvent.input(keyInput, { target: { value: 'sk-switch-me' } });
    fireEvent.click(screen.getByRole('button', { name: text('saveSettings') }));
    expect(sessionStorage.getItem('iu_deepseek-api-key')).toBe('sk-switch-me');

    // Re-open if the save closed the dialog, then switch back to proxy mode.
    if (screen.queryByText(text('settingsTitle')) === null) {
      fireEvent.click(screen.getByRole('button', { name: text('openSettings') }));
      await screen.findByText(text('settingsTitle'));
    }
    const modeAgain = document.getElementById('wa-deepseek-mode') as HTMLSelectElement;
    fireEvent.change(modeAgain, { target: { value: 'proxy' } });
    fireEvent.click(screen.getByRole('button', { name: text('saveSettings') }));

    expect(sessionStorage.getItem('iu_deepseek-api-key')).toBeNull();
    expectNoNetworkCalls();
  });

});
