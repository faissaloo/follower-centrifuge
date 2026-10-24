/**
 * Tests for the unfollow executor: the provable dry-run/live split, the
 * approval + session gates, outcome mapping and stop behavior, abort handling,
 * pacing, progress reporting and the no-network guarantee.
 *
 * Every transport is an injected fake; the global `fetch` guard in
 * `tests/setup.ts` doubles as a tripwire that no real request escapes.
 */
import {
  Mock,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ExecutionEntry,
  ExecutionProgress,
  LiveApproval,
  LivePlan,
  UnfollowPlan,
} from '../../src/model/action-plan';
import { UserNode } from '../../src/model/user';
import type { UnfollowOutcome, UnfollowResult } from '../../src/utils/utils';
import {
  DRY_RUN_ENTRY_DETAIL,
  UnfollowExecutorDeps,
  executeUnfollowPlan,
} from '../../src/utils/unfollow-executor';
import { liveConfirmationPhrase } from '../../src/utils/approval';
import { networkGuard } from '../setup';
import {
  makeDryRunPlan,
  makeLivePlan,
  makeUser,
} from './fixtures';

interface ExecutorHarness {
  readonly deps: UnfollowExecutorDeps;
  readonly unfollow: Mock<(user: UserNode, csrftoken: string) => Promise<UnfollowResult>>;
  readonly sleep: Mock<(ms: number) => Promise<void>>;
  readonly getCsrfToken: Mock<() => string | null>;
  readonly onProgress: Mock<(progress: ExecutionProgress) => void>;
  readonly onEntry: Mock<(entry: ExecutionEntry) => void>;
  readonly shouldAbort: Mock<() => boolean>;
}

function makeHarness(overrides: Partial<UnfollowExecutorDeps> = {}): ExecutorHarness {
  const unfollow = vi.fn<(user: UserNode, csrftoken: string) => Promise<UnfollowResult>>(
    async () => ({ outcome: 'unfollowed', detail: 'confirmed by fake transport' }),
  );
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const getCsrfToken = vi.fn<() => string | null>(() => 'csrf-token-123');
  const onProgress = vi.fn<(progress: ExecutionProgress) => void>();
  const onEntry = vi.fn<(entry: ExecutionEntry) => void>();
  const shouldAbort = vi.fn<() => boolean>(() => false);
  const deps: UnfollowExecutorDeps = {
    unfollow,
    sleep,
    getCsrfToken,
    onProgress,
    onEntry,
    shouldAbort,
    timings: { timeBetweenUnfollows: 1000, timeToWaitAfterFiveUnfollows: 5000 },
    random: vi.fn<() => number>(() => 0.5),
    now: vi.fn<() => number>(() => 1_700_000_000_000),
    ...overrides,
  };
  // Read the mocks back out of `deps` so callers that inject their own spies
  // (via `overrides`) still get the spy they can assert on.
  return {
    deps,
    unfollow: deps.unfollow as ExecutorHarness['unfollow'],
    sleep: deps.sleep as ExecutorHarness['sleep'],
    getCsrfToken: deps.getCsrfToken as ExecutorHarness['getCsrfToken'],
    onProgress: deps.onProgress as ExecutorHarness['onProgress'],
    onEntry: deps.onEntry as ExecutorHarness['onEntry'],
    shouldAbort: deps.shouldAbort as ExecutorHarness['shouldAbort'],
  };
}

/** Build a plan whose targets are `count` fake accounts. */
function livePlanOf(count: number, approval: Partial<LiveApproval> = {}): LivePlan {
  const users: UserNode[] = [];
  for (let index = 0; index < count; index += 1) {
    users.push(makeUser(`live_${index}`));
  }
  return makeLivePlan(users, approval);
}

/** Transport implementation replaying a fixed sequence of outcomes. */
function responseScript(
  ...outcomes: readonly UnfollowOutcome[]
): (user: UserNode, csrftoken: string) => Promise<UnfollowResult> {
  const queue = outcomes.slice();
  let nextIndex = 0;
  return async () => {
    const outcome: UnfollowOutcome = nextIndex < queue.length ? queue[nextIndex] : 'failed';
    nextIndex += 1;
    return { outcome, detail: `transport said ${outcome}` };
  };
}

function percentages(harness: ExecutorHarness): number[] {
  return harness.onProgress.mock.calls.map(call => call[0].percentage);
}

function sleepDurations(harness: ExecutorHarness): number[] {
  return harness.sleep.mock.calls.map(call => call[0]);
}

describe('dry-run plan execution', () => {
  it('simulates every target without any transport or network call', async () => {
    const harness = makeHarness();
    const plan = makeDryRunPlan([makeUser('dry_1'), makeUser('dry_2')]);

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(result.mode).toBe('dry-run');
    expect(result.stopReason).toBe('complete');
    expect(result.changedAnything).toBe(false);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(entry => entry.status)).toEqual(['simulated', 'simulated']);
    expect(result.entries.map(entry => entry.user.id)).toEqual(['dry_1', 'dry_2']);
    expect(result.entries[0].detail).toBe(DRY_RUN_ENTRY_DETAIL);
    expect(DRY_RUN_ENTRY_DETAIL).toBe('dry run: no request was sent');
    expect(harness.unfollow).not.toHaveBeenCalled();
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it('never sleeps during a dry run, even for many targets', async () => {
    const harness = makeHarness();
    const users: UserNode[] = [];
    for (let index = 0; index < 12; index += 1) {
      users.push(makeUser(`dry_many_${index}`));
    }

    const result = await executeUnfollowPlan(makeDryRunPlan(users), harness.deps);

    expect(result.entries).toHaveLength(12);
    expect(harness.sleep).not.toHaveBeenCalled();
    expect(harness.unfollow).not.toHaveBeenCalled();
  });

  it('never reads the session token or polled abort flag during a dry run', async () => {
    const harness = makeHarness();
    const plan = makeDryRunPlan([makeUser('dry_3')]);

    await executeUnfollowPlan(plan, harness.deps);

    expect(harness.getCsrfToken).not.toHaveBeenCalled();
    expect(harness.shouldAbort).not.toHaveBeenCalled();
  });

  it('streams one onEntry call per simulated entry in order', async () => {
    const harness = makeHarness();
    const plan = makeDryRunPlan([makeUser('dry_4'), makeUser('dry_5'), makeUser('dry_6')]);

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(harness.onEntry).toHaveBeenCalledTimes(3);
    const streamed = harness.onEntry.mock.calls.map(call => call[0]);
    expect(streamed).toEqual(result.entries);
    expect(streamed.map(entry => entry.status)).toEqual(['simulated', 'simulated', 'simulated']);
  });

  it('reports monotonic progress ending at 100 percent', async () => {
    const harness = makeHarness();
    const plan = makeDryRunPlan([makeUser('dry_7'), makeUser('dry_8'), makeUser('dry_9')]);

    await executeUnfollowPlan(plan, harness.deps);

    const progress = harness.onProgress.mock.calls.map(call => call[0]);
    expect(progress.map(entry => entry.completed)).toEqual([1, 2, 3]);
    expect(percentages(harness)).toEqual([33, 66, 100]);
    expect(progress.every(entry => entry.mode === 'dry-run' && entry.total === 3)).toBe(true);
  });

  it('refuses to simulate anything for an empty dry-run plan', async () => {
    const harness = makeHarness();

    const result = await executeUnfollowPlan(makeDryRunPlan([]), harness.deps);

    expect(result.entries).toHaveLength(0);
    expect(result.stopReason).toBe('complete');
    expect(result.changedAnything).toBe(false);
    expect(harness.unfollow).not.toHaveBeenCalled();
    expect(harness.sleep).not.toHaveBeenCalled();
    expect(harness.onProgress).not.toHaveBeenCalled();
    expect(harness.onEntry).not.toHaveBeenCalled();
  });

  it('does not mutate the dry-run plan or its targets', async () => {
    const harness = makeHarness();
    const plan = Object.freeze(makeDryRunPlan([makeUser('dry_10'), makeUser('dry_11')]));

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(result.entries).toHaveLength(2);
    expect(plan.targets).toHaveLength(2);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('treats a plan with a forged non-live mode as a simulation', async () => {
    const harness = makeHarness();
    const forged = {
      ...makeDryRunPlan([makeUser('dry_forged')]),
      mode: 'forged-mode',
    } as unknown as UnfollowPlan;

    const result = await executeUnfollowPlan(forged, harness.deps);

    expect(result.mode).toBe('dry-run');
    expect(result.entries.map(entry => entry.status)).toEqual(['simulated']);
    expect(result.changedAnything).toBe(false);
    expect(harness.unfollow).not.toHaveBeenCalled();
  });
});

describe('executeUnfollowPlan - follower removal', () => {
  it('uses the remove-follower transport and records a confirmed follower removal', async () => {
    const removeFollower = vi.fn(async () => ({ outcome: 'removed-follower' as const, detail: 'confirmed' }));
    const harness = makeHarness({ removeFollower });
    const user = makeUser('f1', { followed_by_viewer: false, follows_viewer: true });
    const plan: LivePlan = {
      mode: 'live',
      targets: [{ user, relationship: 'follower', action: 'remove-follower' }],
      skipped: [],
      createdAt: 0,
      approval: { typedConfirmation: liveConfirmationPhrase(1), expectedCount: 1, approvedAt: 0 },
    };
    const result = await executeUnfollowPlan(plan, harness.deps);
    expect(result.mode).toBe('live');
    expect(result.changedAnything).toBe(true);
    expect(result.entries[0].status).toBe('removed-follower');
    expect(removeFollower).toHaveBeenCalledTimes(1);
    expect(harness.unfollow).not.toHaveBeenCalled();
  });
});

describe('live approval gate', () => {
  it('refuses a wrong typed phrase before touching anything', async () => {
    const harness = makeHarness();
    const plan = livePlanOf(2, { typedConfirmation: 'unfollow 2' });

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(result.mode).toBe('live');
    expect(result.stopReason).toBe('invalid-approval');
    expect(result.entries).toHaveLength(0);
    expect(result.changedAnything).toBe(false);
    expect(harness.unfollow).not.toHaveBeenCalled();
    expect(harness.getCsrfToken).not.toHaveBeenCalled();
    expect(harness.sleep).not.toHaveBeenCalled();
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it('refuses a stale expected count even when the phrase count matches', async () => {
    const harness = makeHarness();
    const plan = livePlanOf(2, { expectedCount: 3 });

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(result.stopReason).toBe('invalid-approval');
    expect(harness.unfollow).not.toHaveBeenCalled();
  });

  it('refuses a live plan that carries zero targets', async () => {
    const harness = makeHarness();

    const result = await executeUnfollowPlan(livePlanOf(0), harness.deps);

    expect(result.stopReason).toBe('invalid-approval');
    expect(result.entries).toHaveLength(0);
    expect(harness.unfollow).not.toHaveBeenCalled();
  });

  it('refuses a phrase with surrounding whitespace', async () => {
    const harness = makeHarness();
    const plan = livePlanOf(1, { typedConfirmation: ' UNFOLLOW 1' });

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(result.stopReason).toBe('invalid-approval');
    expect(harness.unfollow).not.toHaveBeenCalled();
  });

  it('refuses a live plan whose approval object is missing entirely', async () => {
    const validPlan = livePlanOf(1);
    const forged = {
      mode: 'live',
      targets: validPlan.targets,
      skipped: [],
      createdAt: 0,
    } as unknown as LivePlan;
    const harness = makeHarness();

    const result = await executeUnfollowPlan(forged, harness.deps);

    expect(result.stopReason).toBe('invalid-approval');
    expect(result.entries).toHaveLength(0);
    expect(harness.unfollow).not.toHaveBeenCalled();
  });

  it('reports no progress or entries when the approval is invalid', async () => {
    const harness = makeHarness();
    const plan = livePlanOf(1, { typedConfirmation: 'UNFOLLOW 2' });

    await executeUnfollowPlan(plan, harness.deps);

    expect(harness.onProgress).not.toHaveBeenCalled();
    expect(harness.onEntry).not.toHaveBeenCalled();
  });

  it('executes the exact target set once the approval is valid', async () => {
    const harness = makeHarness();
    const plan = livePlanOf(1);

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(result.stopReason).toBe('complete');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('unfollowed');
    expect(result.changedAnything).toBe(true);
    expect(harness.unfollow).toHaveBeenCalledTimes(1);
    expect(harness.unfollow.mock.calls[0][0].id).toBe('live_0');
  });
});

describe('live pacing telemetry', () => {
  it('reports a cooldown and a pacing ETA instead of looking frozen', async () => {
    const onCooldown = vi.fn();
    const harness = makeHarness({ onCooldown });
    await executeUnfollowPlan(livePlanOf(2), harness.deps);
    expect(onCooldown).toHaveBeenCalledTimes(1);
    const info = onCooldown.mock.calls[0][0];
    expect(info.delayMs).toBeGreaterThan(0);
    expect(info.estimatedRemainingMs).toBeGreaterThan(0);
    const progress = harness.onProgress.mock.calls.map(call => call[0]);
    expect(progress[0].estimatedRemainingMs).toBeGreaterThan(0);
    expect(progress[1].estimatedRemainingMs).toBe(0);
  });
});

describe('live session gate', () => {
  it('stops with missing-session when there is no CSRF token', async () => {
    const harness = makeHarness({ getCsrfToken: vi.fn<() => string | null>(() => null) });

    const result = await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(result.mode).toBe('live');
    expect(result.stopReason).toBe('missing-session');
    expect(result.entries).toHaveLength(0);
    expect(result.changedAnything).toBe(false);
    expect(harness.unfollow).not.toHaveBeenCalled();
    expect(harness.sleep).not.toHaveBeenCalled();
    expect(harness.onProgress).not.toHaveBeenCalled();
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it('fails closed when reading the CSRF token throws', async () => {
    const getCsrfToken = vi.fn<() => string | null>(() => {
      throw new Error('cookie jar exploded');
    });
    const harness = makeHarness({ getCsrfToken });

    const result = await executeUnfollowPlan(livePlanOf(1), harness.deps);

    expect(result.stopReason).toBe('missing-session');
    expect(harness.unfollow).not.toHaveBeenCalled();
  });

  it('passes the session CSRF token to every transport call', async () => {
    const getCsrfToken = vi.fn<() => string | null>(() => 'csrf-abc');
    const harness = makeHarness({ getCsrfToken });

    await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(harness.unfollow).toHaveBeenCalledTimes(2);
    expect(harness.unfollow.mock.calls.map(call => call[1])).toEqual(['csrf-abc', 'csrf-abc']);
    expect(getCsrfToken).toHaveBeenCalledTimes(1);
  });
});

describe('live outcome mapping and stop behavior', () => {
  it('records confirmed unfollows and reports that something changed', async () => {
    const harness = makeHarness();

    const result = await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(result.entries.map(entry => entry.status)).toEqual(['unfollowed', 'unfollowed']);
    expect(result.entries.map(entry => entry.detail)).toEqual([
      'confirmed by fake transport',
      'confirmed by fake transport',
    ]);
    expect(result.stopReason).toBe('complete');
    expect(result.changedAnything).toBe(true);
  });

  it('continues after a failed unfollow and still reports the change', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('failed', 'unfollowed'));

    const result = await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(result.entries.map(entry => entry.status)).toEqual(['failed', 'unfollowed']);
    expect(result.stopReason).toBe('complete');
    expect(result.changedAnything).toBe(true);
    expect(harness.unfollow).toHaveBeenCalledTimes(2);
  });

  it('keeps changedAnything false when every attempt fails', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('failed', 'failed'));

    const result = await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(result.entries.map(entry => entry.status)).toEqual(['failed', 'failed']);
    expect(result.stopReason).toBe('complete');
    expect(result.changedAnything).toBe(false);
  });

  it('stops the queue when Instagram blocks the action', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('unfollowed', 'blocked', 'unfollowed'));

    const result = await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(result.entries.map(entry => entry.status)).toEqual(['unfollowed', 'blocked']);
    expect(result.stopReason).toBe('action-blocked');
    expect(result.changedAnything).toBe(true);
    expect(harness.unfollow).toHaveBeenCalledTimes(2);
  });

  it('reports changedAnything false when the first attempt is blocked', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('blocked', 'unfollowed'));

    const result = await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('blocked');
    expect(result.stopReason).toBe('action-blocked');
    expect(result.changedAnything).toBe(false);
    expect(harness.unfollow).toHaveBeenCalledTimes(1);
  });

  it('turns a thrown transport error into a failed entry and keeps going', async () => {
    const harness = makeHarness();
    harness.unfollow
      .mockImplementationOnce(async () => {
        throw new Error('socket closed');
      })
      .mockImplementation(async () => ({ outcome: 'unfollowed', detail: 'confirmed' }));

    const result = await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].status).toBe('failed');
    expect(result.entries[0].detail).toContain('socket closed');
    expect(result.entries[1].status).toBe('unfollowed');
    expect(result.changedAnything).toBe(true);
  });

  it('describes non-Error throws safely', async () => {
    // Some third-party transports reject with plain values rather than Errors.
    const nonErrorFailure: unknown = 'plain string failure';
    const harness = makeHarness();
    harness.unfollow.mockImplementation(async () => {
      throw nonErrorFailure;
    });

    const result = await executeUnfollowPlan(livePlanOf(1), harness.deps);

    expect(result.entries[0].status).toBe('failed');
    expect(result.entries[0].detail).toContain('plain string failure');
    expect(result.changedAnything).toBe(false);
  });

  it('calls the transport sequentially in plan order', async () => {
    const harness = makeHarness();
    const users = [makeUser('order_a'), makeUser('order_b'), makeUser('order_c')];

    await executeUnfollowPlan(makeLivePlan(users), harness.deps);

    expect(harness.unfollow.mock.calls.map(call => call[0].id)).toEqual(['order_a', 'order_b', 'order_c']);
  });

  it('propagates transport failure details', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('failed'));

    const result = await executeUnfollowPlan(livePlanOf(1), harness.deps);

    expect(result.entries[0].detail).toBe('transport said failed');
  });

  it('propagates blocked details', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('blocked'));

    const result = await executeUnfollowPlan(livePlanOf(1), harness.deps);

    expect(result.entries[0].detail).toBe('transport said blocked');
  });

  it('streams every attempted entry through onEntry in order', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('unfollowed', 'failed', 'blocked'));

    const result = await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(harness.onEntry).toHaveBeenCalledTimes(3);
    const streamed = harness.onEntry.mock.calls.map(call => call[0]);
    expect(streamed).toEqual(result.entries);
    expect(streamed.map(entry => entry.status)).toEqual(['unfollowed', 'failed', 'blocked']);
  });

  it('reports monotonic progress reaching 100 percent for mixed outcomes', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('failed', 'unfollowed', 'failed'));

    await executeUnfollowPlan(livePlanOf(3), harness.deps);

    const progress = harness.onProgress.mock.calls.map(call => call[0]);
    expect(progress.map(entry => entry.completed)).toEqual([1, 2, 3]);
    expect(percentages(harness)).toEqual([33, 66, 100]);
    expect(progress.every(entry => entry.mode === 'live' && entry.total === 3)).toBe(true);
  });

  it('does not report 100 percent when a block stops the run early', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('blocked'));

    await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(percentages(harness)).toEqual([33]);
  });
});

describe('abort handling', () => {
  it('aborts before the first attempt without calling the transport', async () => {
    const harness = makeHarness({ shouldAbort: vi.fn<() => boolean>(() => true) });

    const result = await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(result.stopReason).toBe('aborted');
    expect(result.entries).toHaveLength(0);
    expect(result.changedAnything).toBe(false);
    expect(harness.unfollow).not.toHaveBeenCalled();
    expect(harness.sleep).not.toHaveBeenCalled();
    expect(harness.onProgress).not.toHaveBeenCalled();
  });

  it('aborts between users after the first attempt', async () => {
    const shouldAbort = vi.fn<() => boolean>();
    shouldAbort.mockReturnValueOnce(false).mockReturnValue(true);
    const harness = makeHarness({ shouldAbort });

    const result = await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(result.stopReason).toBe('aborted');
    expect(result.entries).toHaveLength(1);
    expect(harness.unfollow).toHaveBeenCalledTimes(1);
    expect(result.changedAnything).toBe(true);
  });

  it('does not send the next request when abort is requested during the pacing sleep', async () => {
    let aborted = false;
    const shouldAbort = vi.fn<() => boolean>(() => aborted);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      aborted = true;
    });
    const harness = makeHarness({ shouldAbort, sleep });

    const result = await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(harness.sleep).toHaveBeenCalledTimes(1);
    expect(harness.unfollow).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(1);
    expect(result.stopReason).toBe('aborted');
  });

  it('keeps the already-emitted entries when aborting mid-queue', async () => {
    const shouldAbort = vi.fn<() => boolean>();
    // Loop-top check for attempt 1, loop-top check for attempt 2 and the
    // post-sleep re-check for attempt 2 all pass; the loop-top check for
    // attempt 3 then aborts.
    shouldAbort.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const harness = makeHarness({ shouldAbort });

    const result = await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(result.stopReason).toBe('aborted');
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(entry => entry.status)).toEqual(['unfollowed', 'unfollowed']);
    expect(harness.unfollow).toHaveBeenCalledTimes(2);
  });
});

describe('pacing', () => {
  it('sleeps between users but never after the last one', async () => {
    const harness = makeHarness();

    await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(sleepDurations(harness)).toEqual([1000, 1000]);
  });

  it('does not sleep at all for a single target', async () => {
    const harness = makeHarness();

    await executeUnfollowPlan(livePlanOf(1), harness.deps);

    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('jitters the gap below and above the configured base', async () => {
    const lowHarness = makeHarness({ random: vi.fn<() => number>(() => 0) });
    await executeUnfollowPlan(livePlanOf(2), lowHarness.deps);
    expect(sleepDurations(lowHarness)).toEqual([500]);

    const highHarness = makeHarness({ random: vi.fn<() => number>(() => 0.9) });
    await executeUnfollowPlan(livePlanOf(2), highHarness.deps);
    expect(sleepDurations(highHarness)).toEqual([1400]);
  });

  it('inserts the long pause after every five attempts', async () => {
    const harness = makeHarness();

    await executeUnfollowPlan(livePlanOf(6), harness.deps);

    expect(sleepDurations(harness)).toEqual([1000, 1000, 1000, 1000, 5000]);
  });

  it('repeats the long pause every five attempts across a longer run', async () => {
    const harness = makeHarness();

    await executeUnfollowPlan(livePlanOf(11), harness.deps);

    expect(sleepDurations(harness)).toEqual([1000, 1000, 1000, 1000, 5000, 1000, 1000, 1000, 1000, 5000]);
  });

  it('does not add a trailing long pause when the run ends on a multiple of five', async () => {
    const harness = makeHarness();

    await executeUnfollowPlan(livePlanOf(5), harness.deps);

    expect(sleepDurations(harness)).toEqual([1000, 1000, 1000, 1000]);
  });

  it('counts failed attempts towards the long-pause cadence', async () => {
    const harness = makeHarness();
    harness.unfollow.mockImplementation(responseScript('failed', 'failed', 'failed', 'failed', 'failed', 'unfollowed'));

    await executeUnfollowPlan(livePlanOf(6), harness.deps);

    expect(sleepDurations(harness)).toEqual([1000, 1000, 1000, 1000, 5000]);
  });

  it('clamps non-positive timings to zero but still awaits the injected sleep', async () => {
    const harness = makeHarness({
      timings: { timeBetweenUnfollows: 0, timeToWaitAfterFiveUnfollows: -5000 },
    });

    await executeUnfollowPlan(livePlanOf(3), harness.deps);

    expect(sleepDurations(harness)).toEqual([0, 0]);
  });

  it('defends against non-finite timing values', async () => {
    const harness = makeHarness({
      timings: { timeBetweenUnfollows: Number.NaN, timeToWaitAfterFiveUnfollows: Number.POSITIVE_INFINITY },
    });

    await executeUnfollowPlan(livePlanOf(6), harness.deps);

    expect(harness.sleep).toHaveBeenCalledTimes(5);
    expect(sleepDurations(harness).every(duration => duration === 0)).toBe(true);
  });

  it('falls back to neutral jitter when the random source throws', async () => {
    const random = vi.fn<() => number>(() => {
      throw new Error('no randomness available');
    });
    const harness = makeHarness({ random });

    await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(sleepDurations(harness)).toEqual([1000]);
  });
});

describe('safety invariants', () => {
  it('makes no real network request during a live run', async () => {
    const harness = makeHarness();

    await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(harness.unfollow).toHaveBeenCalledTimes(2);
    expect(networkGuard).not.toHaveBeenCalled();
    // The global guard is still armed for anything that would try to escape.
    await expect(fetch('https://www.instagram.com/api/graphql')).rejects.toThrow(
      /Automated tests must not perform real network requests/,
    );
  });

  it('never reads Date.now directly', async () => {
    const clock = vi.spyOn(Date, 'now');
    const callsBefore = clock.mock.calls.length;
    const harness = makeHarness();

    await executeUnfollowPlan(livePlanOf(2), harness.deps);

    expect(clock.mock.calls.length).toBe(callsBefore);
  });

  it('does not mutate a frozen live plan', async () => {
    const harness = makeHarness();
    const plan = Object.freeze(makeLivePlan([makeUser('frozen_1'), makeUser('frozen_2')]));

    const result = await executeUnfollowPlan(plan, harness.deps);

    expect(result.entries).toHaveLength(2);
    expect(plan.targets).toHaveLength(2);
  });

  it('returns fresh entry arrays on every execution', async () => {
    const harness = makeHarness();
    const plan = livePlanOf(1);

    const first = await executeUnfollowPlan(plan, harness.deps);
    const second = await executeUnfollowPlan(plan, harness.deps);

    expect(first.entries).not.toBe(second.entries);
    expect(first.entries).toHaveLength(second.entries.length);
  });
});
