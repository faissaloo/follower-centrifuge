/**
 * Shared fixture builders for Lead-owned and integration tests.
 * Everything here is synthetic: no real accounts, no network.
 */
import { AuditCandidate, FollowRelationship } from '../../src/model/audit';
import { GenderCategory, GenderGuess, normalizeGender } from '../../src/model/gender';
import { Typename, UserNode } from '../../src/model/user';

export const FIXED_NOW = 1735689600000;

export interface UserNodeOptions {
  readonly id?: string;
  readonly username?: string;
  readonly fullName?: string;
  readonly profilePicUrl?: string;
  readonly isPrivate?: boolean;
  readonly isVerified?: boolean;
  readonly followedByViewer?: boolean;
  readonly followsViewer?: boolean;
}

export function createUserNode(options: UserNodeOptions = {}): UserNode {
  const id = options.id ?? 'user-1';
  const username = options.username ?? 'sample.user';
  const profilePicUrl = options.profilePicUrl ?? 'data:image/svg+xml;utf8,<svg/>';
  return {
    id,
    username,
    full_name: options.fullName ?? 'Sample User',
    profile_pic_url: profilePicUrl,
    is_private: options.isPrivate ?? false,
    is_verified: options.isVerified ?? false,
    followed_by_viewer: options.followedByViewer ?? true,
    follows_viewer: options.followsViewer ?? false,
    requested_by_viewer: false,
    reel: {
      id,
      expiring_at: 0,
      has_pride_media: false,
      latest_reel_media: 0,
      seen: null,
      owner: { __typename: Typename.GraphUser, id, profile_pic_url: profilePicUrl, username },
    },
  };
}

/**
 * Genders a fixture may be built from. The legacy `woman`/`man`/`unknown`
 * names are still accepted and normalized onto the five current categories so
 * older fixtures keep working; new fixtures should use GenderCategory values.
 */
export type FixtureGender = GenderCategory | 'woman' | 'man' | 'unknown';

export function createGenderGuess(
  gender: FixtureGender,
  confidence: number,
  source: 'typesafe' | 'deepseek' | 'demo' = 'deepseek',
): GenderGuess {
  const category = normalizeGender(gender);
  return {
    gender: category,
    confidence,
    reason: `fixture reason for ${category}`,
    source,
    model: source === 'demo' ? 'demo-names:v1' : 'deepseek-chat',
    classifiedAt: FIXED_NOW,
  };
}

export interface CandidateOptions extends UserNodeOptions {
  readonly relationship?: FollowRelationship;
  readonly gender?: FixtureGender;
  readonly confidence?: number;
  readonly genderGuess?: GenderGuess | null;
}

export function createCandidate(options: CandidateOptions = {}): AuditCandidate {
  const relationship = options.relationship ?? 'following';
  const user = createUserNode({
    ...options,
    followedByViewer: options.followedByViewer ?? relationship !== 'follower',
    followsViewer: options.followsViewer ?? relationship !== 'following',
  });
  const gender =
    options.genderGuess !== undefined
      ? options.genderGuess
      : options.gender !== undefined
        ? createGenderGuess(options.gender, options.confidence ?? 0.9)
        : null;
  return { user, relationship, gender };
}

export interface RawUserLike {
  readonly pk?: string | number;
  readonly pk_id?: string;
  readonly username?: string;
  readonly full_name?: string;
  readonly profile_pic_url?: string;
  readonly is_private?: boolean;
  readonly is_verified?: boolean;
  readonly id?: string;
}

export function createRawUser(overrides: RawUserLike = {}): RawUserLike {
  return {
    pk: 1001,
    pk_id: '1001',
    username: 'raw.user',
    full_name: 'Raw User',
    profile_pic_url: 'data:image/svg+xml;utf8,<svg/>',
    is_private: false,
    is_verified: false,
    ...overrides,
  };
}

/** Deterministic fake pagination helper for list-walker integration tests. */
export function pageOf<T>(items: readonly T[], nextMaxId?: string, hasMore?: boolean) {
  return {
    users: items,
    next_max_id: nextMaxId,
    has_more: hasMore === undefined ? nextMaxId !== undefined : hasMore,
  };
}
