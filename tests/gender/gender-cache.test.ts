import { describe, expect, it } from 'vitest';
import { GENDER_CACHE_STORAGE_KEY } from '../../src/model/deepseek-config';
import { GenderCategory } from '../../src/model/gender';
import {
  GENDER_CACHE_MAX_RAW_LENGTH,
  GENDER_CACHE_SCHEMA_VERSION,
  GenderCacheWriteEntry,
  createGenderCache,
  genderCacheStorageKey,
} from '../../src/utils/gender-cache';
import { BrokenStorage, MemoryStorage } from './test-helpers';

function entry(id: string, classifiedAt = 1, gender: GenderCategory = 'female', confidence = 0.9): GenderCacheWriteEntry {
  return { id, gender, confidence, classifiedAt, reason: 'test reason' };
}

interface RawEnvelope {
  readonly schema?: number;
  readonly version?: string;
  readonly savedAt?: number;
  readonly entries: readonly unknown[];
}

function writeRaw(storage: MemoryStorage, version: string, envelope: RawEnvelope): void {
  storage.setItem(genderCacheStorageKey(version), JSON.stringify(envelope));
}

function readRaw(storage: MemoryStorage, version: string): RawEnvelope {
  const raw = storage.getItem(genderCacheStorageKey(version));
  if (raw === null) {
    throw new Error('cache key is missing');
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('cache envelope is not an object');
  }
  return parsed as RawEnvelope;
}

describe('gender cache storage key', () => {
  it('namespaces the localStorage key by classifier version', () => {
    expect(genderCacheStorageKey('v1:deepseek-chat:proxy')).toBe(`${GENDER_CACHE_STORAGE_KEY}:v1:deepseek-chat:proxy`);
    expect(genderCacheStorageKey('a')).not.toBe(genderCacheStorageKey('b'));
  });
});

describe('gender cache read/write', () => {
  it('stores and retrieves guesses for the same version', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage, now: () => 1000 });
    cache.putMany('v1', [entry('a', 10), entry('b', 20, 'male', 0.75)]);
    const hits = cache.getMany('v1', ['a', 'b', 'missing']);
    expect(hits.size).toBe(2);
    expect(hits.get('a')).toMatchObject({ gender: 'female', confidence: 0.9, reason: 'test reason', classifiedAt: 10 });
    expect(hits.get('b')).toMatchObject({ gender: 'male', confidence: 0.75 });
    expect(hits.has('missing')).toBe(false);
  });

  it('keeps machine and organization guesses as first-class categories', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage });
    cache.putMany('v1', [entry('bot', 10, 'machine', 0.88), entry('brand', 20, 'organization', 0.81)]);
    const hits = cache.getMany('v1', ['bot', 'brand']);
    expect(hits.get('bot')).toMatchObject({ gender: 'machine', confidence: 0.88 });
    expect(hits.get('brand')).toMatchObject({ gender: 'organization', confidence: 0.81 });
  });

  it('maps legacy woman/man/unknown cache entries onto the current categories', () => {
    const storage = new MemoryStorage();
    writeRaw(storage, 'v1', {
      schema: GENDER_CACHE_SCHEMA_VERSION,
      version: 'v1',
      savedAt: 1,
      entries: [
        entry('legacy-woman', 1, 'female', 0.9),
        entry('legacy-man', 2, 'male', 0.9),
        entry('legacy-unknown', 3, 'ambiguous', 0.2),
      ].map(({ id, confidence, classifiedAt }) => ({
        id,
        gender: id === 'legacy-woman' ? 'woman' : id === 'legacy-man' ? 'man' : 'unknown',
        confidence,
        classifiedAt,
      })),
    });
    const hits = createGenderCache({ storage }).getMany('v1', ['legacy-woman', 'legacy-man', 'legacy-unknown']);
    expect(hits.size).toBe(3);
    expect(hits.get('legacy-woman')?.gender).toBe('female');
    expect(hits.get('legacy-man')?.gender).toBe('male');
    expect(hits.get('legacy-unknown')?.gender).toBe('ambiguous');
  });

  it('misses everything for a different classifier version', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage });
    cache.putMany('version-1', [entry('a')]);
    expect(cache.getMany('version-2', ['a']).size).toBe(0);
    // The old version's entries are still readable under their own key.
    expect(cache.getMany('version-1', ['a']).size).toBe(1);
  });

  it('overwrites an existing entry instead of duplicating it', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage });
    cache.putMany('v1', [entry('a', 10, 'male', 0.4)]);
    cache.putMany('v1', [entry('a', 20, 'female', 0.95)]);
    const hits = cache.getMany('v1', ['a']);
    expect(hits.get('a')).toMatchObject({ gender: 'female', confidence: 0.95, classifiedAt: 20 });
    expect(readRaw(storage, 'v1').entries).toHaveLength(1);
  });

  it('does nothing when asked to write zero entries', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage });
    cache.putMany('v1', []);
    expect(storage.length).toBe(0);
  });

  it('clear removes only the requested version', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage });
    cache.putMany('v1', [entry('a')]);
    cache.putMany('v2', [entry('b')]);
    cache.clear('v1');
    expect(cache.getMany('v1', ['a']).size).toBe(0);
    expect(cache.getMany('v2', ['b']).size).toBe(1);
  });
});

describe('gender cache corruption tolerance', () => {
  it('ignores invalid JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(genderCacheStorageKey('v1'), '{not json');
    const cache = createGenderCache({ storage });
    expect(cache.getMany('v1', ['a']).size).toBe(0);
  });

  it('ignores envelopes with the wrong schema or version', () => {
    const storage = new MemoryStorage();
    writeRaw(storage, 'v1', { schema: 99, version: 'v1', savedAt: 1, entries: [entry('a')] });
    writeRaw(storage, 'v2', { schema: GENDER_CACHE_SCHEMA_VERSION, version: 'other', savedAt: 1, entries: [entry('b')] });
    const cache = createGenderCache({ storage });
    expect(cache.getMany('v1', ['a']).size).toBe(0);
    expect(cache.getMany('v2', ['b']).size).toBe(0);
  });

  it('drops individually corrupt or tampered entries', () => {
    const storage = new MemoryStorage();
    writeRaw(storage, 'v1', {
      schema: GENDER_CACHE_SCHEMA_VERSION,
      version: 'v1',
      savedAt: 1,
      entries: [
        { id: 'alien', gender: 'alien', confidence: 0.9, classifiedAt: 1 },
        { id: 'too-confident', gender: 'woman', confidence: 7, classifiedAt: 1 },
        { id: 'negative-confidence', gender: 'woman', confidence: -0.2, classifiedAt: 1 },
        { id: '', gender: 'woman', confidence: 0.5, classifiedAt: 1 },
        { id: 'bad-date', gender: 'woman', confidence: 0.5, classifiedAt: 'yesterday' },
        { id: 'valid', gender: 'woman', confidence: 0.5, classifiedAt: 1 },
        null,
        'not an object',
      ],
    });
    const hits = createGenderCache({ storage }).getMany('v1', [
      'alien',
      'too-confident',
      'negative-confidence',
      'bad-date',
      'valid',
    ]);
    // A tampered high confidence must not promote an account: the entry is
    // dropped, not clamped.
    expect(hits.size).toBe(1);
    expect(hits.get('valid')).toMatchObject({ gender: 'female', confidence: 0.5 });
  });

  it('keeps the first stored entry when ids are duplicated', () => {
    const storage = new MemoryStorage();
    writeRaw(storage, 'v1', {
      schema: GENDER_CACHE_SCHEMA_VERSION,
      version: 'v1',
      savedAt: 1,
      entries: [entry('a', 10, 'female', 0.9), entry('a', 20, 'male', 0.3)],
    });
    const hits = createGenderCache({ storage }).getMany('v1', ['a']);
    expect(hits.get('a')).toMatchObject({ gender: 'female', confidence: 0.9 });
  });

  it('ignores absurdly large raw values without parsing them', () => {
    const storage = new MemoryStorage();
    storage.setItem(genderCacheStorageKey('v1'), 'x'.repeat(GENDER_CACHE_MAX_RAW_LENGTH + 1));
    expect(createGenderCache({ storage }).getMany('v1', ['a']).size).toBe(0);
  });

  it('survives a storage implementation that throws on every call', () => {
    const cache = createGenderCache({ storage: new BrokenStorage() });
    expect(() => {
      cache.putMany('v1', [entry('a')]);
    }).not.toThrow();
    expect(cache.getMany('v1', ['a']).size).toBe(0);
    expect(() => {
      cache.clear('v1');
    }).not.toThrow();
  });
});

describe('gender cache pruning', () => {
  it('keeps only the newest entries when the bound is exceeded', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage, maxEntries: 3 });
    cache.putMany('v1', [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4), entry('e', 5)]);
    const hits = cache.getMany('v1', ['a', 'b', 'c', 'd', 'e']);
    expect(hits.size).toBe(3);
    expect(hits.has('a')).toBe(false);
    expect(hits.has('b')).toBe(false);
    expect(hits.has('c')).toBe(true);
    expect(hits.has('d')).toBe(true);
    expect(hits.has('e')).toBe(true);
  });

  it('breaks timestamp ties deterministically by id', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage, maxEntries: 2 });
    cache.putMany('v1', [entry('b', 1), entry('a', 1), entry('c', 1)]);
    const hits = cache.getMany('v1', ['a', 'b', 'c']);
    expect(hits.has('a')).toBe(false);
    expect(hits.has('b')).toBe(true);
    expect(hits.has('c')).toBe(true);
  });

  it('prunes existing entries when new ones push past the bound', () => {
    const storage = new MemoryStorage();
    const cache = createGenderCache({ storage, maxEntries: 2 });
    cache.putMany('v1', [entry('a', 1), entry('b', 2)]);
    cache.putMany('v1', [entry('c', 3)]);
    const hits = cache.getMany('v1', ['a', 'b', 'c']);
    expect(hits.size).toBe(2);
    expect(hits.has('a')).toBe(false);
    expect(hits.has('b')).toBe(true);
    expect(hits.has('c')).toBe(true);
  });
});
