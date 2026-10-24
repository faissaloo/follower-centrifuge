/**
 * Executes an {@link UnfollowPlan}.
 *
 * SAFETY CONTRACT - this module is the only place in the app that can really
 * unfollow somebody, so it is built as two structurally separated code paths:
 *
 * 1. `runDryRun` is handed a {@link DryRunPlan} and a dependency bundle that
 *    *does not contain* the unfollow transport, the CSRF token reader, timers or
 *    the abort hook. It is therefore incapable of making a request, sleeping or
 *    otherwise touching the real account - not merely configured not to. Every
 *    target becomes a `simulated` entry and `changedAnything` is always false.
 *
 * 2. `runLive` is only reached for a plan whose `mode` is exactly `'live'`, and
 *    it re-validates the embedded human approval (exact typed phrase for the
 *    exact target count) before it reads the session token or calls the
 *    injected transport. Invalid approval returns `invalid-approval` with zero
 *    entries; a missing session returns `missing-session`. Neither path calls
 *    the network.
 *
 * Every network call goes through the injected `unfollow` transport; this
 * module never imports or calls `fetch` itself and never reads the clock, so it
 * is fully deterministic and offline-testable.
 */
import type {
  ActionMode,
  DryRunPlan,
  ExecutionEntry,
  ExecutionProgress,
  ExecutionResult,
  ExecutionStopReason,
  LiveApproval,
  LivePlan,
  PlannedTarget,
  UnfollowPlan,
} from '../model/action-plan';
import type { Timings } from '../model/timings';
import type { UserNode } from '../model/user';
import { isLiveApprovalValid } from './approval';
import type { UnfollowResult } from './utils';

/** Detail attached to every simulated dry-run entry. Never a real request. */
export const DRY_RUN_ENTRY_DETAIL = 'dry run: no request was sent';

/** A longer rate-limit-precaution pause is inserted before every Nth attempt. */
const LONG_PAUSE_EVERY_ATTEMPTS = 5;

/** Used when the injected random source is absent or misbehaves (neutral jitter). */
const NEUTRAL_RANDOM = 0.5;

/** The two delays the executor observes while live-unfollowing. */
export type UnfollowExecutorTimings = Pick<Timings, 'timeBetweenUnfollows' | 'timeToWaitAfterFiveUnfollows'>;

/** Dependencies of {@link executeUnfollowPlan}; everything is injectable for tests. */
export interface UnfollowExecutorDeps {
  /**
   * Injected transport and the ONLY capability that can mutate Instagram. It
   * must already implement its own retry/confirmation logic; the executor only
   * maps its result to an entry.
   */
  readonly unfollow: (user: UserNode, csrftoken: string) => Promise<UnfollowResult>;
  /** Removes a follower-only account from the viewer's followers list. */
  readonly removeFollower?: (user: UserNode, csrftoken: string) => Promise<UnfollowResult>;
  /** Reads the session CSRF token; `null` means the session state is unknown. */
  readonly getCsrfToken: () => string | null;
  /** Injected timer so tests never wait for real time. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Pacing configuration (`timeBetweenUnfollows`, `timeToWaitAfterFiveUnfollows`). */
  readonly timings: UnfollowExecutorTimings;
  /** Called after every attempted/completed entry with monotonic progress. */
  readonly onProgress: (progress: ExecutionProgress) => void;
  /** Optional per-entry streaming callback (same entries as the final result). */
  readonly onEntry?: (entry: ExecutionEntry) => void;
  /** Polled between users (and after pacing sleeps) so a stop never sends a new request. */
  readonly shouldAbort: () => boolean;
  /**
   * Optional whitelist check polled immediately before every live attempt (and
   * after pacing sleeps). This lets a user protect an account *while the queue
   * is running*: the queue stops before touching it. Implementations should
   * read storage live, not a stale snapshot. Errors fail closed (treated as
   * protected).
   */
  readonly isProtected?: (user: UserNode) => boolean;
  /**
   * Called immediately before a live pacing sleep so the UI can show a
   * countdown instead of looking frozen.
   */
  readonly onCooldown?: (info: {
    readonly delayMs: number;
    readonly estimatedRemainingMs: number;
  }) => void;
  /** Unit-interval random source for pause jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /**
   * Injectable clock, kept for parity with the rest of the app's time
   * handling. The current {@link ExecutionResult} contract carries no
   * timestamps, so the executor never reads it (and never calls `Date.now`).
   */
  readonly now?: () => number;
}

/**
 * The only capabilities a simulated run may see. Deliberately does not contain
 * the unfollow transport, CSRF/session access, timers or abort hook.
 */
interface SimulationDeps {
  readonly onProgress: (progress: ExecutionProgress) => void;
  readonly onEntry?: (entry: ExecutionEntry) => void;
}

function makeProgress(mode: ActionMode, completed: number, total: number): ExecutionProgress {
  const percentage = total <= 0 ? 100 : Math.min(100, Math.floor((completed * 100) / total));
  return { mode, completed, total, percentage };
}

/** Coerce an untrusted timing value into a non-negative whole number of ms. */
function normalizeDelay(value: number): number {
  if (!isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Clamp an untrusted random source into [0, 1]. */
function clampUnitInterval(value: number): number {
  if (!isFinite(value)) {
    return NEUTRAL_RANDOM;
  }
  if (value < 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function readRandomUnit(random: () => number): number {
  try {
    return clampUnitInterval(random());
  } catch {
    // A broken random source must not abort a run halfway through; use neutral jitter.
    return NEUTRAL_RANDOM;
  }
}

/**
 * Delay before attempt `attemptIndex + 1`, given that `attemptIndex` attempts
 * have already run:
 * - every 5th completed attempt triggers the long rate-limit pause instead,
 * - otherwise the configured gap is jittered to 0.5x..1.5x so requests do not
 *   land on a perfectly regular cadence.
 *
 * There is no delay after the last attempt because this is only consulted for
 * attempts with `attemptIndex > 0`.
 */
function pauseBeforeAttempt(attemptIndex: number, deps: UnfollowExecutorDeps): number {
  if (attemptIndex % LONG_PAUSE_EVERY_ATTEMPTS === 0) {
    return normalizeDelay(deps.timings.timeToWaitAfterFiveUnfollows);
  }
  const base = normalizeDelay(deps.timings.timeBetweenUnfollows);
  const random = deps.random ?? Math.random;
  return Math.floor(base * (0.5 + readRandomUnit(random)));
}

/**
 * Simulate a dry run.
 *
 * This function receives no transport and no timers: it can only produce
 * `simulated` entries. The result mode is hard-coded to `'dry-run'` (it never
 * copies `plan.mode`) so even a corrupted plan routed here can never report a
 * live execution or a change to the account.
 */
function runDryRun(plan: DryRunPlan, deps: SimulationDeps): ExecutionResult {
  const total = plan.targets.length;
  const entries: ExecutionEntry[] = [];

  for (const target of plan.targets) {
    const entry: ExecutionEntry = {
      user: target.user,
      status: 'simulated',
      detail: DRY_RUN_ENTRY_DETAIL,
    };
    entries.push(entry);
    if (deps.onEntry !== undefined) {
      deps.onEntry(entry);
    }
    // No pacing in a simulation: nothing is sent that could be rate-limited.
    deps.onProgress(makeProgress('dry-run', entries.length, total));
  }

  return {
    mode: 'dry-run',
    entries,
    stopReason: 'complete',
    changedAnything: false,
  };
}

function invalidApprovalResult(): ExecutionResult {
  return { mode: 'live', entries: [], stopReason: 'invalid-approval', changedAnything: false };
}

function missingSessionResult(): ExecutionResult {
  return { mode: 'live', entries: [], stopReason: 'missing-session', changedAnything: false };
}

/**
 * Read the approval embedded in a live plan.
 *
 * `LivePlan` requires it at the type level, but a plan is plain runtime data
 * that can be forged by hand; reading through an optional view makes a missing
 * approval fail closed (`invalid-approval`) instead of throwing.
 */
function readApproval(plan: LivePlan): LiveApproval | undefined {
  return (plan as { readonly approval?: LiveApproval }).approval;
}

/** True when the optional protection check says "whitelisted" (errors fail closed). */
function isProtectedTarget(user: UserNode, deps: UnfollowExecutorDeps): boolean {
  if (deps.isProtected === undefined) {
    return false;
  }
  try {
    return deps.isProtected(user);
  } catch {
    return true;
  }
}

/** Read the CSRF token, treating a throwing reader as "unknown session". */
function readCsrfToken(deps: UnfollowExecutorDeps): string | null {
  try {
    return deps.getCsrfToken();
  } catch {
    return null;
  }
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return `unfollow request threw ${error.name}: ${error.message}`;
  }
  return `unfollow request threw a non-Error value: ${String(error)}`;
}

/**
 * Perform exactly one unfollow attempt and map its outcome to an entry.
 * A thrown transport error becomes a `failed` entry (it does not abort the
 * queue), while a `blocked` outcome is returned so the caller can stop.
 */
async function attemptUnfollow(
  target: PlannedTarget,
  csrftoken: string,
  deps: UnfollowExecutorDeps,
): Promise<ExecutionEntry> {
  try {
    const action =
      target.action ??
      (target.relationship === 'follower' ? 'remove-follower' : 'unfollow');
    const result =
      action === 'remove-follower'
        ? deps.removeFollower === undefined
          ? { outcome: 'failed' as const, detail: 'Remove-follower transport is not configured.' }
          : await deps.removeFollower(target.user, csrftoken)
        : await deps.unfollow(target.user, csrftoken);
    switch (result.outcome) {
      case 'unfollowed':
        return { user: target.user, status: 'unfollowed', detail: result.detail };
      case 'removed-follower':
        return { user: target.user, status: 'removed-follower', detail: result.detail };
      case 'failed':
        return { user: target.user, status: 'failed', detail: result.detail };
      case 'blocked':
        return { user: target.user, status: 'blocked', detail: result.detail };
      default: {
        // Compile-time exhaustiveness; a forged transport result fails closed.
        const unexpected: never = result.outcome;
        return { user: target.user, status: 'failed', detail: `unknown unfollow outcome: ${String(unexpected)}` };
      }
    }
  } catch (error) {
    return { user: target.user, status: 'failed', detail: describeThrown(error) };
  }
}

/**
 * Expected pacing time left after `completed` attempts. Uses the configured
 * values directly (jitter averages out); long pauses are counted for every
 * fifth upcoming attempt. This intentionally excludes network request latency.
 */
export function estimateExecutionRemainingMs(
  completed: number,
  total: number,
  timings: UnfollowExecutorTimings,
): number {
  const boundedCompleted = Math.max(0, Math.min(total, Math.floor(completed)));
  let remaining = 0;
  // The first planned target is attempted immediately; every later target is
  // preceded by a pacing sleep. When some attempts are already done, the next
  // target's sleep is still ahead, so start at `completed` rather than `+1`.
  const nextDelayIndex = boundedCompleted === 0 ? 1 : boundedCompleted;
  for (let attemptIndex = nextDelayIndex; attemptIndex < total; attemptIndex += 1) {
    remaining +=
      attemptIndex % LONG_PAUSE_EVERY_ATTEMPTS === 0
        ? normalizeDelay(timings.timeToWaitAfterFiveUnfollows)
        : normalizeDelay(timings.timeBetweenUnfollows);
  }
  return remaining;
}

/**
 * Execute a live plan. The approval gate runs before anything else: no token
 * read and no transport call happen for an invalid approval. A valid approval
 * still requires a known CSRF token before the first request.
 */
async function runLive(plan: LivePlan, deps: UnfollowExecutorDeps): Promise<ExecutionResult> {
  const total = plan.targets.length;

  // 1. Human approval gate - first and unconditional.
  const approval = readApproval(plan);
  if (approval === undefined || !isLiveApprovalValid(approval, total)) {
    return invalidApprovalResult();
  }

  // 2. Session gate - no point (and no request) without a CSRF token.
  const csrftoken = readCsrfToken(deps);
  if (csrftoken === null) {
    return missingSessionResult();
  }

  const entries: ExecutionEntry[] = [];
  let changedAnything = false;
  let stopReason: ExecutionStopReason = 'complete';

  for (let index = 0; index < plan.targets.length; index += 1) {
    const target = plan.targets[index];

    // Abort is honoured between users, never mid-request.
    if (deps.shouldAbort()) {
      stopReason = 'aborted';
      break;
    }

    // The account may have been protected since the plan was approved.
    if (isProtectedTarget(target.user, deps)) {
      stopReason = 'protected-target';
      break;
    }

    if (index > 0) {
      const delayMs = pauseBeforeAttempt(index, deps);
      if (deps.onCooldown !== undefined) {
        deps.onCooldown({
          delayMs,
          estimatedRemainingMs: estimateExecutionRemainingMs(entries.length, total, deps.timings),
        });
      }
      await deps.sleep(delayMs);
      // The human may have pressed "stop", or protected a queued account, while
      // we were waiting: never send a request they no longer want.
      if (deps.shouldAbort()) {
        stopReason = 'aborted';
        break;
      }
      if (isProtectedTarget(target.user, deps)) {
        stopReason = 'protected-target';
        break;
      }
    }

    const entry = await attemptUnfollow(target, csrftoken, deps);
    entries.push(entry);
    if (deps.onEntry !== undefined) {
      deps.onEntry(entry);
    }
    if (entry.status === 'unfollowed' || entry.status === 'removed-follower') {
      // `changedAnything` means Instagram confirmed at least one real change;
      // failed/blocked/simulated entries never set it.
      changedAnything = true;
    }
    deps.onProgress({
      ...makeProgress('live', entries.length, total),
      estimatedRemainingMs: estimateExecutionRemainingMs(entries.length, total, deps.timings),
    });

    if (entry.status === 'blocked') {
      // An action-block applies to the whole session: stop instead of hammering
      // Instagram and turning a temporary limit into a longer one.
      stopReason = 'action-blocked';
      break;
    }
  }

  return { mode: 'live', entries, stopReason, changedAnything };
}

/**
 * Execute a plan.
 *
 * Dispatch is intentionally fail-closed: only a plan whose mode is *exactly*
 * `'live'` may reach the live path (where the approval is re-validated);
 * anything else is simulated by `runDryRun`. A forged/corrupted mode can
 * therefore never cause a network request.
 */
export async function executeUnfollowPlan(
  plan: UnfollowPlan,
  deps: UnfollowExecutorDeps,
): Promise<ExecutionResult> {
  if (plan.mode === 'live') {
    return runLive(plan, deps);
  }
  // The simulation path only ever sees these callbacks - no transport, no
  // session token, no timers, no abort hook.
  return runDryRun(plan, { onProgress: deps.onProgress, onEntry: deps.onEntry });
}
