/**
 * App-level safety integration test for a PARTIAL scan.
 *
 * Simulates the realistic failure mode: the following list loads, then the
 * followers list fails mid-scan. The app must:
 *  - keep whatever was fetched for review,
 *  - mark the scan incomplete,
 *  - lock every unfollow action (dry run has no eligible targets; live is
 *    hard-locked regardless of selection),
 *  - never call the unfollow transport.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphMocks = vi.hoisted(() => ({
  fetchFriendshipsPage: vi.fn(),
  unfollowUser: vi.fn(),
}));

vi.mock('../../src/utils/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/utils')>();
  return {
    ...actual,
    fetchFriendshipsPage: graphMocks.fetchFriendshipsPage,
    unfollowUser: graphMocks.unfollowUser,
    sleep: vi.fn(async () => undefined),
    getCookie: (name: string) => {
      if (name === 'ds_user_id') {
        return 'viewer-id';
      }
      if (name === 'csrftoken') {
        return 'csrf-token';
      }
      return null;
    },
  };
});

vi.mock('../../src/utils/gender-classifier', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/gender-classifier')>();
  const classifier = {
    version: 'test:v1',
    source: 'deepseek' as const,
    model: 'test-model',
    classifyBatch: vi.fn(async (users: ReadonlyArray<{ readonly id: string }>) =>
      users.map(user => ({ id: user.id, gender: 'female' as const, confidence: 0.95, reason: 'test' })),
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

function findAccountInAnyTab(username: string): void {
  const tabs = screen.getAllByRole('tab');
  for (const tab of tabs) {
    fireEvent.click(tab);
    if (screen.queryByText(username) !== null) {
      return;
    }
  }
  throw new Error(`could not find ${username} in any review tab`);
}

beforeEach(() => {
  graphMocks.unfollowUser.mockReset();
  graphMocks.unfollowUser.mockResolvedValue({ outcome: 'unfollowed', detail: 'confirmed' });
  graphMocks.fetchFriendshipsPage.mockReset();
  graphMocks.fetchFriendshipsPage.mockImplementation(
    (kind: 'following' | 'followers') => {
      if (kind === 'following') {
        return Promise.resolve({
          users: [{ pk: 1, pk_id: '1', username: 'alice.w', full_name: 'Alice Wonder', profile_pic_url: '' }],
        });
      }
      const error = new Error('Not found');
      (error as unknown as { name: string }).name = 'InstagramApiError';
      (error as unknown as { status: number }).status = 404;
      return Promise.reject(error);
    },
  );
});

describe('App (partial scan)', () => {
  it('keeps partial results for review but locks every unfollow action', async () => {
    render(<App demoMode={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Female' }));

    // The scan walks following successfully, then fails on followers.
    await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });
    expect(graphMocks.fetchFriendshipsPage).toHaveBeenCalledTimes(2);

    // Incomplete-scan warning is visible.
    expect(screen.getByText(text('scanIncompleteTitle'))).toBeTruthy();
    expect(screen.getByText(text('scanIncompleteBody', text('incompleteFollowers')))).toBeTruthy();

    // The partially fetched account is kept for review; streaming may have
    // classified it already, so it can be in either the target or uncertain tab.
    findAccountInAnyTab('@alice.w');

    // Live unfollow is hard-locked while the scan is incomplete.
    const liveButton = screen.getByRole('button', { name: new RegExp(text('liveRunAction')) });
    expect(disabled(liveButton)).toBe(true);
    expect(liveButton.getAttribute('title')).toBe(text('liveRunLockedIncomplete'));

    // Nothing is eligible, so the dry run is disabled too.
    const dryButton = screen.getByRole('button', { name: new RegExp(text('dryRunAction')) });
    expect(disabled(dryButton)).toBe(true);

    expect(graphMocks.unfollowUser).not.toHaveBeenCalled();
    expectNoNetworkCalls();
  });
  it('does not offer the synthetic demo preview on a real Instagram origin', () => {
    render(<App demoMode={false} />);
    expect(screen.queryByRole('button', { name: new RegExp(text('loadDemoPreview')) })).toBeNull();
    expect(screen.getByRole('button', { name: 'Female' })).toBeTruthy();
    expectNoNetworkCalls();
  });

  it('keeps partial results for review when the scan is cancelled', async () => {
    let releaseSecondPage: (() => void) | undefined;
    let calls = 0;
    graphMocks.fetchFriendshipsPage.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          users: [{ pk: 1, pk_id: '1', username: 'alice.w', full_name: 'Alice Wonder', profile_pic_url: '' }],
          next_max_id: 'page-2',
          has_more: true,
        });
      }
      return new Promise(resolve => {
        releaseSecondPage = () =>
          resolve({
            users: [{ pk: 2, pk_id: '2', username: 'bea.k', full_name: 'Bea Kim', profile_pic_url: '' }],
          });
      });
    });

    render(<App demoMode={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Female' }));
    await screen.findByText(text('scanningTitle'));
    // Wait until the in-flight second-page request has actually started.
    await waitFor(() => expect(calls).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: new RegExp(text('scanCancel')) }));
    if (releaseSecondPage === undefined) {
      throw new Error('second page was not requested');
    }
    releaseSecondPage();

    await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });
    expect(screen.getByText(text('scanIncompleteTitle'))).toBeTruthy();

    findAccountInAnyTab('@alice.w');

    const liveButton = screen.getByRole('button', { name: new RegExp(text('liveRunAction')) });
    expect(disabled(liveButton)).toBe(true);
    expect(graphMocks.unfollowUser).not.toHaveBeenCalled();
  });

});
