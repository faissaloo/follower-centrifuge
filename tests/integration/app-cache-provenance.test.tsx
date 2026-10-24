/**
 * App-level safety tests for review-cache provenance and freshness.
 *
 *  - a cached review is only offered to the Instagram account that produced it;
 *  - a cached review can be reviewed and dry-run but never drives a live run;
 *  - a review older than the live freshness window is rejected at live time.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const utilsMocks = vi.hoisted(() => ({
  unfollowUser: vi.fn(),
  fetchFriendshipsPage: vi.fn(),
  viewerId: 'viewer-a' as string | null,
}));

vi.mock('../../src/utils/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/utils')>();
  return {
    ...actual,
    unfollowUser: utilsMocks.unfollowUser,
    fetchFriendshipsPage: utilsMocks.fetchFriendshipsPage,
    // Pre-write preflight: assume the follow still exists unless a test says otherwise.
    isStillFollowing: vi.fn(async () => true),
    sleep: vi.fn(async () => undefined),
    getCookie: (name: string) => {
      if (name === 'ds_user_id') {
        return utilsMocks.viewerId;
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
import { liveConfirmationPhrase } from '../../src/utils/approval';
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

async function scanToReview(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Female' }));
  await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });
}

beforeEach(() => {
  utilsMocks.viewerId = 'viewer-a';
  utilsMocks.unfollowUser.mockReset();
  utilsMocks.unfollowUser.mockResolvedValue({ outcome: 'unfollowed', detail: 'confirmed' });
  utilsMocks.fetchFriendshipsPage.mockReset();
  utilsMocks.fetchFriendshipsPage.mockImplementation((kind: 'following' | 'followers') => {
    if (kind === 'following') {
      return Promise.resolve({
        users: [{ pk: 1, pk_id: '1', username: 'alina.frames', full_name: 'Alina Moreno', profile_pic_url: '' }],
      });
    }
    return Promise.resolve({
      users: [{ pk: 1, pk_id: '1', username: 'alina.frames', full_name: 'Alina Moreno', profile_pic_url: '' }],
    });
  });
});

describe('App cached-review provenance', () => {
  it('offers a cached review to the same viewer, but locks live actions on it', async () => {
    const first = render(<App demoMode={false} />);
    await scanToReview();
    first.unmount();

    render(<App demoMode={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Load previous scan/i }));
    await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });

    expect(screen.getByText(text('cachedReviewNotice'))).toBeTruthy();
    const liveButton = screen.getByRole('button', { name: new RegExp(text('liveRunAction')) });
    expect(disabled(liveButton)).toBe(true);
    expect(liveButton.getAttribute('title')).toBe(text('liveRunLockedCached'));
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();
    expectNoNetworkCalls();
  });

  it('never offers a cache produced by a different Instagram account', async () => {
    const first = render(<App demoMode={false} />);
    await scanToReview();
    first.unmount();

    utilsMocks.viewerId = 'viewer-b';
    render(<App demoMode={false} />);
    expect(screen.queryByRole('button', { name: /Load previous scan/i })).toBeNull();
    expectNoNetworkCalls();
  });

  it('never offers a cache when no viewer session is known', async () => {
    const first = render(<App demoMode={false} />);
    await scanToReview();
    first.unmount();

    utilsMocks.viewerId = null;
    render(<App demoMode={false} />);
    expect(screen.queryByRole('button', { name: /Load previous scan/i })).toBeNull();
  });

  it('rejects a live run when the scanned review is older than the freshness window', async () => {
    render(<App demoMode={false} />);
    await scanToReview();

    const staleNow = Date.now() + 31 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(staleNow);

    const checkbox = screen.getByLabelText(text('selectAccount', 'alina.frames'));
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(text('liveRunAction')) }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(text('approvalUnderstand')));
    const input = within(dialog).getByLabelText(text('approvalPhraseInputLabel'));
    fireEvent.input(input, { target: { value: liveConfirmationPhrase(1) } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('approvalConfirm') }));

    await waitFor(() => expect(screen.getByText(text('liveRunLockedStale'))).toBeTruthy());
    expect(screen.queryByText(text('execLiveTitle'))).toBeNull();
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();

    nowSpy.mockRestore();
    expectNoNetworkCalls();
  });
});

describe('App live viewer-switch protection', () => {
  it('refuses to execute if the logged-in account changed after the scan', async () => {
    render(<App demoMode={false} />);
    await scanToReview();

    // Another tab switches the Instagram account before the live approval.
    utilsMocks.viewerId = 'viewer-b';

    const checkbox = screen.getByLabelText(text('selectAccount', 'alina.frames'));
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(text('liveRunAction')) }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(text('approvalUnderstand')));
    const input = within(dialog).getByLabelText(text('approvalPhraseInputLabel'));
    fireEvent.input(input, { target: { value: liveConfirmationPhrase(1) } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('approvalConfirm') }));

    await waitFor(() => expect(screen.getByText(text('liveRunLockedViewerChanged'))).toBeTruthy());
    expect(screen.queryByText(text('execLiveTitle'))).toBeNull();
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();
  });
});
