import { LiveApproval } from '../model/action-plan';

/**
 * Human approval phrase for live destructive actions.
 *
 * The phrase includes the exact number of accounts so a mismatch between what
 * the user saw and what is about to be unfollowed is impossible to miss. It is
 * shared by the approval dialog (UI) and the plan builder/executor (safety
 * gate) so the two can never drift apart.
 */
export function liveConfirmationPhrase(expectedCount: number): string {
  return `UNFOLLOW ${expectedCount}`;
}

/**
 * A live plan may only execute when the human typed the exact phrase for the
 * exact number of targets it carries. Comparison is case-sensitive and
 * whitespace-sensitive on purpose: the user must deliberately type it.
 */
export function isLiveApprovalValid(approval: LiveApproval, targetCount: number): boolean {
  if (targetCount <= 0) {
    return false;
  }
  if (approval.expectedCount !== targetCount) {
    return false;
  }
  return approval.typedConfirmation === liveConfirmationPhrase(targetCount);
}
