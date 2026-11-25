import { beforeEach, describe, expect, it } from 'vitest';
import { FetchListUser } from '../../src/model/audit';
import {
  GROWTH_GRAPH_TTL_MS,
  freshSeedGraphs,
  isSeedListFresh,
  loadGrowthGraphCache,
  preferredCachedSeeds,
  putSeedGraph,
  saveGrowthGraphCache,
} from '../../src/utils/growth-graph-cache';

const seed: FetchListUser = { pk_id: 'seed-1', username: 'seed_one', full_name: 'Seed One' };
const following: FetchListUser[] = [{ pk_id: 'a', username: 'candidate_a' }];
const followers: FetchListUser[] = [{ pk_id: 'b', username: 'candidate_b' }];

beforeEach(() => {
  localStorage.clear();
});

describe('growth seed graph cache', () => {
  it('caches following and followers for 30 days and reuses both lists', () => {
    let cache = loadGrowthGraphCache();
    cache = putSeedGraph(cache, seed, { following }, 1_000_000);
    cache = putSeedGraph(cache, seed, { followers }, 1_000_000);
    saveGrowthGraphCache(cache);
    const loaded = loadGrowthGraphCache();
    const entry = loaded.entries['seed-1'];
    expect(isSeedListFresh(entry, 'following', 1_000_000 + 1000)).toBe(true);
    expect(isSeedListFresh(entry, 'followers', 1_000_000 + 1000)).toBe(true);
    expect(entry.following).toEqual(following);
    expect(entry.followers).toEqual(followers);
    expect(preferredCachedSeeds(loaded, 1_000_000 + 1000)[0].username).toBe('seed_one');
  });

  it('expires the cache after 30 days', () => {
    let cache = loadGrowthGraphCache();
    cache = putSeedGraph(cache, seed, { following, followers }, 1_000_000);
    saveGrowthGraphCache(cache);
    const loaded = loadGrowthGraphCache();
    expect(freshSeedGraphs(loaded, 1_000_000 + GROWTH_GRAPH_TTL_MS - 1)).toHaveLength(1);
    expect(preferredCachedSeeds(loaded, 1_000_000 + GROWTH_GRAPH_TTL_MS)).toHaveLength(0);
  });
});
