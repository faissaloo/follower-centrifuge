import { beforeEach, describe, expect, it } from 'vitest';
import { DailyShortlistState } from '../../src/model/growth';
import {
  isShortlistDue,
  loadFilterPrompt,
  loadShortlistState,
  nextDueAt,
  saveFilterPrompt,
  saveShortlistState,
  withSeenHistory,
  loadSeedAccounts,
  parseSeedAccounts,
  saveSeedAccounts,
} from '../../src/utils/daily-shortlist';

const state: DailyShortlistState = {
  version: 1,
  refreshedAt: 1_000_000,
  dueAt: 1_000_000 + 24 * 60 * 60 * 1000,
  filterPrompt: 'ceramics and printmaking',
  entries: [
    {
      id: '1',
      username: 'clay.studio',
      fullName: 'Clay Studio',
      biography: 'handbuilt stoneware',
      profilePicUrl: '',
      isPrivate: false,
      isVerified: false,
      followerCount: 1200,
      followingCount: 300,
      score: 0.81,
      sourceCount: 1,
      networkDistance: 1,
    },
  ],
  seen: {},
};

beforeEach(() => {
  localStorage.clear();
});

describe('daily shortlist persistence', () => {
  it('stores the filter prompt in localStorage so it survives a script restart', () => {
    expect(loadFilterPrompt()).toBeTruthy();
    saveFilterPrompt('process videos and small studios');
    expect(loadFilterPrompt()).toBe('process videos and small studios');
  });

  it('round-trips shortlist state and computes the next due time', () => {
    saveShortlistState(state);
    const loaded = loadShortlistState();
    expect(loaded?.entries[0].username).toBe('clay.studio');
    expect(loaded?.entries[0].sourceCount).toBe(1);
    expect(nextDueAt(1_000_000)).toBe(state.dueAt);
    expect(isShortlistDue(loaded, state.refreshedAt + 1000)).toBe(false);
    expect(isShortlistDue(loaded, state.dueAt)).toBe(true);
  });

  it('stores optional manual seed accounts across restarts', () => {
    const seeds = parseSeedAccounts('@Studio.One, clay.studio\nstudio.one invalid!');
    expect(seeds).toEqual(['studio.one', 'clay.studio']);
    saveSeedAccounts(seeds);
    expect(loadSeedAccounts()).toEqual(seeds);
  });

  it('tracks a 30-day seen history without duplicates', () => {
    const now = 31 * 24 * 60 * 60 * 1000;
    const seen = withSeenHistory({ old: 1 }, state.entries, now);
    expect(seen['clay.studio']).toBe(now);
    expect(seen.old).toBeUndefined();
  });
});
