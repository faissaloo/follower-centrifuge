export const INSTAGRAM_HOSTNAME = 'www.instagram.com';
// The app id Instagram's own web frontend sends on its private REST API
// calls (e.g. /api/v1/friendships/<id>/following/). Required or these
// endpoints behave inconsistently; it is not a secret, just an identifier
// for "the instagram.com web client" and is safe to keep public.
export const INSTAGRAM_WEB_APP_ID = '936619743392459';
export const INSTAGRAM_ASBD_ID = '129477';

// The persisted GraphQL query instagram.com's own Unfollow button runs
// (fb_api_req_friendly_name "usePolarisUnfollowMutation"). Instagram can rotate
// this id on a deploy; if unfollows start failing with a GraphQL error, capture
// the button's /api/graphql request in DevTools and update it here.
export const INSTAGRAM_UNFOLLOW_DOC_ID = '27789106940691111';
export const INSTAGRAM_UNFOLLOW_FRIENDLY_NAME = 'usePolarisUnfollowMutation';

// Page-count safety cap for loading the viewer's own following and followers lists
// (see utils/utils.ts and main.tsx).
export const FOLLOWING_PAGE_SAFETY_LIMIT = 250;
export const FOLLOWERS_PAGE_SAFETY_LIMIT = 250;
// A long safety sleep is taken once every this many scan requests.
export const CHECKS_BEFORE_LONG_SLEEP = 15;
export const RATE_LIMIT_COOLDOWN_SECONDS = 30;
export const WHITELISTED_RESULTS_STORAGE_KEY = 'iu_whitelisted-results';
export const TIMINGS_STORAGE_KEY = 'iu_timings';
export const LAST_SCAN_RESULTS_STORAGE_KEY = 'iu_last-scan-results';
export const LAST_SCAN_TIMESTAMP_STORAGE_KEY = 'iu_last-scan-time';

// TIMINGS CONSTANTS
export const DEFAULT_TIME_BETWEEN_SEARCH_CYCLES = 1000;
export const DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES = 10000;
export const DEFAULT_TIME_BETWEEN_UNFOLLOWS = 4000;
export const DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS = 300000;
export const DEFAULT_USERS_PER_SEARCH_CYCLE = 50;

// Review results cached locally so a completed audit can be reopened without
// hitting Instagram or the DeepSeek API again.
export const REVIEW_CACHE_STORAGE_KEY = 'iu_review-cache';
/** Raw following/followers lists, reused by later scans while fresh. */
export const ACCOUNT_LIST_CACHE_STORAGE_KEY = 'iu_account-lists';
export const ACCOUNT_LIST_CACHE_VERSION = 1;
/** Lists older than this are re-fetched; Instagram changes are not cheap to detect. */
export const ACCOUNT_LIST_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
export const REVIEW_CACHE_VERSION = 3;
// A cached review may drive a live unfollow plan, so it is only trusted for a
// limited time; older relationship data must be re-scanned before acting.
export const REVIEW_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Allow a little clock skew for scans that finished "in the future" on another
// device/time zone; anything beyond this is treated as stale.
export const REVIEW_CACHE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
// Even a freshly scanned review may only start a live run while the data is
// still likely to reflect the account; after this window a re-scan is required.
export const LIVE_REVIEW_MAX_AGE_MS = 30 * 60 * 1000;
