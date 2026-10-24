/**
 * Action-plan domain model.
 *
 * The single most important safety property of this app lives here: a dry run
 * and a live unfollow are different *types*, not a boolean flag. Code that
 * executes a {@link UnfollowPlan} has to narrow on `plan.mode`, and the live
 * variant carries an explicit {@link LiveApproval} that the executor must
 * validate before it is allowed to call Instagram.
 */
import { FollowRelationship } from './audit';
import { UserNode } from './user';

export type ActionMode = 'dry-run' | 'live';

/** Which destructive action applies to a planned target. */
export type PlannedAction = 'unfollow' | 'remove-follower';

/** A likely-target-gender account that will be (or would be) removed. */
export interface PlannedTarget {
  readonly user: UserNode;
  readonly relationship: FollowRelationship;
  /** Unfollow accounts you follow; remove followers-only accounts as followers. */
  /** Defaults from relationship when omitted (legacy callers). */
  readonly action?: PlannedAction;
}

export type SkipReason =
  | 'not-followed-by-you'
  | 'whitelisted'
  /** The classifier did not confidently estimate the selected target gender. */
  | 'not-target-gender'
  | 'duplicate'
  | 'missing-user';

export interface SkippedTarget {
  readonly user: UserNode;
  readonly reason: SkipReason;
}

/**
 * Explicit, human-entered approval required for a live plan. `typedConfirmation`
 * must equal `liveConfirmationPhrase(expectedCount)` exactly.
 */
export interface LiveApproval {
  readonly typedConfirmation: string;
  readonly expectedCount: number;
  readonly approvedAt: number;
}

export interface DryRunPlan {
  readonly mode: 'dry-run';
  readonly targets: readonly PlannedTarget[];
  readonly skipped: readonly SkippedTarget[];
  readonly createdAt: number;
}

export interface LivePlan {
  readonly mode: 'live';
  readonly targets: readonly PlannedTarget[];
  readonly skipped: readonly SkippedTarget[];
  readonly createdAt: number;
  readonly approval: LiveApproval;
}

export type UnfollowPlan = DryRunPlan | LivePlan;

export type ExecutionEntryStatus = 'unfollowed' | 'removed-follower' | 'failed' | 'blocked' | 'simulated';

export interface ExecutionEntry {
  readonly user: UserNode;
  readonly status: ExecutionEntryStatus;
  /** Diagnostic detail (API message, dry-run explanation, ...). */
  readonly detail?: string;
}

export type ExecutionStopReason =
  | 'complete'
  | 'aborted'
  | 'action-blocked'
  | 'invalid-approval'
  | 'missing-session'
  /** A later target became whitelisted before its turn came. */
  | 'protected-target';

export interface ExecutionProgress {
  readonly mode: ActionMode;
  readonly completed: number;
  readonly total: number;
  /** 0..100 */
  readonly percentage: number;
  /** Estimated remaining pacing time for a live run (excludes request latency). */
  readonly estimatedRemainingMs?: number;
}

export interface ExecutionResult {
  readonly mode: ActionMode;
  readonly entries: readonly ExecutionEntry[];
  readonly stopReason: ExecutionStopReason;
  /**
   * True if and only if at least one LIVE unfollow was confirmed by Instagram.
   * Always false for dry runs.
   */
  readonly changedAnything: boolean;
}

/** Result of building a plan from a user's selection. */
export type BuildPlanResult =
  | { readonly ok: true; readonly plan: UnfollowPlan }
  | { readonly ok: false; readonly errors: readonly string[] };
