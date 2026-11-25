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
  readonly fetchSeedFollowing: (seedId: string) => Promise<readonly FetchListUser[]>;
  readonly fetchProfile: (username: string) => Promise<ProfileInfo>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
  readonly shouldAbort?: () => boolean;
  readonly onProgress?: (stage: 'seeds' | 'profiles', message: string) => void;
  /** Usernames already followed/known from the latest scan. */
  readonly knownFollowing?: ReadonlySet<string>;
  /** Daily-shortlist de-duplication history (username -> last seen ms). */
  readonly seen?: Readonly<Record<string, number>>;
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
  const seeds: FetchListUser[] = [];
  for (const user of ownerPage) {
    const username = normalizeUsername(user.username);
    if (username === '' || known.has(username)) {
      continue;
    }
    known.add(username);
    seeds.push(user);
  }
  if (seeds.length === 0) {
    throw new GrowthDiscoveryError('no accounts you follow were found to seed the shortlist');
  }
  const sampledSeeds = shuffle(seeds, deps.random).slice(0, GROWTH_SEED_COUNT);
  const candidates = new Map<string, ShortlistCandidate>();
  const candidateSources = new Map<string, string>();
  let seedIndex = 0;
  for (const seed of sampledSeeds) {
    throwIfAborted(deps);
    const seedUsername = normalizeUsername(seed.username);
    const seedId = String(seed.pk_id ?? seed.pk ?? seed.id ?? seedUsername);
    if (seedId === '' || seedUsername === '') {
      continue;
    }
    if (seedIndex > 0) {
      await deps.sleep(randomBetween(deps.random, GROWTH_SEED_PACING_MS[0], GROWTH_SEED_PACING_MS[1]));
    }
    seedIndex += 1;
    deps.onProgress?.('seeds', `checking @${seedUsername} (${seedIndex}/${sampledSeeds.length})`);
    let following: readonly FetchListUser[] = [];
    try {
      following = await deps.fetchSeedFollowing(seedId);
    } catch {
      continue;
    }
    for (const user of following) {
      const username = normalizeUsername(user.username);
      if (username === '' || username === seedUsername || known.has(username)) {
        continue;
      }
      const existing = candidates.get(username);
      if (existing !== undefined) {
        candidates.set(username, { ...existing, sourceCount: (existing.sourceCount ?? 1) + 1 });
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
        sourceCount: 1,
      });
      candidateSources.set(username, seedUsername);
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
      const profile = await deps.fetchProfile(candidate.username);
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
        sourceUsername: candidateSources.get(candidate.username) ?? candidate.sourceUsername,
        sourceCount: candidate.sourceCount ?? 1,
      });
    } catch {
      // Private/deleted/blocked accounts simply don't make the shortlist.
    }
  }
  if (enriched.length === 0) {
    throw new GrowthDiscoveryError('could not read any public profiles today');
  }
  return enriched;
}
