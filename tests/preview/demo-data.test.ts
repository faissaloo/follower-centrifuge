import { describe, expect, it } from 'vitest';
import {
  createDemoCandidates,
  createDemoDataset,
  createDemoWhitelist,
  DEMO_CLASSIFIER_VERSION,
} from '../../src/preview/demo-data';
import { relationshipIncludesFollower, relationshipIncludesFollowing } from '../../src/model/audit';

describe('demo dataset', () => {
  it('is deterministic', () => {
    expect(JSON.stringify(createDemoCandidates())).toBe(JSON.stringify(createDemoCandidates()));
  });

  it('contains following, follower and mutual relationships', () => {
    const relationships = new Set(createDemoCandidates().map(candidate => candidate.relationship));
    expect(relationships.has('following')).toBe(true);
    expect(relationships.has('follower')).toBe(true);
    expect(relationships.has('mutual')).toBe(true);
  });

  it('sets follow flags consistently with the relationship', () => {
    for (const candidate of createDemoCandidates()) {
      expect(candidate.user.followed_by_viewer).toBe(relationshipIncludesFollowing(candidate.relationship));
      expect(candidate.user.follows_viewer).toBe(relationshipIncludesFollower(candidate.relationship));
    }
  });

  it('includes all five classifier categories', () => {
    const genders = new Set(createDemoCandidates().map(candidate => candidate.gender?.gender));
    expect(genders.has('female')).toBe(true);
    expect(genders.has('male')).toBe(true);
    expect(genders.has('machine')).toBe(true);
    expect(genders.has('organization')).toBe(true);
    expect(genders.has('ambiguous')).toBe(true);
  });

  it('includes a low-confidence female guess below the default threshold', () => {
    expect(
      createDemoCandidates().some(
        candidate => candidate.gender?.gender === 'female' && candidate.gender.confidence < 0.6,
      ),
    ).toBe(true);
  });

  it('uses the demo classifier version as provenance', () => {
    for (const candidate of createDemoCandidates()) {
      expect(candidate.gender?.source).toBe('demo');
      expect(candidate.gender?.model).toBe(DEMO_CLASSIFIER_VERSION);
    }
  });

  it('never references remote images (fully offline preview)', () => {
    for (const candidate of createDemoCandidates()) {
      if (candidate.user.profile_pic_url !== '') {
        expect(candidate.user.profile_pic_url.startsWith('data:image/svg+xml')).toBe(true);
      }
    }
  });

  it('pre-protects a subset of accounts in the demo whitelist', () => {
    const whitelist = createDemoWhitelist();
    expect(whitelist.length).toBeGreaterThan(0);
    const ids = new Set(whitelist.map(user => user.id));
    expect(ids.size).toBe(whitelist.length);
    const dataset = createDemoDataset();
    expect(dataset.whitelistedResults.map(user => user.id).sort()).toEqual(whitelist.map(user => user.id).sort());
  });

  it('produces unique ids and usernames', () => {
    const candidates = createDemoCandidates();
    expect(new Set(candidates.map(candidate => candidate.user.id)).size).toBe(candidates.length);
    expect(new Set(candidates.map(candidate => candidate.user.username)).size).toBe(candidates.length);
  });
});
