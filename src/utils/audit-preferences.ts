/**
 * Persisted "nuke target" preference: which classifier category the wizard is
 * currently hunting for.
 *
 * This is a pure view preference, never scan data: it lives in its own
 * localStorage entry so switching categories cannot corrupt a cached review,
 * the whitelist or the classifier cache. Values are validated on both read and
 * write, and storage failures (private mode, quota) degrade to the in-memory
 * choice instead of throwing.
 */
import { GenderCategory, GENDER_CATEGORIES } from '../model/gender';

/** Separate namespace from the review/whitelist caches; safe to clear on its own. */
export const AUDIT_TARGET_CATEGORY_STORAGE_KEY = 'iu_audit-target-category';

/** Pre-category versions stored the target under this key. */
export const LEGACY_TARGET_GENDER_STORAGE_KEY = 'iu_audit-target-gender';

/** Defaults to women so an untouched install behaves like the old product. */
export const DEFAULT_TARGET_CATEGORY: GenderCategory = 'female';

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(GENDER_CATEGORIES);

/**
 * Narrow any untrusted stored value to a supported {@link GenderCategory}.
 * Legacy `woman`/`man`/`unknown` values written by older versions (and the
 * old target-gender key) are upgraded so existing preferences survive.
 */
export function normalizeTargetCategory(value: unknown): GenderCategory {
  switch (value) {
    case 'woman':
      return 'female';
    case 'man':
      return 'male';
    case 'unknown':
      return 'ambiguous';
    default:
      return typeof value === 'string' && CATEGORY_SET.has(value) ? (value as GenderCategory) : DEFAULT_TARGET_CATEGORY;
  }
}

function readStoredCategory(): GenderCategory {
  try {
    const current = localStorage.getItem(AUDIT_TARGET_CATEGORY_STORAGE_KEY);
    if (current !== null) {
      return normalizeTargetCategory(current);
    }
    const legacy = localStorage.getItem(LEGACY_TARGET_GENDER_STORAGE_KEY);
    if (legacy !== null) {
      return normalizeTargetCategory(legacy);
    }
    return DEFAULT_TARGET_CATEGORY;
  } catch {
    // localStorage can be unavailable (privacy mode / disabled storage).
    return DEFAULT_TARGET_CATEGORY;
  }
}

/** Read the persisted nuke category, falling back to the default on any problem. */
export function loadTargetCategory(): GenderCategory {
  return readStoredCategory();
}

/** Persist the nuke category; storage failures must never break the UI. */
export function saveTargetCategory(category: GenderCategory): void {
  try {
    localStorage.setItem(AUDIT_TARGET_CATEGORY_STORAGE_KEY, normalizeTargetCategory(category));
  } catch {
    // Ignore storage failures; the in-memory choice still works for this session.
  }
}
