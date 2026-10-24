/**
 * App-level integration tests for the offline demo flow.
 *
 * Renders the real `App` (all screens, real state machine, real review/filter
 * logic, real dry-run plan + executor) with the synthetic demo dataset and a
 * demo-mode flag. No Instagram and no DeepSeek requests can happen: the scan
 * path is disabled, and the global fetch guard is asserted untouched.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { t, TranslationKey } from '../../src/utils/i18n';
import { expectNoNetworkCalls } from './network-assertions';
import { REVIEW_CACHE_STORAGE_KEY, WHITELISTED_RESULTS_STORAGE_KEY } from '../../src/constants/constants';
import { AUDIT_TARGET_CATEGORY_STORAGE_KEY } from '../../src/utils/audit-preferences';

function text(key: TranslationKey, ...args: Array<string | number>): string {
  return t('en', key, ...args);
}


/** Narrow a DOM element to a form control and read its disabled state. */
function disabled(element: HTMLElement): boolean {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLButtonElement)) {
    throw new Error(`expected a form control, got ${element.tagName}`);
  }
  return element.disabled;
}

function renderDemo() {
  render(<App demoMode autoLoadDemo />);
}

function selectableCheckbox(username: string): HTMLInputElement {
  return screen.getByLabelText(text('selectAccount', username)) ;
}

describe('App (demo mode)', () => {
  it('opens the synthetic review immediately with ?preview=review semantics and never touches the network', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    expect(screen.getByText(text('demoNotice'))).toBeTruthy();
    expectNoNetworkCalls();
  });

  it('reaches the review from the launch screen via the demo button', async () => {
    render(<App demoMode />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(text('loadDemoPreview')) }));
    await screen.findByText(text('reviewTitle'));
    expectNoNetworkCalls();
  });

  it('shows only likely women the viewer follows in the default tab', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    expect(screen.getByText('@alina.frames')).toBeTruthy();
    expect(screen.getByText('@fieldnotes.studio')).toBeTruthy();
    // follower-only, male and uncertain accounts are not in the default tab
    expect(screen.queryByText('@bob')).toBeNull();
    expect(screen.queryByText('@keystone.labs')).toBeNull();
    expect(screen.queryByText('@nightform')).toBeNull();
  });

  it('switches to the uncertain tab and shows low-confidence/unclear accounts', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    const tabs = screen.getAllByRole('tab');
    const uncertainTab = tabs.find(tab => tab.textContent !== null && tab.textContent.indexOf(text('tabOtherUncertain')) !== -1);
    expect(uncertainTab).toBeTruthy();
    fireEvent.click(uncertainTab!);
    await waitFor(() => expect(screen.getByText('@nightform')).toBeTruthy());
    expect(screen.getByText('@understory')).toBeTruthy();
  });

  it('allows removing followers-only accounts from the followers tab', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    const tabs = screen.getAllByRole('tab');
    const followersTab = tabs.find(
      tab => tab.textContent !== null && tab.textContent.indexOf(text('tabTargetFollowers', 'Female')) !== -1,
    );
    fireEvent.click(followersTab!);
    await waitFor(() => expect(screen.getByText('@keystone.labs')).toBeTruthy());
    const select = screen.getByLabelText(text('selectAccount', 'keystone.labs'));
    expect(disabled(select)).toBe(false);
    fireEvent.click(select);
  });

  it('protects an account: it leaves the women tab, appears under protected and cannot be selected', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(screen.getByLabelText(text('protectAccount', 'alina.frames')));
    await waitFor(() => expect(screen.queryByText('@alina.frames')).toBeNull());
    const tabs = screen.getAllByRole('tab');
    const protectedTab = tabs.find(
      tab => tab.textContent !== null && tab.textContent.indexOf(text('tabWhitelisted')) !== -1,
    );
    fireEvent.click(protectedTab!);
    await waitFor(() => expect(screen.getByText('@alina.frames')).toBeTruthy());
  });

  it('filters by minimum confidence', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    const confidence = screen.getByLabelText(text('minimumConfidence'));
    fireEvent.input(confidence, { target: { value: '96' } });
    await waitFor(() => expect(screen.queryByText('@citrus.archive')).toBeNull());
    expect(screen.getByText('@alina.frames')).toBeTruthy();
  });

  it('filters by search term across username and display name', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    const search = screen.getByPlaceholderText(text('searchPlaceholder'));
    fireEvent.input(search, { target: { value: 'Mara' } });
    await waitFor(() => expect(screen.getByText('@citrus.archive')).toBeTruthy());
    expect(screen.queryByText('@alina.frames')).toBeNull();
  });

  it('runs a dry run end-to-end: zero Instagram writes, simulated entries, distinct SIMULATION banner', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(selectableCheckbox('alina.frames'));
    fireEvent.click(selectableCheckbox('citrus.archive'));

    const dryRunButton = screen.getByRole('button', { name: new RegExp(text('dryRunAction')) });
    expect(disabled(dryRunButton)).toBe(false);
    fireEvent.click(dryRunButton);

    await screen.findByText(text('execDryTitle'));
    const executing = document.querySelector('[data-executing-mode]');
    expect(executing?.getAttribute('data-executing-mode')).toBe('dry-run');
    const modeBanner = screen.getByTestId('mode-banner');
    expect(modeBanner.getAttribute('data-mode')).toBe('dry-run');
    expect(modeBanner.textContent).toContain('SIMULATION');
    expect(document.body.innerHTML).not.toContain(text('execLiveTitle'));
    // every logged entry is a simulation, never a real unfollow
    expect(screen.getAllByText(text('entrySimulated')).length).toBe(2);
    expectNoNetworkCalls();
  });

  it('returns from the dry-run report to the review list', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(selectableCheckbox('alina.frames'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(text('dryRunAction')) }));
    await screen.findByText(text('execDryTitle'));
    fireEvent.click(screen.getByRole('button', { name: text('execBackToReview') }));
    await screen.findByText(text('reviewTitle'));
    expect(screen.getByText('@alina.frames')).toBeTruthy();
  });

  it('hard-disables live unfollowing while reviewing demo data', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(selectableCheckbox('alina.frames'));
    const liveButton = screen.getByRole('button', { name: new RegExp(text('liveRunAction')) });
    expect(disabled(liveButton)).toBe(true);
    expect(liveButton.getAttribute('title')).toBe(text('liveRunBlocked'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expectNoNetworkCalls();
  });

  it('shows the protected list in settings without exposing an executable path', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(screen.getByRole('button', { name: text('openSettings') }));
    await screen.findByText(text('settingsTitle'));
    expectNoNetworkCalls();
  });

  it('switches the classifier to offline demo mode, tests the connection through App wiring and saves it', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    fireEvent.click(screen.getByRole('button', { name: text('openSettings') }));
    await screen.findByText(text('settingsTitle'));

    const modeSelect = document.getElementById('wa-deepseek-mode') as HTMLSelectElement | null;
    expect(modeSelect).not.toBeNull();
    fireEvent.change(modeSelect!, { target: { value: 'demo' } });

    // Demo mode needs no connection probe, so the button disappears.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: text('testConnection') })).toBeNull(),
    );
    expect(screen.getByText(text('modeDemoNote'))).toBeTruthy();
    expectNoNetworkCalls();

    fireEvent.click(screen.getByRole('button', { name: text('saveSettings') }));
    const raw = localStorage.getItem('iu_deepseek-config') ?? '';
    expect(raw).toContain('"mode":"demo"');
    expect(raw).not.toContain('apiKey');
    expectNoNetworkCalls();
  });
  it('keeps the live action non-executable end-to-end in demo mode', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    const liveButton = screen.getByRole('button', { name: new RegExp(text('liveRunAction')) });
    expect(liveButton.getAttribute('title')).toBe(text('liveRunBlocked'));
    expect(screen.queryByText(text('execLiveTitle'))).toBeNull();
    expectNoNetworkCalls();
  });

  it('never persists demo whitelist or cache changes into the real browser storage', async () => {
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    expect(localStorage.getItem(WHITELISTED_RESULTS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(REVIEW_CACHE_STORAGE_KEY)).toBeNull();

    // Protect and unprotect demo accounts: the in-memory demo list may change,
    // but the real origin storage must stay untouched.
    fireEvent.click(screen.getByLabelText(text('protectAccount', 'alina.frames')));
    await waitFor(() => expect(screen.queryByText('@alina.frames')).toBeNull());
    expect(localStorage.getItem(WHITELISTED_RESULTS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(REVIEW_CACHE_STORAGE_KEY)).toBeNull();

    // Demo scans also never write a review cache.
    expect(localStorage.getItem(REVIEW_CACHE_STORAGE_KEY)).toBeNull();
    expectNoNetworkCalls();
  });

});

describe('App (demo mode) nuke category preference', () => {
  /** Pre-seed the persisted category preference before the app mounts. */
  function persistTarget(category: string): void {
    localStorage.setItem(AUDIT_TARGET_CATEGORY_STORAGE_KEY, category);
  }

  it('loads the persisted men category and opens the men tabs by default', async () => {
    persistTarget('male');
    renderDemo();
    await screen.findByText(text('reviewTitle'));

    expect(
      screen.getAllByRole('tab').some(tab => tab.textContent !== null && tab.textContent.indexOf(text('tabTargetFollowing', 'Male')) !== -1),
    ).toBe(true);
    expect(screen.getByText(t('en', 'reviewNuking', t('en', 'categoryMale')))).toBeTruthy();
    // Likely men the viewer follows are listed; likely women are not in this tab.
    expect(screen.getByText('@dawnledger')).toBeTruthy();
    expect(screen.getByText('@elias.market')).toBeTruthy();
    expect(screen.queryByText('@alina.frames')).toBeNull();
    expectNoNetworkCalls();
  });

  it('starts from the wizard with five nuke categories and no legacy scan button', async () => {
    render(<App demoMode />);
    await screen.findByText(text('nukeHeading'));
    for (const key of ['categoryFemale', 'categoryMale', 'categoryMachine', 'categoryOrganization', 'categoryAmbiguous'] as const) {
      expect(screen.getByRole('button', { name: text(key) })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /Scan my lists/i })).toBeNull();
    expect(screen.getByText(t('en', 'advancedLabel'))).toBeTruthy();
    expectNoNetworkCalls();
  });

  it('opens the matching review when a wizard category is clicked', async () => {
    render(<App demoMode />);
    fireEvent.click(await screen.findByRole('button', { name: text('categoryMachine') }));
    await screen.findByText(text('reviewTitle'));
    expect(screen.getByText(t('en', 'reviewNuking', t('en', 'categoryMachine')))).toBeTruthy();
    expect(screen.getByText('@nightly.bot')).toBeTruthy();
    expect(localStorage.getItem(AUDIT_TARGET_CATEGORY_STORAGE_KEY)).toBe('machine');
    expectNoNetworkCalls();
  });

  it('shows machine accounts when the persisted category is machine', async () => {
    persistTarget('machine');
    renderDemo();
    await screen.findByText(text('reviewTitle'));
    expect(screen.getByText(t('en', 'reviewNuking', t('en', 'categoryMachine')))).toBeTruthy();
    expect(screen.getByText('@nightly.bot')).toBeTruthy();
    expect(screen.queryByText('@alina.frames')).toBeNull();
    expectNoNetworkCalls();
  });

  it('runs a dry run over likely men end-to-end without any Instagram write', async () => {
    persistTarget('male');
    renderDemo();
    await screen.findByText(text('reviewTitle'));

    fireEvent.click(selectableCheckbox('dawnledger'));
    fireEvent.click(selectableCheckbox('elias.market'));
    const dryRunButton = screen.getByRole('button', { name: new RegExp(text('dryRunAction')) });
    expect(disabled(dryRunButton)).toBe(false);
    fireEvent.click(dryRunButton);

    await screen.findByText(text('execDryTitle'));
    const banner = screen.getByTestId('mode-banner');
    expect(banner.getAttribute('data-mode')).toBe('dry-run');
    expect(screen.getAllByText(text('entrySimulated')).length).toBe(2);
    expectNoNetworkCalls();
  });

  it('silently falls back to women for a corrupt persisted category', async () => {
    persistTarget('nonbinary');
    renderDemo();
    await screen.findByText(text('reviewTitle'));

    expect(screen.getByText(t('en', 'reviewNuking', t('en', 'categoryFemale')))).toBeTruthy();
    expect(screen.getByText('@alina.frames')).toBeTruthy();
    expect(screen.queryByText('@dawnledger')).toBeNull();
    expectNoNetworkCalls();
  });
});
