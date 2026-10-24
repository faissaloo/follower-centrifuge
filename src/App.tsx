import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
  DEFAULT_TIME_BETWEEN_UNFOLLOWS,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
  DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
  DEFAULT_USERS_PER_SEARCH_CYCLE,
  FOLLOWERS_PAGE_SAFETY_LIMIT,
  FOLLOWING_PAGE_SAFETY_LIMIT,
  LIVE_REVIEW_MAX_AGE_MS,
} from './constants/constants';
import { AuditCandidate, AuditFilter, AuditTab, DEFAULT_AUDIT_FILTER, FetchListFn, FetchListUser } from './model/audit';
import { GenderCategory } from './model/gender';
import { DeepSeekConfig, HAS_EMBEDDED_DEEPSEEK_KEY, HAS_EMBEDDED_TYPESAFE_KEY } from './model/deepseek-config';
import { probeRelayConnection, relayUrlCandidates, relayWillBeUsed } from './utils/classifier-relay';
import { UnfollowPlan } from './model/action-plan';
import { AppState, ExecutingState, ReviewState, ScanningState } from './model/state';
import { Timings } from './model/timings';
import { UserNode } from './model/user';
import { createDemoDataset, DEMO_CLASSIFIER_VERSION } from './preview/demo-data';
import { getCandidatesForDisplay } from './utils/audit-display';
import { loadTargetCategory, saveTargetCategory } from './utils/audit-preferences';
import { clearAccountListCache, createCachedListFetch, loadAccountListCache, saveAccountListCache } from './utils/account-list-cache';
import { buildUnfollowPlan } from './utils/action-plan';
import { estimateExecutionRemainingMs, executeUnfollowPlan } from './utils/unfollow-executor';
import { loadDeepSeekConfig, saveDeepSeekConfig } from './utils/deepseek-settings';
import {
  createDemoGenderClassifier,
  createGenderClassifier,
  isDeepSeekConfigured,
  isTypeSafeConfigured,
  testDeepSeekConnection,
} from './utils/gender-classifier';
import { createFriendshipsListFetcher } from './utils/friendships-list';
import { getInitialLanguage, Language, saveLanguage, t } from './utils/i18n';
import { loadReviewCache, ReviewCacheRecord, saveReviewCache } from './utils/review-cache';
import { loadTimings, loadWhitelist, saveTimings, saveWhitelist } from './utils/whitelist-manager';
import { copyListToClipboard, exportToCSV, exportToJSON, fetchFriendshipsPage, getCookie, isStillFollower, isStillFollowing, removeFollower, sleep, unfollowUser } from './utils/utils';
import { buildWhitelistProtection, isProtectedByWhitelist, withoutProtectionFor } from './utils/whitelist-match';
import { runAccountAudit } from './utils/account-audit';

import { NukeWizard } from './components/NukeWizard';
import { ScanningScreen } from './components/ScanningScreen';
import { ClassifierAttribution, ReviewScreen } from './components/ReviewScreen';
import { ExecutingScreen } from './components/ExecutingScreen';
import { SettingMenu } from './components/SettingMenu';
import { Toast } from './components/Toast';

export interface AppProps {
  /**
   * Local previews (`localhost`, `127.0.0.1`) run in demo mode: scanning loads
   * synthetic data and nothing ever contacts Instagram or DeepSeek.
   */
  readonly demoMode?: boolean;
  /** Immediately open the synthetic demo review (used by `?preview=review`). */
  readonly autoLoadDemo?: boolean;
}

type ToastStyle = 'success' | 'error' | 'warning' | 'info';
type ToastState = { readonly show: false } | { readonly show: true; readonly text: string; readonly style: ToastStyle };

const DEFAULT_TIMINGS: Timings = {
  timeBetweenSearchCycles: DEFAULT_TIME_BETWEEN_SEARCH_CYCLES,
  timeToWaitAfterFiveSearchCycles: DEFAULT_TIME_TO_WAIT_AFTER_FIVE_SEARCH_CYCLES,
  timeBetweenUnfollows: DEFAULT_TIME_BETWEEN_UNFOLLOWS,
  timeToWaitAfterFiveUnfollows: DEFAULT_TIME_TO_WAIT_AFTER_FIVE_UNFOLLOWS,
  usersPerSearchCycle: DEFAULT_USERS_PER_SEARCH_CYCLE,
};

/**
 * Filter a freshly opened review starts with: the user's persisted audit
 * target (women by default) plus the conservative display defaults.
 */
function loadInitialAuditFilter(): AuditFilter {
  return { ...DEFAULT_AUDIT_FILTER, targetCategory: loadTargetCategory(), includeAmbiguous: true };
}

function loadInitialTimings(): Timings {
  const stored = loadTimings();
  return {
    timeBetweenSearchCycles: stored?.timeBetweenSearchCycles ?? DEFAULT_TIMINGS.timeBetweenSearchCycles,
    timeToWaitAfterFiveSearchCycles:
      stored?.timeToWaitAfterFiveSearchCycles ?? DEFAULT_TIMINGS.timeToWaitAfterFiveSearchCycles,
    timeBetweenUnfollows: stored?.timeBetweenUnfollows ?? DEFAULT_TIMINGS.timeBetweenUnfollows,
    timeToWaitAfterFiveUnfollows:
      stored?.timeToWaitAfterFiveUnfollows ?? DEFAULT_TIMINGS.timeToWaitAfterFiveUnfollows,
    usersPerSearchCycle: stored?.usersPerSearchCycle ?? DEFAULT_TIMINGS.usersPerSearchCycle,
  };
}

function mergeCandidates(
  existing: readonly AuditCandidate[],
  incoming: readonly AuditCandidate[],
): readonly AuditCandidate[] {
  if (incoming.length === 0) {
    return existing;
  }
  const merged = [...existing];
  const indexById = new Map<string, number>();
  for (let index = 0; index < merged.length; index++) {
    indexById.set(merged[index].user.id, index);
  }
  for (const candidate of incoming) {
    const index = indexById.get(candidate.user.id);
    if (index === undefined) {
      indexById.set(candidate.user.id, merged.length);
      merged.push(candidate);
    } else {
      merged[index] = candidate;
    }
  }
  return merged;
}

function selectedUsers(review: ReviewState): readonly UserNode[] {
  const byId = new Map<string, UserNode>();
  for (const candidate of review.candidates) {
    byId.set(candidate.user.id, candidate.user);
  }
  const users: UserNode[] = [];
  for (const id of review.selectedIds) {
    const user = byId.get(id);
    if (user !== undefined) {
      users.push(user);
    }
  }
  return users;
}

function whitelistProtectionOf(review: ReviewState): {
  readonly ids: ReadonlySet<string>;
  readonly usernames: ReadonlySet<string>;
} {
  return buildWhitelistProtection(review.whitelistedResults);
}

function toReviewCacheRecord(review: ReviewState, viewerId: string): ReviewCacheRecord {
  return {
    version: 3,
    demo: review.demo,
    viewerId,
    candidates: review.candidates,
    whitelistedResults: review.whitelistedResults,
    classifierVersion: review.classifierVersion,
    scanComplete: review.scanComplete,
    followingComplete: review.followingComplete,
    followersComplete: review.followersComplete,
    classificationFailures: review.classificationFailures,
    totalFetched: review.totalFetched,
    scanTimestamp: review.scanTimestamp,
  };
}

function reviewFromCache(record: ReviewCacheRecord): ReviewState {
  return {
    status: 'reviewing',
    candidates: record.candidates,
    // Protection is read from the live whitelist: a protected account added or
    // removed after the scan must never be resurrected from the cache.
    whitelistedResults: loadWhitelist(),
    selectedIds: [],
    currentTab: 'target-following',
    searchTerm: '',
    filter: loadInitialAuditFilter(),
    scanComplete: record.scanComplete,
    followingComplete: record.followingComplete,
    followersComplete: record.followersComplete,
    classificationFailures: record.classificationFailures,
    classifierVersion: record.classifierVersion,
    totalFetched: record.totalFetched,
    scanTimestamp: record.scanTimestamp,
    demo: record.demo,
    viewerId: record.viewerId,
    // A cached review may only be reviewed/dry-run; a fresh scan is required
    // before any live action (see ReviewScreen/App live gating).
    fromCache: true,
  };
}

/**
 * After a completed live run, accounts Instagram confirmed as unfollowed are
 * removed from the review list so a second run cannot target them again from a
 * stale candidate record.
 */
function reviewAfterLiveRun(review: ReviewState, unfollowedIds: ReadonlySet<string>): ReviewState {
  if (unfollowedIds.size === 0) {
    return review;
  }
  return {
    ...review,
    candidates: review.candidates.filter(candidate => !unfollowedIds.has(candidate.user.id)),
    selectedIds: review.selectedIds.filter(id => !unfollowedIds.has(id)),
  };
}

function createExecutingState(
  plan: UnfollowPlan,
  percentage: number,
  stopReason?: ExecutingState['stopReason'],
  estimatedRemainingMs?: number,
): ExecutingState {
  return {
    status: 'executing',
    plan,
    percentage,
    entries: [],
    searchTerm: '',
    showSucceeded: true,
    showFailed: true,
    stopReason,
    estimatedRemainingMs,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export const App = ({ demoMode = false, autoLoadDemo = false }: AppProps) => {
  const [state, setState] = useState<AppState>({ status: 'initial' });
  const [lang, setLang] = useState<Language>(() => getInitialLanguage());
  const [toast, setToast] = useState<ToastState>({ show: false });
  const [timings, setTimings] = useState<Timings>(() => loadInitialTimings());
  const [deepSeekConfig, setDeepSeekConfig] = useState<DeepSeekConfig>(() => loadDeepSeekConfig());
  const keySetupNeeded =
    !demoMode &&
    !HAS_EMBEDDED_DEEPSEEK_KEY &&
    !HAS_EMBEDDED_TYPESAFE_KEY &&
    deepSeekConfig.typesafeApiKey.trim() === '' &&
    deepSeekConfig.apiKey.trim() === '';
  const handleSaveWizardKeys = useCallback((typesafeKey: string, deepseekKey: string): void => {
    const next: DeepSeekConfig = {
      ...deepSeekConfig,
      typesafeApiKey: typesafeKey !== '' ? typesafeKey : deepSeekConfig.typesafeApiKey,
      apiKey: deepseekKey !== '' ? deepseekKey : deepSeekConfig.apiKey,
      // A direct DeepSeek key needs direct mode; otherwise the local proxy is
      // still used and browser-entered fallback keys are ignored.
      mode: deepseekKey !== '' && !HAS_EMBEDDED_DEEPSEEK_KEY ? 'direct' : deepSeekConfig.mode,
    };
    saveDeepSeekConfig(next);
    setDeepSeekConfig(next);
  }, [deepSeekConfig]);
  // Launch-screen preflight: on Instagram the relay is the only transport that
  // can reach the classifiers, so verify it before letting a scan start.
  const relayRequired = !demoMode && relayWillBeUsed(deepSeekConfig, { hostname: location.hostname });
  const [relayCheck, setRelayCheck] = useState<{ status: 'checking' | 'ok' | 'error'; message?: string }>(() =>
    relayRequired ? { status: 'checking' } : { status: 'ok' },
  );
  const relayCheckId = useRef(0);
  const runRelayCheck = useCallback(async (): Promise<void> => {
    const checkId = relayCheckId.current + 1;
    relayCheckId.current = checkId;
    if (!relayRequired) {
      setRelayCheck({ status: 'ok' });
      return;
    }
    setRelayCheck({ status: 'checking' });
    const candidates = relayUrlCandidates(deepSeekConfig);
    const result = await probeRelayConnection({
      relayUrl: candidates[0],
      fallbackRelayUrls: candidates.slice(1),
      timeoutMs: 2500,
    });
    if (relayCheckId.current !== checkId) {
      return;
    }
    setRelayCheck(result.ok ? { status: 'ok' } : { status: 'error', message: result.message });
  }, [relayRequired, deepSeekConfig]);
  useEffect(() => {
    void runRelayCheck();
  }, [runRelayCheck]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, setTargetCategory] = useState<GenderCategory>(() => loadTargetCategory());
  const [pendingLiveApproval, setPendingLiveApproval] = useState(false);
  const [cachedReview, setCachedReview] = useState<ReviewCacheRecord | null>(() =>
    loadReviewCache(Date.now(), getCookie('ds_user_id')),
  );

  const pendingCategoryRef = useRef<GenderCategory>(loadTargetCategory());
  const abortScanRef = useRef(false);
  const abortExecutionRef = useRef(false);
  const lastReviewRef = useRef<ReviewState | null>(null);
  const autoLoadedRef = useRef(false);

  const langRef = useRef(lang);
  langRef.current = lang;
  const timingsRef = useRef(timings);
  timingsRef.current = timings;
  const demoModeRef = useRef(demoMode);
  demoModeRef.current = demoMode;

  const notify = useCallback((text: string, style: ToastStyle = 'info') => {
    setToast({ show: true, text, style });
  }, []);

  /**
   * Persist a review for the currently logged-in viewer. Demo reviews and
   * sessions without a known viewer id are never cached.
   */
  const persistReviewCache = useCallback((review: ReviewState) => {
    if (review.demo || demoModeRef.current) {
      return;
    }
    const viewerId = getCookie('ds_user_id');
    if (viewerId === null || viewerId === '') {
      return;
    }
    const record = toReviewCacheRecord(review, viewerId);
    saveReviewCache(record);
    setCachedReview(record);
  }, []);

  const closeToast = useCallback(() => setToast({ show: false }), []);

  const handleLanguageChange = useCallback((nextLang: Language) => {
    setLang(nextLang);
    saveLanguage(nextLang);
  }, []);

  // ---------------------------------------------------------------------------
  // Demo mode / cached review
  // ---------------------------------------------------------------------------
  const loadDemoReview = useCallback(() => {
    const dataset = createDemoDataset();
    const review: ReviewState = {
      status: 'reviewing',
      candidates: dataset.candidates,
      whitelistedResults: dataset.whitelistedResults,
      selectedIds: [],
      currentTab: 'target-following',
      searchTerm: '',
      filter: { ...loadInitialAuditFilter(), targetCategory: pendingCategoryRef.current },
      scanComplete: true,
      followingComplete: true,
      followersComplete: true,
      classificationFailures: 0,
      classifierVersion: DEMO_CLASSIFIER_VERSION,
      totalFetched: dataset.candidates.length,
      scanTimestamp: Date.now(),
      demo: true,
      viewerId: null,
      fromCache: false,
    };
    lastReviewRef.current = review;
    setState(review);
    notify(t(langRef.current, 'demoLoaded', dataset.candidates.length), 'info');
  }, [notify]);

  useEffect(() => {
    if (!autoLoadDemo || autoLoadedRef.current) {
      return;
    }
    autoLoadedRef.current = true;
    loadDemoReview();
  }, [autoLoadDemo, loadDemoReview]);

  const loadCachedReview = useCallback(() => {
    const record = loadReviewCache(Date.now(), getCookie('ds_user_id'));
    if (record === null) {
      return;
    }
    const review = reviewFromCache(record);
    lastReviewRef.current = review;
    setState(review);
    notify(t(langRef.current, 'loadedFromCache', review.totalFetched), 'info');
  }, [notify]);

  // ---------------------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------------------
  const startScan = useCallback((category?: GenderCategory) => {
    if (category !== undefined) {
      pendingCategoryRef.current = category;
      saveTargetCategory(category);
      setTargetCategory(category);
    }
    if (demoModeRef.current) {
      loadDemoReview();
      return;
    }
    if (getCookie('ds_user_id') === null) {
      notify(t(langRef.current, 'scanFailedFollowing'), 'error');
      return;
    }
    setState({
      status: 'scanning',
      phase: 'fetching-following',
      percentage: 0,
      followingFetched: 0,
      followersFetched: 0,
      classified: 0,
      toClassify: 0,
      candidates: [],
    });
  }, [loadDemoReview, notify]);

  const cancelScan = useCallback(() => {
    // Stop the walk; the runner resolves with whatever it had already fetched
    // and the UI moves to the (incomplete) review so partial work is kept.
    abortScanRef.current = true;
    notify(t(langRef.current, 'scanAborted'), 'info');
  }, [notify]);

  useEffect(() => {
    if (state.status !== 'scanning' || demoMode) {
      return undefined;
    }
    let cancelled = false;
    abortScanRef.current = false;
    const config = deepSeekConfig;
    const currentTimings = timings;
    const language = lang;
    const classifier =
      config.mode === 'demo' ? createDemoGenderClassifier() : createGenderClassifier(config);

    const viewerId = getCookie('ds_user_id');
    const cachedLists = loadAccountListCache(viewerId);
    const collectedFollowing: FetchListUser[] = [];
    const collectedFollowers: FetchListUser[] = [];
    let fetchList: FetchListFn;
    if (cachedLists !== null) {
      // A fresh list pair is replayed locally; cached guesses are reused, and
      // failing that only the classifier requests are re-run.
      fetchList = createCachedListFetch(cachedLists);
      const ageMinutes = Math.max(1, Math.round((Date.now() - cachedLists.fetchedAt) / 60000));
      notify(t(language, 'usingCachedLists', ageMinutes), 'info');
    } else {
      fetchList = createFriendshipsListFetcher({
        fetchPage: async (kind, maxId, count) => {
          const page = await fetchFriendshipsPage(kind, maxId, count);
          const users = page.users ?? [];
          (kind === 'following' ? collectedFollowing : collectedFollowers).push(...users);
          return page;
        },
        sleep: ms => sleep(ms),
        random: () => Math.random(),
        shouldAbort: () => abortScanRef.current,
        pageSafetyLimit: Math.max(FOLLOWING_PAGE_SAFETY_LIMIT, FOLLOWERS_PAGE_SAFETY_LIMIT),
        usersPerPage: currentTimings.usersPerSearchCycle ?? DEFAULT_USERS_PER_SEARCH_CYCLE,
        onNotice: notice => {
          setState(previous => (previous.status === 'scanning' ? { ...previous, notice } : previous));
        },
        onError: (error, kind) => {
          console.error(`Could not load the ${kind} list:`, error);
        },
      });
    }

    runAccountAudit({
      fetchList,
      classifier,
      // Start producing guesses as soon as a small slice is available, and
      // keep two batches in flight so Jev + the DeepSeek photo pass overlap.
      classifyBatchSize: Math.min(Math.max(1, config.batchSize), 10),
      parallelClassifierBatches: 2,
      now: () => Date.now(),
      shouldAbort: () => abortScanRef.current,
      onProgress: progress => {
        setState(previous => {
          if (previous.status !== 'scanning') {
            return previous;
          }
          const next: ScanningState = {
            ...previous,
            phase: progress.phase,
            percentage: progress.percentage,
            followingFetched: progress.followingFetched,
            followersFetched: progress.followersFetched,
            classified: progress.classified,
            toClassify: progress.toClassify,
            notice: progress.notice,
          };
          return next;
        });
      },
      retryFailedBatches: true,
      onCandidatesBatch: batch => {
        setState(previous => {
          if (previous.status !== 'scanning') {
            return previous;
          }
          return { ...previous, candidates: mergeCandidates(previous.candidates, batch) };
        });
      },
    })
      .then(result => {
        if (cancelled) {
          return;
        }
        if (
          cachedLists === null &&
          viewerId !== null &&
          result.followingComplete &&
          result.followersComplete
        ) {
          saveAccountListCache(viewerId, collectedFollowing, collectedFollowers);
        }
        if (result.candidates.length === 0 && !result.finished) {
          setState({ status: 'initial' });
          notify(
            t(language, result.followingComplete ? 'scanFailedFollowers' : 'scanFailedFollowing'),
            'error',
          );
          return;
        }
        const review: ReviewState = {
          status: 'reviewing',
          candidates: result.candidates,
          whitelistedResults: loadWhitelist(),
          selectedIds: [],
          currentTab: 'target-following',
          searchTerm: '',
          filter: { ...loadInitialAuditFilter(), targetCategory: pendingCategoryRef.current },
          scanComplete: result.finished,
          followingComplete: result.followingComplete,
          followersComplete: result.followersComplete,
          classificationFailures: result.classificationFailures,
          classifierError: result.classificationError,
          classifierVersion: classifier.version,
          totalFetched: result.candidates.length,
          scanTimestamp: cachedLists === null ? Date.now() : cachedLists.fetchedAt,
          demo: false,
          viewerId: getCookie('ds_user_id'),
          fromCache: false,
        };
        lastReviewRef.current = review;
        setState(review);
        persistReviewCache(review);
        if (result.finished) {
          notify(t(language, 'scanCompleted'), 'success');
        } else {
          notify(t(language, 'partialScanInterrupted', result.candidates.length), 'warning');
        }
      })
      .catch(error => {
        if (cancelled) {
          return;
        }
        console.error('Audit scan failed:', error);
        setState({ status: 'initial' });
        notify(t(language, 'scanFailedFollowing'), 'error');
      });

    return () => {
      cancelled = true;
      abortScanRef.current = true;
    };
    // Deliberately only re-runs when the app enters the scanning state; the
    // other inputs are captured for one scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  // ---------------------------------------------------------------------------
  // Review handlers
  // ---------------------------------------------------------------------------
  const updateReview = useCallback((updater: (review: ReviewState) => ReviewState) => {
    setState(previous => (previous.status === 'reviewing' ? updater(previous) : previous));
  }, []);

  const handleTabChange = useCallback((tab: AuditTab) => {
    updateReview(review => ({ ...review, currentTab: tab }));
  }, [updateReview]);

  const handleSearchChange = useCallback((term: string) => {
    updateReview(review => ({ ...review, searchTerm: term }));
  }, [updateReview]);

  const handleFilterChange = useCallback((filter: AuditFilter) => {
    // The nuke category is a wizard preference, not scan data: persist it as
    // soon as filters change so a re-scan keeps the same target.
    pendingCategoryRef.current = filter.targetCategory;
    saveTargetCategory(filter.targetCategory);
    setTargetCategory(filter.targetCategory);
    updateReview(review => {
      if (review.filter.targetCategory === filter.targetCategory) {
        return { ...review, filter };
      }
      // A selection made for the previous category is not valid for the new
      // one; clearing it keeps "selected" and "eligible" counts honest.
      return { ...review, filter, selectedIds: [] };
    });
  }, [updateReview]);

  const handleSelectionChange = useCallback((ids: readonly string[]) => {
    updateReview(review => ({ ...review, selectedIds: ids }));
  }, [updateReview]);

  const handleToggleWhitelist = useCallback((user: UserNode) => {
    updateReview(review => {
      // Protection matches ids AND usernames: a bulk-pasted whitelist entry has
      // a synthetic id, so an id-only check would leave the real account
      // unfollowable while showing it as protected.
      const isWhitelisted = isProtectedByWhitelist(user, review.whitelistedResults);
      const whitelistedResults = isWhitelisted
        ? withoutProtectionFor(user, review.whitelistedResults)
        : [...review.whitelistedResults, user];
      const next: ReviewState = {
        ...review,
        whitelistedResults,
        selectedIds: isWhitelisted ? review.selectedIds : review.selectedIds.filter(id => id !== user.id),
      };
      // The demo dataset is synthetic; it must never overwrite the user's real
      // protected list or the real review cache of this browser origin.
      if (review.demo || demoModeRef.current) {
        return next;
      }
      saveWhitelist(whitelistedResults);
      persistReviewCache(next);
      return next;
    });
  }, [persistReviewCache, updateReview]);

  const handleWhitelistFromSettings = useCallback((users: readonly UserNode[]) => {
    const current = state;
    const editingDemoReview = current.status === 'reviewing' && current.demo;
    if (!editingDemoReview && !demoModeRef.current) {
      saveWhitelist(users);
    }
    updateReview(review => {
      const next: ReviewState = { ...review, whitelistedResults: users };
      if (review.demo || demoModeRef.current) {
        return next;
      }
      persistReviewCache(next);
      return next;
    });
  }, [persistReviewCache, state, updateReview]);

  const buildPlanForSelection = useCallback((
    mode: 'dry-run' | 'live',
    typedConfirmation?: string,
    targetIds?: readonly string[],
  ) => {
    const review = state.status === 'reviewing' ? state : null;
    if (review === null) {
      return null;
    }
    if (mode === 'live') {
      if (review.demo || demoModeRef.current) {
        notify(t(langRef.current, 'liveRunBlocked'), 'error');
        return null;
      }
      if (review.fromCache) {
        notify(t(langRef.current, 'liveRunLockedCached'), 'error');
        return null;
      }
      if (Date.now() - review.scanTimestamp > LIVE_REVIEW_MAX_AGE_MS) {
        notify(t(langRef.current, 'liveRunLockedStale'), 'error');
        return null;
      }
      const currentViewer = getCookie('ds_user_id');
      if (currentViewer === null || review.viewerId === null || currentViewer !== review.viewerId) {
        // Another tab may have switched Instagram accounts during the review.
        notify(t(langRef.current, 'liveRunLockedViewerChanged'), 'error');
        return null;
      }
    }
    const protection = whitelistProtectionOf(review);
    let selected: readonly UserNode[];
    if (targetIds === undefined) {
      selected = selectedUsers(review);
    } else {
      // The live approval dialog reports the exact account ids it displayed;
      // bind the executable plan to those identities instead of re-deriving
      // the selection, so a selection change behind the dialog can never send
      // the approval to a different set of accounts.
      const usersById = new Map<string, UserNode>();
      for (const candidate of review.candidates) {
        usersById.set(candidate.user.id, candidate.user);
      }
      const bound: UserNode[] = [];
      for (const id of targetIds) {
        const user = usersById.get(id);
        if (user !== undefined) {
          bound.push(user);
        }
      }
      selected = bound;
    }
    const result = buildUnfollowPlan({
      includeFollowers: true,
      allowAmbiguousSelections: review.filter.includeAmbiguous,
      selected,
      candidates: review.candidates,
      whitelistedIds: protection.ids,
      whitelistedUsernames: protection.usernames,
      mode,
      typedConfirmation,
      minimumConfidence: review.filter.minimumConfidence,
      targetCategory: review.filter.targetCategory,
      now: () => Date.now(),
    });
    if (!result.ok) {
      notify(t(langRef.current, 'planBuildFailed', result.errors.join(' ')), 'error');
      return null;
    }
    return result.plan;
  }, [notify, state]);

  const beginExecution = useCallback((plan: ExecutingState['plan']) => {
    if (state.status === 'reviewing') {
      lastReviewRef.current = state;
    }
    abortExecutionRef.current = false;
    // A dry run with nothing to simulate is already finished; no executor
    // callback would ever fire, so mark it complete up front.
    if (plan.targets.length === 0) {
      setState(createExecutingState(plan, 100, 'complete'));
      return;
    }
    const estimatedRemainingMs =
      plan.mode === 'live'
        ? estimateExecutionRemainingMs(0, plan.targets.length, timingsRef.current)
        : undefined;
    setState(createExecutingState(plan, 0, undefined, estimatedRemainingMs));
  }, [state]);

  const handleDryRun = useCallback(() => {
    const plan = buildPlanForSelection('dry-run');
    if (plan !== null) {
      beginExecution(plan);
    }
  }, [beginExecution, buildPlanForSelection]);

  const handleLiveRun = useCallback((typedConfirmation: string, targetIds: readonly string[]) => {
    const reviewingDemo = state.status === 'reviewing' && state.demo;
    if (demoModeRef.current || reviewingDemo) {
      // Localhost/demo runs are offline by contract; live unfollowing is not
      // available there even if a session cookie happens to exist.
      notify(t(langRef.current, 'liveRunBlocked'), 'error');
      return;
    }
    const plan = buildPlanForSelection('live', typedConfirmation, targetIds);
    if (plan !== null && plan.mode === 'live') {
      clearAccountListCache();
      beginExecution(plan);
    }
  }, [beginExecution, buildPlanForSelection, notify, state]);

  const handleReviewBack = useCallback(() => {
    const current = state.status === 'reviewing' ? state : null;
    if (current !== null && current.selectedIds.length > 0) {
      // eslint-disable-next-line no-alert
      if (!confirm(t(langRef.current, 'goBackConfirm'))) {
        return;
      }
    }
    setState({ status: 'initial' });
  }, [state]);

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (state.status !== 'executing') {
      return undefined;
    }
    if (state.stopReason !== undefined) {
      return undefined;
    }
    let cancelled = false;
    const plan = state.plan;
    const currentTimings = timingsRef.current;
    const language = langRef.current;

    executeUnfollowPlan(plan, {
      unfollow: async (user, csrftoken) => {
        // Pre-write safety preflight: even a fresh scan can go stale. Fail
        // closed when we cannot confirm the account is still followed.
        const stillFollowing = await isStillFollowing(user);
        if (stillFollowing !== true) {
          return {
            outcome: 'failed',
            detail:
              stillFollowing === false
                ? 'Account is no longer in your following list; skipped.'
                : 'Could not verify the account is still followed; skipped for safety.',
          };
        }
        return unfollowUser(user, csrftoken);
      },
      removeFollower: async (user, csrftoken) => {
        const stillFollower = await isStillFollower(user);
        if (stillFollower !== true) {
          return {
            outcome: 'failed',
            detail:
              stillFollower === false
                ? 'Account is no longer in your followers list; skipped.'
                : 'Could not verify the account is still a follower; skipped for safety.',
          };
        }
        return removeFollower(user, csrftoken);
      },
      getCsrfToken: () => getCookie('csrftoken'),
      sleep: ms => sleep(ms),
      onCooldown: ({ delayMs, estimatedRemainingMs }) => {
        setState(previous => (
          previous.status === 'executing'
            ? {
                ...previous,
                cooldownEndsAt: Date.now() + delayMs,
                cooldownTotalMs: delayMs,
                estimatedRemainingMs,
              }
            : previous
        ));
      },
      timings: {
        timeBetweenUnfollows: currentTimings.timeBetweenUnfollows,
        timeToWaitAfterFiveUnfollows: currentTimings.timeToWaitAfterFiveUnfollows,
      },
      random: () => Math.random(),
      shouldAbort: () => abortExecutionRef.current,
      // Read the protected list fresh for every attempt: a whitelist change made
      // from Settings while the queue runs must stop the queue before that
      // account is touched.
      isProtected: user => isProtectedByWhitelist(user, loadWhitelist()),
      onProgress: progress => {
        setState(previous => {
          if (previous.status !== 'executing') {
            return previous;
          }
          return {
            ...previous,
            percentage: progress.percentage,
            estimatedRemainingMs: progress.estimatedRemainingMs ?? previous.estimatedRemainingMs,
          };
        });
      },
      onEntry: entry => {
        setState(previous => (
          previous.status === 'executing' ? { ...previous, entries: [...previous.entries, entry] } : previous
        ));
        if (plan.mode === 'live' && (entry.status === 'unfollowed' || entry.status === 'removed-follower')) {
          // Persist the removal as soon as Instagram confirms it, so a closed
          // tab or interrupted run cannot resurrect this account from cache.
          const review = lastReviewRef.current;
          if (review !== null) {
            const updated = reviewAfterLiveRun(review, new Set([entry.user.id]));
            lastReviewRef.current = updated;
            persistReviewCache(updated);
          }
        }
      },
    })
      .then(result => {
        if (cancelled) {
          return;
        }
        setState(previous => (
          previous.status === 'executing'
            ? {
                ...previous,
                percentage: 100,
                entries: result.entries,
                stopReason: result.stopReason,
                cooldownEndsAt: undefined,
                cooldownTotalMs: undefined,
                estimatedRemainingMs: 0,
              }
            : previous
        ));
        if (result.mode === 'live') {
          const unfollowedIds = new Set<string>();
          for (const entry of result.entries) {
            if (entry.status === 'unfollowed' || entry.status === 'removed-follower') {
              unfollowedIds.add(entry.user.id);
            }
          }
          const review = lastReviewRef.current;
          if (review !== null) {
            const updated = reviewAfterLiveRun(review, unfollowedIds);
            lastReviewRef.current = updated;
            persistReviewCache(updated);
          }
          if (result.stopReason === 'action-blocked') {
            notify(t(language, 'actionBlockedWarning'), 'error');
          } else if (result.stopReason === 'missing-session') {
            notify(t(language, 'scanFailedFollowing'), 'error');
          }
        }
      })
      .catch(error => {
        if (cancelled) {
          return;
        }
        console.error('Execution failed unexpectedly:', error);
        notify(t(language, 'planBuildFailed', errorMessage(error)), 'error');
        setState(previous => (
          previous.status === 'executing' ? { ...previous, stopReason: 'aborted' } : previous
        ));
      });

    return () => {
      cancelled = true;
    };
    // Deliberately only re-runs when entering the executing state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  const stopExecution = useCallback(() => {
    abortExecutionRef.current = true;
    notify(t(langRef.current, 'execStopHint'), 'warning');
  }, [notify]);

  const handleExecutionBack = useCallback(() => {
    abortExecutionRef.current = true;
    const review = lastReviewRef.current;
    if (review !== null) {
      setState(review);
    } else {
      setState({ status: 'initial' });
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const handleSaveTimings = useCallback((nextTimings: Timings) => {
    setTimings(nextTimings);
    saveTimings(nextTimings);
  }, []);

  const handleSaveDeepSeekConfig = useCallback((config: DeepSeekConfig) => {
    saveDeepSeekConfig(config);
    setDeepSeekConfig(config);
  }, []);

  const handleTestConnection = useCallback(
    (config: DeepSeekConfig) => testDeepSeekConnection(config),
    [],
  );

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------
  const visibleUsers = useMemo(() => {
    if (state.status !== 'reviewing') {
      return [];
    }
    return getCandidatesForDisplay(
      state.candidates,
      state.whitelistedResults,
      state.currentTab,
      state.searchTerm,
      state.filter,
    ).map(candidate => candidate.user);
  }, [state]);

  const handleCopy = useCallback(() => {
    copyListToClipboard(visibleUsers, t(langRef.current, 'copiedToClipboard')).catch(() => {
      notify(t(langRef.current, 'copyFailed'), 'error');
    });
  }, [notify, visibleUsers]);

  const handleExportJson = useCallback(() => {
    exportToJSON(visibleUsers);
  }, [visibleUsers]);

  const handleExportCsv = useCallback(() => {
    exportToCSV(visibleUsers);
  }, [visibleUsers]);

  // ---------------------------------------------------------------------------
  // Unload guard for long-running destructive work
  // ---------------------------------------------------------------------------
  const isActiveProcess =
    state.status === 'scanning' ||
    (state.status === 'executing' && state.stopReason === undefined && state.plan.mode === 'live');

  useEffect(() => {
    if (!isActiveProcess) {
      return undefined;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      event.returnValue = 'Changes you made may not be saved.';
      return 'Changes you made may not be saved.';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isActiveProcess]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const whitelistedUsersForSettings =
    state.status === 'reviewing' ? state.whitelistedResults : loadWhitelist();
  // Classifier status shown on the launch screen: primary provider first, with
  // the fallback / transport in the detail line.
  const providerMode =
    deepSeekConfig.mode === 'demo' ? 'demo' : deepSeekConfig.provider;
  let providerDetail: string;
  if (providerMode === 'typesafe') {
    const fallback = deepSeekConfig.fallbackToDeepSeek ? ' · DeepSeek fallback' : '';
    const keyState = deepSeekConfig.typesafeApiKey.trim() === '' ? ' · key not set' : '';
    providerDetail = `${deepSeekConfig.typesafeModel}${fallback}${keyState}`;
  } else if (providerMode === 'deepseek') {
    const transport =
      deepSeekConfig.mode === 'proxy' ? deepSeekConfig.proxyBaseUrl : `${deepSeekConfig.directBaseUrl} · ${deepSeekConfig.model}`;
    const keyState =
      deepSeekConfig.mode === 'direct' && deepSeekConfig.apiKey.trim() === '' ? ' · key not set' : '';
    providerDetail = `${transport}${keyState}`;
  } else {
    providerDetail = 'Offline demo classifier';
  }

  const classifierLabel =
    providerMode === 'typesafe'
      ? t(lang, 'providerTypeSafe')
      : providerMode === 'deepseek'
        ? t(lang, 'providerDeepSeekOption')
        : t(lang, 'providerDemo');
  const classifierReady =
    classifierLabel !== '' &&
    (deepSeekConfig.mode === 'demo'
      ? true
      : deepSeekConfig.provider === 'typesafe'
        ? isTypeSafeConfigured(deepSeekConfig) ||
          (deepSeekConfig.fallbackToDeepSeek && isDeepSeekConfigured(deepSeekConfig))
        : deepSeekConfig.provider === 'deepseek'
          ? isDeepSeekConfigured(deepSeekConfig)
          : false);

  // Wizard step 3 -> step 2 transition: a completed dry run can hand back to
  // the review with the typed live-approval dialog pre-opened.
  const handleExecutionRequestLive = useCallback(() => {
    if (state.status !== 'executing' || state.plan.mode !== 'dry-run') {
      return;
    }
    const review = lastReviewRef.current;
    if (review === null) {
      return;
    }
    setState(review);
    setPendingLiveApproval(true);
  }, [state]);

  const lastReviewForExecution = lastReviewRef.current;
  let executionLiveDisabledReason: string | undefined;
  if (lastReviewForExecution === null || !lastReviewForExecution.scanComplete) {
    executionLiveDisabledReason = t(lang, 'liveRunLockedIncomplete');
  } else if (lastReviewForExecution.fromCache) {
    executionLiveDisabledReason = t(lang, 'liveRunLockedCached');
  } else if (demoModeRef.current) {
    executionLiveDisabledReason = t(lang, 'liveRunBlocked');
  }

  const classifierAttribution: ClassifierAttribution = {
    primary: providerMode === 'demo' ? 'demo' : deepSeekConfig.provider === 'deepseek' ? 'deepseek' : 'typesafe',
    fallback:
      deepSeekConfig.provider === 'typesafe' &&
      deepSeekConfig.fallbackToDeepSeek &&
      isDeepSeekConfigured(deepSeekConfig)
        ? 'deepseek'
        : null,
    visionModel: deepSeekConfig.visionModel,
    photoEnabled: deepSeekConfig.includeProfilePhotos && isDeepSeekConfigured(deepSeekConfig),
  };

  let markup: React.JSX.Element;
  switch (state.status) {
    case 'initial':
      markup = (
        <NukeWizard
          lang={lang}
          onNuke={startScan}
          onOpenAdvanced={() => setSettingsOpen(true)}
          classifierLabel={classifierLabel}
          classifierDetail={providerDetail}
          classifierReady={classifierReady}
          relayStatus={relayRequired ? relayCheck.status : undefined}
          relayMessage={relayCheck.message}
          keySetupNeeded={keySetupNeeded}
          onSaveClassifierKeys={handleSaveWizardKeys}
          onRetryRelay={() => {
            void runRelayCheck();
          }}
          onLoadDemo={demoMode ? loadDemoReview : undefined}
          cachedScanCount={cachedReview !== null ? cachedReview.candidates.length : undefined}
          onLoadCached={cachedReview !== null ? loadCachedReview : undefined}
          scanDisabled={!demoMode && getCookie('ds_user_id') === null}
          scanDisabledReason={t(lang, 'scanFailedFollowing')}
        />
      );
      break;
    case 'scanning':
      markup = (
        <ScanningScreen
          lang={lang}
          phase={state.phase}
          percentage={state.percentage}
          followingFetched={state.followingFetched}
          followersFetched={state.followersFetched}
          classified={state.classified}
          toClassify={state.toClassify}
          notice={state.notice}
          onCancel={cancelScan}
        />
      );
      break;
    case 'reviewing':
      markup = (
        <ReviewScreen
          lang={lang}
          candidates={state.candidates}
          whitelistedResults={state.whitelistedResults}
          selectedIds={state.selectedIds}
          currentTab={state.currentTab}
          searchTerm={state.searchTerm}
          filter={state.filter}
          scanComplete={state.scanComplete}
          followingComplete={state.followingComplete}
          followersComplete={state.followersComplete}
          classificationFailures={state.classificationFailures}
          classifierError={state.classifierError}
          totalFetched={state.totalFetched}
          classifierVersion={state.classifierVersion}
          demo={state.demo}
          fromCache={state.fromCache}
          onTabChange={handleTabChange}
          onSearchChange={handleSearchChange}
          onFilterChange={handleFilterChange}
          onSelectionChange={handleSelectionChange}
          onToggleWhitelist={handleToggleWhitelist}
          requestLiveApproval={pendingLiveApproval}
          onLiveApprovalRequestHandled={() => setPendingLiveApproval(false)}
          onDryRun={handleDryRun}
          onLiveRun={handleLiveRun}
          onBack={handleReviewBack}
          onLanguageChange={handleLanguageChange}
          onOpenSettings={() => setSettingsOpen(true)}
          onCopy={handleCopy}
          onExportJson={handleExportJson}
          onExportCsv={handleExportCsv}
          classifierAttribution={classifierAttribution}
          includeFollowers
        />
      );
      break;
    case 'executing':
      markup = (
        <ExecutingScreen
          lang={lang}
          plan={state.plan}
          percentage={state.percentage}
          entries={state.entries}
          estimatedRemainingMs={state.estimatedRemainingMs}
          cooldownEndsAt={state.cooldownEndsAt}
          stopReason={state.stopReason}
          searchTerm={state.searchTerm}
          showSucceeded={state.showSucceeded}
          showFailed={state.showFailed}
          onSearchChange={term => {
            setState(previous => (previous.status === 'executing' ? { ...previous, searchTerm: term } : previous));
          }}
          onShowSucceededChange={show => {
            setState(previous => (previous.status === 'executing' ? { ...previous, showSucceeded: show } : previous));
          }}
          onShowFailedChange={show => {
            setState(previous => (previous.status === 'executing' ? { ...previous, showFailed: show } : previous));
          }}
          onRequestLive={state.plan.mode === 'dry-run' ? handleExecutionRequestLive : undefined}
          requestLiveDisabledReason={executionLiveDisabledReason}
          onStop={stopExecution}
          onBack={handleExecutionBack}
          onLanguageChange={handleLanguageChange}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      );
      break;
    default:
      throw new Error('Unhandled app state');
  }

  return (
    <main id='main' role='main' className='iu'>
      {markup}
      {toast.show && (
        <Toast
          show={toast.show}
          message={toast.text}
          style={toast.style}
          onClose={closeToast}
          closeLabel={t(lang, 'close')}
        />
      )}
      {settingsOpen && (
        <SettingMenu
          lang={lang}
          onClose={() => setSettingsOpen(false)}
          onLanguageChange={handleLanguageChange}
          timings={timings}
          onSaveTimings={handleSaveTimings}
          deepSeekConfig={deepSeekConfig}
          onSaveDeepSeekConfig={handleSaveDeepSeekConfig}
          onTestConnection={handleTestConnection}
          whitelistedUsers={whitelistedUsersForSettings}
          onWhitelistUpdate={handleWhitelistFromSettings}
        />
      )}
    </main>
  );
};

export default App;
