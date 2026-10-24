import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAccountListCache,
  createCachedListFetch,
  loadAccountListCache,
  saveAccountListCache,
} from '../../src/utils/account-list-cache';

beforeEach(() => {
  localStorage.clear();
});

const following = [{ pk: 1, username: 'alice', full_name: 'Alice A' }];
const followers = [{ pk: 2, username: 'bob', full_name: 'Bob B' }];

describe('following/followers list cache', () => {
  it('round-trips viewer-scoped lists and replays them through the runner callback', async () => {
    const now = 1_000_000;
    expect(saveAccountListCache('viewer-1', following, followers, localStorage, now)).toBe(true);
    const cached = loadAccountListCache('viewer-1', localStorage, now + 1000);
    expect(cached).not.toBeNull();
    expect(cached?.following).toEqual(following);
    expect(cached?.followers).toEqual(followers);

    const seen: string[][] = [];
    const fetchList = createCachedListFetch(cached!);
    await fetchList('following', users => {
      seen.push(users.map(user => String(user.username)));
    });
    await fetchList('followers', users => {
      seen.push(users.map(user => String(user.username)));
    });
    expect(seen).toEqual([['alice'], ['bob']]);
  });

  it('rejects another viewer and expired lists', () => {
    const now = 1_000_000;
    saveAccountListCache('viewer-1', following, followers, localStorage, now);
    expect(loadAccountListCache('viewer-2', localStorage, now)).toBeNull();
    saveAccountListCache('viewer-1', following, followers, localStorage, now);
    expect(loadAccountListCache('viewer-1', localStorage, now + 31 * 60 * 1000)).toBeNull();
  });

  it('discards corrupted or invalid payloads and supports explicit clearing', () => {
    localStorage.setItem('iu_account-lists', '{not json');
    expect(loadAccountListCache('viewer-1', localStorage, Date.now())).toBeNull();
    localStorage.setItem('iu_account-lists', JSON.stringify({ version: 1, viewerId: 'viewer-1', fetchedAt: Date.now(), following: [{ nope: true }], followers: [] }));
    expect(loadAccountListCache('viewer-1', localStorage, Date.now())).toBeNull();
    saveAccountListCache('viewer-1', following, followers, localStorage, Date.now());
    clearAccountListCache(localStorage);
    expect(loadAccountListCache('viewer-1', localStorage, Date.now())).toBeNull();
  });
});
