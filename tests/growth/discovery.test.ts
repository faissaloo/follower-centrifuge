import { describe, expect, it, vi } from 'vitest';
import { FetchListUser } from '../../src/model/audit';
import { discoverGrowthCandidates } from '../../src/utils/growth-discovery';

function user(id: string, username: string): FetchListUser {
  return { pk_id: id, username, full_name: username, profile_pic_url: '' };
}

describe('growth discovery', () => {
  it('keeps raw candidates when profile reads all fail', async () => {
    const result = await discoverGrowthCandidates({
      fetchViewerFollowing: async () => [user('seed1', 'seed_one')],
      fetchSeedFollowing: async () => [user('c1', 'private_candidate'), user('c2', 'public_candidate')],
      fetchSeedFollowers: async () => [],
      fetchProfile: async () => {
        throw new Error('profile endpoint down');
      },
      sleep: async () => undefined,
      random: () => 0.5,
      now: () => 1_000_000,
    });
    expect(result).toHaveLength(2);
    expect(result.every(candidate => candidate.biography === '')).toBe(true);
    expect(result.map(candidate => candidate.username)).toContain('private_candidate');
  });

  it('uses a manually supplied seed even when it is outside your following page', async () => {
    const manualSeed: FetchListUser = { pk_id: 'manual', username: 'manual_seed' };
    const result = await discoverGrowthCandidates({
      fetchViewerFollowing: async () => [user('seed1', 'seed_one')],
      fetchSeedFollowing: async seed => [user(`c-${seed.username}`, `via_${seed.username}`)],
      fetchSeedFollowers: async () => [],
      fetchProfile: async candidate => ({
        id: candidate.id,
        username: candidate.username,
        fullName: candidate.username,
        biography: '',
        profilePicUrl: '',
        isPrivate: false,
        isVerified: false,
        followerCount: 1,
        followingCount: 1,
      }),
      preferredSeeds: [manualSeed],
      sleep: async () => undefined,
      random: () => 0.5,
      now: () => 1_000_000,
    });
    expect(result.some(candidate => candidate.username === 'via_manual_seed')).toBe(true);
  });

  it('records how each account was discovered and uses both seed lists', async () => {
    const result = await discoverGrowthCandidates({
      fetchViewerFollowing: async () => [user('seed1', 'seed_one')],
      fetchSeedFollowing: async () => [user('f1', 'via_following')],
      fetchSeedFollowers: async () => [user('r1', 'via_followers')],
      fetchProfile: async candidate => ({
        id: candidate.id,
        username: candidate.username,
        fullName: candidate.username,
        biography: `${candidate.username} bio`,
        profilePicUrl: '',
        isPrivate: false,
        isVerified: false,
        followerCount: 10,
        followingCount: 10,
      }),
      sleep: async () => undefined,
      random: () => 0.5,
      now: () => 1_000_000,
    });
    const followingCandidate = result.find(candidate => candidate.username === 'via_following');
    const followerCandidate = result.find(candidate => candidate.username === 'via_followers');
    expect(followingCandidate?.discoveredVia).toEqual(['@seed_one · following']);
    expect(followerCandidate?.discoveredVia).toEqual(['@seed_one · followers']);
    expect(followingCandidate?.biography).toBe('via_following bio');
  });

  it('samples follows, skips known/seen accounts, and counts repeated sources', async () => {
    const profile = (username: string) => ({
      id: `id-${username}`,
      username,
      fullName: username,
      biography: `${username} makes things`,
      profilePicUrl: '',
      isPrivate: false,
      isVerified: false,
      followerCount: 100,
      followingCount: 100,
    });
    const sleep = vi.fn(async () => undefined);
    const result = await discoverGrowthCandidates({
      fetchViewerFollowing: async () => [user('seed1', 'seed_one'), user('seed2', 'seed_two')],
      fetchSeedFollowing: async seed =>
        seed.username === 'seed_one'
          ? [user('c1', 'candidate_one'), user('c2', 'candidate_two'), user('known', 'already_followed')]
          : [user('c2', 'candidate_two'), user('c3', 'candidate_three'), user('seen', 'seen_before')],
      fetchSeedFollowers: async () => [],
      fetchProfile: async candidate => profile(candidate.username),
      sleep,
      random: () => 0.5,
      now: () => 1_000_000,
      knownFollowing: new Set(['already_followed']),
      seen: { seen_before: 999_000 },
    });
    expect(result.map(candidate => candidate.username).sort()).toEqual([
      'candidate_one',
      'candidate_three',
      'candidate_two',
    ]);
    const repeated = result.find(candidate => candidate.username === 'candidate_two');
    expect(repeated?.sourceCount).toBe(2);
    expect(sleep).toHaveBeenCalled();
  });
});
