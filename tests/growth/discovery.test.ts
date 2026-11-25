import { describe, expect, it, vi } from 'vitest';
import { FetchListUser } from '../../src/model/audit';
import { discoverGrowthCandidates } from '../../src/utils/growth-discovery';

function user(id: string, username: string): FetchListUser {
  return { pk_id: id, username, full_name: username, profile_pic_url: '' };
}

describe('growth discovery', () => {
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
      fetchSeedFollowing: async seedId =>
        seedId === 'seed1'
          ? [user('c1', 'candidate_one'), user('c2', 'candidate_two'), user('known', 'already_followed')]
          : [user('c2', 'candidate_two'), user('c3', 'candidate_three'), user('seen', 'seen_before')],
      fetchProfile: async username => profile(username),
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
