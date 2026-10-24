import { ACCOUNT_LIST_CACHE_MAX_AGE_MS, ACCOUNT_LIST_CACHE_STORAGE_KEY, ACCOUNT_LIST_CACHE_VERSION } from '../constants/constants';
import { FetchListFn, FetchListUser } from '../model/audit';
import { UserNode } from '../model/user';

/**
 * Cache of the raw following/followers lists from a completed scan.
 *
 * A repeated scan with a different target category does not need to pay for
 * pagination again: the same lists can be replayed into the classifier, which
 * reuses cached guesses (or reclassifies only when its prompt/model settings
 * changed). The cache is viewer-scoped and strictly freshness-bounded, and live
 * unfollow runs invalidate it because they change the lists.
 */
export interface AccountListCacheRecord {
  readonly version: number;
  readonly viewerId: string;
  readonly fetchedAt: number;
  readonly following: readonly FetchListUser[];
  readonly followers: readonly FetchListUser[];
}

const MAX_USERS_PER_LIST = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUser(value: unknown): FetchListUser | null {
  if (!isRecord(value)) {
    return null;
  }
  const username = typeof value.username === 'string' ? value.username : '';
  const pk = typeof value.pk === 'string' || typeof value.pk === 'number' ? value.pk : undefined;
  const pkId = typeof value.pk_id === 'string' ? value.pk_id : undefined;
  const id = typeof value.id === 'string' ? value.id : undefined;
  if (username.trim() === '' || (pk === undefined && pkId === undefined && id === undefined)) {
    return null;
  }
  return {
    ...(pk === undefined ? {} : { pk }),
    ...(pkId === undefined ? {} : { pk_id: pkId }),
    ...(id === undefined ? {} : { id }),
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
  if (value.length > MAX_USERS_PER_LIST) {
    return null;
  }
  const users: FetchListUser[] = [];
  for (const item of value) {
    const user = readUser(item);
    if (user === null) {
      return null;
    }
    users.push(user);
  }
  return users;
}

/** Save a completed list pair. Storage failures are non-fatal. */
export function saveAccountListCache(
  viewerId: string | null,
  following: readonly FetchListUser[],
  followers: readonly FetchListUser[],
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
  now: number = Date.now(),
): boolean {
  if (viewerId === null || viewerId.trim() === '' || storage === undefined) {
    return false;
  }
  const record: AccountListCacheRecord = {
    version: ACCOUNT_LIST_CACHE_VERSION,
    viewerId,
    fetchedAt: now,
    following,
    followers,
  };
  try {
    storage.setItem(ACCOUNT_LIST_CACHE_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load lists for this viewer if they are still fresh. Invalid, cross-viewer or
 * stale payloads are removed and treated as absent.
 */
export function loadAccountListCache(
  viewerId: string | null,
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
  now: number = Date.now(),
  maxAgeMs: number = ACCOUNT_LIST_CACHE_MAX_AGE_MS,
): AccountListCacheRecord | null {
  if (viewerId === null || viewerId.trim() === '' || storage === undefined) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(ACCOUNT_LIST_CACHE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(ACCOUNT_LIST_CACHE_STORAGE_KEY);
    return null;
  }
  if (!isRecord(parsed)) {
    storage.removeItem(ACCOUNT_LIST_CACHE_STORAGE_KEY);
    return null;
  }
  const version = typeof parsed.version === 'number' ? parsed.version : null;
  const cachedViewer = typeof parsed.viewerId === 'string' ? parsed.viewerId : null;
  const fetchedAt = typeof parsed.fetchedAt === 'number' && isFinite(parsed.fetchedAt) ? parsed.fetchedAt : null;
  const following = readUsers(parsed.following);
  const followers = readUsers(parsed.followers);
  const stale =
    fetchedAt === null || fetchedAt > now + 5 * 60 * 1000 || now - fetchedAt > Math.max(0, maxAgeMs);
  if (
    version !== ACCOUNT_LIST_CACHE_VERSION ||
    cachedViewer === null ||
    cachedViewer !== viewerId ||
    fetchedAt === null ||
    following === null ||
    followers === null ||
    stale
  ) {
    storage.removeItem(ACCOUNT_LIST_CACHE_STORAGE_KEY);
    return null;
  }
  return { version, viewerId: cachedViewer, fetchedAt, following, followers };
}

/** Remove cached lists (e.g. after a live unfollow run changes them). */
export function clearAccountListCache(
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): void {
  try {
    storage?.removeItem(ACCOUNT_LIST_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/** Replay cached lists through the runner's page callback without network I/O. */
export function createCachedListFetch(
  record: AccountListCacheRecord,
  pageSize = 50,
): FetchListFn {
  return async (kind, onPage) => {
    const users = kind === 'following' ? record.following : record.followers;
    for (let start = 0; start < users.length; start += pageSize) {
      onPage(users.slice(start, start + pageSize));
      await Promise.resolve();
    }
    return true;
  };
}

/** Convert a cached list entry to a full viewer node (used only for whitelist UI). */
export function cachedUserToUserNode(user: FetchListUser): UserNode | null {
  const id = typeof user.pk_id === 'string' ? user.pk_id : typeof user.id === 'string' ? user.id : typeof user.pk === 'number' || typeof user.pk === 'string' ? String(user.pk) : '';
  if (id === '' || typeof user.username !== 'string') {
    return null;
  }
  return {
    id,
    username: user.username,
    full_name: user.full_name ?? '',
    profile_pic_url: user.profile_pic_url ?? '',
    is_private: user.is_private ?? false,
    is_verified: user.is_verified ?? false,
    followed_by_viewer: false,
    follows_viewer: false,
    requested_by_viewer: false,
  };
}
