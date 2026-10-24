/**
 * Gender inference domain model.
 *
 * The app never *knows* somebody's gender or what kind of account it is. It
 * asks a language model to make a best-effort guess from public,
 * self-published signals only: the account's display name and username. Every
 * guess carries a confidence and is rendered to the user as an estimate
 * ("likely female" / "likely male" / "machine" / "organization" /
 * "ambiguous"), never as a fact.
 *
 * The classifier answers with five categories. Only `female` and `male` can be
 * selected as an audit target; `machine`, `organization` and `ambiguous` are
 * collected in the "other / uncertain" bucket and are never unfollow-eligible.
 */
/** How an account's public name most likely reads. */
export type GenderCategory = 'female' | 'male' | 'machine' | 'organization' | 'ambiguous';

/**
 * The person category the user chose to audit. Only `female` and `male` can be
 * targets: `machine`, `organization` and `ambiguous` are shown under
 * "other / uncertain" and can never be selected for unfollowing.
 */
export type TargetGender = 'female' | 'male';

/**
 * Historic name for the classifier category. Kept as an alias so older code
 * and cached data keep compiling; new code should prefer {@link GenderCategory}.
 */
export type LikelyGender = GenderCategory;

/** Every category a classifier may answer with (useful for validation/iteration). */
export const GENDER_CATEGORIES: readonly GenderCategory[] = [
  'female',
  'male',
  'machine',
  'organization',
  'ambiguous',
];

/**
 * A classifier result with provenance attached. `source` says how the guess
 * was produced (real API call vs. offline demo data) and `model` /
 * `classifiedAt` make cached results auditable.
 */
export interface GenderGuess {
  readonly gender: GenderCategory;
  readonly confidence: number;
  readonly reason?: string;
  readonly source: 'typesafe' | 'deepseek' | 'demo';
  readonly model: string;
  readonly classifiedAt: number;
}

/** One account submitted for classification. Only public data is included. */
export interface GenderInput {
  readonly id: string;
  readonly username: string;
  readonly fullName: string;
  /** Public profile photo URL, when available and photo classification is enabled. */
  readonly profilePicUrl?: string;
  /** Neutral visual cues generated from the profile photo (added by the photo pass). */
  readonly photoDescription?: string;
}

/**
 * A single row returned by a {@link GenderClassifier}. Ids must match the
 * ids that were submitted; a classifier is expected to answer for every
 * submitted account (using `ambiguous` when it cannot tell).
 */
export interface GenderBatchEntry {
  readonly id: string;
  readonly gender: GenderCategory;
  readonly confidence: number;
  readonly reason?: string;
  /**
   * Optional per-entry provenance. A fallback classifier can mix providers in
   * one batch (e.g. TypeSafe primary, DeepSeek fallback); when omitted the
   * surrounding classifier's `source`/`model` is used.
   */
  readonly source?: 'typesafe' | 'deepseek' | 'demo';
  readonly model?: string;
}

/**
 * Pluggable gender classifier. `version` identifies prompt + model + logic and
 * is used as part of the cache key, so changing the prompt or model
 * automatically invalidates previously cached guesses.
 */
export interface GenderClassifier {
  /** Identifies prompt + model + logic; used to invalidate cached guesses. */
  readonly version: string;
  /** How guesses from this classifier are produced. */
  readonly source: 'typesafe' | 'deepseek' | 'demo';
  /** Model / dataset label recorded on each guess. */
  readonly model: string;
  classifyBatch(users: readonly GenderInput[]): Promise<readonly GenderBatchEntry[]>;
}

/**
 * Default confidence threshold for treating a guess as a likely target.
 * The name is kept for compatibility with the original women-only product;
 * the threshold itself is gender-neutral.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/**
 * True when `guess` estimates the requested target (`female` or `male`) with
 * at least `minimumConfidence` confidence.
 *
 * `null` (not yet classified), `ambiguous` and the non-person categories
 * (`machine`, `organization`) are never likely targets - `machine`,
 * `organization` and `ambiguous` can never be unfollowed, no matter how
 * confident the classifier is. A confident guess for the opposite target is
 * not a target either.
 */
export function isLikelyGender(
  guess: GenderGuess | null | undefined,
  target: TargetGender,
  minimumConfidence: number = DEFAULT_CONFIDENCE_THRESHOLD,
): boolean {
  return guess !== null && guess !== undefined && guess.gender === target && guess.confidence >= minimumConfidence;
}

/**
 * True when `guess` confidently matches the requested category.
 *
 * Unlike {@link isLikelyGender} this also accepts the non-person categories
 * (`machine`, `organization`, `ambiguous`), because the wizard lets the user
 * explicitly choose which category to nuke (e.g. bots). `null` guesses never
 * match.
 */
export function isCategoryGuess(
  guess: GenderGuess | null | undefined,
  category: GenderCategory,
  minimumConfidence: number = DEFAULT_CONFIDENCE_THRESHOLD,
): boolean {
  return guess !== null && guess !== undefined && guess.gender === category && guess.confidence >= minimumConfidence;
}

/**
 * Clamp an untrusted confidence value into the 0..1 range.
 *
 * Deliberately strict: only finite numbers and plain decimal strings are
 * accepted. Booleans (Number(true) === 1), arrays, objects and localized
 * strings must not be able to clear the "likely target" confidence threshold.
 */
export function normalizeConfidence(value: unknown): number {
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(trimmed)) {
      return 0;
    }
    numeric = Number(trimmed);
  } else {
    return 0;
  }
  if (!isFinite(numeric)) {
    return 0;
  }
  if (numeric < 0) {
    return 0;
  }
  if (numeric > 1) {
    return 1;
  }
  return numeric;
}

/**
 * Narrow an untrusted value to a known {@link GenderCategory}.
 *
 * The five current categories pass through unchanged. The legacy classifier
 * categories (`woman`, `man`, `unknown`) are mapped onto the new ones so that
 * guesses from an older cache or an older classifier build stay readable
 * instead of being discarded: `woman` -> `female`, `man` -> `male`,
 * `unknown` -> `ambiguous`. Anything else becomes `ambiguous` (the safe
 * "cannot tell" category), never a target.
 */
export function normalizeGender(value: unknown): GenderCategory {
  switch (value) {
    case 'female':
    case 'woman':
      return 'female';
    case 'male':
    case 'man':
      return 'male';
    case 'machine':
      return 'machine';
    case 'organization':
      return 'organization';
    case 'ambiguous':
    case 'unknown':
      return 'ambiguous';
    default:
      return 'ambiguous';
  }
}
