import {
  AuditCandidate,
  AuditFilter,
  AuditSummary,
  AuditTab,
  DEFAULT_AUDIT_FILTER,
  GenderCategory,
  relationshipIncludesFollower,
  relationshipIncludesFollowing,
} from '../model/audit';
import { isCategoryGuess } from '../model/gender';
import { UserNode } from '../model/user';
import { buildWhitelistProtection, isProtectedBy } from './whitelist-match';

/** Results per review page. */
export const AUDIT_RESULTS_PER_PAGE = 50;

/** A likely account of the selected nuke category under the current threshold. */
export function isConfidentTarget(candidate: AuditCandidate, filter: AuditFilter): boolean {
  return isCategoryGuess(candidate.gender, filter.targetCategory, filter.minimumConfidence);
}

/**
 * True when a candidate belongs in the "other / uncertain" tab.
 *
 * The non-person categories (`machine`, `organization`, `ambiguous`) always
 * belong there, no matter how confident the classifier is: they can never be
 * a target and can never be unfollowed. Not-yet-classified accounts and
 * female/male guesses below the confidence filter are uncertain too.
 *
 * A confident guess for the *opposite* target is neither a target nor
 * uncertain; it is simply not what this audit is looking for, so it is hidden
 * from both the target tabs and the other/uncertain tab.
 */
export function isUncertainCandidate(candidate: AuditCandidate, filter: AuditFilter): boolean {
  return !isConfidentTarget(candidate, filter);
}

function matchesSearch(candidate: AuditCandidate, searchTerm: string): boolean {
  if (searchTerm === '') {
    return true;
  }
  const needle = searchTerm.toLowerCase();
  return (
    candidate.user.username.toLowerCase().includes(needle) ||
    candidate.user.full_name.toLowerCase().includes(needle)
  );
}

function matchesCommonFilter(candidate: AuditCandidate, searchTerm: string, filter: AuditFilter): boolean {
  if (!filter.showPrivate && candidate.user.is_private) {
    return false;
  }
  if (!filter.showVerified && candidate.user.is_verified) {
    return false;
  }
  return matchesSearch(candidate, searchTerm);
}

/**
 * The exact list of candidates the review screen should render for a tab.
 *
 * Whitelisted accounts always leave every review tab except the protected one,
 * so a protected account can never be presented as a normal unfollow candidate
 * by accident. The first two tabs are target-aware: they show only accounts
 * confidently estimated as `filter.targetCategory`.
 */
export function getCandidatesForDisplay(
  candidates: readonly AuditCandidate[],
  whitelistedResults: readonly UserNode[],
  currentTab: AuditTab,
  searchTerm: string,
  filter: AuditFilter = DEFAULT_AUDIT_FILTER,
): readonly AuditCandidate[] {
  const protection = buildWhitelistProtection(whitelistedResults);
  const visible: AuditCandidate[] = [];

  for (const candidate of candidates) {
    const isWhitelisted = isProtectedBy(candidate.user, protection);
    switch (currentTab) {
      case 'target-following':
        if (isWhitelisted || !isConfidentTarget(candidate, filter) || !relationshipIncludesFollowing(candidate.relationship)) {
          continue;
        }
        break;
      case 'target-followers':
        if (isWhitelisted || !isConfidentTarget(candidate, filter) || !relationshipIncludesFollower(candidate.relationship)) {
          continue;
        }
        break;
      case 'uncertain':
        if (isWhitelisted || !isUncertainCandidate(candidate, filter)) {
          continue;
        }
        break;
      case 'whitelisted':
        if (!isWhitelisted) {
          continue;
        }
        break;
      default:
        throw new Error(`Unhandled audit tab: ${String(currentTab)}`);
    }
    if (!matchesCommonFilter(candidate, searchTerm, filter)) {
      continue;
    }
    visible.push(candidate);
  }

  return [...visible].sort((a, b) => (a.user.username > b.user.username ? 1 : a.user.username < b.user.username ? -1 : 0));
}

export function getMaxAuditPage(visibleCandidates: readonly AuditCandidate[]): number {
  const pageCount = Math.ceil(visibleCandidates.length / AUDIT_RESULTS_PER_PAGE);
  return pageCount < 1 ? 1 : pageCount;
}

export function getCurrentAuditPage(
  visibleCandidates: readonly AuditCandidate[],
  currentPage: number,
): readonly AuditCandidate[] {
  const startIndex = AUDIT_RESULTS_PER_PAGE * (currentPage - 1);
  return visibleCandidates.slice(startIndex, startIndex + AUDIT_RESULTS_PER_PAGE);
}

/**
 * Accounts from the current view that can legally be removed right now.
 *
 * A target must be connected in either direction (you follow them, they follow
 * you, or both), not whitelisted, and confidently estimated as the selected
 * `targetCategory`. All five categories can be selected by the wizard.
 */
export function getEligibleTargets(
  candidates: readonly AuditCandidate[],
  whitelistedResults: readonly UserNode[],
  minimumConfidence: number,
  targetCategory: GenderCategory = 'female',
  includeFollowers = false,
  includeAmbiguous = false,
): readonly AuditCandidate[] {
  const protection = buildWhitelistProtection(whitelistedResults);
  return candidates.filter(candidate => {
    if (isProtectedBy(candidate.user, protection)) {
      return false;
    }
    const followsThem = candidate.user.followed_by_viewer && relationshipIncludesFollowing(candidate.relationship);
    const followsYou = includeFollowers && relationshipIncludesFollower(candidate.relationship);
    if (!followsThem && !followsYou) {
      return false;
    }
    if (isCategoryGuess(candidate.gender, targetCategory, minimumConfidence)) {
      return true;
    }
    return includeAmbiguous && candidate.gender !== null && candidate.gender.gender === 'ambiguous';
  });
}

/**
 * Target-based counts for the review sidebar. Target counts ignore whitelisted
 * accounts (they can never be unfollowed); `uncertain` mirrors the uncertain
 * tab's definition for every scanned account.
 */
export function summarizeAudit(
  candidates: readonly AuditCandidate[],
  whitelistedResults: readonly UserNode[],
  filter: AuditFilter = DEFAULT_AUDIT_FILTER,
): AuditSummary {
  const protection = buildWhitelistProtection(whitelistedResults);
  let targetFollowing = 0;
  let targetFollowers = 0;
  let targetMutual = 0;
  let uncertain = 0;

  for (const candidate of candidates) {
    const whitelisted = isProtectedBy(candidate.user, protection);
    if (isConfidentTarget(candidate, filter)) {
      if (!whitelisted && relationshipIncludesFollowing(candidate.relationship)) {
        targetFollowing++;
      }
      if (!whitelisted && relationshipIncludesFollower(candidate.relationship)) {
        targetFollowers++;
      }
      if (!whitelisted && candidate.relationship === 'mutual') {
        targetMutual++;
      }
    } else if (isUncertainCandidate(candidate, filter)) {
      uncertain++;
    }
  }

  return {
    targetFollowing,
    targetFollowers,
    targetMutual,
    uncertain,
    totalCandidates: candidates.length,
    eligibleForUnfollow: getEligibleTargets(
      candidates,
      whitelistedResults,
      filter.minimumConfidence,
      filter.targetCategory,
    ).length,
  };
}

/** True when the selected ids include at least one eligible target. */
export function hasEligibleSelection(
  candidates: readonly AuditCandidate[],
  whitelistedResults: readonly UserNode[],
  selectedIds: readonly string[],
  minimumConfidence: number,
  targetCategory: GenderCategory = 'female',
): boolean {
  const selected = new Set(selectedIds);
  return getEligibleTargets(candidates, whitelistedResults, minimumConfidence, targetCategory).some(c =>
    selected.has(c.user.id),
  );
}
