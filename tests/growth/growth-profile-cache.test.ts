import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileInfo } from '../../src/utils/utils';
import { createCachedProfileFetcher } from '../../src/utils/growth-profile-cache';

const profile: ProfileInfo = {
  id: '1',
  username: 'clay.studio',
  fullName: 'Clay Studio',
  biography: 'process work',
  profilePicUrl: '',
  isPrivate: false,
  isVerified: false,
  followerCount: 100,
  followingCount: 100,
};

beforeEach(() => {
  localStorage.clear();
});

describe('growth profile cache', () => {
  it('reuses a successful profile lookup and does not refetch it', async () => {
    const fetchProfile = vi.fn(async () => profile);
    const now = () => 1_000_000;
    const cached = createCachedProfileFetcher(fetchProfile, { now });
    expect(await cached('clay.studio')).toEqual(profile);
    expect(await cached('clay.studio')).toEqual(profile);
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });

  it('remembers a permanently unavailable profile for 24 hours', async () => {
    const unavailable = Object.assign(new Error('not found'), { status: 404 });
    const fetchProfile = vi.fn(async () => {
      throw unavailable;
    });
    let now = 1_000_000;
    const cached = createCachedProfileFetcher(fetchProfile, { now: () => now });
    await expect(cached('private.account')).rejects.toThrow();
    await expect(cached('private.account')).rejects.toThrow(/unavailable/);
    expect(fetchProfile).toHaveBeenCalledTimes(1);
    now += 25 * 60 * 60 * 1000;
    await expect(cached('private.account')).rejects.toThrow();
    expect(fetchProfile).toHaveBeenCalledTimes(2);
  });

  it('stops hammering profiles after a 429 and keeps a cooldown', async () => {
    const limited = Object.assign(new Error('too many requests'), { status: 429 });
    const fetchProfile = vi.fn(async () => {
      throw limited;
    });
    let now = 1_000_000;
    const cached = createCachedProfileFetcher(fetchProfile, { now: () => now });
    await expect(cached('first.account')).rejects.toThrow(/429|too many/i);
    await expect(cached('second.account')).rejects.toThrow(/rate-limiting/i);
    expect(fetchProfile).toHaveBeenCalledTimes(1);
    now += 31 * 60 * 1000;
    await expect(cached('second.account')).rejects.toThrow(/429|too many/i);
    expect(fetchProfile).toHaveBeenCalledTimes(2);
  });
});
