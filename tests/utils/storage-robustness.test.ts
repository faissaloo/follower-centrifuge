/**
 * LocalStorage is untrusted and may be unavailable (privacy mode, sandboxed
 * iframes, quota errors). Loading must never throw and must never let a
 * malformed whitelist entry break safety checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTimings, loadWhitelist } from '../../src/utils/whitelist-manager';
import { buildWhitelistProtection } from '../../src/utils/whitelist-match';
import { createUserNode } from '../helpers/fixtures';
import { TIMINGS_STORAGE_KEY, WHITELISTED_RESULTS_STORAGE_KEY } from '../../src/constants/constants';

beforeEach(() => {
  localStorage.clear();
});

describe('loadTimings robustness', () => {
  it('returns null when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => loadTimings()).not.toThrow();
    expect(loadTimings()).toBeNull();
    spy.mockRestore();
  });

  it('returns null for corrupt or non-numeric timings', () => {
    localStorage.setItem(TIMINGS_STORAGE_KEY, '{broken');
    expect(loadTimings()).toBeNull();
    localStorage.setItem(TIMINGS_STORAGE_KEY, JSON.stringify({ timeBetweenUnfollows: 'fast' }));
    expect(loadTimings()).toBeNull();
    localStorage.setItem(TIMINGS_STORAGE_KEY, JSON.stringify({ timeBetweenUnfollows: 10 }));
    expect(loadTimings()).toEqual({ timeBetweenUnfollows: 10 });
  });
});

describe('loadWhitelist robustness', () => {
  it('returns [] when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => loadWhitelist()).not.toThrow();
    expect(loadWhitelist()).toEqual([]);
    spy.mockRestore();
  });

  it('filters malformed entries instead of crashing protection checks', () => {
    localStorage.setItem(
      WHITELISTED_RESULTS_STORAGE_KEY,
      JSON.stringify([
        null,
        42,
        'hello',
        { id: 'good-1', username: 'alice' },
        { id: 7, username: 'bob' },
        { id: 'good-2' },
        { id: '', username: 'zed' },
      ]),
    );
    const whitelist = loadWhitelist();
    expect(whitelist.map(entry => entry.id)).toEqual(['good-1']);
    // A malformed list must still produce a usable protection descriptor.
    expect(() => buildWhitelistProtection(whitelist)).not.toThrow();
    expect(buildWhitelistProtection(whitelist).ids.has('good-1')).toBe(true);
  });

  it('tolerates non-object entries passed directly to protection helpers', () => {
    const malformed = [null, 42, createUserNode({ id: 'ok', username: 'carol' })] as unknown as UserNodeList;
    expect(() => buildWhitelistProtection(malformed)).not.toThrow();
    expect(buildWhitelistProtection(malformed).ids.has('ok')).toBe(true);
  });
});

type UserNodeList = Parameters<typeof buildWhitelistProtection>[0];
