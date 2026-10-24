import {
  AuditCandidate,
  AuditPhase,
  AuditProgress,
  AuditResult,
  AuditRunnerDeps,
  FetchListUser,
  FollowRelationship,
  FriendshipsListKind,
  relationshipOf,
} from '../model/audit';
import { GenderGuess, GenderInput, normalizeConfidence, normalizeGender } from '../model/gender';
import { UserNode } from '../model/user';

/**
 * Read-only orchestration of the women audit.
 *
 * The runner walks the viewer's following list and then their followers list
 * through the injected `fetchList`, merges the two lists into one account per
 * person (detecting mutuals), and finally asks the injected `GenderClassifier`
 * to estimate a gender from each account's public name. Nothing here touches
 * Instagram or DeepSeek directly, and nothing here unfollows anyone: the audit
 * only produces candidates for the review screen.
 *
 * Determinism matters because the result feeds a destructive-action review
 * screen: encounter order is preserved (following list first, then new
 * follower-only entries in followers order), the clock is injectable, and
 * progress percentages only ever move forward.
 */

/** Accounts sent to the classifier per request when the caller omits a batch size. */
export const DEFAULT_CLASSIFY_BATCH_SIZE = 25;

/**
 * Progress layout: fetching the following list fills 0-20%, fetching the
 * followers list 20-40%, classification 40-99%, and 100% means complete.
 */
const FETCH_PHASE_SPAN = 20;
const FETCH_FOLLOWING_START = 0;
const FETCH_FOLLOWERS_START = 20;
const CLASSIFY_START = 40;
const CLASSIFY_MAX = 99;
const COMPLETE_PERCENTAGE = 100;

const NOTICE_ABORTED = 'aborted';
const NOTICE_FOLLOWING_FAILED = 'Failed to load the following list; the scan stopped before classification.';
const NOTICE_FOLLOWERS_FAILED = 'Failed to load the followers list; the scan stopped before classification.';

type GuessOrNull = GenderGuess | null;

/** Raw classifier answers keyed by the submitted account id. */
type ClassifierAnswers = Map<string, Record<string, unknown>>;

type FetchOutcome = 'complete' | 'failed' | 'aborted';

/**
 * Thrown out of a page callback to unwind `fetchList` once the caller aborts
 * (a fetch loop has no generic cancellation token, so throwing from the
 * callback is the only way to stop pagination between pages).
 */
class AuditAbortedError extends Error {
  constructor() {
    super('Audit aborted');
    this.name = 'AuditAbortedError';
    // Required so `instanceof` keeps working: the bundle targets ES5 and
    // TypeScript downlevels `class extends Error` to a constructor function.
    Object.setPrototypeOf(this, AuditAbortedError.prototype);
  }
}

/** One account accumulated while walking the two lists. */
interface PendingAccount {
  /** Creation order; used to pick the earliest (canonical) record when merging. */
  readonly order: number;
  removed: boolean;
  /** Identity keys, namespaced by where the value came from (`id:...`). */
  idKeys: string[];
  /** Lowercased usernames seen for this account (identity aliases). */
  usernameKeys: string[];
  /** Display username from the first encounter that had one. */
  username: string;
  pkId: string | null;
  pk: string | null;
  rawId: string | null;
  fullName: string;
  profilePicUrl: string;
  isPrivate: boolean;
  isVerified: boolean;
  followsThem: boolean;
  followsYou: boolean;
}

interface AccountIndex {
  /** Encounter order; merged-away records stay but are flagged `removed`. */
  readonly accounts: PendingAccount[];
  readonly byKey: Map<string, PendingAccount>;
}

/** A fully merged account, before classification results are attached. */
interface CandidateSeed {
  readonly user: UserNode;
  readonly relationship: FollowRelationship;
}

/** Fallback wall clock. The app and tests inject `deps.now` instead. */
function defaultNow(): number {
  return Date.now();
}

/** Normalize one raw id-like field (pk / pk_id / id) to a canonical string. */
function normalizeIdValue(value: unknown): string | null {
  if (typeof value === 'number') {
    return isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null;
}

/** Append a namespaced identity key unless it was already collected. */
function appendIdKey(idKeys: string[], value: unknown): void {
  const normalized = normalizeIdValue(value);
  if (normalized === null) {
    return;
  }
  const key = `id:${normalized}`;
  if (idKeys.indexOf(key) === -1) {
    idKeys.push(key);
  }
}

/** Lowercase/trim a username for case-insensitive identity matching. */
function normalizeUsernameKey(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

/** Resolve the batch size, falling back to the safe default for bad input. */
function resolveClassifyBatchSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CLASSIFY_BATCH_SIZE;
  }
  if (!isFinite(value) || value < 1) {
    return DEFAULT_CLASSIFY_BATCH_SIZE;
  }
  return Math.floor(value);
}

/**
 * Convert one friendships entry into a pending account. Entries without any
 * identity signal cannot be deduplicated, classified or displayed, so they are
 * dropped defensively instead of becoming a bogus candidate.
 */
function createPendingAccount(
  entry: FetchListUser,
  kind: FriendshipsListKind,
  order: number,
): PendingAccount | null {
  const idKeys: string[] = [];
  appendIdKey(idKeys, entry.pk_id);
  appendIdKey(idKeys, entry.pk);
  appendIdKey(idKeys, entry.id);
  const usernameKey = normalizeUsernameKey(entry.username);
  if (idKeys.length === 0 && usernameKey === '') {
    return null;
  }
  const displayUsername = typeof entry.username === 'string' ? entry.username.trim() : '';
  return {
    order,
    removed: false,
    idKeys,
    usernameKeys: usernameKey === '' ? [] : [usernameKey],
    username: displayUsername,
    pkId: normalizeIdValue(entry.pk_id),
    pk: normalizeIdValue(entry.pk),
    rawId: normalizeIdValue(entry.id),
    fullName: typeof entry.full_name === 'string' ? entry.full_name : '',
    profilePicUrl: typeof entry.profile_pic_url === 'string' ? entry.profile_pic_url : '',
    isPrivate: entry.is_private === true,
    isVerified: entry.is_verified === true,
    followsThem: kind === 'following',
    followsYou: kind === 'followers',
  };
}

/** Merge two records that were proven to describe the same account. */
function mergePendingAccount(target: PendingAccount, source: PendingAccount): void {
  target.followsThem = target.followsThem || source.followsThem;
  target.followsYou = target.followsYou || source.followsYou;
  if (target.pkId === null) {
    target.pkId = source.pkId;
  }
  if (target.pk === null) {
    target.pk = source.pk;
  }
  if (target.rawId === null) {
    target.rawId = source.rawId;
  }
  if (target.username === '' && source.username !== '') {
    target.username = source.username;
  }
  if (target.fullName === '') {
    target.fullName = source.fullName;
  }
  if (target.profilePicUrl === '') {
    target.profilePicUrl = source.profilePicUrl;
  }
  target.isPrivate = target.isPrivate || source.isPrivate;
  target.isVerified = target.isVerified || source.isVerified;
  for (const key of source.idKeys) {
    if (target.idKeys.indexOf(key) === -1) {
      target.idKeys.push(key);
    }
  }
  for (const key of source.usernameKeys) {
    if (target.usernameKeys.indexOf(key) === -1) {
      target.usernameKeys.push(key);
    }
  }
}

/** All namespaced identity keys an account is currently known by. */
function pendingAccountKeys(account: PendingAccount): string[] {
  const keys = account.idKeys.slice();
  for (const usernameKey of account.usernameKeys) {
    keys.push(`username:${usernameKey}`);
  }
  return keys;
}

function createAccountIndex(): AccountIndex {
  return {
    accounts: [],
    byKey: new Map<string, PendingAccount>(),
  };
}

function registerAccountKeys(index: AccountIndex, account: PendingAccount): void {
  for (const key of pendingAccountKeys(account)) {
    index.byKey.set(key, account);
  }
}

/** Fold `absorbed` (and all of its identity keys) into `base`. */
function absorbAccount(index: AccountIndex, base: PendingAccount, absorbed: PendingAccount): void {
  mergePendingAccount(base, absorbed);
  registerAccountKeys(index, base);
  absorbed.removed = true;
}

/** Index one friendships entry, merging it into any account it matches. */
function addAccountToIndex(index: AccountIndex, entry: FetchListUser, kind: FriendshipsListKind): void {
  const pending = createPendingAccount(entry, kind, index.accounts.length);
  if (pending === null) {
    return;
  }
  // Matching is done through the key index so merging stays cheap even for
  // accounts with thousands of followings.
  const matches: PendingAccount[] = [];
  const seen = new Set<PendingAccount>();
  for (const key of pendingAccountKeys(pending)) {
    const existing = index.byKey.get(key);
    if (existing !== undefined && !existing.removed && !seen.has(existing)) {
      seen.add(existing);
      matches.push(existing);
    }
  }
  if (matches.length === 0) {
    index.accounts.push(pending);
    registerAccountKeys(index, pending);
    return;
  }
  // A single new entry can bridge two previously separate records (for
  // example a response that repeats both identity fields); merge them all into
  // the record encountered first so ordering stays stable.
  let base = matches[0];
  for (const match of matches) {
    if (match.order < base.order) {
      base = match;
    }
  }
  for (const match of matches) {
    if (match !== base) {
      absorbAccount(index, base, match);
    }
  }
  mergePendingAccount(base, pending);
  registerAccountKeys(index, base);
}

/** The id exposed on the built UserNode, following the contract priority. */
function resolveUserId(account: PendingAccount): string {
  if (account.pkId !== null) {
    return account.pkId;
  }
  if (account.pk !== null) {
    return account.pk;
  }
  if (account.rawId !== null) {
    return account.rawId;
  }
  if (account.username !== '') {
    return `username:${account.username}`;
  }
  // Unreachable: accounts without any identity signal are dropped earlier.
  return `account:${String(account.order)}`;
}

/**
 * Build the `UserNode` the rest of the app consumes. Relationship flags are
 * derived from the merged relationship, not from the source list, so mutuals
 * are represented consistently.
 */
function createUserNode(account: PendingAccount, relationship: FollowRelationship): UserNode {
  return {
    id: resolveUserId(account),
    username: account.username,
    full_name: account.fullName,
    profile_pic_url: account.profilePicUrl,
    is_private: account.isPrivate,
    is_verified: account.isVerified,
    followed_by_viewer: relationship !== 'follower',
    follows_viewer: relationship !== 'following',
    requested_by_viewer: false,
  };
}

/** Turn the merged index into deterministically ordered candidate seeds. */
function collectCandidateSeeds(index: AccountIndex): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];
  for (const account of index.accounts) {
    if (account.removed) {
      continue;
    }
    const relationship = relationshipOf(account.followsThem, account.followsYou);
    seeds.push({
      user: createUserNode(account, relationship),
      relationship,
    });
  }
  return seeds;
}

/**
 * Pseudo-percentage while walking a list: the total page count is unknown
 * until pagination ends, so this approaches the end of the band asymptotically
 * without ever leaving it (0..19 for the following list, 20..39 for followers).
 */
function pageFetchPercentage(phaseStart: number, pageCount: number): number {
  return phaseStart + Math.floor((FETCH_PHASE_SPAN * pageCount) / (pageCount + 1));
}

/**
 * Index classifier answers by account id. Only structurally sensible answers
 * are kept; duplicate ids keep the first answer, which makes the result
 * independent of classifier output order.
 */
function indexClassifierAnswers(raw: unknown): ClassifierAnswers {
  const byId: ClassifierAnswers = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(raw)) {
    return byId;
  }
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record: Record<string, unknown> = item;
    const id = record.id;
    if (typeof id !== 'string' || id === '' || byId.has(id)) {
      continue;
    }
    byId.set(id, record);
  }
  return byId;
}

/** Human readable explanation for accounts the classifier left unanswered. */
function batchFailureNotice(batchThrew: boolean, failureCount: number): string | undefined {
  if (failureCount === 0) {
    return undefined;
  }
  if (batchThrew) {
    return `Classifier request failed; ${failureCount} account(s) left unclassified.`;
  }
  return `Classifier did not answer for ${failureCount} account(s); left unclassified.`;
}

/**
 * Run the read-only women audit.
 *
 * Resolves with every account discovered across both lists (unclassified
 * candidates have `gender: null`) and completion flags the UI can use to block
 * any live unfollow after an abort or a failed list fetch.
 */
export async function runAccountAudit(deps: AuditRunnerDeps): Promise<AuditResult> {
  const classifyBatchSize = resolveClassifyBatchSize(deps.classifyBatchSize);
  const now: () => number = deps.now !== undefined ? deps.now : defaultNow;

  const index = createAccountIndex();
  const guessById = new Map<string, GuessOrNull>();
  const queue: CandidateSeed[] = [];
  const scheduledIds = new Set<string>();
  const emittedRelationship = new Map<string, FollowRelationship>();

  let followingFetched = 0;
  let followersFetched = 0;
  let classified = 0;
  let classificationFailures = 0;
  const failedSeeds: CandidateSeed[] = [];
  const failedIds = new Set<string>();
  let classificationError: string | undefined;
  let followingComplete = false;
  let followersComplete = false;
  let lastPercentage = 0;
  let fetchPoints = 0;
  let aborted = false;

  let classificationStarted = false;
  let classificationStopped = false;
  let listsFinished = false;
  let pageDelivered = false;
  const workerWakes = new Set<() => void>();

  /**
   * Combined progress: loading contributes up to 40% (20% per list) and the
   * streaming classifier adds up to 59% based on the accounts known so far.
   * The emitted percentage is clamped monotonically because new pages can grow
   * the classification denominator while older batches are already done.
   */
  const classifyPoints = (): number =>
    scheduledIds.size === 0
      ? 0
      : Math.floor(((CLASSIFY_MAX - CLASSIFY_START) * classified) / scheduledIds.size);
  const overallPercentage = (): number => Math.min(CLASSIFY_MAX, fetchPoints + classifyPoints());
  const remainingToClassify = (): number =>
    Math.max(0, scheduledIds.size - classified - classificationFailures);

  /** Emit progress, clamping to 0..100 and never moving backwards. */
  const emitProgress = (phase: AuditPhase, percentage: number, notice?: string): void => {
    const clamped = Math.floor(Math.max(0, Math.min(COMPLETE_PERCENTAGE, percentage)));
    const monotonic = clamped < lastPercentage ? lastPercentage : clamped;
    lastPercentage = monotonic;
    const progress: AuditProgress = {
      phase,
      followingFetched,
      followersFetched,
      classified,
      toClassify: remainingToClassify(),
      percentage: monotonic,
    };
    if (notice === undefined) {
      deps.onProgress(progress);
      return;
    }
    deps.onProgress({ ...progress, notice });
  };

  const wakeWorker = (): void => {
    const wakes = Array.from(workerWakes);
    workerWakes.clear();
    for (const wake of wakes) {
      wake();
    }
  };

  const waitForWork = (): Promise<void> =>
    new Promise<void>(resolve => {
      workerWakes.add(resolve);
    });

  const stopClassification = (): void => {
    classificationStopped = true;
    listsFinished = true;
    wakeWorker();
  };

  /** Materialize the current merged account list with classification results. */
  const buildResult = (finished: boolean): AuditResult => {
    const candidates: AuditCandidate[] = [];
    for (const seed of collectCandidateSeeds(index)) {
      candidates.push({
        user: seed.user,
        relationship: seed.relationship,
        gender: guessById.get(seed.user.id) ?? null,
      });
    }
    return {
      candidates,
      followingComplete,
      followersComplete,
      classificationFailures,
      classificationError,
      finished,
    };
  };

  const emitAbort = (): AuditResult => {
    stopClassification();
    emitProgress('failed', lastPercentage, NOTICE_ABORTED);
    return buildResult(false);
  };

  const emitFailure = (notice: string): AuditResult => {
    stopClassification();
    emitProgress('failed', lastPercentage, notice);
    return buildResult(false);
  };

  /** Attach classifier provenance to one raw answer (per-entry provenance wins). */
  const createGuess = (answer: Record<string, unknown>): GenderGuess => {
    const reason = answer.reason;
    const rawSource = answer.source;
    const source =
      rawSource === 'typesafe' || rawSource === 'deepseek' || rawSource === 'demo'
        ? rawSource
        : deps.classifier.source;
    const rawModel = answer.model;
    const model =
      typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel.trim() : deps.classifier.model;
    return {
      gender: normalizeGender(answer.gender),
      confidence: normalizeConfidence(answer.confidence),
      reason: typeof reason === 'string' ? reason : undefined,
      source,
      model,
      classifiedAt: now(),
    };
  };

  /** Queue any freshly discovered index accounts that were not classified yet. */
  function enqueueNewSeeds(): void {
    for (const seed of collectCandidateSeeds(index)) {
      const id = seed.user.id;
      if (scheduledIds.has(id)) {
        continue;
      }
      scheduledIds.add(id);
      queue.push(seed);
      pageDelivered = true;
    }
    if (pageDelivered) {
      wakeWorker();
    }
  }

  async function classifyBatch(seeds: readonly CandidateSeed[]): Promise<void> {
    const inputs: GenderInput[] = seeds.map(seed => ({
      id: seed.user.id,
      username: seed.user.username,
      fullName: seed.user.full_name,
      profilePicUrl: seed.user.profile_pic_url,
    }));
    let answersById: ClassifierAnswers = new Map<string, Record<string, unknown>>();
    let batchThrew = false;
    try {
      const rawAnswers: unknown = await deps.classifier.classifyBatch(inputs);
      answersById = indexClassifierAnswers(rawAnswers);
    } catch (error) {
      batchThrew = true;
      if (classificationError === undefined) {
        classificationError = error instanceof Error ? error.message : String(error);
      }
    }
    if (classificationStopped || aborted) {
      return;
    }

    let batchFailureCount = 0;
    const batchCandidates: AuditCandidate[] = [];
    for (const seed of seeds) {
      const answer = batchThrew ? undefined : answersById.get(seed.user.id);
      const guess = answer === undefined ? null : createGuess(answer);
      if (guess === null) {
        batchFailureCount += 1;
        if (!failedIds.has(seed.user.id)) {
          failedIds.add(seed.user.id);
          failedSeeds.push(seed);
        }
      } else {
        guessById.set(seed.user.id, guess);
        classified += 1;
      }
      emittedRelationship.set(seed.user.id, seed.relationship);
      batchCandidates.push({
        user: seed.user,
        relationship: seed.relationship,
        gender: guess,
      });
    }
    classificationFailures += batchFailureCount;
    emitProgress('classifying', overallPercentage(), batchFailureNotice(batchThrew, batchFailureCount));
    deps.onCandidatesBatch(batchCandidates);
  }

  /**
   * Classify in the background while the lists are still loading. A page's
   * accounts are classified immediately (in slices of `classifyBatchSize`)
   * instead of waiting for the whole list, so the counters visibly move while
   * followers are fetched.
   */
  async function classifierWorker(): Promise<void> {
    while (!classificationStopped) {
      if (deps.shouldAbort()) {
        aborted = true;
        classificationStopped = true;
        wakeWorker();
        return;
      }
      if (queue.length === 0) {
        pageDelivered = false;
        if (listsFinished) {
          return;
        }
        await waitForWork();
        continue;
      }
      if (queue.length < classifyBatchSize && !pageDelivered && !listsFinished) {
        await waitForWork();
        continue;
      }
      if (!classificationStarted) {
        classificationStarted = true;
        emitProgress('classifying', overallPercentage());
      }
      // pageDelivered stays true while the page still has queued accounts, so
      // all workers can drain it in parallel instead of one taking the lot.
      const batch = queue.splice(0, classifyBatchSize);
      await classifyBatch(batch);
    }
  }

  /**
   * Walk one friendships list. Page callbacks are processed in order; an abort
   * observed inside a callback throws to stop pagination immediately.
   */
  const fetchKind = async (kind: FriendshipsListKind): Promise<FetchOutcome> => {
    let pagesSeen = 0;
    const phase: AuditPhase = kind === 'following' ? 'fetching-following' : 'fetching-followers';
    const phaseStart = kind === 'following' ? FETCH_FOLLOWING_START : FETCH_FOLLOWERS_START;
    const onPage = (users: readonly FetchListUser[]): void => {
      if (deps.shouldAbort()) {
        aborted = true;
        throw new AuditAbortedError();
      }
      pagesSeen += 1;
      if (kind === 'following') {
        followingFetched += users.length;
      } else {
        followersFetched += users.length;
      }
      for (const entry of users) {
        addAccountToIndex(index, entry, kind);
      }
      enqueueNewSeeds();
      fetchPoints = Math.max(fetchPoints, pageFetchPercentage(phaseStart, pagesSeen));
      emitProgress(phase, overallPercentage());
    };
    let completed = false;
    try {
      completed = await deps.fetchList(kind, onPage);
    } catch (error) {
      if (error instanceof AuditAbortedError || aborted || deps.shouldAbort()) {
        aborted = true;
        return 'aborted';
      }
      return 'failed';
    }
    if (aborted || deps.shouldAbort()) {
      aborted = true;
      return 'aborted';
    }
    return completed ? 'complete' : 'failed';
  };

  // Abort requested before any work: nothing to fetch, nothing to classify.
  if (deps.shouldAbort()) {
    return emitAbort();
  }

  emitProgress('fetching-following', FETCH_FOLLOWING_START);
  const workerCount = Math.max(1, Math.min(3, Math.floor(deps.parallelClassifierBatches ?? 1)));
  const workerPromises: Array<Promise<void>> = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    workerPromises.push(classifierWorker());
  }

  let outcome = await fetchKind('following');
  if (outcome === 'aborted') {
    return emitAbort();
  }
  if (outcome === 'failed') {
    // Never let a partial following list look complete: the review screen must
    // not offer live unfollows built on an incomplete picture.
    return emitFailure(NOTICE_FOLLOWING_FAILED);
  }
  followingComplete = true;
  emitProgress('fetching-followers', Math.max(fetchPoints, FETCH_FOLLOWERS_START));

  outcome = await fetchKind('followers');
  if (outcome === 'aborted') {
    return emitAbort();
  }
  if (outcome === 'failed') {
    return emitFailure(NOTICE_FOLLOWERS_FAILED);
  }
  followersComplete = true;
  listsFinished = true;
  // A merge can rename a synthetic account id; make sure anything still
  // unscheduled is picked up, then drain the remaining queue.
  enqueueNewSeeds();
  wakeWorker();
  await Promise.all(workerPromises);
  if (deps.shouldAbort()) {
    return emitAbort();
  }

  // One delayed retry of failed batches recovers from transient rate limits /
  // timeouts without making the whole scan fail permanently.
  if (deps.retryFailedBatches === true && failedSeeds.length > 0) {
    const delayMs = deps.classifierRetryDelayMs !== undefined ? Math.max(0, deps.classifierRetryDelayMs) : 1200;
    if (delayMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
    if (!deps.shouldAbort()) {
      for (let start = 0; start < failedSeeds.length; start += classifyBatchSize) {
        if (deps.shouldAbort()) {
          break;
        }
        const retryBatch = failedSeeds.slice(start, start + classifyBatchSize);
        let answersById: ClassifierAnswers = new Map<string, Record<string, unknown>>();
        let retryThrew = false;
        try {
          const rawAnswers: unknown = await deps.classifier.classifyBatch(
            retryBatch.map(seed => ({
              id: seed.user.id,
              username: seed.user.username,
              fullName: seed.user.full_name,
              profilePicUrl: seed.user.profile_pic_url,
            })),
          );
          answersById = indexClassifierAnswers(rawAnswers);
        } catch (error) {
          retryThrew = true;
          if (classificationError === undefined) {
            classificationError = error instanceof Error ? error.message : String(error);
          }
        }
        const recovered: AuditCandidate[] = [];
        for (const seed of retryBatch) {
          const answer = retryThrew ? undefined : answersById.get(seed.user.id);
          const guess = answer === undefined ? null : createGuess(answer);
          if (guess === null) {
            continue;
          }
          guessById.set(seed.user.id, guess);
          failedIds.delete(seed.user.id);
          classificationFailures = Math.max(0, classificationFailures - 1);
          classified += 1;
          recovered.push({ user: seed.user, relationship: seed.relationship, gender: guess });
        }
        if (recovered.length > 0) {
          emitProgress('classifying', overallPercentage());
          deps.onCandidatesBatch(recovered);
        }
      }
      const stillFailed = failedSeeds.filter(seed => failedIds.has(seed.user.id));
      failedSeeds.length = 0;
      failedSeeds.push(...stillFailed);
    }
  }

  // Classified batches were emitted with the relationship known at that time;
  // mutuals discovered later must be corrected before the review uses them.
  const seeds = collectCandidateSeeds(index);
  const relationshipUpdates: AuditCandidate[] = [];
  for (const seed of seeds) {
    const previous = emittedRelationship.get(seed.user.id);
    if (previous !== undefined && previous !== seed.relationship) {
      relationshipUpdates.push({
        user: seed.user,
        relationship: seed.relationship,
        gender: guessById.get(seed.user.id) ?? null,
      });
    }
  }
  if (relationshipUpdates.length > 0) {
    deps.onCandidatesBatch(relationshipUpdates);
  }

  emitProgress('complete', COMPLETE_PERCENTAGE);
  return buildResult(true);
}
