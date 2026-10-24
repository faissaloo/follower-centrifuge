/**
 * Paginated walking of Instagram's friendships lists.
 *
 * Pure and fully injected so it can be tested without any network: App wires
 * the real `fetchFriendshipsPage`, a sleep implementation, and abort/pause
 * predicates. This is the same pagination/retry/rate-limit behavior the app
 * needs to survive large accounts and Instagram soft blocks.
 */
import { FetchListFn, FetchListUser, FriendshipsListKind } from '../model/audit';

export interface FriendshipsPageLike {
  readonly users?: readonly FetchListUser[];
  readonly next_max_id?: string;
  readonly has_more?: boolean;
}

export interface FriendshipsListFetcherDeps {
  /** Fetches one page; may throw (App wraps InstagramApiError/network failures). */
  readonly fetchPage: (
    kind: FriendshipsListKind,
    maxId?: string,
    count?: number,
  ) => Promise<FriendshipsPageLike>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly shouldAbort: () => boolean;
  /** Optional pause predicate (e.g. user pressed "pause"). Checked before each page. */
  readonly isPaused?: () => boolean;
  /** Progress note callbacks for cooldowns / retries. */
  readonly onNotice?: (notice: string) => void;
  /** Hard cap on pages walked per list. */
  readonly pageSafetyLimit?: number;
  readonly usersPerPage?: number;
  readonly maxRetries?: number;
  /** Pacing between successive page requests. */
  readonly pacing?: {
    readonly minDelayMs: number;
    readonly maxExtraDelayMs: number;
    readonly longPauseEveryRequests: number;
    readonly longPauseMs: number;
  };
  /** Called with the last error when a list walk gives up or fails. */
  readonly onError?: (error: unknown, kind: FriendshipsListKind) => void;
}

const DEFAULT_PACING = {
  minDelayMs: 1000,
  maxExtraDelayMs: 900,
  longPauseEveryRequests: 15,
  longPauseMs: 10000,
};

function errorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return null;
}

/** Transient failures are worth retrying; everything else fails the walk. */
export function isTransientFetchError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  if (typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'InstagramApiError') {
    const status = errorStatus(error);
    if (status === 429) {
      return true;
    }
    if (status !== null && status >= 500) {
      return true;
    }
    const message = String((error as { message?: unknown }).message ?? '');
    return /feedback_required|checkpoint|rate limit|please wait|try again later/i.test(message);
  }
  const message = String((error as { message?: unknown }).message ?? error);
  return /fetch|network|timed out|timeout|aborted/i.test(message);
}

export function createFriendshipsListFetcher(deps: FriendshipsListFetcherDeps): FetchListFn {
  const pageSafetyLimit = deps.pageSafetyLimit ?? 250;
  const maxRetries = deps.maxRetries ?? 3;
  const pacing = deps.pacing ?? DEFAULT_PACING;

  const pace = async (requestsSoFar: number): Promise<void> => {
    const jitter = Math.floor(deps.random() * pacing.maxExtraDelayMs);
    await deps.sleep(pacing.minDelayMs + jitter);
    if (pacing.longPauseEveryRequests > 0 && requestsSoFar > 0 && requestsSoFar % pacing.longPauseEveryRequests === 0) {
      await deps.sleep(pacing.longPauseMs);
    }
  };

  /**
   * Fetch one page, retrying transient failures with cooldowns. Returns null
   * when the walk should stop; the error is reported through `deps.onError`.
   */
  const loadPage = async (kind: FriendshipsListKind, maxId: string | undefined): Promise<FriendshipsPageLike | null> => {
    let retries = 0;
    for (;;) {
      if (deps.shouldAbort()) {
        return null;
      }
      try {
        return await deps.fetchPage(kind, maxId, deps.usersPerPage);
      } catch (error) {
        const transient = isTransientFetchError(error);
        const status = errorStatus(error);
        if (transient && retries < maxRetries && !deps.shouldAbort()) {
          retries++;
          const waitSeconds = (status === 429 ? 30 : 5) * retries;
          deps.onNotice?.(`retrying after ${waitSeconds}s`);
          await deps.sleep(waitSeconds * 1000);
          if (deps.shouldAbort()) {
            return null;
          }
          continue;
        }
        deps.onError?.(error, kind);
        return null;
      }
    }
  };

  const waitWhilePaused = async (): Promise<boolean> => {
    if (deps.isPaused === undefined) {
      return true;
    }
    while (deps.isPaused()) {
      await deps.sleep(1000);
      if (deps.shouldAbort()) {
        return false;
      }
    }
    return true;
  };

  return async (kind, onPage) => {
    let maxId: string | undefined;
    let pagesFetched = 0;
    let requests = 0;

    for (;;) {
      if (deps.shouldAbort()) {
        deps.onNotice?.('aborted');
        return false;
      }
      if (!(await waitWhilePaused())) {
        deps.onNotice?.('aborted');
        return false;
      }

      const page = await loadPage(kind, maxId);
      if (page === null) {
        return false;
      }

      requests++;
      const pageUsers = page.users ?? [];
      const onPageResult = onPage(pageUsers);
      if (onPageResult !== undefined) {
        await onPageResult;
      }

      if (deps.shouldAbort()) {
        deps.onNotice?.('aborted');
        return false;
      }

      // Completeness rules (fail closed):
      //  - an empty page only proves the list is complete if Instagram does not
      //    claim there is more;
      //  - a page that claims has_more=true but gives no next_max_id cannot be
      //    followed, so the walk is INCOMPLETE (live unfollow must stay locked)
      //    rather than silently treating a truncated list as finished.
      if (page.has_more === false) {
        return true;
      }
      const claimsMore = page.has_more === true;
      const nextMaxId = typeof page.next_max_id === 'string' ? page.next_max_id.trim() : '';
      if (pageUsers.length === 0 || nextMaxId === '') {
        return !claimsMore;
      }

      pagesFetched++;
      if (pagesFetched >= pageSafetyLimit) {
        deps.onNotice?.(`page safety limit ${pageSafetyLimit} reached`);
        return false;
      }
      maxId = nextMaxId;
      await pace(requests);
    }
  };
}
