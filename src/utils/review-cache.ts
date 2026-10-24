import { AuditCandidate, FollowRelationship } from '../model/audit';
import { GenderCategory, GENDER_CATEGORIES, GenderGuess, normalizeGender } from '../model/gender';
import { UserNode } from '../model/user';
import {
  REVIEW_CACHE_MAX_AGE_MS,
  REVIEW_CACHE_MAX_FUTURE_SKEW_MS,
  REVIEW_CACHE_STORAGE_KEY,
  REVIEW_CACHE_VERSION,
} from '../constants/constants';

/**
 * Local cache of a completed review, so reopening the tool does not re-scan
 * Instagram or re-bill DeepSeek classification. Everything loaded from
 * localStorage is untrusted and validated field by field before use.
 */
export interface ReviewCacheRecord {
  readonly version: number;
  /**
   * True when this review holds the synthetic demo dataset. Demo reviews are
   * never persisted and are rejected by {@link loadReviewCache}, so fake
   * accounts can never be mistaken for a real scan.
   */
  readonly demo: boolean;
  /**
   * Instagram id of the logged-in viewer whose lists produced this review.
   * Loading refuses caches that belong to a different (or unknown) session.
   */
  readonly viewerId: string;
  readonly candidates: readonly AuditCandidate[];
  readonly whitelistedResults: readonly UserNode[];
  readonly classifierVersion: string;
  readonly scanComplete: boolean;
  readonly followingComplete: boolean;
  readonly followersComplete: boolean;
  readonly classificationFailures: number;
  readonly totalFetched: number;
  readonly scanTimestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

function readNonNegativeNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null;
}

function isFollowRelationship(value: unknown): value is FollowRelationship {
  return value === 'following' || value === 'follower' || value === 'mutual';
}

function parseUserNode(value: unknown): UserNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value, 'id');
  const username = readString(value, 'username');
  if (id === null || id === '' || username === null || username === '') {
    return null;
  }
  return {
    id,
    username,
    full_name: readString(value, 'full_name') ?? '',
    profile_pic_url: readString(value, 'profile_pic_url') ?? '',
    is_private: readBoolean(value, 'is_private') ?? false,
    is_verified: readBoolean(value, 'is_verified') ?? false,
    followed_by_viewer: readBoolean(value, 'followed_by_viewer') ?? true,
    follows_viewer: readBoolean(value, 'follows_viewer') ?? false,
    requested_by_viewer: readBoolean(value, 'requested_by_viewer') ?? false,
  };
}

/**
 * Parse an untrusted cached category. The five current categories pass
 * through; the legacy `woman`/`man`/`unknown` guesses from an older app
 * version are mapped onto `female`/`male`/`ambiguous` before display.
 */
function parseCachedGender(value: unknown): GenderCategory | null {
  if (value === 'woman' || value === 'man' || value === 'unknown') {
    return normalizeGender(value);
  }
  for (const category of GENDER_CATEGORIES) {
    if (value === category) {
      return category;
    }
  }
  return null;
}

function parseGenderGuess(value: unknown): GenderGuess | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const rawGender = value.gender;
  const gender = parseCachedGender(rawGender);
  if (gender === null) {
    return undefined;
  }
  const confidence = typeof value.confidence === 'number' ? value.confidence : Number(value.confidence);
  if (!isFinite(confidence)) {
    return undefined;
  }
  const source = value.source;
  if (source !== 'typesafe' && source !== 'deepseek' && source !== 'demo') {
    return undefined;
  }
  return {
    gender,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: readString(value, 'reason') ?? undefined,
    source,
    model: readString(value, 'model') ?? '',
    classifiedAt: readNonNegativeNumber(value, 'classifiedAt') ?? 0,
  };
}

function parseCandidate(value: unknown): AuditCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  const user = parseUserNode(value.user);
  const relationship = value.relationship;
  if (user === null || !isFollowRelationship(relationship)) {
    return null;
  }
  const gender = parseGenderGuess(value.gender);
  if (gender === undefined) {
    return null;
  }
  return { user, relationship, gender };
}

export function parseReviewCacheRecord(value: unknown): ReviewCacheRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.version !== REVIEW_CACHE_VERSION) {
    return null;
  }
  const rawCandidates = value.candidates;
  const rawWhitelist = value.whitelistedResults;
  if (!Array.isArray(rawCandidates) || !Array.isArray(rawWhitelist)) {
    return null;
  }
  const candidates: AuditCandidate[] = [];
  for (const rawCandidate of rawCandidates) {
    const candidate = parseCandidate(rawCandidate);
    if (candidate === null) {
      return null;
    }
    candidates.push(candidate);
  }
  const whitelistedResults: UserNode[] = [];
  for (const rawUser of rawWhitelist) {
    const user = parseUserNode(rawUser);
    if (user === null) {
      return null;
    }
    whitelistedResults.push(user);
  }
  const demo = readBoolean(value, 'demo');
  const viewerId = readString(value, 'viewerId');
  const classifierVersion = readString(value, 'classifierVersion');
  const scanComplete = readBoolean(value, 'scanComplete');
  const followingComplete = readBoolean(value, 'followingComplete');
  const followersComplete = readBoolean(value, 'followersComplete');
  const classificationFailures = readNonNegativeNumber(value, 'classificationFailures');
  const totalFetched = readNonNegativeNumber(value, 'totalFetched');
  const scanTimestamp = readNonNegativeNumber(value, 'scanTimestamp');
  if (
    demo === null ||
    viewerId === null ||
    viewerId === '' ||
    classifierVersion === null ||
    scanComplete === null ||
    followingComplete === null ||
    followersComplete === null ||
    classificationFailures === null ||
    totalFetched === null ||
    scanTimestamp === null
  ) {
    return null;
  }
  return {
    version: REVIEW_CACHE_VERSION,
    demo,
    viewerId,
    candidates,
    whitelistedResults,
    classifierVersion,
    scanComplete,
    followingComplete,
    followersComplete,
    classificationFailures,
    totalFetched,
    scanTimestamp,
  };
}

export function saveReviewCache(record: ReviewCacheRecord): void {
  try {
    localStorage.setItem(REVIEW_CACHE_STORAGE_KEY, JSON.stringify({ ...record, version: REVIEW_CACHE_VERSION }));
  } catch (error) {
    console.warn('Could not cache review results:', error);
  }
}

/**
 * A cached review is only usable while it is recent enough to reasonably
 * reflect the live account state. Expired records are ignored rather than
 * silently trusted for a later (potentially live) run.
 */
export function isReviewCacheFresh(record: ReviewCacheRecord, now: number = Date.now()): boolean {
  if (!isFinite(now) || now < 0) {
    return false;
  }
  const age = now - record.scanTimestamp;
  return age >= -REVIEW_CACHE_MAX_FUTURE_SKEW_MS && age <= REVIEW_CACHE_MAX_AGE_MS;
}

/**
 * Load a cached review.
 *
 * `expectedViewerId` is the Instagram id of the account currently logged in;
 * caches from another account (or from no session) are never returned, even if
 * they are fresh. Demo records are rejected as well.
 */
export function loadReviewCache(now: number, expectedViewerId: string | null): ReviewCacheRecord | null {
  try {
    if (expectedViewerId === null || expectedViewerId === '') {
      return null;
    }
    const raw = localStorage.getItem(REVIEW_CACHE_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const record = parseReviewCacheRecord(JSON.parse(raw));
    if (record === null || record.demo || !isReviewCacheFresh(record, now)) {
      return null;
    }
    if (record.viewerId !== expectedViewerId) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export function clearReviewCache(): void {
  try {
    localStorage.removeItem(REVIEW_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
