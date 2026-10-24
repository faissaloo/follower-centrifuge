import { GenderCategory, GenderClassifier, GenderGuess, DEFAULT_CONFIDENCE_THRESHOLD } from './gender';
import { UserNode } from './user';

/** Where the audited account sits relative to the logged-in viewer. */
export type FollowRelationship = 'following' | 'follower' | 'mutual';

/**
 * The audit target (`'female' | 'male'`), re-exported from the gender model so
 * audit code can import it from either module.
 */
export type { GenderCategory, TargetGender } from './gender';

export type FriendshipsListKind = 'following' | 'followers';

/**
 * Minimal shape of an entry returned by Instagram's private friendships REST
 * endpoints. Kept structural so audit logic can be tested without importing
 * the network layer.
 */
export interface FetchListUser {
  readonly pk?: string | number;
  readonly pk_id?: string;
  readonly username?: string;
  readonly full_name?: string;
  readonly profile_pic_url?: string;
  readonly is_private?: boolean;
  readonly is_verified?: boolean;
  readonly id?: string;
}

export function relationshipOf(followsThem: boolean, followsYou: boolean): FollowRelationship {
  if (followsThem && followsYou) {
    return 'mutual';
  }
  return followsThem ? 'following' : 'follower';
}

export function relationshipIncludesFollowing(relationship: FollowRelationship): boolean {
  return relationship === 'following' || relationship === 'mutual';
}

export function relationshipIncludesFollower(relationship: FollowRelationship): boolean {
  return relationship === 'follower' || relationship === 'mutual';
}

/** One account discovered by the audit, with its name-based gender guess. */
export interface AuditCandidate {
  readonly user: UserNode;
  readonly relationship: FollowRelationship;
  /** null until the classifier has answered for this account. */
  readonly gender: GenderGuess | null;
}

export type AuditPhase = 'fetching-following' | 'fetching-followers' | 'classifying' | 'complete' | 'failed';

/** Progress reported by the audit runner, always safe to render. */
export interface AuditProgress {
  readonly phase: AuditPhase;
  readonly followingFetched: number;
  readonly followersFetched: number;
  readonly classified: number;
  readonly toClassify: number;
  /** 0..100 */
  readonly percentage: number;
  /** Optional human readable progress note (e.g. "retrying classification"). */
  readonly notice?: string;
}

export interface AuditResult {
  readonly candidates: readonly AuditCandidate[];
  readonly followingComplete: boolean;
  readonly followersComplete: boolean;
  /** Number of accounts the classifier could not answer for (guess = unknown). */
  readonly classificationFailures: number;
  /** First classifier transport error, verbatim, for an actionable UI hint. */
  readonly classificationError?: string;
  /** True when both lists were fully walked and classification finished. */
  readonly finished: boolean;
}

/** Page loader injected into the audit runner (wraps Instagram's pagination). */
export type FetchListFn = (
  kind: FriendshipsListKind,
  onPage: (users: readonly FetchListUser[]) => void | Promise<void>,
) => Promise<boolean>;

/** Dependencies of the audit runner, all injectable for offline testing. */
export interface AuditRunnerDeps {
  readonly fetchList: FetchListFn;
  readonly classifier: GenderClassifier;
  /** Accounts sent to the classifier per request. */
  readonly classifyBatchSize?: number;
  /** How many classifier batches may be in flight at once (App uses 2). */
  readonly parallelClassifierBatches?: number;
  readonly onProgress: (progress: AuditProgress) => void;
  /** Emits each batch of candidates as soon as classification finishes it. */
  readonly onCandidatesBatch: (candidates: readonly AuditCandidate[]) => void;
  readonly shouldAbort: () => boolean;
  readonly now?: () => number;
  /** Retry batches the classifier failed once, after a short pause (App default). */
  readonly retryFailedBatches?: boolean;
  readonly classifierRetryDelayMs?: number;
}

/**
 * Tabs available on the review screen. The first two are the target-gender
 * relationship tabs (labels are generated from {@link TargetGender}); the
 * third holds every category that is not a confident target (machine,
 * organization, ambiguous and low-confidence guesses); the last is protection.
 */
export type AuditTab = 'target-following' | 'target-followers' | 'uncertain' | 'whitelisted';

export interface AuditFilter {
  /** Minimum confidence for a guess to count as a likely target account. */
  readonly minimumConfidence: number;
  /** Which classifier category the wizard is nuking (all five categories). */
  readonly targetCategory: GenderCategory;
  readonly showPrivate: boolean;
  readonly showVerified: boolean;
  /** Let the human manually select ambiguous accounts from the uncertain tab. */
  readonly includeAmbiguous: boolean;
}

export const DEFAULT_AUDIT_FILTER: AuditFilter = {
  minimumConfidence: DEFAULT_CONFIDENCE_THRESHOLD,
  targetCategory: 'female',
  showPrivate: true,
  showVerified: true,
  includeAmbiguous: false,
};

export interface AuditSummary {
  /** Likely target-gender accounts the viewer follows (includes mutuals). */
  readonly targetFollowing: number;
  /** Likely target-gender accounts who follow the viewer (includes mutuals). */
  readonly targetFollowers: number;
  /** Likely target-gender accounts who both follow and are followed back. */
  readonly targetMutual: number;
  /**
   * The "other / uncertain" bucket: machine/organization/ambiguous accounts
   * (always) plus unclassified or below-confidence female/male guesses.
   * A confident opposite-target guess is not uncertain.
   */
  readonly uncertain: number;
  readonly totalCandidates: number;
  /**
   * Target-gender accounts followed by the viewer, not whitelisted, eligible
   * to be unfollowed.
   */
  readonly eligibleForUnfollow: number;
}
