import { describe, expect, it } from 'vitest';
import { buildUnfollowPlan, countEligibleTargets } from '../../src/utils/action-plan';
import { createCandidate, createUserNode } from '../helpers/fixtures';
import { liveConfirmationPhrase } from '../../src/utils/approval';

const alice = createCandidate({ id: 'real-1', username: 'alice', gender: 'woman', confidence: 0.95 });
const pastedAlice = createUserNode({
  id: 'pasted_alice_1735689600000_ab12',
  username: 'alice',
  fullName: 'alice',
});

/**
 * Regression tests for the bulk-pasted whitelist flaw: pasted protections have
 * synthetic ids, so plan building must also match on the normalized username.
 */
describe('plan builder: pasted-username whitelist protection', () => {
  it('never targets a real account covered by a pasted username entry', () => {
    const result = buildUnfollowPlan({
      selected: [alice.user],
      candidates: [alice],
      whitelistedIds: new Set([pastedAlice.id]),
      whitelistedUsernames: new Set(['alice']),
      mode: 'dry-run',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.targets).toEqual([]);
    expect(result.plan.skipped).toHaveLength(1);
    expect(result.plan.skipped[0].reason).toBe('whitelisted');
  });

  it('refuses to build a live plan for a pasted-protected account', () => {
    const result = buildUnfollowPlan({
      selected: [alice.user],
      candidates: [alice],
      whitelistedIds: new Set([pastedAlice.id]),
      whitelistedUsernames: new Set(['alice']),
      mode: 'live',
      typedConfirmation: liveConfirmationPhrase(1),
    });
    expect(result.ok).toBe(false);
  });

  it('counts pasted-protected accounts as ineligible', () => {
    expect(
      countEligibleTargets({
        selected: [alice.user],
        candidates: [alice],
        whitelistedIds: new Set([pastedAlice.id]),
        whitelistedUsernames: new Set(['alice']),
      }),
    ).toBe(0);
  });

  it('is case-insensitive and tolerates a leading @ in stored usernames', () => {
    const result = buildUnfollowPlan({
      selected: [alice.user],
      candidates: [alice],
      whitelistedIds: new Set(),
      whitelistedUsernames: new Set(['@ALICE']),
      mode: 'dry-run',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.targets).toEqual([]);
  });

  it('still targets the account when no matching protection exists', () => {
    const other = createUserNode({ id: 'pasted_bob_1_x', username: 'bob' });
    const result = buildUnfollowPlan({
      selected: [alice.user],
      candidates: [alice],
      whitelistedIds: new Set([other.id]),
      whitelistedUsernames: new Set(['bob']),
      mode: 'dry-run',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.targets.map(target => target.user.username)).toEqual(['alice']);
  });
});
