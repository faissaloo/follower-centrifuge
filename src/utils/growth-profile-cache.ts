import { ProfileInfo } from './utils';

/**
 * Small cache of public profile reads for the Daily 20 shortlist. It avoids
 * re-reading the same profiles every day and remembers which profiles are
 * unavailable (private/deleted) so we don't waste request budget on them.
 * Only public profile fields are stored.
 */
export const GROWTH_PROFILE_CACHE_KEY = 'iu_growth-profile-cache';
export const GROWTH_PROFILE_CACHE_VERSION = 1;
export const GROWTH_PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GROWTH_PROFILE_UNAVAILABLE_TTL_MS = 24 * 60 * 60 * 1000;
export const GROWTH_PROFILE_RATE_LIMIT_KEY = 'iu_growth-profile-rate-limited-until';
export const GROWTH_PROFILE_RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 250;

interface CachedProfileEntry {
  readonly profile: ProfileInfo | null;
  readonly checkedAt: number;
}

interface ProfileCacheFile {
  readonly version: number;
  readonly entries: Record<string, CachedProfileEntry>;
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProfile(value: unknown): ProfileInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  const username = typeof value.username === 'string' ? value.username : '';
  if (username === '') {
    return null;
  }
  return {
    id: typeof value.id === 'string' ? value.id : username,
    username,
    fullName: typeof value.fullName === 'string' ? value.fullName : '',
    biography: typeof value.biography === 'string' ? value.biography : '',
    profilePicUrl: typeof value.profilePicUrl === 'string' ? value.profilePicUrl : '',
    isPrivate: value.isPrivate === true,
    isVerified: value.isVerified === true,
    followerCount: typeof value.followerCount === 'number' && isFinite(value.followerCount) ? value.followerCount : 0,
    followingCount: typeof value.followingCount === 'number' && isFinite(value.followingCount) ? value.followingCount : 0,
  };
}

function loadCache(storage: Storage | null): ProfileCacheFile {
  if (storage === null) {
    return { version: GROWTH_PROFILE_CACHE_VERSION, entries: {} };
  }
  try {
    const raw = storage.getItem(GROWTH_PROFILE_CACHE_KEY);
    if (raw === null) {
      return { version: GROWTH_PROFILE_CACHE_VERSION, entries: {} };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== GROWTH_PROFILE_CACHE_VERSION || !isRecord(parsed.entries)) {
      return { version: GROWTH_PROFILE_CACHE_VERSION, entries: {} };
    }
    const entries: Record<string, CachedProfileEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!isRecord(value) || typeof value.checkedAt !== 'number' || !isFinite(value.checkedAt)) {
        continue;
      }
      if (value.profile === null) {
        entries[key.toLowerCase()] = { profile: null, checkedAt: value.checkedAt };
      } else {
        const profile = readProfile(value.profile);
        if (profile !== null) {
          entries[key.toLowerCase()] = { profile, checkedAt: value.checkedAt };
        }
      }
    }
    return { version: GROWTH_PROFILE_CACHE_VERSION, entries };
  } catch {
    return { version: GROWTH_PROFILE_CACHE_VERSION, entries: {} };
  }
}

function saveCache(cache: ProfileCacheFile, storage: Storage | null): void {
  if (storage === null) {
    return;
  }
  const keys = Object.keys(cache.entries);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => cache.entries[b].checkedAt - cache.entries[a].checkedAt);
    for (const key of keys.slice(MAX_ENTRIES)) {
      delete cache.entries[key];
    }
  }
  try {
    storage.setItem(GROWTH_PROFILE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Cache failures are non-fatal.
  }
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 429 || (error instanceof Error && /\b429\b/.test(error.message));
}

function readRateLimitUntil(storage: Storage | null): number {
  if (storage === null) {
return 0;
}
  try {
    const raw = storage.getItem(GROWTH_PROFILE_RATE_LIMIT_KEY);
    const value = raw === null ? 0 : Number(raw);
    return isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeRateLimitUntil(storage: Storage | null, until: number): void {
  if (storage === null) {
return;
}
  try {
    storage.setItem(GROWTH_PROFILE_RATE_LIMIT_KEY, String(until));
  } catch {
    // Non-fatal.
  }
}

function isPermanentlyUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 403 || status === 404 || status === 410;
}

/**
 * Wrap a profile fetcher with the cache. Cached successful profiles are reused
 * for 7 days; known-unavailable profiles are skipped for 24 hours.
 */
export interface ProfileLookup {
  readonly id?: string;
  readonly username: string;
}

export function createCachedProfileFetcher(
  fetchProfile: (lookup: ProfileLookup) => Promise<ProfileInfo>,
  options: {
    readonly storage?: Storage | null;
    readonly now?: () => number;
    readonly cooldownMs?: number;
  } = {},
): (lookup: ProfileLookup | string) => Promise<ProfileInfo> {
  const storage = options.storage === undefined ? storageOrNull() : options.storage;
  const now = options.now ?? (() => Date.now());
  const cooldownMs = options.cooldownMs ?? GROWTH_PROFILE_RATE_LIMIT_COOLDOWN_MS;
  const cache = loadCache(storage);
  return async (lookup: ProfileLookup | string): Promise<ProfileInfo> => {
    const blockedUntil = readRateLimitUntil(storage);
    if (now() < blockedUntil) {
      const remainingMinutes = Math.max(1, Math.ceil((blockedUntil - now()) / 60000));
      const window = remainingMinutes >= 60
        ? `~${Math.ceil(remainingMinutes / 60)} more hours`
        : `~${remainingMinutes} more minutes`;
      throw new Error(`instagram is rate-limiting profile reads; paused for ${window}`);
    }
    const requested = typeof lookup === 'string' ? { username: lookup } : lookup;
    const username = requested.username;
    const key = username.trim().toLowerCase();
    const entries = cache.entries as Record<string, CachedProfileEntry | undefined>;
    const hit = entries[key];
    if (hit !== undefined) {
      const ttl = hit.profile === null ? GROWTH_PROFILE_UNAVAILABLE_TTL_MS : GROWTH_PROFILE_TTL_MS;
      if (now() - hit.checkedAt < ttl) {
        if (hit.profile === null) {
          throw new Error(`profile unavailable: @${username}`);
        }
        return hit.profile;
      }
      delete cache.entries[key];
    }
    try {
      const profile = await fetchProfile(requested);
      cache.entries[key] = { profile, checkedAt: now() };
      saveCache(cache, storage);
      return profile;
    } catch (error) {
      if (isRateLimited(error)) {
        writeRateLimitUntil(storage, now() + cooldownMs);
      } else if (isPermanentlyUnavailable(error)) {
        cache.entries[key] = { profile: null, checkedAt: now() };
        saveCache(cache, storage);
      }
      throw error;
    }
  };
}
