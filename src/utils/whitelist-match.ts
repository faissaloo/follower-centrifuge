import { UserNode } from '../model/user';

/**
 * Whitelist ("protected accounts") matching.
 *
 * Protection is deliberately matched on BOTH the Instagram account id and the
 * normalized username:
 *  - the bulk-paste flow in the whitelist manager creates protected entries
 *    without a real Instagram id (`pasted_<username>_<timestamp>`), so an
 *    id-only check would silently fail to protect the real account;
 *  - imported whitelists may come from an older export where ids could be
 *    missing/renamed.
 *
 * A whitelist entry therefore protects every account with the same id OR the
 * same case-insensitive username. This helper is the single source of truth
 * used by the review display, the plan builder and the UI.
 */

export function normalizeProtectedUsername(username: string): string {
  return username.trim().replace(/^@+/, '').toLowerCase();
}

export interface WhitelistProtection {
  readonly ids: ReadonlySet<string>;
  readonly usernames: ReadonlySet<string>;
}

export function buildWhitelistProtection(whitelist: readonly UserNode[]): WhitelistProtection {
  const ids = new Set<string>();
  const usernames = new Set<string>();
  // localStorage is untrusted, so entries are validated even though the public
  // type promises UserNode objects.
  for (const rawEntry of whitelist as readonly unknown[]) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }
    const entry = rawEntry as { readonly id?: unknown; readonly username?: unknown };
    if (typeof entry.id === 'string' && entry.id !== '') {
      ids.add(entry.id);
    }
    const username = normalizeProtectedUsername(typeof entry.username === 'string' ? entry.username : '');
    if (username !== '') {
      usernames.add(username);
    }
  }
  return { ids, usernames };
}

/** True when the user is protected by id or by (normalized) username. */
export function isProtectedBy(
  user: { readonly id: string; readonly username: string },
  protection: WhitelistProtection,
): boolean {
  if (protection.ids.has(user.id)) {
    return true;
  }
  const username = normalizeProtectedUsername(user.username);
  return username !== '' && protection.usernames.has(username);
}

/** Convenience wrapper for call sites that hold the whitelist user list. */
export function isProtectedByWhitelist(
  user: { readonly id: string; readonly username: string },
  whitelist: readonly UserNode[],
): boolean {
  return isProtectedBy(user, buildWhitelistProtection(whitelist));
}

/**
 * Remove every protective entry that covers `user` (by id or username).
 * Used when the user unprotects an account whose protection came from a pasted
 * username entry with a synthetic id.
 */
export function withoutProtectionFor(user: UserNode, whitelist: readonly UserNode[]): readonly UserNode[] {
  const username = normalizeProtectedUsername(user.username);
  return whitelist.filter(entry => {
    if (entry.id === user.id) {
      return false;
    }
    return username === '' || normalizeProtectedUsername(entry.username) !== username;
  });
}
