/**
 * Versioned, bounded localStorage cache for gender guesses.
 *
 * Why a cache at all? A scan can classify hundreds of accounts, the model is
 * paid per token, and re-running the audit should be nearly free. Why so
 * defensive? localStorage is shared with every other script on instagram.com,
 * so the cached JSON must be treated as hostile input:
 *
 *  - the cache lives under a key that includes the classifier `version`, so a
 *    prompt/model change can never resurrect stale guesses;
 *  - malformed JSON, wrong schema versions and individually corrupt entries are
 *    ignored (never thrown), and invalid genders/confidences/ids are dropped;
 *  - the value size is bounded and the entry count is pruned to the newest
 *    {@link GENDER_CACHE_MAX_ENTRIES}, so a hostile or buggy writer cannot fill
 *    the user's storage quota;
 *  - every storage call is wrapped in try/catch: private browsing modes throw.
 *
 * Everything is injectable (`Storage`, clock) so the cache is testable without
 * touching real browser storage.
 */
import { GENDER_CACHE_STORAGE_KEY } from '../model/deepseek-config';
import { GENDER_CATEGORIES, GenderCategory, normalizeGender } from '../model/gender';

/** Maximum number of cached guesses kept per classifier version. */
export const GENDER_CACHE_MAX_ENTRIES = 2000;
/** Maximum raw characters read from localStorage; larger values are corrupt. */
export const GENDER_CACHE_MAX_RAW_LENGTH = 1500000;
/** Schema version of the stored JSON envelope (not the classifier version). */
export const GENDER_CACHE_SCHEMA_VERSION = 1;

/** A cached guess before classifier provenance is re-attached by the caller. */
export interface CachedGenderGuess {
  readonly id: string;
  readonly gender: GenderCategory;
  readonly confidence: number;
  readonly reason?: string;
  readonly classifiedAt: number;
}

/** One result to persist. Same shape as a cached guess; kept separate so the
 * classifier does not depend on the cache's read model. */
export interface GenderCacheWriteEntry {
  readonly id: string;
  readonly gender: GenderCategory;
  readonly confidence: number;
  readonly reason?: string;
  readonly classifiedAt: number;
}

/** Dependencies of {@link createGenderCache}; everything is optional. */
export interface GenderCacheDeps {
  /** Storage implementation; defaults to `window.localStorage` when usable. */
  readonly storage?: Storage;
  /** Clock used for the envelope timestamp; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Maximum retained entries; defaults to {@link GENDER_CACHE_MAX_ENTRIES}. */
  readonly maxEntries?: number;
}

/** The cache contract consumed by the DeepSeek classifier. */
export interface GenderCache {
  /** Cached guesses for the requested ids (missing/corrupt entries omitted). */
  getMany(version: string, ids: readonly string[]): Map<string, CachedGenderGuess>;
  /** Store guesses and prune the cache to its bounded size. Never throws. */
  putMany(version: string, entries: readonly GenderCacheWriteEntry[]): void;
  /** Remove the cache for one classifier version (or the current version). */
  clear(version: string): void;
}

interface CacheEnvelope {
  readonly schema: number;
  readonly version: string;
  readonly savedAt: number;
  readonly entries: readonly CachedGenderGuess[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** localStorage key for one classifier version. */
export function genderCacheStorageKey(version: string): string {
  return `${GENDER_CACHE_STORAGE_KEY}:${version}`;
}

/**
 * Resolve a usable Storage implementation. Writing a probe key catches private
 * modes that expose localStorage but throw on `setItem`.
 */
function resolveStorage(explicitStorage: Storage | undefined): Storage | null {
  if (explicitStorage !== undefined) {
    return explicitStorage;
  }
  try {
    // Probe with a write: some privacy modes expose localStorage but throw on
    // setItem. A ReferenceError in a non-browser context is caught too.
    const probeKey = `${GENDER_CACHE_STORAGE_KEY}:__probe__`;
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Parse an untrusted cached category. The five current categories pass
 * through; legacy `woman`/`man`/`unknown` guesses from an older classifier
 * version are mapped onto `female`/`male`/`ambiguous` so old caches stay
 * usable instead of being discarded. Anything else is corrupt.
 */
function parseCachedGender(value: unknown): GenderCategory | null {
  if (value === 'woman' || value === 'man' || value === 'unknown') {
    return normalizeGender(value);
  }
  for (const category of GENDER_CATEGORIES) {
    if (value === category) {
      return category;
    }
  }
  return null;
}

/** Validate one untrusted cached entry; returns null when it must be ignored. */
function toCachedGuess(value: unknown): CachedGenderGuess | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  if (typeof id !== 'string' || id === '' || id.length > 512) {
    return null;
  }
  const gender = parseCachedGender(value.gender);
  if (gender === null) {
    return null;
  }
  const confidence = value.confidence;
  // Out-of-range values mean corruption/tampering: drop instead of clamping so
  // a hostile page cannot promote an account to a confident "likely woman".
  if (typeof confidence !== 'number' || !isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }
  const classifiedAt = value.classifiedAt;
  if (typeof classifiedAt !== 'number' || !isFinite(classifiedAt) || classifiedAt < 0) {
    return null;
  }
  const reason = typeof value.reason === 'string' && value.reason !== '' ? value.reason : null;
  if (reason === null) {
    return { id, gender, confidence, classifiedAt };
  }
  return { id, gender, confidence, reason, classifiedAt };
}

function parseEnvelope(raw: string, version: string): readonly CachedGenderGuess[] {
  if (raw.length > GENDER_CACHE_MAX_RAW_LENGTH) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    return [];
  }
  if (parsed.schema !== GENDER_CACHE_SCHEMA_VERSION || parsed.version !== version) {
    return [];
  }
  const entries = parsed.entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  const valid: CachedGenderGuess[] = [];
  for (const entry of entries) {
    const guess = toCachedGuess(entry);
    if (guess !== null) {
      valid.push(guess);
    }
  }
  return valid;
}

/** Stable ordering for pruning: oldest first, id as deterministic tie-breaker. */
function compareOldestFirst(left: CachedGenderGuess, right: CachedGenderGuess): number {
  if (left.classifiedAt !== right.classifiedAt) {
    return left.classifiedAt - right.classifiedAt;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

function readEnvelope(storage: Storage, version: string): readonly CachedGenderGuess[] {
  try {
    const raw = storage.getItem(genderCacheStorageKey(version));
    if (raw === null) {
      return [];
    }
    return parseEnvelope(raw, version);
  } catch {
    // Corrupt JSON, quota errors while reading, disabled storage: cache miss.
    return [];
  }
}

function normalizeMaxEntries(value: number | undefined): number {
  if (value === undefined || !isFinite(value) || value < 1) {
    return GENDER_CACHE_MAX_ENTRIES;
  }
  return Math.floor(value);
}

/**
 * Create a cache bound to one Storage implementation. Failures never propagate
 * into the classification flow: the cache is an optimisation, not a source of
 * truth.
 */
export function createGenderCache(deps: GenderCacheDeps = {}): GenderCache {
  const storage = resolveStorage(deps.storage);
  const now = deps.now !== undefined ? deps.now : () => Date.now();
  const maxEntries = normalizeMaxEntries(deps.maxEntries);

  function getMany(version: string, ids: readonly string[]): Map<string, CachedGenderGuess> {
    const matches = new Map<string, CachedGenderGuess>();
    if (storage === null || ids.length === 0) {
      return matches;
    }
    const wanted = new Set<string>();
    for (const id of ids) {
      wanted.add(id);
    }
    const entries = readEnvelope(storage, version);
    for (const entry of entries) {
      if (wanted.has(entry.id) && !matches.has(entry.id)) {
        matches.set(entry.id, entry);
      }
    }
    return matches;
  }

  function putMany(version: string, written: readonly GenderCacheWriteEntry[]): void {
    if (storage === null || written.length === 0) {
      return;
    }
    try {
      const combined: CachedGenderGuess[] = [];
      const indexById = new Map<string, number>();
      const existing = readEnvelope(storage, version);
      for (const entry of existing) {
        indexById.set(entry.id, combined.length);
        combined.push(entry);
      }
      for (const guess of written) {
        const record: CachedGenderGuess = {
          id: guess.id,
          gender: guess.gender,
          confidence: guess.confidence,
          classifiedAt: guess.classifiedAt,
        };
        const withReason: CachedGenderGuess = guess.reason === undefined ? record : { ...record, reason: guess.reason };
        const existingIndex = indexById.get(guess.id);
        if (existingIndex === undefined) {
          indexById.set(guess.id, combined.length);
          combined.push(withReason);
        } else {
          combined[existingIndex] = withReason;
        }
      }
      let bounded = combined;
      if (combined.length > maxEntries) {
        const sorted = combined.slice(0).sort(compareOldestFirst);
        bounded = sorted.slice(sorted.length - maxEntries);
      }
      const envelope: CacheEnvelope = {
        schema: GENDER_CACHE_SCHEMA_VERSION,
        version,
        savedAt: now(),
        entries: bounded,
      };
      storage.setItem(genderCacheStorageKey(version), JSON.stringify(envelope));
    } catch {
      // Quota exceeded or storage disabled: drop the cache write silently. The
      // in-memory results are still returned to the caller.
    }
  }

  function clear(version: string): void {
    if (storage === null) {
      return;
    }
    try {
      storage.removeItem(genderCacheStorageKey(version));
    } catch {
      // Ignore: an unremovable cache entry is ignored on read anyway.
    }
  }

  return { getMany, putMany, clear };
}
