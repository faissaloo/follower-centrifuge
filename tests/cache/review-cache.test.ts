import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearReviewCache,
  isReviewCacheFresh,
  loadReviewCache,
  parseReviewCacheRecord,
  ReviewCacheRecord,
  saveReviewCache,
} from '../../src/utils/review-cache';
import { createCandidate, FIXED_NOW } from '../helpers/fixtures';
import { REVIEW_CACHE_STORAGE_KEY, REVIEW_CACHE_VERSION } from '../../src/constants/constants';

function record(overrides: Partial<ReviewCacheRecord> = {}): ReviewCacheRecord {
  const candidates = [createCandidate({ id: 'a', username: 'alice', gender: 'woman', confidence: 0.9 })];
  return {
    version: REVIEW_CACHE_VERSION,
    demo: false,
    viewerId: 'viewer-1',
    candidates,
    whitelistedResults: [candidates[0].user],
    classifierVersion: 'deepseek-chat:v1',
    scanComplete: true,
    followingComplete: true,
    followersComplete: true,
    classificationFailures: 2,
    totalFetched: 10,
    scanTimestamp: 1735689600000,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('review cache', () => {
  it('upgrades legacy woman/man/unknown cached categories onto the five-category model', () => {
    const raw = JSON.parse(JSON.stringify(record())) as {
      candidates: Array<{ gender: { gender: string } }>;
    };
    raw.candidates[0].gender.gender = 'woman';
    const parsedWoman = parseReviewCacheRecord(raw);
    expect(parsedWoman?.candidates[0].gender?.gender).toBe('female');

    raw.candidates[0].gender.gender = 'man';
    expect(parseReviewCacheRecord(raw)?.candidates[0].gender?.gender).toBe('male');

    raw.candidates[0].gender.gender = 'unknown';
    expect(parseReviewCacheRecord(raw)?.candidates[0].gender?.gender).toBe('ambiguous');
  });

  it('accepts TypeSafe provenance in a cached guess', () => {
    const raw = JSON.parse(JSON.stringify(record())) as {
      candidates: Array<{ gender: { source: string } }>;
    };
    raw.candidates[0].gender.source = 'typesafe';
    expect(parseReviewCacheRecord(raw)?.candidates[0].gender?.source).toBe('typesafe');
  });

  it('accepts the five canonical categories in a cached guess', () => {
    const raw = JSON.parse(JSON.stringify(record())) as {
      candidates: Array<{ gender: { gender: string } }>;
    };
    for (const category of ['female', 'male', 'machine', 'organization', 'ambiguous']) {
      raw.candidates[0].gender.gender = category;
      expect(parseReviewCacheRecord(raw)?.candidates[0].gender?.gender).toBe(category);
    }
  });

  it('round-trips a completed review', () => {
    const original = record();
    saveReviewCache(original);
    const loaded = loadReviewCache(FIXED_NOW + 1000, 'viewer-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.candidates.map(c => c.user.id)).toEqual(['a']);
    expect(loaded?.candidates[0].user.username).toBe('alice');
    expect(loaded?.candidates[0].relationship).toBe('following');
    expect(loaded?.candidates[0].gender).toEqual(original.candidates[0].gender);
    expect(loaded?.whitelistedResults.map(u => u.id)).toEqual(['a']);
    expect(loaded?.classifierVersion).toBe('deepseek-chat:v1');
    expect(loaded?.scanComplete).toBe(true);
    expect(loaded?.classificationFailures).toBe(2);
    expect(loaded?.totalFetched).toBe(10);
    expect(loaded?.scanTimestamp).toBe(1735689600000);
    expect(loaded?.demo).toBe(false);
  });

  it('returns null when nothing is cached', () => {
    expect(loadReviewCache(FIXED_NOW + 1000, 'viewer-1')).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    localStorage.setItem(REVIEW_CACHE_STORAGE_KEY, '{broken');
    expect(loadReviewCache(FIXED_NOW + 1000, 'viewer-1')).toBeNull();
  });

  it('rejects records from an older cache version', () => {
    localStorage.setItem(REVIEW_CACHE_STORAGE_KEY, JSON.stringify({ ...record(), version: 0 }));
    expect(loadReviewCache(FIXED_NOW + 1000, 'viewer-1')).toBeNull();
  });

  it('rejects records with missing or malformed candidates', () => {
    expect(parseReviewCacheRecord({ ...record(), candidates: 'nope' })).toBeNull();
    expect(parseReviewCacheRecord({ ...record(), candidates: [{ user: {} }] })).toBeNull();
    expect(parseReviewCacheRecord({ ...record(), candidates: [null] })).toBeNull();
  });

  it('rejects unknown relationship values', () => {
    const candidate = createCandidate();
    const raw = JSON.parse(JSON.stringify(record()));
    raw.candidates[0].relationship = 'enemy';
    expect(parseReviewCacheRecord(raw)).toBeNull();
    expect(candidate).toBeTruthy();
  });

  it('rejects malformed gender data', () => {
    const raw = JSON.parse(JSON.stringify(record()));
    raw.candidates[0].gender = { gender: 'robot', confidence: 1, source: 'deepseek' };
    expect(parseReviewCacheRecord(raw)).toBeNull();
  });

  it('accepts candidates that were never classified (gender null)', () => {
    const raw = JSON.parse(JSON.stringify(record()));
    raw.candidates[0].gender = null;
    const parsed = parseReviewCacheRecord(raw);
    expect(parsed?.candidates[0].gender).toBeNull();
  });

  it('clamps untrusted confidence values into 0..1', () => {
    const raw = JSON.parse(JSON.stringify(record()));
    raw.candidates[0].gender.confidence = 42;
    expect(parseReviewCacheRecord(raw)?.candidates[0].gender?.confidence).toBe(1);
    raw.candidates[0].gender.confidence = -3;
    expect(parseReviewCacheRecord(raw)?.candidates[0].gender?.confidence).toBe(0);
  });

  it('fills defaults for optional user fields', () => {
    const raw = JSON.parse(JSON.stringify(record()));
    delete raw.candidates[0].user.full_name;
    delete raw.candidates[0].user.is_private;
    const parsed = parseReviewCacheRecord(raw);
    expect(parsed?.candidates[0].user.full_name).toBe('');
    expect(parsed?.candidates[0].user.is_private).toBe(false);
  });

  it('clears the cache', () => {
    saveReviewCache(record());
    clearReviewCache();
    expect(loadReviewCache(FIXED_NOW + 1000, 'viewer-1')).toBeNull();
  });

  it('does not throw when localStorage is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveReviewCache(record())).not.toThrow();
    setItem.mockRestore();
    warn.mockRestore();
  });

  it('rejects demo records outright, even if they were persisted by an older build', () => {
    const demoRecord = record({ demo: true });
    expect(parseReviewCacheRecord(JSON.parse(JSON.stringify(demoRecord)))?.demo).toBe(true);

    localStorage.setItem(REVIEW_CACHE_STORAGE_KEY, JSON.stringify(demoRecord));
    expect(loadReviewCache(FIXED_NOW + 1000, 'viewer-1')).toBeNull();
  });

  it('rejects records without an explicit demo flag (shape changed)', () => {
    const raw = JSON.parse(JSON.stringify(record())) as Record<string, unknown>;
    delete raw.demo;
    expect(parseReviewCacheRecord(raw)).toBeNull();
  });

  it('refuses a cached review that belongs to a different Instagram viewer', () => {
    saveReviewCache(record());
    expect(loadReviewCache(FIXED_NOW + 1000, 'viewer-2')).toBeNull();
  });

  it('refuses a cached review when no viewer session is known', () => {
    saveReviewCache(record());
    expect(loadReviewCache(FIXED_NOW + 1000, null)).toBeNull();
    expect(loadReviewCache(FIXED_NOW + 1000, '')).toBeNull();
  });

  it('accepts the cache only for the viewer that produced it', () => {
    saveReviewCache(record());
    expect(loadReviewCache(FIXED_NOW + 1000, 'viewer-1')).not.toBeNull();
  });

  it('ignores a cache that is older than the freshness window', () => {
    saveReviewCache(record());
    const dayPlus = FIXED_NOW + 24 * 60 * 60 * 1000 + 1;
    expect(isReviewCacheFresh(record(), dayPlus)).toBe(false);
    expect(loadReviewCache(dayPlus, 'viewer-1')).toBeNull();
  });

  it('accepts a cache just inside the freshness window', () => {
    saveReviewCache(record());
    const justInside = FIXED_NOW + 24 * 60 * 60 * 1000 - 1;
    expect(loadReviewCache(justInside, 'viewer-1')).not.toBeNull();
  });

  it('ignores a cache timestamped suspiciously far in the future', () => {
    saveReviewCache(record());
    // `now` in the past relative to the cached timestamp = clock skew/future record.
    const skewedNow = FIXED_NOW - 10 * 60 * 1000;
    expect(isReviewCacheFresh(record(), skewedNow)).toBe(false);
    expect(loadReviewCache(skewedNow, 'viewer-1')).toBeNull();
  });
});
