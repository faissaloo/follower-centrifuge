import { describe, expect, it } from 'vitest';
import {
  AUDIT_RESULTS_PER_PAGE,
  getCandidatesForDisplay,
  getCurrentAuditPage,
  getEligibleTargets,
  getMaxAuditPage,
  hasEligibleSelection,
  isConfidentTarget,
  isUncertainCandidate,
  summarizeAudit,
} from '../../src/utils/audit-display';
import { AuditCandidate, AuditFilter, DEFAULT_AUDIT_FILTER } from '../../src/model/audit';
import { GenderCategory } from '../../src/model/gender';
import { createCandidate, createUserNode } from '../helpers/fixtures';

function ids(candidates: readonly AuditCandidate[]): string[] {
  return candidates.map(candidate => candidate.user.id);
}

/** Non-default filters: the default nuke category is deliberately kept as `female`. */
function filterFor(target: GenderCategory, overrides: Partial<AuditFilter> = {}): AuditFilter {
  return { ...DEFAULT_AUDIT_FILTER, targetCategory: target, ...overrides };
}

const followingFemale = createCandidate({ id: 'f-follow', username: 'alice', gender: 'female', confidence: 0.9 });
const mutualFemale = createCandidate({ id: 'f-mutual', username: 'bea', relationship: 'mutual', gender: 'female', confidence: 0.8 });
const followerFemale = createCandidate({ id: 'f-follower', username: 'cara', relationship: 'follower', gender: 'female', confidence: 0.9 });
const followingMale = createCandidate({ id: 'm-follow', username: 'dan', gender: 'male', confidence: 0.9 });
const mutualMale = createCandidate({ id: 'm-mutual', username: 'greg', relationship: 'mutual', gender: 'male', confidence: 0.85 });
const followerMale = createCandidate({ id: 'm-follower', username: 'hank', relationship: 'follower', gender: 'male', confidence: 0.9 });
const lowConfidenceFemale = createCandidate({ id: 'f-low', username: 'fran', gender: 'female', confidence: 0.5 });
const lowConfidenceMale = createCandidate({ id: 'm-low', username: 'ian', gender: 'male', confidence: 0.5 });
const ambiguous = createCandidate({ id: 'g-ambiguous', username: 'erin', gender: 'ambiguous', confidence: 0.4 });
const machine = createCandidate({ id: 'g-machine', username: 'xbot', gender: 'machine', confidence: 0.99 });
const organization = createCandidate({ id: 'g-org', username: 'xcorp', gender: 'organization', confidence: 0.97 });
const unclassified = createCandidate({ id: 'x-unclassified', username: 'gil', genderGuess: null });
const allCandidates = [
  followingFemale,
  mutualFemale,
  followerFemale,
  followingMale,
  mutualMale,
  followerMale,
  lowConfidenceFemale,
  lowConfidenceMale,
  ambiguous,
  machine,
  organization,
  unclassified,
];

describe('isConfidentTarget / isUncertainCandidate', () => {
  it('defaults to the female target: female guesses at/above the threshold are confident targets', () => {
    expect(DEFAULT_AUDIT_FILTER.targetCategory).toBe('female');
    expect(isConfidentTarget(followingFemale, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isConfidentTarget(mutualFemale, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isConfidentTarget(lowConfidenceFemale, DEFAULT_AUDIT_FILTER)).toBe(false);
  });

  it('never treats males or non-person categories as females', () => {
    expect(isConfidentTarget(followingMale, DEFAULT_AUDIT_FILTER)).toBe(false);
    expect(isConfidentTarget(ambiguous, DEFAULT_AUDIT_FILTER)).toBe(false);
    expect(isConfidentTarget(machine, DEFAULT_AUDIT_FILTER)).toBe(false);
    expect(isConfidentTarget(unclassified, DEFAULT_AUDIT_FILTER)).toBe(false);
  });

  it('treats confident males as targets when the target is male', () => {
    const maleFilter = filterFor('male');
    expect(isConfidentTarget(followingMale, maleFilter)).toBe(true);
    expect(isConfidentTarget(mutualMale, maleFilter)).toBe(true);
    expect(isConfidentTarget(followingFemale, maleFilter)).toBe(false);
    expect(isConfidentTarget(lowConfidenceMale, maleFilter)).toBe(false);
  });

  it('always puts machine, organization and ambiguous accounts in the other/uncertain bucket', () => {
    expect(isUncertainCandidate(machine, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isUncertainCandidate(organization, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isUncertainCandidate(ambiguous, DEFAULT_AUDIT_FILTER)).toBe(true);
    // Even under the male target, which they can never match.
    expect(isUncertainCandidate(machine, filterFor('male'))).toBe(true);
    expect(isUncertainCandidate(organization, filterFor('male'))).toBe(true);
    expect(isUncertainCandidate(ambiguous, filterFor('male'))).toBe(true);
  });

  it('puts low-confidence guesses and unclassified accounts in other/uncertain', () => {
    expect(isUncertainCandidate(lowConfidenceFemale, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isUncertainCandidate(lowConfidenceMale, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isUncertainCandidate(unclassified, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isUncertainCandidate(followingFemale, DEFAULT_AUDIT_FILTER)).toBe(false);
    expect(isUncertainCandidate(followingMale, filterFor('male'))).toBe(false);
  });

  it('puts every non-target guess (including the opposite gender) in the other/uncertain bucket', () => {
    expect(isUncertainCandidate(followingFemale, DEFAULT_AUDIT_FILTER)).toBe(false);
    expect(isUncertainCandidate(followingMale, DEFAULT_AUDIT_FILTER)).toBe(true);
    expect(isUncertainCandidate(followingFemale, filterFor('male'))).toBe(true);
    expect(isConfidentTarget(followingFemale, filterFor('male'))).toBe(false);
  });
});

describe('getCandidatesForDisplay', () => {
  it('shows confident females the viewer follows in the default target tab', () => {
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-following', '', DEFAULT_AUDIT_FILTER))).toEqual([
      'f-follow',
      'f-mutual',
    ]);
  });

  it('includes mutuals in both target tabs', () => {
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-followers', '', DEFAULT_AUDIT_FILTER))).toEqual([
      'f-mutual',
      'f-follower',
    ]);
  });

  it('shows confident males in the target tabs when the target is male', () => {
    const maleFilter = filterFor('male');
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-following', '', maleFilter))).toEqual([
      'm-follow',
      'm-mutual',
    ]);
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-followers', '', maleFilter))).toEqual([
      'm-mutual',
      'm-follower',
    ]);
  });

  it('never shows the opposite target or non-person categories in the target tabs', () => {
    const maleFilter = filterFor('male');
    const menFollowing = ids(getCandidatesForDisplay(allCandidates, [], 'target-following', '', maleFilter));
    expect(menFollowing.indexOf('f-follow')).toBe(-1);
    expect(menFollowing.indexOf('g-machine')).toBe(-1);
    const womenFollowing = ids(getCandidatesForDisplay(allCandidates, [], 'target-following', '', DEFAULT_AUDIT_FILTER));
    expect(womenFollowing.indexOf('m-follow')).toBe(-1);
    expect(womenFollowing.indexOf('g-org')).toBe(-1);
  });

  it('keeps non-target guesses in the other/uncertain tab for person targets', () => {
    for (const target of ['female', 'male'] as const) {
      const uncertainIds = ids(getCandidatesForDisplay(allCandidates, [], 'uncertain', '', filterFor(target)));
      for (const id of ['g-ambiguous', 'f-low', 'x-unclassified', 'm-low', 'g-machine', 'g-org']) {
        expect(uncertainIds).toContain(id);
      }
      expect(uncertainIds).not.toContain(target === 'female' ? 'f-follow' : 'm-follow');
    }
  });

  it('treats an explicitly chosen non-person category as a valid nuke target', () => {
    const machineFilter = filterFor('machine');
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-following', '', machineFilter))).toEqual(['g-machine']);
    expect(ids(getEligibleTargets(allCandidates, [], 0.6, 'machine'))).toEqual(['g-machine']);
    expect(summarizeAudit(allCandidates, [], machineFilter).eligibleForUnfollow).toBe(1);

    const orgFilter = filterFor('organization');
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-following', '', orgFilter))).toEqual(['g-org']);
    expect(isUncertainCandidate(machine, orgFilter)).toBe(true);
  });

  it('excludes whitelisted accounts from target tabs and lists them in the whitelisted tab', () => {
    const whitelist = [mutualFemale.user];
    expect(ids(getCandidatesForDisplay(allCandidates, whitelist, 'target-following', '', DEFAULT_AUDIT_FILTER))).toEqual([
      'f-follow',
    ]);
    expect(ids(getCandidatesForDisplay(allCandidates, whitelist, 'whitelisted', '', DEFAULT_AUDIT_FILTER))).toEqual([
      'f-mutual',
    ]);
  });

  it('sorts visible results by username for stable alphabetical rendering', () => {
    const candidates = [
      createCandidate({ id: 'z', username: 'zoe', gender: 'female' }),
      createCandidate({ id: 'a', username: 'amy', gender: 'female' }),
    ];
    expect(getCandidatesForDisplay(candidates, [], 'target-following', '', DEFAULT_AUDIT_FILTER).map(c => c.user.username)).toEqual([
      'amy',
      'zoe',
    ]);
  });

  it('respects the private filter', () => {
    const privateFemale = createCandidate({ id: 'priv', username: 'ivy', gender: 'female', isPrivate: true });
    const filter = { ...DEFAULT_AUDIT_FILTER, showPrivate: false };
    expect(ids(getCandidatesForDisplay([privateFemale], [], 'target-following', '', filter))).toEqual([]);
    expect(ids(getCandidatesForDisplay([privateFemale], [], 'target-following', '', DEFAULT_AUDIT_FILTER))).toEqual(['priv']);
  });

  it('respects the verified filter', () => {
    const verifiedMale = createCandidate({ id: 'ver', username: 'jo', gender: 'male', isVerified: true });
    const filter = filterFor('male', { showVerified: false });
    expect(ids(getCandidatesForDisplay([verifiedMale], [], 'target-following', '', filter))).toEqual([]);
  });

  it('searches username and display name case-insensitively', () => {
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-following', 'ALICE', DEFAULT_AUDIT_FILTER))).toEqual(['f-follow']);
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-following', 'bea', DEFAULT_AUDIT_FILTER))).toEqual(['f-mutual']);
    expect(ids(getCandidatesForDisplay(allCandidates, [], 'target-following', 'nobody', DEFAULT_AUDIT_FILTER))).toEqual([]);
  });

  it('applies the common filters in the whitelisted tab as well', () => {
    const verifiedWhitelisted = createCandidate({ id: 'vw', username: 'kim', gender: 'female', isVerified: true });
    const whitelist = [verifiedWhitelisted.user];
    const filter = { ...DEFAULT_AUDIT_FILTER, showVerified: false };
    expect(ids(getCandidatesForDisplay([verifiedWhitelisted], whitelist, 'whitelisted', '', filter))).toEqual([]);
    expect(ids(getCandidatesForDisplay([verifiedWhitelisted], whitelist, 'whitelisted', '', DEFAULT_AUDIT_FILTER))).toEqual(['vw']);
  });

  it('respects a lower confidence threshold from the filter for both targets', () => {
    expect(
      ids(getCandidatesForDisplay([lowConfidenceFemale], [], 'target-following', '', { ...DEFAULT_AUDIT_FILTER, minimumConfidence: 0.4 })),
    ).toEqual(['f-low']);
    expect(
      ids(getCandidatesForDisplay([lowConfidenceMale], [], 'target-following', '', filterFor('male', { minimumConfidence: 0.4 }))),
    ).toEqual(['m-low']);
    expect(
      ids(getCandidatesForDisplay([lowConfidenceMale], [], 'target-following', '', filterFor('male', { minimumConfidence: 0.6 }))),
    ).toEqual([]);
  });

  it('rejects an unknown tab instead of silently rendering nothing', () => {
    expect(() =>
      getCandidatesForDisplay(allCandidates, [], 'not-a-tab' as unknown as Parameters<typeof getCandidatesForDisplay>[2], '', DEFAULT_AUDIT_FILTER),
    ).toThrow(/Unhandled audit tab/);
  });
});

describe('pagination', () => {
  const many = Array.from({ length: AUDIT_RESULTS_PER_PAGE * 2 + 3 }, (_, index) =>
    createCandidate({ id: `p-${index}`, username: `user-${String(index).padStart(3, '0')}`, gender: 'female' }),
  );

  it('computes page counts and never returns less than one page', () => {
    expect(getMaxAuditPage([])).toBe(1);
    expect(getMaxAuditPage([followingFemale])).toBe(1);
    expect(getMaxAuditPage(many)).toBe(3);
  });

  it('slices the requested page', () => {
    expect(getCurrentAuditPage(many, 1)).toHaveLength(AUDIT_RESULTS_PER_PAGE);
    expect(getCurrentAuditPage(many, 3)).toHaveLength(3);
    expect(getCurrentAuditPage(many, 4)).toHaveLength(0);
  });
});

describe('eligible targets and summary', () => {
  it('only allows followed, non-whitelisted, confident females to be unfollowed by default', () => {
    expect(getEligibleTargets(allCandidates, [mutualFemale.user], 0.6).map(c => c.user.id)).toEqual(['f-follow']);
  });

  it('only allows followed, non-whitelisted, confident males when the target is male', () => {
    expect(getEligibleTargets(allCandidates, [mutualMale.user], 0.6, 'male').map(c => c.user.id)).toEqual(['m-follow']);
  });

  it('never makes machine, organization or ambiguous accounts eligible, however confident', () => {
    const others = [machine, organization, ambiguous];
    expect(getEligibleTargets(others, [], 0.6, 'female')).toEqual([]);
    expect(getEligibleTargets(others, [], 0.6, 'male')).toEqual([]);
    expect(getEligibleTargets(others, [], 0, 'female')).toEqual([]);
  });

  it('excludes follower-only accounts even when they match the target', () => {
    expect(getEligibleTargets([followerFemale], [], 0.6)).toEqual([]);
    expect(getEligibleTargets([followerMale], [], 0.6, 'male')).toEqual([]);
  });

  it('summarizes target-based counts for the review sidebar', () => {
    const summary = summarizeAudit(allCandidates, [mutualFemale.user]);
    const uncertain = allCandidates.filter(candidate => !isConfidentTarget(candidate, DEFAULT_AUDIT_FILTER)).length;
    expect(summary).toEqual({
      targetFollowing: 1,
      targetFollowers: 1,
      targetMutual: 0,
      uncertain,
      totalCandidates: 12,
      eligibleForUnfollow: 1,
    });
    expect(uncertain).toBeGreaterThan(6);
  });

  it('summarizes male counts and the non-male other bucket when the target is male', () => {
    const summary = summarizeAudit(allCandidates, [mutualMale.user], filterFor('male'));
    const uncertain = allCandidates.filter(candidate => !isConfidentTarget(candidate, filterFor('male'))).length;
    expect(summary).toEqual({
      targetFollowing: 1,
      targetFollowers: 1,
      targetMutual: 0,
      uncertain,
      totalCandidates: 12,
      eligibleForUnfollow: 1,
    });
  });

  it('counts mutual accounts in both target relationship totals', () => {
    expect(summarizeAudit([mutualFemale], []).targetMutual).toBe(1);
    expect(summarizeAudit([mutualFemale], []).targetFollowing).toBe(1);
    expect(summarizeAudit([mutualFemale], []).targetFollowers).toBe(1);
    const maleSummary = summarizeAudit([mutualMale], [], filterFor('male'));
    expect(maleSummary.targetMutual).toBe(1);
    expect(maleSummary.targetFollowing).toBe(1);
    expect(maleSummary.targetFollowers).toBe(1);
  });

  it('reports whether the current selection has an eligible target for either gender', () => {
    expect(hasEligibleSelection(allCandidates, [], ['f-follow'], 0.6)).toBe(true);
    expect(hasEligibleSelection(allCandidates, [], ['f-follower'], 0.6)).toBe(false);
    expect(hasEligibleSelection(allCandidates, [], [], 0.6)).toBe(false);
    expect(hasEligibleSelection(allCandidates, [followingFemale.user], ['f-follow'], 0.6)).toBe(false);
    expect(hasEligibleSelection(allCandidates, [], ['m-follow'], 0.6, 'male')).toBe(true);
    expect(hasEligibleSelection(allCandidates, [], ['f-follow'], 0.6, 'male')).toBe(false);
    expect(hasEligibleSelection(allCandidates, [], ['g-machine'], 0.6, 'female')).toBe(false);
  });

  it('does not mutate its inputs', () => {
    const candidates = [followingFemale, followingMale];
    const snapshot = JSON.stringify(candidates);
    getCandidatesForDisplay(candidates, [], 'target-following', '', DEFAULT_AUDIT_FILTER);
    summarizeAudit(candidates, [createUserNode()]);
    summarizeAudit(candidates, [createUserNode()], filterFor('male'));
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });
});
