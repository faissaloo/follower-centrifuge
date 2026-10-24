/**
 * Shared fixtures for the unfollow safety tests.
 *
 * All data here is invented: no real Instagram account id, username or profile
 * picture appears anywhere in this suite.
 */
import { AuditCandidate, FollowRelationship } from '../../src/model/audit';
import {
  DryRunPlan,
  LiveApproval,
  LivePlan,
  PlannedTarget,
} from '../../src/model/action-plan';
import { GenderGuess } from '../../src/model/gender';
import { UserNode } from '../../src/model/user';
import { liveConfirmationPhrase } from '../../src/utils/approval';

/** A fully-shaped fake account with an explicit follow relationship. */
export function makeUser(id: string, overrides: Partial<Omit<UserNode, 'id'>> = {}): UserNode {
  return {
    id,
    username: `user_${id}`,
    full_name: `Fake User ${id}`,
    profile_pic_url: `https://example.test/profile/${id}.jpg`,
    is_private: false,
    is_verified: false,
    followed_by_viewer: true,
    follows_viewer: false,
    requested_by_viewer: false,
    ...overrides,
  };
}

/** A complete gender guess; default is a confident "likely female". */
export function makeGenderGuess(overrides: Partial<GenderGuess> = {}): GenderGuess {
  return {
    gender: 'female',
    confidence: 0.9,
    reason: 'name reads feminine',
    source: 'demo',
    model: 'test-demo-model',
    classifiedAt: 0,
    ...overrides,
  };
}

export function makeFemaleGuess(confidence = 0.9): GenderGuess {
  return makeGenderGuess({ gender: 'female', confidence });
}

export function makeMaleGuess(confidence = 0.9): GenderGuess {
  return makeGenderGuess({ gender: 'male', confidence });
}

/** Deprecated aliases kept for older safety tests. */
export const makeWomanGuess = makeFemaleGuess;
export const makeManGuess = makeMaleGuess;

/** A user node plus the matching audit candidate. */
export interface CandidateFixture {
  readonly user: UserNode;
  readonly candidate: AuditCandidate;
}

/**
 * Build a user and its candidate in one step. Follow flags are derived from the
 * relationship the same way the audit runner derives them.
 */
export function makeCandidateFixture(
  id: string,
  relationship: FollowRelationship = 'following',
  gender: GenderGuess | null = makeWomanGuess(),
): CandidateFixture {
  const user = makeUser(id, {
    followed_by_viewer: relationship !== 'follower',
    follows_viewer: relationship !== 'following',
  });
  return { user, candidate: { user, relationship, gender } };
}

/** A follower-only account (not unfollowable by construction). */
export function makeFollowerOnlyFixture(id: string): CandidateFixture {
  return makeCandidateFixture(id, 'follower');
}

function toPlannedTargets(users: readonly UserNode[]): PlannedTarget[] {
  return users.map(
    (user): PlannedTarget => ({ user, relationship: 'following' }),
  );
}

/** A dry-run plan over the given targets (no skipped entries). */
export function makeDryRunPlan(users: readonly UserNode[], createdAt = 0): DryRunPlan {
  return {
    mode: 'dry-run',
    targets: toPlannedTargets(users),
    skipped: [],
    createdAt,
  };
}

/**
 * A live plan whose approval is valid by default; pass `approval` overrides to
 * build the invalid-approval cases.
 */
export function makeLivePlan(users: readonly UserNode[], approval: Partial<LiveApproval> = {}): LivePlan {
  const expectedCount = users.length;
  return {
    mode: 'live',
    targets: toPlannedTargets(users),
    skipped: [],
    createdAt: 1_600_000_000_000,
    approval: {
      typedConfirmation: liveConfirmationPhrase(expectedCount),
      expectedCount,
      approvedAt: 1_600_000_000_000,
      ...approval,
    },
  };
}
