import { describe, expect, it, vi } from 'vitest';
import {
  createFriendshipsListFetcher,
  FriendshipsListFetcherDeps,
  isTransientFetchError,
} from '../../src/utils/friendships-list';
import { FetchListUser, FriendshipsListKind } from '../../src/model/audit';
import { pageOf } from '../helpers/fixtures';

function user(pk: number): FetchListUser {
  return { pk, pk_id: String(pk), username: `user${pk}`, full_name: `User ${pk}`, profile_pic_url: '' };
}

function makeDeps(overrides: Partial<FriendshipsListFetcherDeps> = {}): FriendshipsListFetcherDeps {
  return {
    fetchPage: vi.fn(async () => pageOf([], undefined)),
    sleep: vi.fn(async () => undefined),
    random: () => 0,
    shouldAbort: () => false,
    ...overrides,
  };
}


describe('createFriendshipsListFetcher', () => {
  it('walks paginated pages in order and returns true at the end', async () => {
    const seen: string[] = [];
    const fetchPage = vi.fn(async (_kind: FriendshipsListKind, maxId?: string) => {
      seen.push(maxId ?? 'start');
      if (maxId === undefined) {
        return pageOf([user(1), user(2)], 'page2');
      }
      return pageOf([user(3)], undefined as string | undefined);
    });
    const onPage = vi.fn(async (_users: readonly FetchListUser[]): Promise<void> => undefined);
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage }));
    await expect(fetchList('following', onPage)).resolves.toBe(true);
    expect(seen).toEqual(['start', 'page2']);
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onPage.mock.calls[0][0].map(entry => entry.pk)).toEqual([1, 2]);
    expect(onPage.mock.calls[1][0].map(entry => entry.pk)).toEqual([3]);
  });

  it('passes the kind and requested page size through to fetchPage', async () => {
    const fetchPage = vi.fn(async () => pageOf([]));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, usersPerPage: 33 }));
    await fetchList('followers', () => undefined);
    expect(fetchPage).toHaveBeenCalledWith('followers', undefined, 33);
  });

  it('awaits an async onPage callback before requesting the next page', async () => {
    const order: string[] = [];
    let pageIndex = 0;
    const fetchPage = async () => {
      order.push('fetch');
      pageIndex++;
      return pageIndex === 1 ? pageOf([user(1)], 'next') : pageOf([user(2)]);
    };
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage }));
    await fetchList('following', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('onPage');
    });
    expect(order).toEqual(['fetch', 'onPage', 'fetch', 'onPage']);
  });

  it('treats a has_more=true page without a usable next_max_id as incomplete', async () => {
    const fetchPage = vi.fn(async () => ({ users: [user(1)], has_more: true }));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage }));
    // Cannot prove the list is complete -> the scan must be marked incomplete so
    // live unfollowing stays locked.
    await expect(fetchList('following', () => undefined)).resolves.toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('completes when the last page explicitly reports has_more=false', async () => {
    const fetchPage = vi.fn(async () => ({ users: [user(1)], has_more: false }));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(true);
  });

  it('stops when has_more is explicitly false even with a next_max_id', async () => {
    const fetchPage = vi.fn(async () => ({ users: [user(1)], next_max_id: 'more', has_more: false }));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('treats an empty page with has_more=true as incomplete', async () => {
    const fetchPage = vi.fn(async () => pageOf([], 'next', true));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('completes on an empty page when has_more is not claimed', async () => {
    const fetchPage = vi.fn(async () => ({ users: [] }));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(true);
  });

  it('retries transient 429 errors with escalating cooldowns', async () => {
    let attempts = 0;
    const fetchPage = vi.fn(async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error('Instagram returned HTTP 429');
        (error as any).name = 'InstagramApiError';
        (error as any).status = 429;
        throw error;
      }
      return pageOf([user(1)]);
    });
    const sleep = vi.fn(async () => undefined);
    const onNotice = vi.fn();
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, sleep, onNotice }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(30000);
    expect(sleep).toHaveBeenCalledWith(60000);
    expect(onNotice).toHaveBeenCalledWith('retrying after 30s');
  });

  it('gives up after maxRetries transient failures and reports the error', async () => {
    const fetchPage = vi.fn(async () => {
      const error = new Error('network down');
      throw error;
    });
    const onError = vi.fn();
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, maxRetries: 2, onError }));
    await expect(fetchList('followers', () => undefined)).resolves.toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transient errors such as 404', async () => {
    const fetchPage = vi.fn(async () => {
      const error = new Error('Not found');
      (error as any).name = 'InstagramApiError';
      (error as any).status = 404;
      throw error;
    });
    const onError = vi.fn();
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, onError }));
    await expect(fetchList('followers', () => undefined)).resolves.toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('aborts before a single request when shouldAbort is true', async () => {
    const fetchPage = vi.fn(async () => pageOf([user(1)]));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, shouldAbort: () => true }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('aborts between pages', async () => {
    let aborted = false;
    const fetchPage = vi.fn(async () => {
      const isFirst = fetchPage.mock.calls.length === 1;
      return isFirst ? pageOf([user(1)], 'next') : pageOf([user(2)]);
    });
    const fetchList = createFriendshipsListFetcher(
      makeDeps({
        fetchPage,
        shouldAbort: () => aborted,
        random: () => 0,
      }),
    );
    await expect(
      fetchList('following', () => {
        aborted = true;
      }),
    ).resolves.toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('waits while paused and resumes afterwards', async () => {
    let paused = true;
    const sleep = vi.fn(async () => {
      paused = false;
    });
    const fetchPage = vi.fn(async () => pageOf([user(1)]));
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, sleep, isPaused: () => paused }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stops at the page safety limit', async () => {
    const fetchPage = vi.fn(async () => pageOf([user(1)], 'next'));
    const onNotice = vi.fn();
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, pageSafetyLimit: 2, onNotice }));
    await expect(fetchList('following', () => undefined)).resolves.toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(onNotice).toHaveBeenCalledWith('page safety limit 2 reached');
  });

  it('paces requests between pages with jitter', async () => {
    const sleep = vi.fn(async () => undefined);
    let pageIndex = 0;
    const fetchPage = async () => {
      pageIndex++;
      return pageIndex === 1 ? pageOf([user(1)], 'next') : pageOf([]);
    };
    const fetchList = createFriendshipsListFetcher(makeDeps({ fetchPage, sleep, random: () => 0.5 }));
    await fetchList('following', () => undefined);
    expect(sleep).toHaveBeenCalledWith(1450);
  });

  it('takes the long safety pause every N requests', async () => {
    const sleep = vi.fn(async () => undefined);
    let pageIndex = 0;
    const fetchPage = async () => {
      pageIndex++;
      return pageIndex < 3 ? pageOf([user(pageIndex)], 'next') : pageOf([]);
    };
    const fetchList = createFriendshipsListFetcher(
      makeDeps({
        fetchPage,
        sleep,
        random: () => 0,
        pacing: { minDelayMs: 10, maxExtraDelayMs: 0, longPauseEveryRequests: 2, longPauseMs: 999 },
      }),
    );
    await fetchList('following', () => undefined);
    expect(sleep).toHaveBeenCalledWith(999);
  });
});

describe('isTransientFetchError', () => {
  it('flags 429 and 5xx InstagramApiError', () => {
    const rateLimited: any = new Error('rate limited');
    rateLimited.name = 'InstagramApiError';
    rateLimited.status = 429;
    const serverError: any = new Error('boom');
    serverError.name = 'InstagramApiError';
    serverError.status = 503;
    expect(isTransientFetchError(rateLimited)).toBe(true);
    expect(isTransientFetchError(serverError)).toBe(true);
  });

  it('flags feedback_required style soft blocks', () => {
    const blocked: any = new Error('feedback_required');
    blocked.name = 'InstagramApiError';
    blocked.status = 400;
    expect(isTransientFetchError(blocked)).toBe(true);
  });

  it('flags network-ish errors', () => {
    expect(isTransientFetchError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientFetchError(new Error('network timeout'))).toBe(true);
  });

  it('does not flag ordinary non-transient errors', () => {
    const notFound: any = new Error('Not found');
    notFound.name = 'InstagramApiError';
    notFound.status = 404;
    expect(isTransientFetchError(notFound)).toBe(false);
    expect(isTransientFetchError(new Error('invalid payload'))).toBe(false);
    expect(isTransientFetchError(null)).toBe(false);
  });
});
