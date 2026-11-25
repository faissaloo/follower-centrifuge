import { FetchListUser } from '../model/audit';
import {
  GROWTH_MAX_CANDIDATES,
  GROWTH_MAX_PROFILE_LOOKUPS,
  GROWTH_PROFILE_PACING_MS,
  GROWTH_SEED_COUNT,
  GROWTH_SEED_PACING_MS,
  ShortlistCandidate,
  SHORTLIST_HISTORY_DAYS,
} from '../model/growth';
import { ProfileInfo } from './utils';

/**
 * Read-only candidate discovery for the Daily 20 shortlist.
 *
 * Strategy: take a few accounts you follow, sample a page of THEIR following
 * lists, de-duplicate against accounts you already know/follow and the last
 * 30 days, then enrich a bounded set with public profile data. No follow or
 * unfollow requests are made here.
 */
export interface GrowthDiscoveryDeps {
  readonly fetchViewerFollowing: () => Promise<readonly FetchListUser[]>;
  readonly fetchSeedFollowing: (seed: FetchListUser) => Promise<readonly FetchListUser[]>;
  readonly fetchSeedFollowers: (seed: FetchListUser) => Promise<readonly FetchListUser[]>;
  readonly fetchProfile: (candidate: { readonly id: string; readonly username: string }) => Promise<ProfileInfo>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
  readonly shouldAbort?: () => boolean;
  readonly onProgress?: (stage: 'seeds' | 'profiles', message: string) => void;
  /** Usernames already followed/known from the latest scan. */
  readonly knownFollowing?: ReadonlySet<string>;
  /** Daily-shortlist de-duplication history (username -> last seen ms). */
  readonly seen?: Readonly<Record<string, number>>;
  /** Seeds remembered from the 30-day graph cache, reused before new ones. */
  readonly preferredSeeds?: readonly FetchListUser[];
  /** Cache-hit predicate so cached seed lists don't trigger pacing sleeps. */
  readonly isSeedCached?: (seedId: string) => boolean;
}

export class GrowthDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrowthDiscoveryError';
  }
}

function normalizeUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
}

function randomBetween(random: () => number, min: number, max: number): number {
  const unit = Math.max(0, Math.min(1, random()));
  return Math.floor(min + unit * (max - min));
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.max(0, Math.min(0.999999, random())) * (index + 1));
    const temp = copy[index];
    copy[index] = copy[swap];
    copy[swap] = temp;
  }
  return copy;
}

function wasSeenRecently(seen: Readonly<Record<string, number>> | undefined, username: string, now: number): boolean {
  if (seen === undefined) {
    return false;
  }
  const timestamp = seen[username];
  return timestamp >= now - SHORTLIST_HISTORY_DAYS * 24 * 60 * 60 * 1000;
}

function throwIfAborted(deps: GrowthDiscoveryDeps): void {
  if (deps.shouldAbort?.() === true) {
    throw new GrowthDiscoveryError('shortlist refresh cancelled');
  }
}

/** Run one bounded read-only discovery pass. */
export async function discoverGrowthCandidates(deps: GrowthDiscoveryDeps): Promise<readonly ShortlistCandidate[]> {
  throwIfAborted(deps);
  const now = deps.now();
  const ownerPage = await deps.fetchViewerFollowing();
  const known = new Set<string>();
  (deps.knownFollowing ?? new Set<string>()).forEach(username => {
    known.add(normalizeUsername(username));
  });
  const ownerSeeds: FetchListUser[] = [];
  for (const user of ownerPage) {
    const username = normalizeUsername(user.username);
    if (username === '' || known.has(username)) {
      continue;
    }
    known.add(username);
    ownerSeeds.push(user);
  }
  const seedById = new Map<string, FetchListUser>();
  for (const seed of [...(deps.preferredSeeds ?? []), ...shuffle(ownerSeeds, deps.random)]) {
    const id = String(seed.pk_id ?? seed.pk ?? seed.id ?? normalizeUsername(seed.username));
    const username = normalizeUsername(seed.username);
    if (id !== '' && username !== '' && !seedById.has(id)) {
      seedById.set(id, seed);
    }
  }
  const sampledSeeds = Array.from(seedById.values()).slice(0, GROWTH_SEED_COUNT);
  if (sampledSeeds.length === 0) {
    throw new GrowthDiscoveryError('no accounts you follow were found to seed the shortlist');
  }
  const candidates = new Map<string, ShortlistCandidate>();
  let seedIndex = 0;
  for (const seed of sampledSeeds) {
    throwIfAborted(deps);
    const seedUsername = normalizeUsername(seed.username);
    const seedId = String(seed.pk_id ?? seed.pk ?? seed.id ?? seedUsername);
    if (seedId === '' || seedUsername === '') {
      continue;
    }
    const cached = deps.isSeedCached?.(seedId) === true;
    if (seedIndex > 0 && !cached) {
      await deps.sleep(randomBetween(deps.random, GROWTH_SEED_PACING_MS[0], GROWTH_SEED_PACING_MS[1]));
    }
    seedIndex += 1;
    deps.onProgress?.('seeds', `checking @${seedUsername} (${seedIndex}/${sampledSeeds.length})`);
    let following: readonly FetchListUser[] = [];
    let followers: readonly FetchListUser[] = [];
    let followingError = false;
    let followersError = false;
    try {
      following = await deps.fetchSeedFollowing(seed);
    } catch {
      followingError = true;
    }
    try {
      followers = await deps.fetchSeedFollowers(seed);
    } catch {
      followersError = true;
    }
    deps.onProgress?.(
      'seeds',
      `@${seedUsername}: ${following.length} following${followingError ? ' (failed)' : ''} / ` +
        `${followers.length} followers${followersError ? ' (failed)' : ''}`,
    );
    if (following.length === 0 && followers.length === 0) {
      continue;
    }
    const perSeed = new Set<string>();
    const lists: Array<{ readonly users: readonly FetchListUser[]; readonly type: 'following' | 'followers' }> = [
      { users: following, type: 'following' },
      { users: followers, type: 'followers' },
    ];
    for (const list of lists) {
      for (const user of list.users) {
        const username = normalizeUsername(user.username);
        if (username === '' || username === seedUsername || known.has(username) || perSeed.has(username)) {
          continue;
        }
        perSeed.add(username);
        const via = `@${seedUsername} · ${list.type}`;
        const existing = candidates.get(username);
        if (existing !== undefined) {
          candidates.set(username, {
            ...existing,
            sourceCount: (existing.sourceCount ?? 1) + 1,
            discoveredVia: [...(existing.discoveredVia ?? []), via].slice(0, 8),
          });
          continue;
        }
        if (wasSeenRecently(deps.seen, username, now)) {
          continue;
        }
        candidates.set(username, {
          id: String(user.pk_id ?? user.pk ?? user.id ?? username),
          username,
          fullName: user.full_name ?? '',
          biography: '',
          profilePicUrl: user.profile_pic_url ?? '',
          isPrivate: user.is_private ?? false,
          isVerified: user.is_verified ?? false,
          followerCount: 0,
          followingCount: 0,
          score: 0,
          sourceUsername: seedUsername,
          discoveredVia: [via],
          sourceCount: 1,
        });
      }
    }
  }
  if (candidates.size === 0) {
    throw new GrowthDiscoveryError('no new candidates were found today');
  }

  const sampled = shuffle(Array.from(candidates.values()), deps.random).slice(0, GROWTH_MAX_CANDIDATES);
  const enriched: ShortlistCandidate[] = [];
  let profileIndex = 0;
  for (const candidate of sampled) {
    throwIfAborted(deps);
    if (profileIndex >= GROWTH_MAX_PROFILE_LOOKUPS) {
      break;
    }
    if (profileIndex > 0) {
      await deps.sleep(randomBetween(deps.random, GROWTH_PROFILE_PACING_MS[0], GROWTH_PROFILE_PACING_MS[1]));
    }
    profileIndex += 1;
    deps.onProgress?.('profiles', `reading @${candidate.username} (${profileIndex}/${sampled.length})`);
    try {
      const profile = await deps.fetchProfile({ id: candidate.id, username: candidate.username });
      enriched.push({
        ...candidate,
        id: profile.id !== '' ? profile.id : candidate.id,
        username: normalizeUsername(profile.username) !== '' ? profile.username : candidate.username,
        fullName: profile.fullName !== '' ? profile.fullName : candidate.fullName,
        biography: profile.biography,
        profilePicUrl: profile.profilePicUrl !== '' ? profile.profilePicUrl : candidate.profilePicUrl,
        isPrivate: profile.isPrivate,
        isVerified: profile.isVerified,
        followerCount: profile.followerCount,
        followingCount: profile.followingCount,
        sourceUsername: candidate.sourceUsername,
        discoveredVia: candidate.discoveredVia,
        sourceCount: candidate.sourceCount ?? 1,
      });
    } catch {
      // Profile lookups fail for private/deleted/rate-limited accounts. The
      // following-list row still gives us enough to review the account, so keep
      // it instead of dropping the whole shortlist.
      enriched.push(candidate);
    }
  }
  if (enriched.length === 0) {
    throw new GrowthDiscoveryError('no candidate profiles were found today');
  }
  return enriched;
}
