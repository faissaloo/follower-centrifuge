import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NukeWizard, NukeWizardProps } from '../../src/components/NukeWizard';
import { WizardSteps } from '../../src/components/WizardSteps';
import { t } from '../../src/utils/i18n';

afterEach(cleanup);

function wizardProps(overrides: Partial<NukeWizardProps> = {}): NukeWizardProps {
  return {
    lang: 'en',
    onNuke: vi.fn(),
    onOpenAdvanced: vi.fn(),
    classifierLabel: 'TypeSafe Jev (primary)',
    classifierDetail: 'jev-latest · DeepSeek fallback',
    classifierReady: true,
    ...overrides,
  };
}

describe('NukeWizard (step 1)', () => {
  it('asks which category to nuke and offers all five categories', () => {
    render(<NukeWizard {...wizardProps()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('en', 'nukeHeading'));
    expect(screen.getByText(t('en', 'nukeIntro'))).toBeTruthy();
    for (const key of ['categoryFemale', 'categoryMale', 'categoryMachine', 'categoryOrganization', 'categoryAmbiguous'] as const) {
      expect(screen.getByRole('button', { name: t('en', key) })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /scan my lists/i })).toBeNull();
  });

  it('starts the scan with the chosen category', () => {
    const onNuke = vi.fn();
    render(<NukeWizard {...wizardProps({ onNuke })} />);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'categoryMachine') }));
    expect(onNuke).toHaveBeenCalledTimes(1);
    expect(onNuke.mock.calls[0][0]).toBe('machine');
  });

  it('keeps advanced setup out of the way behind a quiet link', () => {
    const onOpenAdvanced = vi.fn();
    render(<NukeWizard {...wizardProps({ onOpenAdvanced })} />);
    const advanced = screen.getByRole('button', { name: t('en', 'advancedLabel') });
    expect(advanced.className).toContain('wa-btn--quiet-link');
    fireEvent.click(advanced);
    expect(onOpenAdvanced).toHaveBeenCalledTimes(1);
  });

  it('shows a warning instead of blocking when the classifier is not configured', () => {
    render(<NukeWizard {...wizardProps({ classifierReady: false })} />);
    expect(screen.getByText(t('en', 'wizardNotConfigured'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'advancedLabel') })).toBeTruthy();
  });

  it('asks for API keys inline in a public build with no baked-in keys', () => {
    const onSaveClassifierKeys = vi.fn();
    render(
      <NukeWizard
        {...wizardProps({
          classifierReady: false,
          keySetupNeeded: true,
          onSaveClassifierKeys,
        })}
      />,
    );
    expect(screen.getByText(t('en', 'keySetupTitle'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'categoryFemale') }).hasAttribute('disabled')).toBe(true);
    const save = screen.getByRole('button', { name: t('en', 'keySetupSave') });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.input(screen.getByLabelText(t('en', 'keySetupTypeSafe')), { target: { value: 'apikey_test_123' } });
    fireEvent.input(screen.getByLabelText(t('en', 'keySetupDeepSeek')), { target: { value: 'sk-test-456' } });
    fireEvent.click(save);
    expect(onSaveClassifierKeys).toHaveBeenCalledWith('apikey_test_123', 'sk-test-456');
  });

  it('blocks category picks until the local relay preflight passes', () => {
    const onRetryRelay = vi.fn();
    render(
      <NukeWizard
        {...wizardProps({ relayStatus: 'error', relayMessage: 'connection refused', onRetryRelay })}
      />,
    );
    expect(screen.getByText(t('en', 'relayUnavailableTitle'))).toBeTruthy();
    expect(screen.getByText(t('en', 'relayUnavailableBody'))).toBeTruthy();
    expect(screen.getByText('connection refused')).toBeTruthy();
    const machine = screen.getByRole('button', { name: t('en', 'categoryMachine') });
    expect(machine.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('en', 'relayRetry') }));
    expect(onRetryRelay).toHaveBeenCalledTimes(1);
  });

  it('shows checking state, then enables picks and confirms the relay when connected', () => {
    const { rerender } = render(<NukeWizard {...wizardProps({ relayStatus: 'checking' })} />);
    expect(screen.getByText(t('en', 'relayChecking'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'categoryFemale') }).hasAttribute('disabled')).toBe(true);
    rerender(<NukeWizard {...wizardProps({ relayStatus: 'ok' })} />);
    expect(screen.getByText(t('en', 'relayConnected'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('en', 'categoryFemale') }).hasAttribute('disabled')).toBe(false);
  });

  it('offers cached and demo entry points and honours disabled scanning', () => {
    const onLoadCached = vi.fn();
    const onLoadDemo = vi.fn();
    render(
      <NukeWizard
        {...wizardProps({ onLoadCached, onLoadDemo, cachedScanCount: 12, scanDisabled: true, scanDisabledReason: 'need cookies' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: t('en', 'cachedScanAvailable', 12) }));
    fireEvent.click(screen.getByRole('button', { name: t('en', 'loadDemoPreview') }));
    expect(onLoadCached).toHaveBeenCalledTimes(1);
    expect(onLoadDemo).toHaveBeenCalledTimes(1);
    expect(screen.getByText('need cookies')).toBeTruthy();
    for (const key of ['categoryFemale', 'categoryMachine'] as const) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: t('en', key) }).disabled).toBe(true);
    }
  });

  it('renders the wizard step indicator and the dry-run promise', () => {
    render(<NukeWizard {...wizardProps()} />);
    expect(screen.getByText(t('en', 'wizardStepPick'))).toBeTruthy();
    expect(screen.getByText(t('en', 'wizardStepDryRun'))).toBeTruthy();
    expect(screen.getByText(t('en', 'wizardStepNuke'))).toBeTruthy();
    expect(screen.getByText(t('en', 'dryRunPromise'))).toBeTruthy();
    expect(screen.getByText(t('en', 'wizardRelayHint'))).toBeTruthy();
  });
});

describe('WizardSteps', () => {
  it('marks the current step', () => {
    const { container } = render(<WizardSteps lang='en' current={2} />);
    const current = container.querySelector('.wa-steps__item--current');
    expect(current?.textContent).toContain(t('en', 'wizardStepDryRun'));
    expect(current?.getAttribute('aria-current')).toBe('step');
    expect(container.querySelector('.wa-steps__item--done')?.textContent).toContain(t('en', 'wizardStepPick'));
  });
});
