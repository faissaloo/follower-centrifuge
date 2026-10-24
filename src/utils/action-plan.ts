/**
 * Builds an {@link UnfollowPlan} from a review-screen selection.
 *
 * This module is deliberately pure: it reads its inputs, never performs I/O and
 * never touches Instagram. It is the only supported way to obtain a
 * {@link LivePlan}: the live variant is returned solely when the human typed a
 * `typedConfirmation` that exactly matches {@link liveConfirmationPhrase} for
 * the number of eligible targets, so a live plan can never be produced from a
 * missing, stale or near-miss approval.
 *
 * Building a plan is not executing it: see `unfollow-executor.ts` for the
 * second half of the safety gate (the executor re-validates the approval before
 * it is allowed to call the network at all).
 */
import { AuditCandidate, GenderCategory, relationshipIncludesFollower, relationshipIncludesFollowing } from '../model/audit';
import {
  ActionMode,
  BuildPlanResult,
  DryRunPlan,
  LiveApproval,
  LivePlan,
  PlannedTarget,
  SkipReason,
  SkippedTarget,
} from '../model/action-plan';
import { isCategoryGuess } from '../model/gender';
import { UserNode } from '../model/user';
import { liveConfirmationPhrase } from './approval';
import { normalizeProtectedUsername } from './whitelist-match';

/** Everything the plan builder needs from the review screen. */
export interface BuildUnfollowPlanInput {
  /** Accounts the human ticked for unfollowing, in the order to process them. */
  readonly selected: readonly UserNode[];
  /** All candidates produced by the audit; source of truth for relationships and gender. */
  readonly candidates: readonly AuditCandidate[];
  /** Ids of whitelisted accounts that may never be unfollowed. */
  readonly whitelistedIds: ReadonlySet<string>;
  /**
   * Normalized usernames of whitelisted accounts as well. Bulk-pasted
   * whitelist entries have synthetic ids, so an id-only check would fail to
   * protect the real account; the plan builder therefore checks both.
   */
  readonly whitelistedUsernames?: ReadonlySet<string>;
  /** `dry-run` builds a safe preview; `live` additionally requires an exact approval phrase. */
  readonly mode: ActionMode;
  /** Exact phrase typed by the human; only checked (and required) in live mode. */
  readonly typedConfirmation?: string;
  /** Confidence below this is not a likely target (defaults to `DEFAULT_CONFIDENCE_THRESHOLD`). */
  readonly minimumConfidence?: number;
  /** Classifier category this plan is allowed to remove (defaults to `'female'`). */
  readonly targetCategory?: GenderCategory;
  /** Also allow removing followers-only accounts (defaults to false for legacy callers). */
  readonly includeFollowers?: boolean;
  /** Allow explicitly selected ambiguous accounts to be manually removed. */
  readonly allowAmbiguousSelections?: boolean;
  /** Injectable clock for reproducible plans. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Input of {@link countEligibleTargets}: the same selection data as
 * {@link BuildUnfollowPlanInput} minus the mode/approval/clock fields.
 */
export interface CountEligibleTargetsInput {
  readonly selected: readonly UserNode[];
  readonly candidates: readonly AuditCandidate[];
  readonly whitelistedIds: ReadonlySet<string>;
  readonly whitelistedUsernames?: ReadonlySet<string>;
  readonly minimumConfidence?: number;
  /** Classifier category this count is allowed to remove (defaults to `'female'`). */
  readonly targetCategory?: GenderCategory;
  /** Also count followers-only accounts (defaults to false for legacy callers). */
  readonly includeFollowers?: boolean;
  /** Count explicitly selected ambiguous accounts as manual targets. */
  readonly allowAmbiguousSelections?: boolean;
}

/** Split of a selection into what can be unfollowed and why the rest cannot. */
interface SelectionAnalysis {
  readonly targets: readonly PlannedTarget[];
  readonly skipped: readonly SkippedTarget[];
}

/** Result of classifying one selected account. */
type Eligibility =
  | { readonly eligible: true; readonly target: PlannedTarget }
  | { readonly eligible: false; readonly reason: SkipReason };

const defaultNow = (): number => Date.now();

/**
 * Index the audit candidates by account id. The first candidate wins so a
 * corrupted duplicate cannot change which relationship/gender verdict a plan is
 * built from (input order is the only deterministic tie-breaker we have).
 */
function indexCandidatesById(candidates: readonly AuditCandidate[]): ReadonlyMap<string, AuditCandidate> {
  const candidatesById = new Map<string, AuditCandidate>();
  for (const candidate of candidates) {
    const id = candidate.user.id;
    if (!candidatesById.has(id)) {
      candidatesById.set(id, candidate);
    }
  }
  return candidatesById;
}

/**
 * Decide whether one selected account may be part of an unfollow plan.
 *
 * The checks are ordered from "we do not even know this account" to "this
 * account is definitely touchable":
 *  1. unknown ids are skipped (`missing-user`) - we never unfollow an account
 *     that is not in the audit result;
 *  2. whitelisting protects unconditionally (`whitelisted`) - it wins over
 *     every other consideration on purpose;
 *  3. accounts in either direction can be removed: following/mutual accounts
 *     are unfollowed, followers-only accounts are removed as followers
 *     (`not-followed-by-you` when neither applies);
 *  4. only confident guesses for the plan's target gender qualify
 *     (`not-target-gender`).
 *
 * The audit candidate - not the possibly stale selected node - is the source of
 * truth for relationship flags; the selection only decides membership and order.
 */
/** Normalize any caller-provided whitelist username set (tolerates @/case). */
function normalizeUsernameSet(usernames: ReadonlySet<string> | undefined): ReadonlySet<string> {
  const normalized = new Set<string>();
  if (usernames === undefined) {
    return normalized;
  }
  for (const candidate of Array.from(usernames)) {
    const username = normalizeProtectedUsername(candidate);
    if (username !== '') {
      normalized.add(username);
    }
  }
  return normalized;
}

function isWhitelistedForPlan(
  user: UserNode,
  whitelistedIds: ReadonlySet<string>,
  whitelistedUsernames: ReadonlySet<string> | undefined,
): boolean {
  if (whitelistedIds.has(user.id)) {
    return true;
  }
  if (whitelistedUsernames === undefined) {
    return false;
  }
  const username = normalizeProtectedUsername(user.username);
  return username !== '' && whitelistedUsernames.has(username);
}

function evaluateEligibility(
  user: UserNode,
  candidate: AuditCandidate | undefined,
  whitelistedIds: ReadonlySet<string>,
  whitelistedUsernames: ReadonlySet<string> | undefined,
  minimumConfidence: number | undefined,
  targetCategory: GenderCategory,
  includeFollowers: boolean,
  allowAmbiguous: boolean,
): Eligibility {
  if (candidate === undefined) {
    return { eligible: false, reason: 'missing-user' };
  }
  if (isWhitelistedForPlan(user, whitelistedIds, whitelistedUsernames)) {
    return { eligible: false, reason: 'whitelisted' };
  }
  const followsThem = candidate.user.followed_by_viewer && relationshipIncludesFollowing(candidate.relationship);
  const followsYou = includeFollowers && relationshipIncludesFollower(candidate.relationship);
  if (!followsThem && !followsYou) {
    return { eligible: false, reason: 'not-followed-by-you' };
  }
  const manualAmbiguous =
    allowAmbiguous && candidate.gender !== null && candidate.gender.gender === 'ambiguous';
  if (!manualAmbiguous && !isCategoryGuess(candidate.gender, targetCategory, minimumConfidence)) {
    return { eligible: false, reason: 'not-target-gender' };
  }
  return {
    eligible: true,
    target: {
      user: candidate.user,
      relationship: candidate.relationship,
      action: followsThem ? 'unfollow' : 'remove-follower',
    },
  };
}

/**
 * Round-robin unfollow and remove-follower targets. Without this, a selection
 * built tab-by-tab (all following first, followers second) would delay every
 * follower removal until the whole unfollow queue has been paced through.
 * Relative order within each action is preserved.
 */
function interleavePlanActions(targets: readonly PlannedTarget[]): PlannedTarget[] {
  const unfollows: PlannedTarget[] = [];
  const removals: PlannedTarget[] = [];
  for (const target of targets) {
    if (target.action === 'remove-follower') {
      removals.push(target);
    } else {
      unfollows.push(target);
    }
  }
  if (unfollows.length === 0 || removals.length === 0) {
    return [...targets];
  }
  const interleaved: PlannedTarget[] = [];
  let unfollowIndex = 0;
  let removalIndex = 0;
  const startWithUnfollow = targets[0].action !== 'remove-follower';
  let takeUnfollow = startWithUnfollow;
  while (unfollowIndex < unfollows.length || removalIndex < removals.length) {
    if (takeUnfollow) {
      if (unfollowIndex < unfollows.length) {
        interleaved.push(unfollows[unfollowIndex]);
        unfollowIndex += 1;
      }
    } else if (removalIndex < removals.length) {
      interleaved.push(removals[removalIndex]);
      removalIndex += 1;
    }
    takeUnfollow = !takeUnfollow;
    // If the preferred side is exhausted, keep taking from the other side.
    if (takeUnfollow && unfollowIndex >= unfollows.length) {
      takeUnfollow = false;
    }
    if (!takeUnfollow && removalIndex >= removals.length) {
      takeUnfollow = true;
    }
  }
  return interleaved;
}

/**
 * Classify a whole selection: de-duplicate repeated ids (first occurrence wins,
 * later ones are reported as `duplicate`) and keep the human's order for the
 * eligible targets as well as for the skip list.
 */
function analyzeSelection(input: CountEligibleTargetsInput): SelectionAnalysis {
  const candidatesById = indexCandidatesById(input.candidates);
  const whitelistedUsernames = normalizeUsernameSet(input.whitelistedUsernames);
  const targetCategory: GenderCategory = input.targetCategory !== undefined ? input.targetCategory : 'female';
  const seenIds = new Set<string>();
  const targets: PlannedTarget[] = [];
  const skipped: SkippedTarget[] = [];

  for (const user of input.selected) {
    if (seenIds.has(user.id)) {
      skipped.push({ user, reason: 'duplicate' });
      continue;
    }
    seenIds.add(user.id);

    const eligibility = evaluateEligibility(
      user,
      candidatesById.get(user.id),
      input.whitelistedIds,
      whitelistedUsernames,
      input.minimumConfidence,
      targetCategory,
      input.includeFollowers === true,
      input.allowAmbiguousSelections === true,
    );
    if (eligibility.eligible) {
      targets.push(eligibility.target);
    } else {
      skipped.push({ user, reason: eligibility.reason });
    }
  }

  return { targets: interleavePlanActions(targets), skipped };
}


function createDryRunPlan(analysis: SelectionAnalysis, createdAt: number): DryRunPlan {
  return {
    mode: 'dry-run',
    targets: analysis.targets,
    skipped: analysis.skipped,
    createdAt,
  };
}

/**
 * Build a live plan or a list of human-readable errors. A live plan is only
 * produced when there is at least one eligible target *and* the typed phrase is
 * byte-for-byte the expected confirmation for exactly that target count.
 */
function createLivePlanResult(
  analysis: SelectionAnalysis,
  typedConfirmation: string | undefined,
  createdAt: number,
): BuildPlanResult {
  const targetCount = analysis.targets.length;

  if (targetCount === 0) {
    return {
      ok: false,
      errors: ['No eligible accounts are selected, so there is nothing to unfollow.'],
    };
  }

  const expectedPhrase = liveConfirmationPhrase(targetCount);
  if (typedConfirmation === undefined || typedConfirmation !== expectedPhrase) {
    const accountWord = targetCount === 1 ? 'account' : 'accounts';
    return {
      ok: false,
      errors: [
        `Live unfollowing is locked. Type "${expectedPhrase}" exactly to confirm unfollowing ${targetCount} ${accountWord}.`,
      ],
    };
  }

  const approval: LiveApproval = {
    typedConfirmation,
    expectedCount: targetCount,
    approvedAt: createdAt,
  };
  const plan: LivePlan = {
    mode: 'live',
    targets: analysis.targets,
    skipped: analysis.skipped,
    createdAt,
    approval,
  };
  return { ok: true, plan };
}

/**
 * Turn a review selection into an executable plan.
 *
 * - A dry-run plan is always `ok`, even when empty: the skipped list explains
 *   what was excluded and nothing downstream can mutate Instagram.
 * - A live plan is only `ok` with a valid exact-count approval; otherwise the
 *   result carries errors and *no* plan at all, so there is nothing an executor
 *   could run even by mistake.
 */
export function buildUnfollowPlan(input: BuildUnfollowPlanInput): BuildPlanResult {
  const analysis = analyzeSelection(input);
  const now = input.now ?? defaultNow;
  const createdAt = now();

  switch (input.mode) {
    case 'dry-run':
      return { ok: true, plan: createDryRunPlan(analysis, createdAt) };
    case 'live':
      return createLivePlanResult(analysis, input.typedConfirmation, createdAt);
    default:
      // Unreachable for well-typed callers; fail closed instead of guessing a mode.
      return { ok: false, errors: [`Unsupported action mode: ${String(input.mode)}.`] };
  }
}

/**
 * Number of accounts in a selection that would actually be unfollowed.
 *
 * The approval UI needs this count *before* a plan exists (the phrase embeds
 * it), and it must use exactly the same eligibility rules as the plan builder -
 * hence this shared, pure helper.
 */
export function countEligibleTargets(input: CountEligibleTargetsInput): number {
  return analyzeSelection(input).targets.length;
}
