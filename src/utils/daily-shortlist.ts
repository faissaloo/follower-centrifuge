import {
  DAILY_SHORTLIST_SIZE,
  DailyShortlistState,
  DEFAULT_FILTER_PROMPT,
  SHORTLIST_HISTORY_DAYS,
  MAX_MANUAL_SEEDS,
  SHORTLIST_PROMPT_STORAGE_KEY,
  SHORTLIST_REFRESH_MS,
  SHORTLIST_SEEDS_STORAGE_KEY,
  SHORTLIST_STATE_VERSION,
  SHORTLIST_STORAGE_KEY,
  ShortlistCandidate,
} from '../model/growth';

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCandidate(value: unknown): ShortlistCandidate | null {
  if (!isRecord(value)) {
return null;
}
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id) : '';
  if (username === '' || id === '') {
return null;
}
  return {
    id,
    username,
    fullName: typeof value.fullName === 'string' ? value.fullName : '',
    biography: typeof value.biography === 'string' ? value.biography.slice(0, 300) : '',
    profilePicUrl: typeof value.profilePicUrl === 'string' ? value.profilePicUrl : '',
    isPrivate: value.isPrivate === true,
    isVerified: value.isVerified === true,
    followerCount: typeof value.followerCount === 'number' && isFinite(value.followerCount) ? Math.max(0, value.followerCount) : 0,
    followingCount: typeof value.followingCount === 'number' && isFinite(value.followingCount) ? Math.max(0, value.followingCount) : 0,
    score: typeof value.score === 'number' && isFinite(value.score) ? Math.max(0, Math.min(1, value.score)) : 0,
    ...(typeof value.sourceUsername === 'string' && value.sourceUsername !== '' ? { sourceUsername: value.sourceUsername } : {}),
    ...(Array.isArray(value.discoveredVia)
      ? {
          discoveredVia: value.discoveredVia
            .filter((item): item is string => typeof item === 'string' && item !== '')
            .slice(0, 8)
            .map(item => item.slice(0, 80)),
        }
      : {}),
    ...(typeof value.sourceCount === 'number' && isFinite(value.sourceCount)
      ? { sourceCount: Math.max(1, Math.round(value.sourceCount)) }
      : {}),
    ...(typeof value.networkDistance === 'number' && isFinite(value.networkDistance)
      ? { networkDistance: Math.max(0, Math.min(1, value.networkDistance)) }
      : {}),
    ...(value.followState === 'requested' || value.followState === 'following'
      ? { followState: value.followState }
      : {}),
    ...(typeof value.photoCues === 'string' && value.photoCues !== ''
      ? { photoCues: value.photoCues.slice(0, 240) }
      : {}),
  };
}

function readSeen(value: unknown): Record<string, number> {
  const seen: Record<string, number> = {};
  if (!isRecord(value)) {
return seen;
}
  for (const [username, timestamp] of Object.entries(value)) {
    if (typeof timestamp === 'number' && isFinite(timestamp) && timestamp > 0) {
      seen[username.toLowerCase()] = timestamp;
    }
  }
  return seen;
}

export function parseShortlistState(value: unknown): DailyShortlistState | null {
  if (!isRecord(value) || value.version !== SHORTLIST_STATE_VERSION) {
return null;
}
  if (typeof value.refreshedAt !== 'number' || !isFinite(value.refreshedAt)) {
return null;
}
  if (typeof value.dueAt !== 'number' || !isFinite(value.dueAt)) {
return null;
}
  if (typeof value.filterPrompt !== 'string') {
return null;
}
  if (!Array.isArray(value.entries)) {
return null;
}
  const entries: ShortlistCandidate[] = [];
  for (const entry of value.entries.slice(0, DAILY_SHORTLIST_SIZE)) {
    const candidate = readCandidate(entry);
    if (candidate !== null) {
entries.push(candidate);
}
  }
  return {
    version: SHORTLIST_STATE_VERSION,
    refreshedAt: value.refreshedAt,
    dueAt: value.dueAt,
    filterPrompt: value.filterPrompt.slice(0, 500),
    entries,
    seen: readSeen(value.seen),
  };
}

export function loadShortlistState(storage: Storage | null = storageOrNull()): DailyShortlistState | null {
  if (storage === null) {
return null;
}
  try {
    const raw = storage.getItem(SHORTLIST_STORAGE_KEY);
    if (raw === null) {
return null;
}
    return parseShortlistState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveShortlistState(state: DailyShortlistState, storage: Storage | null = storageOrNull()): void {
  if (storage === null) {
return;
}
  try {
    storage.setItem(SHORTLIST_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage is best-effort; the in-memory state still works.
  }
}

export function nextDueAt(refreshedAt: number): number {
  return refreshedAt + SHORTLIST_REFRESH_MS;
}

export function isShortlistDue(state: DailyShortlistState | null, now: number): boolean {
  return state === null || now >= state.dueAt;
}

export function pruneSeen(seen: Readonly<Record<string, number>>, now: number): Record<string, number> {
  const cutoff = now - SHORTLIST_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const pruned: Record<string, number> = {};
  for (const [username, timestamp] of Object.entries(seen)) {
    if (timestamp >= cutoff) {
pruned[username] = timestamp;
}
  }
  return pruned;
}

export function recentlySeen(seen: Readonly<Record<string, number>>, username: string, now: number): boolean {
  const timestamp = seen[username.toLowerCase()];
  return timestamp >= now - SHORTLIST_HISTORY_DAYS * 24 * 60 * 60 * 1000;
}

export function loadFilterPrompt(storage: Storage | null = storageOrNull()): string {
  if (storage === null) {
return DEFAULT_FILTER_PROMPT;
}
  try {
    return storage.getItem(SHORTLIST_PROMPT_STORAGE_KEY) ?? DEFAULT_FILTER_PROMPT;
  } catch {
    return DEFAULT_FILTER_PROMPT;
  }
}

export function saveFilterPrompt(prompt: string, storage: Storage | null = storageOrNull()): void {
  if (storage === null) {
return;
}
  try {
    storage.setItem(SHORTLIST_PROMPT_STORAGE_KEY, prompt);
  } catch {
    // Ignore storage failures.
  }
}

/** Merge usernames into the 30-day de-duplication history. */
export function withSeenHistory(
  previous: Readonly<Record<string, number>>,
  entries: readonly ShortlistCandidate[],
  now: number,
): Record<string, number> {
  const pruned = pruneSeen(previous, now);
  for (const entry of entries) {
    pruned[entry.username.toLowerCase()] = now;
  }
  return pruned;
}

/** Normalize user-entered seed usernames (commas/whitespace/@ allowed). */
export function parseSeedAccounts(raw: string): string[] {
  const seeds: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const username = token.trim().replace(/^@/, '').toLowerCase();
    if (username !== '' && /^[a-z0-9._]{1,30}$/.test(username) && seeds.indexOf(username) === -1) {
      seeds.push(username);
    }
    if (seeds.length >= MAX_MANUAL_SEEDS) {
      break;
    }
  }
  return seeds;
}

export function loadSeedAccounts(storage: Storage | null = storageOrNull()): string[] {
  if (storage === null) {
return [];
}
  try {
    const raw = storage.getItem(SHORTLIST_SEEDS_STORAGE_KEY);
    if (raw === null) {
return [];
}
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
return [];
}
    return parseSeedAccounts(parsed.filter((item): item is string => typeof item === 'string').join(' '));
  } catch {
    return [];
  }
}

export function saveSeedAccounts(seeds: readonly string[], storage: Storage | null = storageOrNull()): void {
  if (storage === null) {
return;
}
  try {
    storage.setItem(SHORTLIST_SEEDS_STORAGE_KEY, JSON.stringify(seeds.slice(0, MAX_MANUAL_SEEDS)));
  } catch {
    // Ignore storage failures.
  }
}
