import { FetchListUser } from '../model/audit';

/**
 * 30-day cache of the sampled seed accounts' follower/following lists.
 *
 * These lists change slowly; re-reading every refresh is wasteful and noisy.
 * Seeds are reused across refreshes while fresh, and their lists are served
 * from this cache instead of hitting Instagram.
 */
export const GROWTH_GRAPH_CACHE_KEY = 'iu_growth-graph-cache';
export const GROWTH_GRAPH_CACHE_VERSION = 3;
export const GROWTH_GRAPH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SEEDS = 24;
const MAX_USERS_PER_LIST = 200;

export interface CachedSeedGraph {
  readonly seed: FetchListUser;
  readonly following: readonly FetchListUser[];
  readonly followers: readonly FetchListUser[];
  readonly fetchedAt: number;
  /** Which lists have actually been fetched (empty lists are still fetched). */
  readonly cachedLists: ReadonlyArray<'following' | 'followers'>;
}

export interface GrowthGraphCache {
  readonly version: number;
  readonly entries: Readonly<Record<string, CachedSeedGraph>>;
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

function userKey(user: FetchListUser): string {
  return String(user.pk_id ?? user.pk ?? user.id ?? user.username ?? '');
}

function readUser(value: unknown): FetchListUser | null {
  if (!isRecord(value)) {
    return null;
  }
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const id = userKey(value as unknown as FetchListUser);
  if (username === '' || id === '') {
    return null;
  }
  return {
    ...(typeof value.pk === 'string' || typeof value.pk === 'number' ? { pk: value.pk } : {}),
    ...(typeof value.pk_id === 'string' ? { pk_id: value.pk_id } : {}),
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    username,
    ...(typeof value.full_name === 'string' ? { full_name: value.full_name } : {}),
    ...(typeof value.profile_pic_url === 'string' ? { profile_pic_url: value.profile_pic_url } : {}),
    ...(typeof value.is_private === 'boolean' ? { is_private: value.is_private } : {}),
    ...(typeof value.is_verified === 'boolean' ? { is_verified: value.is_verified } : {}),
  };
}

function readUsers(value: unknown): readonly FetchListUser[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const users: FetchListUser[] = [];
  for (const item of value.slice(0, MAX_USERS_PER_LIST)) {
    const user = readUser(item);
    if (user !== null) {
      users.push(user);
    }
  }
  return users;
}

function readEntry(value: unknown): CachedSeedGraph | null {
  if (!isRecord(value) || typeof value.fetchedAt !== 'number' || !isFinite(value.fetchedAt)) {
    return null;
  }
  const seed = readUser(value.seed);
  const following = readUsers(value.following);
  const followers = readUsers(value.followers);
  if (seed === null || following === null || followers === null) {
    return null;
  }
  const cachedLists: Array<'following' | 'followers'> = [];
  if (Array.isArray(value.cachedLists)) {
    for (const item of value.cachedLists) {
      if (item === 'following' || item === 'followers') {
cachedLists.push(item);
}
    }
  }
  return { seed, following, followers, fetchedAt: value.fetchedAt, cachedLists };
}

export function loadGrowthGraphCache(storage: Storage | null = storageOrNull()): GrowthGraphCache {
  const empty: GrowthGraphCache = { version: GROWTH_GRAPH_CACHE_VERSION, entries: {} };
  if (storage === null) {
return empty;
}
  try {
    const raw = storage.getItem(GROWTH_GRAPH_CACHE_KEY);
    if (raw === null) {
return empty;
}
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== GROWTH_GRAPH_CACHE_VERSION || !isRecord(parsed.entries)) {
      return empty;
    }
    const entries: Record<string, CachedSeedGraph> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      const entry = readEntry(value);
      if (entry !== null) {
entries[key] = entry;
}
    }
    return { version: GROWTH_GRAPH_CACHE_VERSION, entries };
  } catch {
    return empty;
  }
}

export function saveGrowthGraphCache(cache: GrowthGraphCache, storage: Storage | null = storageOrNull()): void {
  if (storage === null) {
return;
}
  const entries = Object.entries(cache.entries);
  if (entries.length > MAX_SEEDS) {
    entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
    const kept: Record<string, CachedSeedGraph> = {};
    for (const [key, entry] of entries.slice(0, MAX_SEEDS)) {
kept[key] = entry;
}
    cache = { version: GROWTH_GRAPH_CACHE_VERSION, entries: kept };
  }
  try {
    storage.setItem(GROWTH_GRAPH_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Cache failures are non-fatal.
  }
}

export function isSeedGraphFresh(entry: CachedSeedGraph | undefined, now: number): entry is CachedSeedGraph {
  return entry !== undefined && now - entry.fetchedAt >= 0 && now - entry.fetchedAt < GROWTH_GRAPH_TTL_MS;
}

export function freshSeedGraphs(cache: GrowthGraphCache, now: number): readonly CachedSeedGraph[] {
  return Object.values(cache.entries).filter(entry => isSeedGraphFresh(entry, now));
}

export function isSeedListFresh(
  entry: CachedSeedGraph | undefined,
  list: 'following' | 'followers',
  now: number,
): boolean {
  return isSeedGraphFresh(entry, now) && entry.cachedLists.includes(list);
}

/** Fresh seeds with both lists cached and at least one discovery candidate. */
export function preferredCachedSeeds(cache: GrowthGraphCache, now: number): readonly FetchListUser[] {
  return Object.values(cache.entries)
    .filter(entry => isSeedGraphFresh(entry, now) && entry.cachedLists.length === 2)
    .filter(entry => entry.following.length > 0 || entry.followers.length > 0)
    .map(entry => entry.seed);
}

/** Merge new list data into the cache and return the updated cache. */
export function putSeedGraph(
  cache: GrowthGraphCache,
  seed: FetchListUser,
  lists: { readonly following?: readonly FetchListUser[]; readonly followers?: readonly FetchListUser[] },
  now: number,
): GrowthGraphCache {
  const key = userKey(seed);
  const previous = cache.entries[key] as CachedSeedGraph | undefined;
  const cachedLists = new Set<'following' | 'followers'>(previous?.cachedLists ?? []);
  if (lists.following !== undefined) {
cachedLists.add('following');
}
  if (lists.followers !== undefined) {
cachedLists.add('followers');
}
  const entry: CachedSeedGraph = {
    seed,
    following: lists.following ?? previous?.following ?? [],
    followers: lists.followers ?? previous?.followers ?? [],
    fetchedAt: now,
    cachedLists: Array.from(cachedLists),
  };
  return {
    version: GROWTH_GRAPH_CACHE_VERSION,
    entries: { ...cache.entries, [key]: entry },
  };
}
