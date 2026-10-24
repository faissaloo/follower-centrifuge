/**
 * App-level integration tests for the LIVE approval -> execution path.
 *
 * The Instagram-facing helpers (`fetchFriendshipsPage`, `unfollowUser`,
 * `getCookie`, `sleep`) and the DeepSeek classifier are mocked so no real
 * network is possible; everything above them is the real app: scan ->
 * review selection -> plan building -> approval gating -> executor -> screen
 * transitions and the removal of successfully unfollowed accounts.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const utilsMocks = vi.hoisted(() => ({
  unfollowUser: vi.fn(),
  fetchFriendshipsPage: vi.fn(),
  isStillFollowing: vi.fn(),
  csrfToken: 'csrf-token' as string | null,
}));

vi.mock('../../src/utils/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils/utils')>();
  return {
    ...actual,
    unfollowUser: utilsMocks.unfollowUser,
    fetchFriendshipsPage: utilsMocks.fetchFriendshipsPage,
    // Pre-write preflight: assume the follow still exists unless a test says otherwise.
    isStillFollowing: utilsMocks.isStillFollowing,
    sleep: vi.fn(async () => undefined),
    getCookie: (name: string) => {
      if (name === 'csrftoken') {
        return utilsMocks.csrfToken;
      }
      if (name === 'ds_user_id') {
        return 'viewer-id';
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
      users.map(user => ({
        id: user.id,
        gender: 'female' as const,
        confidence: 0.95,
        reason: 'test fixture',
      })),
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
import { saveWhitelist } from '../../src/utils/whitelist-manager';
import { createUserNode } from '../helpers/fixtures';
import { expectNoNetworkCalls } from './network-assertions';

function text(key: TranslationKey, ...args: Array<string | number>): string {
  return t('en', key, ...args);
}

function selectableCheckbox(username: string): HTMLInputElement {
  return screen.getByLabelText(text('selectAccount', username));
}

function disabled(element: HTMLElement): boolean {
  if (!(element instanceof HTMLButtonElement) && !(element instanceof HTMLInputElement)) {
    throw new Error(`expected a form control, got ${element.tagName}`);
  }
  return element.disabled;
}

/**
 * Walk the real scan path with mocked list pages: alina follows you back
 * (mutual), citrus does not (following-only). Both are classified as likely
 * women, so both are eligible unfollow targets.
 */
async function startScannedReview() {
  render(<App demoMode={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Female' }));
  await screen.findByText(text('reviewTitle'), undefined, { timeout: 5000 });
}

function selectAndOpenLiveDialog(usernames: readonly string[]) {
  for (const username of usernames) {
    fireEvent.click(selectableCheckbox(username));
  }
  fireEvent.click(screen.getByRole('button', { name: new RegExp(text('liveRunAction')) }));
}

async function approveAndRun(count: number) {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByLabelText(text('approvalUnderstand')));
  const input = within(dialog).getByLabelText(text('approvalPhraseInputLabel'));
  fireEvent.input(input, { target: { value: liveConfirmationPhrase(count) } });
  const confirm = within(dialog).getByRole('button', { name: text('approvalConfirm') });
  expect(disabled(confirm)).toBe(false);
  fireEvent.click(confirm);
}

beforeEach(() => {
  utilsMocks.csrfToken = 'csrf-token';
  utilsMocks.isStillFollowing.mockReset();
  utilsMocks.isStillFollowing.mockResolvedValue(true);
  utilsMocks.unfollowUser.mockReset();
  utilsMocks.unfollowUser.mockResolvedValue({ outcome: 'unfollowed', detail: 'confirmed' });
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

describe('App (live run, mocked Instagram transport)', () => {
  it('executes a live plan only after the exact approval and logs a real unfollow', async () => {
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames']);
    await approveAndRun(1);

    await screen.findByText(text('execLiveTitle'));
    const banner = screen.getByTestId('mode-banner');
    expect(banner.getAttribute('data-mode')).toBe('live');
    expect(banner.textContent).toContain('LIVE');
    await waitFor(() => expect(screen.getByText(text('entryUnfollowed'))).toBeTruthy());

    expect(utilsMocks.unfollowUser).toHaveBeenCalledTimes(1);
    const [user, csrf] = utilsMocks.unfollowUser.mock.calls[0];
    expect(user.username).toBe('alina.frames');
    expect(csrf).toBe('csrf-token');
    expectNoNetworkCalls();
  });

  it('offers a nuke-for-real prompt after a dry run and opens the typed approval', async () => {
    await startScannedReview();
    const firstCheckbox = screen.getAllByRole<HTMLInputElement>('checkbox').find(box => !box.disabled && box.getAttribute('aria-label') !== null);
    expect(firstCheckbox).toBeDefined();
    fireEvent.click(firstCheckbox!);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(text('dryRunAction')) }));
    await screen.findByText(text('execDryTitle'));

    fireEvent.click(screen.getByRole('button', { name: text('dryRunReadyAction') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(new RegExp(text('approvalTitle')))).toBeTruthy();
  });

  it('removes successfully unfollowed accounts from the review list', async () => {
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames']);
    await approveAndRun(1);
    await screen.findByText(text('execLiveTitle'));
    fireEvent.click(await screen.findByRole('button', { name: text('execBackToReview') }));
    await screen.findByText(text('reviewTitle'));
    await waitFor(() => expect(screen.queryByText('@alina.frames')).toBeNull());
    // other candidates stay available
    expect(screen.getByText('@citrus.archive')).toBeTruthy();
  });

  it('stops the queue and warns when Instagram reports an action block', async () => {
    utilsMocks.unfollowUser.mockResolvedValue({ outcome: 'blocked', detail: 'feedback_required' });
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames', 'citrus.archive']);
    await approveAndRun(2);

    await screen.findByText(text('execLiveTitle'));
    await waitFor(() => expect(screen.getAllByText(/action block/i).length).toBeGreaterThanOrEqual(2));
    expect(utilsMocks.unfollowUser).toHaveBeenCalledTimes(1);
  });

  it('continues past a failed unfollow and finishes the queue', async () => {
    utilsMocks.unfollowUser
      .mockResolvedValueOnce({ outcome: 'failed', detail: 'still following' })
      .mockResolvedValueOnce({ outcome: 'unfollowed', detail: 'confirmed' });
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames', 'citrus.archive']);
    await approveAndRun(2);

    await screen.findByText(text('execLiveTitle'));
    await waitFor(() => expect(utilsMocks.unfollowUser).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText(new RegExp(text('stopReasonComplete'))).length).toBeGreaterThan(0));
    expect(screen.getAllByText(text('entryFailed')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(text('entryUnfollowed'))).toBeTruthy();
  });

  it('refuses to execute when the Instagram session token is missing', async () => {
    utilsMocks.csrfToken = null;
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames']);
    await approveAndRun(1);

    await screen.findByText(text('execLiveTitle'));
    await waitFor(() =>
      expect(screen.getByText(new RegExp(text('stopReasonMissingSession')))).toBeTruthy(),
    );
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();
    expectNoNetworkCalls();
  });

  it('a cancelled approval dialog never reaches the executor', async () => {
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames']);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('approvalCancel') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();
    expect(screen.queryByText(text('execLiveTitle'))).toBeNull();
  });

  it('binds the approval dialog to the exact displayed accounts', async () => {
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames']);
    const dialog = await screen.findByRole('dialog');
    const listItems = within(dialog).getAllByRole('listitem');
    expect(listItems).toHaveLength(1);
    expect(listItems[0].textContent).toContain('@alina.frames');
  });
  it('stops the live queue when a queued account is protected while it runs', async () => {
    let releaseFirst: (() => void) | undefined;
    utilsMocks.unfollowUser.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseFirst = () => resolve({ outcome: 'unfollowed', detail: 'confirmed' });
        }),
    );

    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames', 'citrus.archive']);
    await approveAndRun(2);

    await waitFor(() => expect(utilsMocks.unfollowUser).toHaveBeenCalledTimes(1));

    // The user protects the second queued account while the first is in flight.
    saveWhitelist([createUserNode({ id: 'local-protection', username: 'citrus.archive' })]);
    if (releaseFirst === undefined) {
      throw new Error('first unfollow was never started');
    }
    releaseFirst();

    await screen.findByText(new RegExp(text('stopReasonProtectedTarget')));
    expect(utilsMocks.unfollowUser).toHaveBeenCalledTimes(1);
    expect(utilsMocks.unfollowUser.mock.calls[0][0].username).toBe('alina.frames');
  });

  it('skips the write (fail closed) when the follow relationship can no longer be confirmed', async () => {
    utilsMocks.isStillFollowing.mockResolvedValueOnce(false);
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames']);
    await approveAndRun(1);

    await screen.findByText(text('execLiveTitle'));
    await waitFor(() => expect(screen.getAllByText(text('entryFailed')).length).toBeGreaterThanOrEqual(2));
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();
    expectNoNetworkCalls();
  });

  it('skips the write when the preflight itself fails (unknown follow state)', async () => {
    utilsMocks.isStillFollowing.mockResolvedValueOnce(null);
    await startScannedReview();
    selectAndOpenLiveDialog(['alina.frames']);
    await approveAndRun(1);

    await screen.findByText(text('execLiveTitle'));
    await waitFor(() => expect(screen.getAllByText(text('entryFailed')).length).toBeGreaterThanOrEqual(2));
    expect(utilsMocks.unfollowUser).not.toHaveBeenCalled();
  });

});
