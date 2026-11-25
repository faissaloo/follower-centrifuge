/**
 * Daily shortlist domain model.
 *
 * The shortlist is deliberately READ-ONLY: it recommends public accounts for
 * the human to inspect and follow manually. Nothing in this module performs a
 * follow, unfollow, like, comment or DM.
 */
export const DAILY_SHORTLIST_SIZE = 20;
export const SHORTLIST_REFRESH_MS = 24 * 60 * 60 * 1000;
export const SHORTLIST_HISTORY_DAYS = 30;
export const SHORTLIST_STORAGE_KEY = 'iu_daily-shortlist';
export const SHORTLIST_PROMPT_STORAGE_KEY = 'iu_daily-shortlist-filter-prompt';
export const SHORTLIST_SEEDS_STORAGE_KEY = 'iu_daily-shortlist-seed-accounts';
export const MAX_MANUAL_SEEDS = 10;
export const SHORTLIST_STATE_VERSION = 1;
export const DEFAULT_FILTER_PROMPT = 'real people posting original work — not brands, reposters or obvious bots';
export const MAX_FILTER_PROMPT_LENGTH = 500;

/** Hard discovery budgets for one daily refresh (read-only requests only). */
export const GROWTH_SEED_COUNT = 6;
export const GROWTH_FOLLOWING_PER_SEED = 24;
export const GROWTH_MAX_CANDIDATES = 60;
export const GROWTH_MAX_PROFILE_LOOKUPS = 50;
export const GROWTH_SEED_PACING_MS: readonly [number, number] = [1400, 3600];
export const GROWTH_PROFILE_PACING_MS: readonly [number, number] = [900, 2600];

export interface ShortlistCandidate {
  readonly id: string;
  readonly username: string;
  readonly fullName: string;
  readonly biography: string;
  readonly profilePicUrl: string;
  readonly isPrivate: boolean;
  readonly isVerified: boolean;
  readonly followerCount: number;
  readonly followingCount: number;
  /** Filter-match score, 0..1. */
  readonly score: number;
  /** Public account whose list surfaced this candidate. */
  readonly sourceUsername?: string;
  /** Every place this account was found, e.g. "@seed · following". */
  readonly discoveredVia?: readonly string[];
  /** How many sampled follows led to this account (>1 = closer to your network). */
  readonly sourceCount?: number;
  /** 0..1 novelty/distance score; higher means further out from your network. */
  readonly networkDistance?: number;
  /** Result of a manual follow button press, if one has happened. */
  readonly followState?: 'requested' | 'following';
  /** Neutral visual cues used by the shortlist filter (not shown in the UI). */
  readonly photoCues?: string;
}

export type MatchStrength = 'strong' | 'good' | 'maybe' | 'weak';

/** Human-readable band for a filter match score. */
export function matchStrength(score: number): MatchStrength {
  if (score >= 0.75) {
    return 'strong';
  }
  if (score >= 0.5) {
    return 'good';
  }
  if (score >= 0.25) {
    return 'maybe';
  }
  return 'weak';
}

export interface DailyShortlistState {
  readonly version: number;
  /** When this shortlist was generated (epoch ms). */
  readonly refreshedAt: number;
  /** When the next automatic refresh becomes due (epoch ms). */
  readonly dueAt: number;
  /** The filter prompt used for this batch. */
  readonly filterPrompt: string;
  readonly entries: readonly ShortlistCandidate[];
  /** Username -> last day seen (epoch ms), used for 30-day de-duplication. */
  readonly seen: Readonly<Record<string, number>>;
}
