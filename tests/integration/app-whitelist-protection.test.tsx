/**
 * App-level regression tests for whitelist protection coming from the
 * bulk-paste flow (past entries have synthetic ids, not Instagram ids):
 *
 *  - after a scan, a pasted username must protect the matching real account
 *    (hidden from the women tab, shown under "Protected", never selectable);
 *  - reopening a cached review must re-apply the *current* whitelist instead of
 *    the stale copy stored inside the cache record;
 *  - unprotecting via the row's protect button must remove the pasted entry.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const utilsMocks = vi.hoisted(() => ({
  fetchFriendshipsPage: vi.fn(),
  unfollowUser: vi.fn(),
}));

vi.mock('../../src/utils/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/utils')>();
  return {
    ...actual,
    fetchFriendshipsPage: utilsMocks.fetchFriendshipsPage,
    unfollowUser: utilsMocks.unfollowUser,
    sleep: vi.fn(async () => undefined),
    getCookie: (name: string) => (name === 'ds_user_id' ? 'viewer-id' : name === 'csrftoken' ? 'csrf' : null),
  };
});

vi.mock('../../src/utils/gender-classifier', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/gender-classifier')>();
  const classifier = {
    version: 'test:v1',
    source: 'deepseek' as const,
    model: 'test-model',
    classifyBatch: vi.fn(async (users: ReadonlyArray<{ readonly id: string }>) =>
      users.map(user => ({ id: user.id, gender: 'female' as const, confidence: 0.95, reason: 'test fixture' })),
    ),
  };
  return {
    ...actual,
    createDeepSeekGenderClassifier: () => classifier,
    createGenderClassifier: () => classifier,
    createDemoGenderClassifier: () => classifier,
    testDeepSeekConnection: vi.fn(async () => ({ ok: true, message: 'stub' })),
  };
});

import { App } from '../../src/App';
import { t, TranslationKey } from '../../src/utils/i18n';
import { loadWhitelist, saveWhitelist } from '../../src/utils/whitelist-manager';
import { createUserNode } from '../helpers/fixtures';
import { expectNoNetworkCalls } from './network-assertions';

function text(key: TranslationKey, ...args: Array<string | number>): string {
  return t('en', key, ...args);
}

function disabled(element: HTMLElement): boolean {
  if (!(element instanceof HTMLButtonElement) && !(element instanceof HTMLInputElement)) {
    throw new Error(`expected a form control, got ${element.tagName}`);
  }
  return element.disabled;
}

function pastedProtection(username: string) {
  return createUserNode({ id: `pasted_${username}_1735689600000_ab12`, username, fullName: username });
}

async function scanToReview() {
  render(<App demoMode={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Female' }));
  await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });
}

function tab(label: string): HTMLElement {
  const found = screen
    .getAllByRole('tab')
    .find(candidate => candidate.textContent !== null && candidate.textContent.indexOf(label) !== -1);
  if (found === undefined) {
    throw new Error(`tab not found: ${label}`);
  }
  return found;
}

beforeEach(() => {
  utilsMocks.unfollowUser.mockReset();
  utilsMocks.fetchFriendshipsPage.mockReset();
  utilsMocks.fetchFriendshipsPage.mockImplementation((kind: 'following' | 'followers') => {
    if (kind === 'following') {
      return Promise.resolve({
        users: [
          { pk: 1, pk_id: '1', username: 'alina.frames', full_name: 'Alina Moreno', profile_pic_url: '' },
          { pk: 3, pk_id: '3', username: 'citrus.archive', full_name: 'Mara Kim', profile_pic_url: '' },
        ],
      });
    }
    return Promise.resolve({
      users: [{ pk: 1, pk_id: '1', username: 'alina.frames', full_name: 'Alina Moreno', profile_pic_url: '' }],
    });
  });
});

describe('App whitelist protection from the bulk-paste flow', () => {
  it('protects the real account matching a pasted username after scanning', async () => {
    saveWhitelist([pastedProtection('alina.frames')]);
    await scanToReview();

    // Protected account is removed from the women tabs...
    await waitFor(() => expect(screen.queryByText('@alina.frames')).toBeNull());
    expect(screen.getByText('@citrus.archive')).toBeTruthy();

    // ...shown as protected...
    fireEvent.click(tab(text('tabWhitelisted')));
    expect(await screen.findByText('@alina.frames')).toBeTruthy();

    // ...locked for selection...
    const lockedCheckbox = screen.getByLabelText(text('selectAccountDisabled', 'alina.frames'));
    expect(disabled(lockedCheckbox)).toBe(true);

    // ...and live unfollow has no eligible selection.
    const liveButton = screen.getByRole('button', { name: new RegExp(text('liveRunAction')) });
    expect(disabled(liveButton)).toBe(true);
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();
    expectNoNetworkCalls();
  });

  it('re-applies the current whitelist when reopening a cached review', async () => {
    const first = render(<App demoMode={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Female' }));
    await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });
    first.unmount();

    // Protection added after the scan completed: the cache must not win.
    saveWhitelist([pastedProtection('alina.frames')]);

    render(<App demoMode={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Load previous scan/i }));
    await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });

    await waitFor(() => expect(screen.queryByText('@alina.frames')).toBeNull());
    fireEvent.click(tab(text('tabWhitelisted')));
    expect(await screen.findByText('@alina.frames')).toBeTruthy();
  });

  it('unprotecting a pasted username removes the pasted entry and restores eligibility', async () => {
    saveWhitelist([pastedProtection('alina.frames')]);
    await scanToReview();
    fireEvent.click(tab(text('tabWhitelisted')));
    await screen.findByText('@alina.frames');

    fireEvent.click(screen.getByLabelText(text('unprotectAccount', 'alina.frames')));
    await waitFor(() => expect(loadWhitelist()).toHaveLength(0));

    fireEvent.click(tab(text('tabTargetFollowing', 'Female')));
    await waitFor(() => expect(screen.getByText('@alina.frames')).toBeTruthy());
    const checkbox = screen.getByLabelText(text('selectAccount', 'alina.frames'));
    expect(disabled(checkbox)).toBe(false);
  });
});
