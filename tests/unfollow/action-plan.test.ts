/**
 * Tests for the unfollow plan builder: the eligibility matrix (every skip
 * reason), ordering/de-duplication, the live approval gate, and the guarantee
 * that building a plan is pure.
 */
import { describe, expect, it, vi } from 'vitest';
import { AuditCandidate } from '../../src/model/audit';
import { BuildPlanResult, UnfollowPlan } from '../../src/model/action-plan';
import { UserNode } from '../../src/model/user';
import {
  BuildUnfollowPlanInput,
  buildUnfollowPlan,
  countEligibleTargets,
} from '../../src/utils/action-plan';
import {
  CandidateFixture,
  makeCandidateFixture,
  makeFollowerOnlyFixture,
  makeGenderGuess,
  makeMaleGuess,
  makeUser,
  makeFemaleGuess,
} from './fixtures';

/** Assert an ok result and return the plan (narrows the BuildPlanResult union). */
function expectPlan(result: BuildPlanResult): UnfollowPlan {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected an ok plan, got: ${result.errors.join(' | ')}`);
  }
  return result.plan;
}

/** Assert a refusal and return its error messages (narrows the BuildPlanResult union). */
function expectRefused(result: BuildPlanResult): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected the plan builder to refuse a plan');
  }
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

function buildPlan(overrides: Partial<BuildUnfollowPlanInput> = {}): BuildPlanResult {
  return buildUnfollowPlan({
    selected: [],
    candidates: [],
    whitelistedIds: new Set<string>(),
    mode: 'dry-run',
    ...overrides,
  });
}

/** Dry-run plan for a single fixture selection. */
function buildDryRun(...fixtures: readonly CandidateFixture[]): BuildPlanResult {
  return buildPlan({
    selected: fixtures.map(fixture => fixture.user),
    candidates: fixtures.map(fixture => fixture.candidate),
    mode: 'dry-run',
  });
}

function firstTargetUser(plan: UnfollowPlan): UserNode {
  expect(plan.targets.length).toBeGreaterThan(0);
  return plan.targets[0].user;
}

describe('explicit non-person nuke categories', () => {
  it('allows a machine target when the user explicitly chose that category', () => {
    const fixture = makeCandidateFixture('m1', 'following', makeGenderGuess({ gender: 'machine', confidence: 0.99 }));
    const result = buildUnfollowPlan({
      selected: [fixture.user],
      candidates: [fixture.candidate],
      whitelistedIds: new Set<string>(),
      mode: 'dry-run',
      targetCategory: 'machine',
    });
    const plan = expectPlan(result);
    expect(plan.targets.map(target => target.user.id)).toEqual(['m1']);
  });

  it('keeps a female-only plan safe when the machine target is chosen', () => {
    const humans = makeCandidateFixture('h1', 'following', makeFemaleGuess(0.99));
    const result = buildUnfollowPlan({
      selected: [humans.user],
      candidates: [humans.candidate],
      whitelistedIds: new Set<string>(),
      mode: 'dry-run',
      targetCategory: 'machine',
    });
    expect(expectPlan(result).targets).toHaveLength(0);
    expect(expectPlan(result).skipped[0]?.reason).toBe('not-target-gender');
  });
});

describe('plan action ordering', () => {
  it('interleaves unfollows and follower removals so both start immediately', () => {
    const unfollowA = makeCandidateFixture('u1', 'following', makeFemaleGuess());
    const unfollowB = makeCandidateFixture('u2', 'following', makeFemaleGuess());
    const removeA = makeFollowerOnlyFixture('r1');
    const removeB = makeFollowerOnlyFixture('r2');
    const result = buildPlan({
      selected: [unfollowA.user, unfollowB.user, removeA.user, removeB.user],
      candidates: [unfollowA.candidate, unfollowB.candidate, removeA.candidate, removeB.candidate],
      mode: 'dry-run',
      includeFollowers: true,
    });
    const plan = expectPlan(result);
    expect(plan.targets.map(target => target.action)).toEqual([
      'unfollow',
      'remove-follower',
      'unfollow',
      'remove-follower',
    ]);
    expect(plan.targets.map(target => target.user.id)).toEqual(['u1', 'r1', 'u2', 'r2']);
  });
});

describe('manual ambiguous selection', () => {
  it('keeps ambiguous accounts out by default and allows them when explicitly enabled', () => {
    const fixture = makeCandidateFixture('a1', 'following', makeGenderGuess({ gender: 'ambiguous', confidence: 0.99 }));
    const refusedPlan = expectPlan(
      buildPlan({ selected: [fixture.user], candidates: [fixture.candidate], mode: 'dry-run' }),
    );
    expect(refusedPlan.targets).toHaveLength(0);
    expect(refusedPlan.skipped[0].reason).toBe('not-target-gender');
    const allowed = buildPlan({
      selected: [fixture.user],
      candidates: [fixture.candidate],
      mode: 'dry-run',
      allowAmbiguousSelections: true,
    });
    const plan = expectPlan(allowed);
    expect(plan.targets.map(target => target.user.id)).toEqual(['a1']);
    expect(plan.targets[0].action).toBe('unfollow');
  });
});

describe('follower removal', () => {
  it('removes followers-only accounts when includeFollowers is enabled', () => {
    const fixture = makeFollowerOnlyFixture('f1');
    const result = buildPlan({
      selected: [fixture.user],
      candidates: [fixture.candidate],
      mode: 'dry-run',
      includeFollowers: true,
      targetCategory: 'female',
    });
    const plan = expectPlan(result);
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].action).toBe('remove-follower');
    expect(plan.targets[0].relationship).toBe('follower');
  });
});

describe('buildUnfollowPlan - eligibility matrix', () => {
  it('builds a target for a followed likely woman under the default target', () => {
    const fixture = makeCandidateFixture('1', 'following');
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.mode).toBe('dry-run');
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].user).toBe(fixture.user);
    expect(plan.targets[0].relationship).toBe('following');
    expect(plan.skipped).toHaveLength(0);
  });

  it('includes mutual accounts that the viewer follows', () => {
    const fixture = makeCandidateFixture('2', 'mutual');
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].relationship).toBe('mutual');
  });

  it('skips accounts the viewer does not follow', () => {
    const fixture = makeFollowerOnlyFixture('3');
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('not-followed-by-you');
    expect(plan.skipped[0].user).toBe(fixture.user);
  });

  it('skips a candidate whose followed_by_viewer flag is false', () => {
    const user = makeUser('4', { followed_by_viewer: false, follows_viewer: true });
    const candidate: AuditCandidate = { user, relationship: 'mutual', gender: makeFemaleGuess() };
    const plan = expectPlan(buildPlan({ selected: [user], candidates: [candidate] }));

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('not-followed-by-you');
  });

  it('skips whitelisted accounts', () => {
    const fixture = makeCandidateFixture('5', 'following');
    const plan = expectPlan(
      buildPlan({
        selected: [fixture.user],
        candidates: [fixture.candidate],
        whitelistedIds: new Set<string>([fixture.user.id]),
      }),
    );

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('whitelisted');
  });

  it('lets whitelisting win over every other skip reason', () => {
    const fixture = makeFollowerOnlyFixture('6');
    const plan = expectPlan(
      buildPlan({
        selected: [fixture.user],
        candidates: [fixture.candidate],
        whitelistedIds: new Set<string>([fixture.user.id]),
      }),
    );

    expect(plan.skipped[0].reason).toBe('whitelisted');
  });

  it('skips accounts of the opposite gender under the default woman target', () => {
    const fixture = makeCandidateFixture('7', 'following', makeMaleGuess());
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('not-target-gender');
  });

  it('skips unknown-gender accounts', () => {
    const fixture = makeCandidateFixture('8', 'following', makeGenderGuess({ gender: 'ambiguous', confidence: 0.95 }));
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('not-target-gender');
  });

  it('skips unclassified accounts whose gender is null', () => {
    const fixture = makeCandidateFixture('9', 'following', null);
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.skipped[0].reason).toBe('not-target-gender');
  });

  it('skips women below the default confidence threshold', () => {
    const fixture = makeCandidateFixture('10', 'following', makeFemaleGuess(0.59));
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.skipped[0].reason).toBe('not-target-gender');
  });

  it('accepts a woman exactly at the default confidence threshold', () => {
    const fixture = makeCandidateFixture('11', 'following', makeFemaleGuess(0.6));
    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.targets).toHaveLength(1);
  });

  it('honours a custom minimum confidence', () => {
    const fixture = makeCandidateFixture('12', 'following', makeFemaleGuess(0.75));
    const common = {
      selected: [fixture.user],
      candidates: [fixture.candidate],
    };

    const strict = expectPlan(buildPlan({ ...common, minimumConfidence: 0.8 }));
    expect(strict.targets).toHaveLength(0);
    expect(strict.skipped[0].reason).toBe('not-target-gender');

    const lenient = expectPlan(buildPlan({ ...common, minimumConfidence: 0.7 }));
    expect(lenient.targets).toHaveLength(1);
  });

  it('skips selected accounts missing from the candidates', () => {
    const ghost = makeUser('ghost');
    const plan = expectPlan(buildPlan({ selected: [ghost], candidates: [] }));

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('missing-user');
    expect(plan.skipped[0].user).toBe(ghost);
  });

  it('reports one skip reason per ineligible account, in selection order', () => {
    const follower = makeFollowerOnlyFixture('13a');
    const whitelisted = makeCandidateFixture('13b', 'following');
    const man = makeCandidateFixture('13c', 'following', makeMaleGuess());
    const woman = makeCandidateFixture('13d', 'following');
    const ghost = makeUser('13e');

    const plan = expectPlan(
      buildPlan({
        selected: [follower.user, whitelisted.user, man.user, woman.user, ghost],
        candidates: [follower.candidate, whitelisted.candidate, man.candidate, woman.candidate],
        whitelistedIds: new Set<string>([whitelisted.user.id]),
      }),
    );

    expect(plan.targets).toHaveLength(1);
    expect(firstTargetUser(plan)).toBe(woman.user);
    expect(plan.skipped.map(skip => skip.reason)).toEqual([
      'not-followed-by-you',
      'whitelisted',
      'not-target-gender',
      'missing-user',
    ]);
  });

  it('de-duplicates repeated selected ids and keeps the first occurrence', () => {
    const fixture = makeCandidateFixture('14', 'following');
    const repeatedUser = makeUser('14', { username: 'repeated_name' });

    const plan = expectPlan(
      buildPlan({
        selected: [fixture.user, repeatedUser],
        candidates: [fixture.candidate],
      }),
    );

    expect(plan.targets).toHaveLength(1);
    expect(firstTargetUser(plan)).toBe(fixture.user);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('duplicate');
    expect(plan.skipped[0].user).toBe(repeatedUser);
  });

  it('keeps the human selection order for eligible targets', () => {
    const first = makeCandidateFixture('15a');
    const second = makeCandidateFixture('15b');
    const third = makeCandidateFixture('15c');

    const plan = expectPlan(
      buildPlan({
        selected: [third.user, first.user, second.user],
        candidates: [first.candidate, second.candidate, third.candidate],
      }),
    );

    expect(plan.targets.map(target => target.user.id)).toEqual(['15c', '15a', '15b']);
  });

  it('uses the first candidate entry when the candidate list repeats an id', () => {
    const fixture = makeCandidateFixture('16', 'follower');
    const duplicateCandidate: AuditCandidate = {
      user: fixture.user,
      relationship: 'following',
      gender: makeFemaleGuess(),
    };

    const plan = expectPlan(
      buildPlan({
        selected: [fixture.user],
        candidates: [fixture.candidate, duplicateCandidate],
      }),
    );

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('not-followed-by-you');
  });

  it('does not mutate frozen selection or candidate arrays', () => {
    const first = makeCandidateFixture('17a');
    const second = makeCandidateFixture('17b');
    const selected: readonly UserNode[] = Object.freeze([first.user, second.user, first.user]);
    const candidates: readonly AuditCandidate[] = Object.freeze([first.candidate, second.candidate]);

    const plan = expectPlan(buildPlan({ selected, candidates }));

    expect(plan.targets).toHaveLength(2);
    expect(selected).toHaveLength(3);
    expect(candidates).toHaveLength(2);
    expect(plan.targets[0].user).toBe(first.user);
    expect(plan.targets[1].user).toBe(second.user);
  });
});

describe('buildUnfollowPlan - dry-run plans', () => {
  it('allows an empty dry run and still reports every skip', () => {
    const follower = makeFollowerOnlyFixture('20');

    const result = buildPlan({
      selected: [follower.user],
      candidates: [follower.candidate],
      mode: 'dry-run',
    });
    const plan = expectPlan(result);

    expect(result.ok).toBe(true);
    expect(plan.mode).toBe('dry-run');
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped.map(skip => skip.reason)).toEqual(['not-followed-by-you']);
  });

  it('uses the injected clock for createdAt', () => {
    const fixture = makeCandidateFixture('21');
    const now = vi.fn(() => 424242);

    const plan = expectPlan(
      buildPlan({ selected: [fixture.user], candidates: [fixture.candidate], now }),
    );

    expect(plan.createdAt).toBe(424242);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('falls back to Date.now for createdAt', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(777000);
    const fixture = makeCandidateFixture('22');

    const plan = expectPlan(buildDryRun(fixture));

    expect(plan.createdAt).toBe(777000);
    clock.mockRestore();
  });

  it('carries no approval field on a dry-run plan', () => {
    const fixture = makeCandidateFixture('23');
    const plan = expectPlan(buildDryRun(fixture));

    expect('approval' in plan).toBe(false);
  });
});

describe('buildUnfollowPlan - live approval gate', () => {
  function liveSelection(count: number): { selected: UserNode[]; candidates: AuditCandidate[] } {
    const fixtures: CandidateFixture[] = [];
    for (let index = 0; index < count; index += 1) {
      fixtures.push(makeCandidateFixture(`30${index}`));
    }
    return {
      selected: fixtures.map(fixture => fixture.user),
      candidates: fixtures.map(fixture => fixture.candidate),
    };
  }

  it('builds a live plan only with the exact phrase for the exact count', () => {
    const selection = liveSelection(2);

    const result = buildPlan({
      ...selection,
      mode: 'live',
      typedConfirmation: 'UNFOLLOW 2',
      now: () => 999,
    });
    const plan = expectPlan(result);

    expect(plan.mode).toBe('live');
    expect(plan.targets).toHaveLength(2);
    expect(plan.createdAt).toBe(999);
    if (plan.mode !== 'live') {
      throw new Error('expected a live plan');
    }
    expect(plan.approval.typedConfirmation).toBe('UNFOLLOW 2');
    expect(plan.approval.expectedCount).toBe(2);
    expect(plan.approval.approvedAt).toBe(999);
  });

  it('uses one timestamp for createdAt and approvedAt', () => {
    const selection = liveSelection(1);
    const now = vi.fn(() => 123456);

    const plan = expectPlan(
      buildPlan({ ...selection, mode: 'live', typedConfirmation: 'UNFOLLOW 1', now }),
    );
    if (plan.mode !== 'live') {
      throw new Error('expected a live plan');
    }

    expect(plan.createdAt).toBe(123456);
    expect(plan.approval.approvedAt).toBe(123456);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing typed confirmation', () => {
    const selection = liveSelection(1);
    const errors = expectRefused(buildPlan({ ...selection, mode: 'live' }));

    expect(errors.join(' ')).toContain('UNFOLLOW 1');
  });

  it('rejects a phrase with different casing', () => {
    const selection = liveSelection(1);
    const errors = expectRefused(
      buildPlan({ ...selection, mode: 'live', typedConfirmation: 'unfollow 1' }),
    );

    expect(errors.join(' ')).toContain('UNFOLLOW 1');
  });

  it('rejects a phrase with surrounding whitespace', () => {
    const selection = liveSelection(1);
    const lower = expectRefused(
      buildPlan({ ...selection, mode: 'live', typedConfirmation: ' UNFOLLOW 1' }),
    );
    const upper = expectRefused(
      buildPlan({ ...selection, mode: 'live', typedConfirmation: 'UNFOLLOW 1 ' }),
    );

    expect(lower.length).toBeGreaterThan(0);
    expect(upper.length).toBeGreaterThan(0);
  });

  it('rejects a phrase typed for a different target count', () => {
    const selection = liveSelection(2);
    const errors = expectRefused(
      buildPlan({ ...selection, mode: 'live', typedConfirmation: 'UNFOLLOW 1' }),
    );

    expect(errors.join(' ')).toContain('UNFOLLOW 2');
  });

  it('rejects live mode with zero eligible targets even for the "UNFOLLOW 0" phrase', () => {
    const follower = makeFollowerOnlyFixture('31');

    const result = buildPlan({
      selected: [follower.user],
      candidates: [follower.candidate],
      mode: 'live',
      typedConfirmation: 'UNFOLLOW 0',
    });
    const errors = expectRefused(result);

    expect(errors.join(' ')).toContain('nothing to unfollow');
  });

  it('explains the exact expected phrase on rejection', () => {
    const selection = liveSelection(2);
    const errors = expectRefused(
      buildPlan({ ...selection, mode: 'live', typedConfirmation: 'nope' }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('UNFOLLOW 2');
    expect(errors[0]).toContain('2 accounts');
  });

  it('returns no plan at all when the live approval is invalid', () => {
    const selection = liveSelection(1);
    const result = buildPlan({ ...selection, mode: 'live', typedConfirmation: 'UNFOLLOW 2' });

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('plan');
  });

  it('keeps skipped accounts on an approved live plan', () => {
    const eligible = makeCandidateFixture('32a');
    const whitelisted = makeCandidateFixture('32b');

    const plan = expectPlan(
      buildPlan({
        selected: [eligible.user, whitelisted.user],
        candidates: [eligible.candidate, whitelisted.candidate],
        whitelistedIds: new Set<string>([whitelisted.user.id]),
        mode: 'live',
        typedConfirmation: 'UNFOLLOW 1',
      }),
    );

    expect(plan.mode).toBe('live');
    expect(plan.targets).toHaveLength(1);
    expect(firstTargetUser(plan)).toBe(eligible.user);
    expect(plan.skipped.map(skip => skip.reason)).toEqual(['whitelisted']);
  });
});

describe('buildUnfollowPlan - selectable gender target', () => {
  it('unfollows likely men when the target is men', () => {
    const man = makeCandidateFixture('50a', 'following', makeMaleGuess());
    const plan = expectPlan(buildPlan({ selected: [man.user], candidates: [man.candidate], targetCategory: 'male' }));

    expect(plan.targets).toHaveLength(1);
    expect(firstTargetUser(plan)).toBe(man.user);
    expect(plan.skipped).toHaveLength(0);
  });

  it('skips likely women when the target is men', () => {
    const woman = makeCandidateFixture('50b', 'following', makeFemaleGuess());
    const plan = expectPlan(buildPlan({ selected: [woman.user], candidates: [woman.candidate], targetCategory: 'male' }));

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('not-target-gender');
  });

  it('skips likely men under the default woman target without an explicit targetGender', () => {
    const man = makeCandidateFixture('50c', 'following', makeMaleGuess());
    const plan = expectPlan(buildDryRun(man));

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('not-target-gender');
  });

  it('honours the confidence threshold for the selected target', () => {
    const weakMan = makeCandidateFixture('50d', 'following', makeMaleGuess(0.55));
    const strongMan = makeCandidateFixture('50e', 'following', makeMaleGuess(0.75));

    const strict = expectPlan(
      buildPlan({
        selected: [weakMan.user, strongMan.user],
        candidates: [weakMan.candidate, strongMan.candidate],
        targetCategory: 'male',
      }),
    );
    expect(strict.targets.map(target => target.user.id)).toEqual(['50e']);
    expect(strict.skipped.map(skip => [skip.user.id, skip.reason])).toEqual([['50d', 'not-target-gender']]);
  });

  it('builds a live plan over men only when the exact phrase matches the men count', () => {
    const man = makeCandidateFixture('50f', 'following', makeMaleGuess());
    const woman = makeCandidateFixture('50g', 'following', makeFemaleGuess());
    const common = {
      selected: [man.user, woman.user],
      candidates: [man.candidate, woman.candidate],
      targetCategory: 'male' as const,
      mode: 'live' as const,
      now: () => 999,
    };

    const refused = buildPlan({ ...common, typedConfirmation: 'UNFOLLOW 2' });
    expect(refused.ok).toBe(false);

    const plan = expectPlan(buildPlan({ ...common, typedConfirmation: 'UNFOLLOW 1' }));
    expect(plan.mode).toBe('live');
    expect(plan.targets).toHaveLength(1);
    expect(firstTargetUser(plan)).toBe(man.user);
    expect(plan.skipped.map(skip => skip.reason)).toEqual(['not-target-gender']);
  });

  it('lets whitelisting still win under a men target', () => {
    const man = makeCandidateFixture('50h', 'following', makeMaleGuess());
    const plan = expectPlan(
      buildPlan({
        selected: [man.user],
        candidates: [man.candidate],
        whitelistedIds: new Set<string>([man.user.id]),
        targetCategory: 'male',
      }),
    );

    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('whitelisted');
  });
});

describe('countEligibleTargets', () => {
  it('matches the number of targets a dry run would produce', () => {
    const eligible = makeCandidateFixture('40a');
    const follower = makeFollowerOnlyFixture('40b');
    const man = makeCandidateFixture('40c', 'following', makeMaleGuess());
    const common = {
      selected: [eligible.user, follower.user, man.user, eligible.user],
      candidates: [eligible.candidate, follower.candidate, man.candidate],
      whitelistedIds: new Set<string>(),
    };

    const count = countEligibleTargets(common);
    const plan = expectPlan(buildPlan(common));

    expect(count).toBe(1);
    expect(count).toBe(plan.targets.length);
  });

  it('counts zero when nothing is eligible', () => {
    const follower = makeFollowerOnlyFixture('41');

    expect(
      countEligibleTargets({
        selected: [follower.user],
        candidates: [follower.candidate],
        whitelistedIds: new Set<string>(),
      }),
    ).toBe(0);
  });

  it('honours the selected target gender', () => {
    const woman = makeCandidateFixture('43a', 'following', makeFemaleGuess());
    const man = makeCandidateFixture('43b', 'following', makeMaleGuess());
    const common = {
      selected: [woman.user, man.user],
      candidates: [woman.candidate, man.candidate],
      whitelistedIds: new Set<string>(),
    };

    expect(countEligibleTargets(common)).toBe(1);
    expect(countEligibleTargets({ ...common, targetCategory: 'female' })).toBe(1);
    expect(countEligibleTargets({ ...common, targetCategory: 'male' })).toBe(1);
    expect(
      countEligibleTargets({
        selected: [woman.user],
        candidates: [woman.candidate],
        whitelistedIds: new Set<string>(),
        targetCategory: 'male',
      }),
    ).toBe(0);
  });

  it('honours the same custom confidence threshold as the plan builder', () => {
    const fixture = makeCandidateFixture('42', 'following', makeFemaleGuess(0.75));
    const common = {
      selected: [fixture.user],
      candidates: [fixture.candidate],
      whitelistedIds: new Set<string>(),
    };

    expect(countEligibleTargets(common)).toBe(1);
    expect(countEligibleTargets({ ...common, minimumConfidence: 0.8 })).toBe(0);
  });
});
