import { describe, expect, it, vi } from 'vitest';
import { executeUnfollowPlan, UnfollowExecutorDeps } from '../../src/utils/unfollow-executor';
import { LivePlan } from '../../src/model/action-plan';
import { liveConfirmationPhrase } from '../../src/utils/approval';
import { createUserNode } from '../helpers/fixtures';
import { UserNode } from '../../src/model/user';

const USER_A = createUserNode({ id: 'a', username: 'alina.frames' });
const USER_B = createUserNode({ id: 'b', username: 'citrus.archive' });

function livePlan(users: readonly UserNode[]): LivePlan {
  return {
    mode: 'live',
    targets: users.map(user => ({ user, relationship: 'following' as const })),
    skipped: [],
    createdAt: 1735689600000,
    approval: {
      typedConfirmation: liveConfirmationPhrase(users.length),
      expectedCount: users.length,
      approvedAt: 1735689600000,
    },
  };
}

function harness(protectedUsernames: readonly string[] = []) {
  const unfollow = vi.fn(async () => ({ outcome: 'unfollowed' as const, detail: 'confirmed' }));
  const progress: number[] = [];
  const deps: UnfollowExecutorDeps = {
    unfollow,
    getCsrfToken: () => 'csrf-token',
    sleep: vi.fn(async () => undefined),
    timings: { timeBetweenUnfollows: 10, timeToWaitAfterFiveUnfollows: 20 },
    onProgress: p => progress.push(p.percentage),
    shouldAbort: () => false,
    random: () => 0,
    isProtected: user => protectedUsernames.indexOf(user.username) !== -1,
  };
  return { deps, unfollow, progress };
}

describe('executor: mid-run whitelist protection', () => {
  it('never touches a target that was protected before the queue started', async () => {
    const { deps, unfollow } = harness(['alina.frames']);
    const result = await executeUnfollowPlan(livePlan([USER_A, USER_B]), deps);

    expect(unfollow).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('protected-target');
    expect(result.entries).toEqual([]);
    expect(result.changedAnything).toBe(false);
  });

  it('stops before a later target that became protected while earlier ones ran', async () => {
    const protectedNow = new Set<string>();
    const unfollow = vi.fn(async (user: UserNode) => {
      if (user.username === 'alina.frames') {
        // The user protects the second queued account while the first is in flight.
        protectedNow.add('citrus.archive');
        return { outcome: 'unfollowed' as const, detail: 'confirmed' };
      }
      return { outcome: 'unfollowed' as const, detail: 'confirmed' };
    });
    const deps: UnfollowExecutorDeps = {
      unfollow,
      getCsrfToken: () => 'csrf-token',
      sleep: vi.fn(async () => undefined),
      timings: { timeBetweenUnfollows: 10, timeToWaitAfterFiveUnfollows: 20 },
      onProgress: () => undefined,
      shouldAbort: () => false,
      random: () => 0,
      isProtected: user => protectedNow.has(user.username),
    };

    const result = await executeUnfollowPlan(livePlan([USER_A, USER_B]), deps);

    expect(unfollow).toHaveBeenCalledTimes(1);
    expect(unfollow.mock.calls[0][0].username).toBe('alina.frames');
    expect(result.entries.map(entry => entry.user.username)).toEqual(['alina.frames']);
    expect(result.stopReason).toBe('protected-target');
    expect(result.changedAnything).toBe(true);
  });

  it('re-checks protection after a pacing sleep', async () => {
    let sleepHappened = false;
    const protectedNow = new Set<string>();
    const unfollow = vi.fn(async () => ({ outcome: 'unfollowed' as const, detail: 'confirmed' }));
    const deps: UnfollowExecutorDeps = {
      unfollow,
      getCsrfToken: () => 'csrf-token',
      sleep: vi.fn(async () => {
        sleepHappened = true;
        // The user protects the *next* queued account during the pause.
        protectedNow.add('alina.frames');
      }),
      timings: { timeBetweenUnfollows: 10, timeToWaitAfterFiveUnfollows: 20 },
      onProgress: () => undefined,
      shouldAbort: () => false,
      random: () => 0,
      isProtected: user => protectedNow.has(user.username),
    };

    const result = await executeUnfollowPlan(livePlan([USER_B, USER_A]), deps);

    expect(sleepHappened).toBe(true);
    // The second target's protection set during the pause is honoured.
    expect(unfollow).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('protected-target');
  });

  it('fails closed when the protection callback throws', async () => {
    const { deps: baseDeps, unfollow } = harness();
    const deps: UnfollowExecutorDeps = {
      ...baseDeps,
      isProtected: () => {
        throw new Error('storage unavailable');
      },
    };
    const result = await executeUnfollowPlan(livePlan([USER_A, USER_B]), deps);
    expect(unfollow).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('protected-target');
    expect(result.entries).toEqual([]);
  });

  it('keeps running when no account is protected', async () => {
    const { deps, unfollow } = harness();
    const result = await executeUnfollowPlan(livePlan([USER_A, USER_B]), deps);
    expect(unfollow).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('complete');
    expect(result.entries.map(entry => entry.status)).toEqual(['unfollowed', 'unfollowed']);
  });

  it('does not consult protection in a dry run', async () => {
    const isProtected = vi.fn(() => true);
    const dryPlan = {
      mode: 'dry-run' as const,
      targets: [{ user: USER_A, relationship: 'following' as const }],
      skipped: [],
      createdAt: 1735689600000,
    };
    const result = await executeUnfollowPlan(dryPlan, {
      ...harness().deps,
      isProtected,
    });
    expect(isProtected).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('complete');
    expect(result.entries[0].status).toBe('simulated');
  });
});
