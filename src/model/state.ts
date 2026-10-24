import { ActionMode, ExecutionEntry, ExecutionStopReason, UnfollowPlan } from './action-plan';
import { AuditCandidate, AuditPhase, AuditTab, AuditFilter, AuditSummary } from './audit';
import { UserNode } from './user';

/**
 * Global UI state machine.
 *
 * initial -> scanning -> reviewing -> executing -> initial
 *
 * There is deliberately no state in which an unfollow can happen without the
 * user having gone through `reviewing` and an explicit approval; dry runs and
 * live runs share the `executing` screen but are distinguished by
 * `plan.mode` (a discriminated union, see model/action-plan.ts).
 */
export interface ScanningState {
  readonly status: 'scanning';
  readonly phase: AuditPhase;
  readonly percentage: number;
  readonly followingFetched: number;
  readonly followersFetched: number;
  readonly classified: number;
  readonly toClassify: number;
  readonly candidates: readonly AuditCandidate[];
  readonly notice?: string;
}

export interface ReviewState {
  readonly status: 'reviewing';
  readonly candidates: readonly AuditCandidate[];
  readonly whitelistedResults: readonly UserNode[];
  readonly selectedIds: readonly string[];
  readonly currentTab: AuditTab;
  readonly searchTerm: string;
  readonly filter: AuditFilter;
  /** Whether the whole audit (both lists + classification) completed. */
  readonly scanComplete: boolean;
  readonly followingComplete: boolean;
  readonly followersComplete: boolean;
  readonly classificationFailures: number;
  /** First classifier transport error; drives an actionable review banner. */
  readonly classifierError?: string;
  readonly classifierVersion: string;
  readonly totalFetched: number;
  readonly scanTimestamp: number;
  /** True when the review screen is showing the built-in demo dataset. */
  readonly demo: boolean;
  /**
   * Instagram id of the viewer whose lists produced this review. Live actions
   * are refused if the session's current viewer no longer matches.
   */
  readonly viewerId: string | null;
  /**
   * True when this review was restored from the local cache rather than
   * produced by a scan in this session. Live unfollowing is locked for cached
   * reviews; a fresh scan is required before acting.
   */
  readonly fromCache: boolean;
}

export interface ExecutingState {
  readonly status: 'executing';
  readonly plan: UnfollowPlan;
  readonly percentage: number;
  readonly entries: readonly ExecutionEntry[];
  readonly searchTerm: string;
  readonly showSucceeded: boolean;
  readonly showFailed: boolean;
  readonly stopReason?: ExecutionStopReason;
  /** Estimated pacing time left in a live run. */
  readonly estimatedRemainingMs?: number;
  /** Set while the executor is in a deliberate cooldown pause. */
  readonly cooldownEndsAt?: number;
  readonly cooldownTotalMs?: number;
}

export type AppState =
  | { readonly status: 'initial' }
  | ScanningState
  | ReviewState
  | ExecutingState;

export function isExecutingLive(state: AppState): boolean {
  return state.status === 'executing' && state.plan.mode === 'live';
}

/** Only dry-run and live modes can ever reach the execution screen. */
export type ExecutingMode = ActionMode;

export function createEmptySummary(): AuditSummary {
  return {
    targetFollowing: 0,
    targetFollowers: 0,
    targetMutual: 0,
    uncertain: 0,
    totalCandidates: 0,
    eligibleForUnfollow: 0,
  };
}
