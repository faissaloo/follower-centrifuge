import { describe, expect, it, vi } from 'vitest';

import {
  AuditCandidate,
  AuditPhase,
  AuditProgress,
  AuditResult,
  AuditRunnerDeps,
  FetchListFn,
  FetchListUser,
  FriendshipsListKind,
} from '../../src/model/audit';
import { GenderBatchEntry, GenderClassifier, GenderInput, LikelyGender } from '../../src/model/gender';
import { runAccountAudit } from '../../src/utils/account-audit';
import { NetworkDisabledError, networkGuard } from '../setup';

// ---------------------------------------------------------------------------
// Local, deliberately small fakes. Every test injects them; the global fetch
// guard stays armed so an accidental network call fails loudly.
// ---------------------------------------------------------------------------

type UsersPage = readonly FetchListUser[];
type ListScript = UsersPage[] | 'fail' | 'throw';
type GenderInputBatch = GenderInput[];
type CandidateBatch = readonly AuditCandidate[];

interface ScriptedLists {
  readonly following?: ListScript;
  readonly followers?: ListScript;
}

interface ScriptedFetch {
  readonly fetchList: FetchListFn;
  readonly fetchCalls: FriendshipsListKind[];
}

function createScriptedFetchList(lists: ScriptedLists): ScriptedFetch {
  const fetchCalls: FriendshipsListKind[] = [];
  const fetchList: FetchListFn = async (kind, onPage) => {
    fetchCalls.push(kind);
    const script = kind === 'following' ? lists.following ?? [] : lists.followers ?? [];
    if (script === 'fail') {
      return false;
    }
    if (script === 'throw') {
      throw new Error(`The ${kind} list exploded`);
    }
    for (const page of script) {
      await onPage(page);
    }
    return true;
  };
  return { fetchList, fetchCalls };
}

type AnswerFn = (users: readonly GenderInput[], callIndex: number) => readonly GenderBatchEntry[];

function answerAsWoman(users: readonly GenderInput[]): readonly GenderBatchEntry[] {
  return users.map((user): GenderBatchEntry => ({
    id: user.id,
    gender: 'female',
    confidence: 0.9,
    reason: 'test fixture',
  }));
}

interface FakeClassifier {
  readonly classifier: GenderClassifier;
  readonly calls: GenderInputBatch[];
}

function createFakeClassifier(answer: AnswerFn = answerAsWoman): FakeClassifier {
  const calls: GenderInputBatch[] = [];
  const classifier: GenderClassifier = {
    version: 'test-classifier-v1',
    source: 'demo',
    model: 'test-model',
    classifyBatch: async (users: readonly GenderInput[]): Promise<readonly GenderBatchEntry[]> => {
      calls.push(users.slice());
      return answer(users, calls.length - 1);
    },
  };
  return { classifier, calls };
}

function createClassifier(
  classifyBatch: (users: readonly GenderInput[]) => Promise<readonly GenderBatchEntry[]>,
  source: 'deepseek' | 'demo' = 'demo',
  model = 'test-model',
): GenderClassifier {
  return { version: 'test-classifier-v1', source, model, classifyBatch };
}

interface HarnessOptions extends ScriptedLists {
  readonly answer?: AnswerFn;
  readonly classifier?: GenderClassifier;
  readonly classifyBatchSize?: number;
  readonly now?: () => number;
}

interface RunHarness {
  readonly deps: AuditRunnerDeps;
  readonly progress: AuditProgress[];
  readonly batches: CandidateBatch[];
  readonly classifyCalls: GenderInputBatch[];
  readonly fetchCalls: FriendshipsListKind[];
}

function createHarness(options: HarnessOptions = {}): RunHarness {
  const progress: AuditProgress[] = [];
  const batches: CandidateBatch[] = [];
  const fetch = createScriptedFetchList(options);
  let classifier = options.classifier;
  let classifyCalls: GenderInputBatch[] = [];
  if (classifier === undefined) {
    const fake = createFakeClassifier(options.answer);
    classifier = fake.classifier;
    classifyCalls = fake.calls;
  }
  const deps: AuditRunnerDeps = {
    fetchList: fetch.fetchList,
    classifier,
    onProgress: (value: AuditProgress): void => {
      progress.push(value);
    },
    onCandidatesBatch: (batch: CandidateBatch): void => {
      batches.push(batch.slice());
    },
    shouldAbort: (): boolean => false,
    ...(options.classifyBatchSize === undefined ? {} : { classifyBatchSize: options.classifyBatchSize }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return { deps, progress, batches, classifyCalls, fetchCalls: fetch.fetchCalls };
}

interface DepsOverrides {
  readonly fetchList?: FetchListFn;
  readonly classifier?: GenderClassifier;
  readonly classifyBatchSize?: number;
  readonly now?: () => number;
  readonly shouldAbort?: () => boolean;
  readonly onProgress?: (progress: AuditProgress) => void;
  readonly onCandidatesBatch?: (batch: CandidateBatch) => void;
}

function createDeps(overrides: DepsOverrides = {}): AuditRunnerDeps {
  return {
    fetchList: overrides.fetchList ?? createScriptedFetchList({}).fetchList,
    classifier: overrides.classifier ?? createFakeClassifier().classifier,
    onProgress: overrides.onProgress ?? ((): void => undefined),
    onCandidatesBatch: overrides.onCandidatesBatch ?? ((): void => undefined),
    shouldAbort: overrides.shouldAbort ?? ((): boolean => false),
    ...(overrides.classifyBatchSize === undefined ? {} : { classifyBatchSize: overrides.classifyBatchSize }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };
}

interface RecordingOptions {
  readonly classifier?: GenderClassifier;
  readonly classifyBatchSize?: number;
  readonly now?: () => number;
  readonly shouldAbort?: () => boolean;
  readonly answer?: AnswerFn;
  readonly onCandidatesBatch?: (batch: CandidateBatch) => void;
}

interface RecordingRun {
  readonly deps: AuditRunnerDeps;
  readonly progress: AuditProgress[];
  readonly fake: FakeClassifier;
}

function createRecordingDeps(fetchList: FetchListFn, options: RecordingOptions = {}): RecordingRun {
  const progress: AuditProgress[] = [];
  const fake = createFakeClassifier(options.answer);
  const deps = createDeps({
    fetchList,
    classifier: options.classifier ?? fake.classifier,
    onProgress: (value: AuditProgress): void => {
      progress.push(value);
    },
    classifyBatchSize: options.classifyBatchSize,
    now: options.now,
    shouldAbort: options.shouldAbort,
    onCandidatesBatch: options.onCandidatesBatch,
  });
  return { deps, progress, fake };
}

function makeUsers(count: number): FetchListUser[] {
  const users: FetchListUser[] = [];
  for (let index = 0; index < count; index += 1) {
    users.push({ pk: index + 1, username: `user${index + 1}` });
  }
  return users;
}

function findCandidate(result: AuditResult, username: string): AuditCandidate | undefined {
  return result.candidates.find(candidate => candidate.user.username === username);
}

function lastProgress(progress: readonly AuditProgress[]): AuditProgress {
  return progress[progress.length - 1];
}

function phaseSequence(progress: readonly AuditProgress[]): AuditPhase[] {
  const phases: AuditPhase[] = [];
  for (const entry of progress) {
    if (phases.length === 0 || phases[phases.length - 1] !== entry.phase) {
      phases.push(entry.phase);
    }
  }
  return phases;
}

function expectMonotonicPercentages(progress: readonly AuditProgress[]): void {
  let previous = 0;
  for (const entry of progress) {
    expect(entry.percentage).toBeGreaterThanOrEqual(previous);
    previous = entry.percentage;
  }
}

function expectStreamingPercentages(progress: readonly AuditProgress[]): void {
  for (const entry of progress) {
    expect(entry.percentage).toBeGreaterThanOrEqual(0);
    expect(entry.percentage).toBeLessThanOrEqual(100);
    if (entry.phase === 'complete') {
      expect(entry.percentage).toBe(100);
    }
  }
}

// ---------------------------------------------------------------------------
// List fetching, ordering and deduplication
// ---------------------------------------------------------------------------

describe('classifier transport error reporting', () => {
  it('records the first classifier failure verbatim for the review banner', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alina' }]],
      classifier: createClassifier(async () => {
        throw new Error('Could not reach the local relay at ws://localhost:8787/ws. Start it with npm run proxy');
      }),
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.classificationFailures).toBe(1);
    expect(result.classificationError).toContain('local relay');
    expect(result.classificationError).toContain('npm run proxy');
  });
});

describe('runAccountAudit list fetching', () => {
  it('fetches the following list before the followers list', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }]],
      followers: [[{ pk: 2, username: 'bob' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(harness.fetchCalls).toEqual(['following', 'followers']);
    expect(result.finished).toBe(true);
    expect(result.followingComplete).toBe(true);
    expect(result.followersComplete).toBe(true);
    expect(result.candidates.map(candidate => candidate.relationship)).toEqual(['following', 'follower']);
  });

  it('keeps encounter order across the pages of one list', async () => {
    const harness = createHarness({
      following: [
        [{ pk: 1, username: 'alice' }],
        [
          { pk: 2, username: 'bob' },
          { pk: 3, username: 'carol' },
        ],
      ],
      followers: [],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates.map(candidate => candidate.user.username)).toEqual(['alice', 'bob', 'carol']);
  });

  it('appends follower-only accounts after following accounts in followers order', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }]],
      followers: [
        [
          { pk: 2, username: 'bob' },
          { pk: 3, username: 'carol' },
        ],
      ],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates.map(candidate => candidate.user.username)).toEqual(['alice', 'bob', 'carol']);
    expect(result.candidates.map(candidate => candidate.relationship)).toEqual(['following', 'follower', 'follower']);
    expect(findCandidate(result, 'bob')?.relationship).toBe('follower');
  });

  it('keeps a mutual account at its first (following list) position', async () => {
    const harness = createHarness({
      following: [
        [
          { pk: 1, username: 'alice' },
          { pk: 2, username: 'bob' },
        ],
      ],
      followers: [
        [
          { pk: 2, username: 'bob' },
          { pk: 1, username: 'alice' },
        ],
      ],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates.map(candidate => candidate.user.username)).toEqual(['alice', 'bob']);
    expect(result.candidates.map(candidate => candidate.relationship)).toEqual(['mutual', 'mutual']);
  });

  it('awaits the async page callback before requesting the next page', async () => {
    const delivered: string[] = [];
    const fetchList: FetchListFn = async (kind, onPage) => {
      if (kind !== 'following') {
        return true;
      }
      const pages: UsersPage[] = [
        [{ pk: 1, username: 'alice' }],
        [{ pk: 2, username: 'bob' }],
      ];
      for (const page of pages) {
        await Promise.resolve();
        await onPage(page);
        delivered.push('page');
      }
      return true;
    };
    const result = await runAccountAudit(createDeps({ fetchList }));
    expect(delivered).toEqual(['page', 'page']);
    expect(result.candidates.map(candidate => candidate.user.username)).toEqual(['alice', 'bob']);
  });

  it('streams fetch progress after every delivered page', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }], [{ pk: 2, username: 'bob' }]],
      followers: [[{ pk: 3, username: 'carol' }]],
    });
    await runAccountAudit(harness.deps);
    const followingProgress = harness.progress.filter(entry => entry.phase === 'fetching-following');
    expect(followingProgress.map(entry => entry.followingFetched)).toEqual([0, 1, 2]);
    const followerProgress = harness.progress.filter(entry => entry.phase === 'fetching-followers');
    expect(followerProgress.map(entry => entry.followersFetched)).toEqual([0, 1]);
  });
});

describe('runAccountAudit account merging', () => {
  it('counts a repeated entry in the following list only once', async () => {
    const harness = createHarness({
      following: [
        [{ pk: 1, username: 'alice' }],
        [{ pk: 1, username: 'alice' }],
      ],
      followers: [],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].relationship).toBe('following');
  });

  it('counts a repeated entry in the followers list only once', async () => {
    const harness = createHarness({
      following: [],
      followers: [
        [{ pk: 2, username: 'bob' }],
        [{ pk: '2', username: 'BOB' }],
      ],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].relationship).toBe('follower');
    expect(result.candidates[0].user.id).toBe('2');
  });

  it('merges numeric pk with string pk_id across lists into a mutual', async () => {
    const harness = createHarness({
      following: [[{ pk: 42, username: 'alice' }]],
      followers: [[{ pk_id: '42', username: 'alice' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].relationship).toBe('mutual');
    expect(result.candidates[0].user.id).toBe('42');
  });

  it('merges a pk with an id field across lists into a mutual', async () => {
    const harness = createHarness({
      following: [[{ pk: 9, username: 'alice' }]],
      followers: [[{ id: '9', username: 'alice' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].relationship).toBe('mutual');
  });

  it('merges username case variants without ids into a mutual', async () => {
    const harness = createHarness({
      following: [[{ username: 'Alice' }]],
      followers: [[{ username: 'alice' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].relationship).toBe('mutual');
    expect(result.candidates[0].user.username).toBe('Alice');
  });

  it('fills missing profile fields from the later merged entry', async () => {
    const harness = createHarness({
      following: [[{ pk: 3, username: 'carol' }]],
      followers: [
        [
          {
            pk_id: '3',
            full_name: 'Carol D',
            profile_pic_url: 'https://example.test/carol.jpg',
            is_private: true,
            is_verified: true,
          },
        ],
      ],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    const user = result.candidates[0].user;
    expect(user.full_name).toBe('Carol D');
    expect(user.profile_pic_url).toBe('https://example.test/carol.jpg');
    expect(user.is_private).toBe(true);
    expect(user.is_verified).toBe(true);
    expect(result.candidates[0].relationship).toBe('mutual');
  });

  it('does not merge two distinct accounts with different ids and usernames', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }]],
      followers: [[{ pk: 2, username: 'bob' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(2);
  });

  it('merges records bridged by a single entry carrying both identity fields', async () => {
    const harness = createHarness({
      following: [
        [
          { pk_id: '1', username: 'alice' },
          { pk: '2', username: 'bob' },
        ],
      ],
      followers: [[{ pk: 1, pk_id: '2' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].user.username).toBe('alice');
    expect(result.candidates[0].relationship).toBe('mutual');
  });

  it('merges aliases transitively through repeated usernames', async () => {
    const harness = createHarness({
      following: [[{ username: 'alice' }]],
      followers: [[{ pk: 1, username: 'alice' }, { username: 'ALICE' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].relationship).toBe('mutual');
  });
});

// ---------------------------------------------------------------------------
// UserNode construction
// ---------------------------------------------------------------------------

describe('runAccountAudit UserNode construction', () => {
  it('exposes pk_id as the id and maps every provided field', async () => {
    const harness = createHarness({
      following: [
        [
          {
            pk_id: '10',
            pk: 99,
            username: 'alice',
            full_name: 'Alice Adams',
            profile_pic_url: 'https://example.test/alice.jpg',
            is_private: true,
            is_verified: true,
          },
        ],
      ],
      followers: [],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user).toEqual({
      id: '10',
      username: 'alice',
      full_name: 'Alice Adams',
      profile_pic_url: 'https://example.test/alice.jpg',
      is_private: true,
      is_verified: true,
      followed_by_viewer: true,
      follows_viewer: false,
      requested_by_viewer: false,
    });
    expect(result.candidates[0].user.reel).toBeUndefined();
  });

  it('defaults every missing optional profile field', async () => {
    const harness = createHarness({ following: [[{ pk: 5 }]], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user).toEqual({
      id: '5',
      username: '',
      full_name: '',
      profile_pic_url: '',
      is_private: false,
      is_verified: false,
      followed_by_viewer: true,
      follows_viewer: false,
      requested_by_viewer: false,
    });
  });

  it('sets follower relationship flags for follower-only accounts', async () => {
    const harness = createHarness({ following: [], followers: [[{ pk: 6, username: 'bob' }]] });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user.followed_by_viewer).toBe(false);
    expect(result.candidates[0].user.follows_viewer).toBe(true);
  });

  it('sets both relationship flags for mutual accounts', async () => {
    const harness = createHarness({
      following: [[{ pk: 7, username: 'carol' }]],
      followers: [[{ pk_id: '7', username: 'carol' }]],
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user.followed_by_viewer).toBe(true);
    expect(result.candidates[0].user.follows_viewer).toBe(true);
  });

  it('falls back to pk when pk_id is absent', async () => {
    const harness = createHarness({ following: [[{ pk: 11, username: 'alice' }]], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user.id).toBe('11');
  });

  it('falls back to the id field when pk fields are absent', async () => {
    const harness = createHarness({ following: [[{ id: '12', username: 'alice' }]], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user.id).toBe('12');
  });

  it('falls back to a namespaced username id when no id exists', async () => {
    const harness = createHarness({ following: [[{ username: 'dave' }]], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user.id).toBe('username:dave');
  });

  it('trims usernames used for display and identity', async () => {
    const harness = createHarness({ following: [[{ username: '  dave  ' }]], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].user.username).toBe('dave');
    expect(result.candidates[0].user.id).toBe('username:dave');
    expect(harness.classifyCalls[0][0].username).toBe('dave');
  });

  it('drops entries that carry neither an id nor a username', async () => {
    const harness = createHarness({ following: [[{}, { pk: 1, username: 'alice' }]], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].user.username).toBe('alice');
    expect(result.finished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('runAccountAudit classification', () => {
  it('uses a default batch size of 25', async () => {
    const harness = createHarness({ following: [makeUsers(30)], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(harness.classifyCalls.map(batch => batch.length)).toEqual([25, 5]);
    expect(harness.batches.map(batch => batch.length)).toEqual([25, 5]);
    expect(result.candidates).toHaveLength(30);
  });

  it('honors a custom classifyBatchSize', async () => {
    const harness = createHarness({ following: [makeUsers(5)], followers: [], classifyBatchSize: 2 });
    await runAccountAudit(harness.deps);
    expect(harness.classifyCalls.map(batch => batch.length)).toEqual([2, 2, 1]);
    expect(harness.batches.map(batch => batch.length)).toEqual([2, 2, 1]);
  });

  const invalidBatchSizes = [0, -4, NaN];
  for (const invalidBatchSize of invalidBatchSizes) {
    it(`falls back to the default batch size for an invalid value (${String(invalidBatchSize)})`, async () => {
      const harness = createHarness({
        following: [makeUsers(30)],
        followers: [],
        classifyBatchSize: invalidBatchSize,
      });
      await runAccountAudit(harness.deps);
      expect(harness.classifyCalls.map(batch => batch.length)).toEqual([25, 5]);
    });
  }

  it('sends the documented GenderInput shape', async () => {
    const harness = createHarness({
      following: [[{ pk_id: '77', pk: 7, username: 'alice', full_name: 'Alice A' }]],
      followers: [],
    });
    await runAccountAudit(harness.deps);
    expect(harness.classifyCalls[0]).toEqual([{ id: '77', username: 'alice', fullName: 'Alice A', profilePicUrl: '' }]);
  });

  it('attaches a complete GenderGuess with classifier provenance', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }]],
      followers: [],
      now: (): number => 1234,
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].gender).toEqual({
      gender: 'female',
      confidence: 0.9,
      reason: 'test fixture',
      source: 'demo',
      model: 'test-model',
      classifiedAt: 1234,
    });
  });

  it('stamps every guess with the injected clock', async () => {
    const now = vi.fn((): number => 777);
    const harness = createHarness({ following: [makeUsers(3)], followers: [], now });
    const result = await runAccountAudit(harness.deps);
    expect(now).toHaveBeenCalledTimes(3);
    for (const candidate of result.candidates) {
      expect(candidate.gender?.classifiedAt).toBe(777);
    }
  });

  it('clamps untrusted confidence values into 0..1', async () => {
    const confidences = [7, -2, NaN];
    const answer: AnswerFn = users =>
      users.map((user, index): GenderBatchEntry => ({
        id: user.id,
        gender: 'female',
        confidence: confidences[index],
      }));
    const harness = createHarness({ following: [makeUsers(3)], followers: [], answer });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates.map(candidate => candidate.gender?.confidence)).toEqual([1, 0, 0]);
  });

  it('normalizes unrecognized genders to unknown', async () => {
    const answer: AnswerFn = users =>
      users.map((user): GenderBatchEntry => ({
        id: user.id,
        gender: 'robot' as unknown as LikelyGender,
        confidence: 0.9,
      }));
    const harness = createHarness({ following: [[{ pk: 1, username: 'alice' }]], followers: [], answer });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].gender?.gender).toBe('ambiguous');
  });

  it('leaves reason undefined when the classifier omits it', async () => {
    const answer: AnswerFn = users =>
      users.map((user): GenderBatchEntry => ({ id: user.id, gender: 'male', confidence: 0.8 }));
    const harness = createHarness({ following: [[{ pk: 1, username: 'alice' }]], followers: [], answer });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].gender?.reason).toBeUndefined();
    expect(result.candidates[0].gender?.gender).toBe('male');
  });

  it('counts omitted ids as failures and leaves them unclassified', async () => {
    const answer: AnswerFn = users =>
      users.slice(0, 2).map((user): GenderBatchEntry => ({
        id: user.id,
        gender: 'female',
        confidence: 0.9,
      }));
    const harness = createHarness({ following: [makeUsers(3)], followers: [], answer });
    const result = await runAccountAudit(harness.deps);
    expect(result.classificationFailures).toBe(1);
    expect(result.candidates[2].gender).toBeNull();
    expect(result.finished).toBe(true);
    expect(harness.batches).toHaveLength(1);
    expect(harness.batches[0][2].gender).toBeNull();
    const notices = harness.progress.filter(entry => entry.phase === 'classifying' && entry.notice !== undefined);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[notices.length - 1].notice).toContain('unclassified');
  });

  it('ignores answers for ids that were never submitted', async () => {
    const answer: AnswerFn = users => [
      ...answerAsWoman(users),
      { id: 'ghost-account', gender: 'female', confidence: 0.5 },
    ];
    const harness = createHarness({ following: [makeUsers(2)], followers: [], answer });
    const result = await runAccountAudit(harness.deps);
    expect(result.classificationFailures).toBe(0);
    expect(result.candidates.every(candidate => candidate.gender !== null)).toBe(true);
  });

  it('keeps the first answer when the classifier repeats an id', async () => {
    const answer: AnswerFn = users => [
      { id: users[0].id, gender: 'female', confidence: 0.1 },
      { id: users[0].id, gender: 'male', confidence: 0.9 },
    ];
    const harness = createHarness({ following: [[{ pk: 1, username: 'alice' }]], followers: [], answer });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].gender?.gender).toBe('female');
    expect(result.candidates[0].gender?.confidence).toBe(0.1);
  });

  it('survives a classifier that throws for the whole batch', async () => {
    const classifyBatch = vi.fn(
      async (): Promise<readonly GenderBatchEntry[]> => {
        throw new Error('DeepSeek exploded');
      },
    );
    const harness = createHarness({
      following: [makeUsers(2)],
      followers: [],
      classifier: createClassifier(classifyBatch),
    });
    const result = await runAccountAudit(harness.deps);
    expect(classifyBatch).toHaveBeenCalledTimes(1);
    expect(result.finished).toBe(true);
    expect(result.classificationFailures).toBe(2);
    expect(result.candidates.every(candidate => candidate.gender === null)).toBe(true);
    expect(harness.batches).toHaveLength(1);
    const notices = harness.progress.filter(entry => entry.phase === 'classifying' && entry.notice !== undefined);
    expect(notices.length).toBeGreaterThan(0);
  });

  it('continues with later batches after one batch throws', async () => {
    const answer: AnswerFn = (users, callIndex) => {
      if (callIndex === 0) {
        throw new Error('first batch down');
      }
      return answerAsWoman(users);
    };
    const harness = createHarness({ following: [makeUsers(4)], followers: [], classifyBatchSize: 2, answer });
    const result = await runAccountAudit(harness.deps);
    expect(result.finished).toBe(true);
    expect(result.classificationFailures).toBe(2);
    expect(result.candidates[0].gender).toBeNull();
    expect(result.candidates[1].gender).toBeNull();
    expect(result.candidates[2].gender?.gender).toBe('female');
    expect(result.candidates[3].gender?.gender).toBe('female');
  });

  it('classifies candidates from both lists in encounter order', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }, { pk: 2, username: 'bob' }]],
      followers: [[{ pk: 3, username: 'carol' }]],
      classifyBatchSize: 2,
    });
    await runAccountAudit(harness.deps);
    expect(harness.classifyCalls.map(batch => batch.map(input => input.username))).toEqual([
      ['alice', 'bob'],
      ['carol'],
    ]);
  });

  it('emits one streaming candidate batch per classification batch', async () => {
    const harness = createHarness({ following: [makeUsers(5)], followers: [], classifyBatchSize: 2 });
    const result = await runAccountAudit(harness.deps);
    expect(harness.batches.map(batch => batch.length)).toEqual([2, 2, 1]);
    for (const batch of harness.batches) {
      for (const candidate of batch) {
        expect(candidate.gender).not.toBeNull();
      }
    }
    const streamed = harness.batches[0].concat(harness.batches[1], harness.batches[2]);
    expect(streamed).toEqual(result.candidates);
  });

  it('does not emit candidate batches when there is nothing to classify', async () => {
    const harness = createHarness({ following: [], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(harness.classifyCalls).toEqual([]);
    expect(harness.batches).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.finished).toBe(true);
  });

  it('records the classifier source and model on every guess', async () => {
    const classifier = createClassifier(
      async users => answerAsWoman(users),
      'deepseek',
      'deepseek-chat',
    );
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }]],
      followers: [],
      classifier,
    });
    const result = await runAccountAudit(harness.deps);
    expect(result.candidates[0].gender?.source).toBe('deepseek');
    expect(result.candidates[0].gender?.model).toBe('deepseek-chat');
  });

  it('reports zero classification failures when every account is answered', async () => {
    const harness = createHarness({ following: [makeUsers(3)], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result.classificationFailures).toBe(0);
    expect(result.candidates.every(candidate => candidate.gender !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

describe('runAccountAudit progress reporting', () => {
  it('starts at zero percent while fetching the following list', async () => {
    const harness = createHarness({ following: [[{ pk: 1, username: 'alice' }]], followers: [] });
    await runAccountAudit(harness.deps);
    expect(harness.progress[0]).toEqual({
      phase: 'fetching-following',
      followingFetched: 0,
      followersFetched: 0,
      classified: 0,
      toClassify: 0,
      percentage: 0,
    });
  });

  it('walks through the documented phases', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }]],
      followers: [[{ pk: 2, username: 'bob' }]],
    });
    await runAccountAudit(harness.deps);
    const phases = phaseSequence(harness.progress);
    expect(phases[0]).toBe('fetching-following');
    expect(phases[phases.length - 1]).toBe('complete');
    expect(phases).toContain('fetching-followers');
    expect(phases).toContain('classifying');
  });

  it('keeps percentages monotonic', async () => {
    const harness = createHarness({ following: [makeUsers(5)], followers: [], classifyBatchSize: 2 });
    await runAccountAudit(harness.deps);
    expectMonotonicPercentages(harness.progress);
  });

  it('keeps streaming percentages inside 0..100 and completes at 100', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }], [{ pk: 2, username: 'bob' }]],
      followers: [[{ pk: 3, username: 'carol' }], [{ pk: 4, username: 'dave' }]],
      classifyBatchSize: 2,
    });
    await runAccountAudit(harness.deps);
    expectStreamingPercentages(harness.progress);
    expectMonotonicPercentages(harness.progress);
  });

  it('reports final counts and 100 percent on completion', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }, { pk: 2, username: 'bob' }]],
      followers: [[{ pk: 3, username: 'carol' }]],
      classifyBatchSize: 2,
    });
    const result = await runAccountAudit(harness.deps);
    expect(lastProgress(harness.progress)).toEqual({
      phase: 'complete',
      followingFetched: 2,
      followersFetched: 1,
      classified: 3,
      toClassify: 0,
      percentage: 100,
    });
    expect(result.candidates).toHaveLength(3);
  });

  it('advances classification progress after every batch', async () => {
    const harness = createHarness({ following: [makeUsers(5)], followers: [], classifyBatchSize: 2 });
    await runAccountAudit(harness.deps);
    const classifying = harness.progress.filter(entry => entry.phase === 'classifying');
    expect(classifying.map(entry => entry.classified)).toEqual([0, 2, 4, 5]);
    expectMonotonicPercentages(harness.progress);
  });

  it('classifies accounts while the followers list is still loading', async () => {
    const classifyCalls: GenderInputBatch[] = [];
    let releaseFollowers: () => void = () => undefined;
    const followersGate = new Promise<void>(resolve => {
      releaseFollowers = resolve;
    });
    const classifier = createClassifier(async users => {
      classifyCalls.push(users.slice());
      return answerAsWoman(users);
    });
    const fetchList: FetchListFn = async (kind, onPage) => {
      if (kind === 'following') {
        await onPage([{ pk: 1, username: 'alice' }, { pk: 2, username: 'bob' }]);
        return true;
      }
      await followersGate;
      await onPage([{ pk: 3, username: 'carol' }]);
      return true;
    };
    const run = createDeps({ fetchList, classifier });
    const running = runAccountAudit(run);
    // Let the following page and its classification batch run, while the
    // followers request is still blocked.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(classifyCalls.length).toBeGreaterThan(0);
    expect(classifyCalls[0].map(input => input.username)).toEqual(['alice', 'bob']);
    releaseFollowers();
    const result = await running;
    expect(result.finished).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every(candidate => candidate.gender !== null)).toBe(true);
  });

  it('moves the classified counter while followers are still arriving', async () => {
    const harness = createHarness({
      following: [[{ pk: 1, username: 'alice' }]],
      followers: [[{ pk: 2, username: 'bob' }], [{ pk: 3, username: 'carol' }]],
      classifyBatchSize: 1,
    });
    await runAccountAudit(harness.deps);
    const duringFollowers = harness.progress.filter(
      entry => entry.phase === 'fetching-followers' && entry.followersFetched > 0,
    );
    expect(duringFollowers.some(entry => entry.classified > 0)).toBe(true);
  });

  it('runs two classifier batches in parallel while accounts are still being processed', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const classifier = createClassifier(async users => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => setTimeout(resolve, 15));
      inFlight -= 1;
      return answerAsWoman(users);
    });
    const harness = createHarness({ following: [makeUsers(6)], followers: [], classifier });
    const result = await runAccountAudit({
      ...harness.deps,
      classifyBatchSize: 1,
      parallelClassifierBatches: 2,
    });
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(result.finished).toBe(true);
    expect(result.candidates).toHaveLength(6);
    expect(result.candidates.every(candidate => candidate.gender !== null)).toBe(true);
  });

  it('retries failed batches once when enabled and recovers classifications', async () => {
    let attempts = 0;
    const classifier = createClassifier(async users => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary classifier hiccup');
      }
      return answerAsWoman(users);
    });
    const harness = createHarness({ following: [makeUsers(2)], followers: [], classifier });
    const result = await runAccountAudit({
      ...harness.deps,
      retryFailedBatches: true,
      classifierRetryDelayMs: 0,
    });
    expect(attempts).toBe(2);
    expect(result.classificationFailures).toBe(0);
    expect(result.candidates.every(candidate => candidate.gender !== null)).toBe(true);
    expect(result.finished).toBe(true);
  });

  it('handles empty lists with a completed 100 percent run', async () => {
    const harness = createHarness({ following: [], followers: [] });
    const result = await runAccountAudit(harness.deps);
    expect(result).toEqual({
      candidates: [],
      followingComplete: true,
      followersComplete: true,
      classificationFailures: 0,
      finished: true,
    });
    expect(lastProgress(harness.progress)).toEqual({
      phase: 'complete',
      followingFetched: 0,
      followersFetched: 0,
      classified: 0,
      toClassify: 0,
      percentage: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// List failures: a partial list must never look complete
// ---------------------------------------------------------------------------

describe('runAccountAudit list failures', () => {
  it('stops the run when the following list cannot be fetched', async () => {
    const fetchCalls: FriendshipsListKind[] = [];
    const fetchList: FetchListFn = async kind => {
      fetchCalls.push(kind);
      return false;
    };
    const run = createRecordingDeps(fetchList);
    const result = await runAccountAudit(run.deps);
    expect(fetchCalls).toEqual(['following']);
    expect(run.fake.calls).toEqual([]);
    expect(result).toEqual({
      candidates: [],
      followingComplete: false,
      followersComplete: false,
      classificationFailures: 0,
      finished: false,
    });
    expect(lastProgress(run.progress).phase).toBe('failed');
    expect(lastProgress(run.progress).notice).toContain('following');
  });

  it('stops the run when the following list throws', async () => {
    const fetchList: FetchListFn = async () => {
      throw new Error('network down');
    };
    const run = createRecordingDeps(fetchList);
    const result = await runAccountAudit(run.deps);
    expect(result.finished).toBe(false);
    expect(result.followingComplete).toBe(false);
    expect(run.fake.calls).toEqual([]);
    expect(lastProgress(run.progress).phase).toBe('failed');
    expect(lastProgress(run.progress).notice).toContain('following');
  });

  it('never presents a partial following list as a completed scan', async () => {
    const fetchList: FetchListFn = async (kind, onPage) => {
      if (kind === 'following') {
        await onPage([{ pk: 1, username: 'alice' }]);
        return false;
      }
      return true;
    };
    const run = createRecordingDeps(fetchList);
    const result = await runAccountAudit(run.deps);
    expect(result.finished).toBe(false);
    expect(result.followingComplete).toBe(false);
    expect(result.followersComplete).toBe(false);
    expect(result.candidates.map(candidate => candidate.user.username)).toEqual(['alice']);
    // Streaming may already have classified the delivered page before the
    // failure; it must never use accounts from pages that were not delivered.
    for (const call of run.fake.calls) {
      expect(call.every(input => input.username === 'alice')).toBe(true);
    }
    expect(lastProgress(run.progress).phase).toBe('failed');
    expect(lastProgress(run.progress).followingFetched).toBe(1);
  });

  it('returns the partial following candidates when the followers list fails', async () => {
    const fetchList: FetchListFn = async (kind, onPage) => {
      if (kind === 'following') {
        await onPage([{ pk: 1, username: 'alice' }]);
        return true;
      }
      await onPage([{ pk: 2, username: 'bob' }]);
      return false;
    };
    const run = createRecordingDeps(fetchList);
    const result = await runAccountAudit(run.deps);
    expect(result.finished).toBe(false);
    expect(result.followingComplete).toBe(true);
    expect(result.followersComplete).toBe(false);
    expect(result.classificationFailures).toBe(0);
    expect(result.candidates.map(candidate => candidate.user.username)).toEqual(['alice', 'bob']);
    for (const call of run.fake.calls) {
      expect(call.every(input => ['alice', 'bob'].includes(input.username))).toBe(true);
    }
    expect(lastProgress(run.progress).phase).toBe('failed');
    expect(lastProgress(run.progress).notice).toContain('followers');
    expect(lastProgress(run.progress).followersFetched).toBe(1);
  });

  it('does not classify anything after a list failure', async () => {
    const fetchList: FetchListFn = async () => {
      throw new Error('blocked');
    };
    const run = createRecordingDeps(fetchList);
    await runAccountAudit(run.deps);
    expect(run.fake.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aborts
// ---------------------------------------------------------------------------

describe('runAccountAudit abort handling', () => {
  it('does no work at all when already aborted', async () => {
    const fetchCalls: FriendshipsListKind[] = [];
    const fetchList: FetchListFn = async kind => {
      fetchCalls.push(kind);
      return true;
    };
    const run = createRecordingDeps(fetchList, { shouldAbort: (): boolean => true });
    const result = await runAccountAudit(run.deps);
    expect(fetchCalls).toEqual([]);
    expect(run.fake.calls).toEqual([]);
    expect(result.finished).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(lastProgress(run.progress).phase).toBe('failed');
    expect(lastProgress(run.progress).notice).toBe('aborted');
    expect(lastProgress(run.progress).percentage).toBe(0);
  });

  it('unwinds pagination immediately when aborted inside a page callback', async () => {
    let abort = false;
    const fetchCalls: FriendshipsListKind[] = [];
    const pages: UsersPage[] = [[{ pk: 1, username: 'alice' }], [{ pk: 2, username: 'bob' }]];
    const fetchList: FetchListFn = async (kind, onPage) => {
      fetchCalls.push(kind);
      await onPage(pages[0]);
      abort = true;
      await onPage(pages[1]);
      return true;
    };
    const run = createRecordingDeps(fetchList, { shouldAbort: (): boolean => abort });
    const result = await runAccountAudit(run.deps);
    expect(fetchCalls).toEqual(['following']);
    expect(result.finished).toBe(false);
    expect(result.followingComplete).toBe(false);
    expect(result.candidates.map(candidate => candidate.user.username)).toEqual(['alice']);
    for (const call of run.fake.calls) {
      expect(call.every(input => input.username === 'alice')).toBe(true);
    }
    expect(lastProgress(run.progress).notice).toBe('aborted');
  });

  it('stops between the following and followers lists', async () => {
    let abort = false;
    const fetchCalls: FriendshipsListKind[] = [];
    const fetchList: FetchListFn = async (kind, onPage) => {
      fetchCalls.push(kind);
      await onPage([{ pk: 1, username: 'alice' }]);
      abort = true;
      return true;
    };
    const run = createRecordingDeps(fetchList, { shouldAbort: (): boolean => abort });
    const result = await runAccountAudit(run.deps);
    expect(fetchCalls).toEqual(['following']);
    expect(result.finished).toBe(false);
    expect(result.followingComplete).toBe(false);
    expect(lastProgress(run.progress).notice).toBe('aborted');
  });

  it('aborts after both lists without claiming a finished review', async () => {
    let abort = false;
    const fetchCalls: FriendshipsListKind[] = [];
    const fetchList: FetchListFn = async (kind, onPage) => {
      fetchCalls.push(kind);
      await onPage(kind === 'following' ? [{ pk: 1, username: 'alice' }] : [{ pk: 2, username: 'bob' }]);
      if (kind === 'followers') {
        abort = true;
      }
      return true;
    };
    const run = createRecordingDeps(fetchList, { shouldAbort: (): boolean => abort });
    const result = await runAccountAudit(run.deps);
    expect(fetchCalls).toEqual(['following', 'followers']);
    expect(result.finished).toBe(false);
    expect(result.followingComplete).toBe(true);
    expect(result.followersComplete).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(lastProgress(run.progress).notice).toBe('aborted');
  });

  it('stops mid-classification and keeps the completed batches', async () => {
    let abort = false;
    const classifyCalls: GenderInputBatch[] = [];
    const classifier = createClassifier(async users => {
      classifyCalls.push(users.slice());
      abort = true;
      return answerAsWoman(users);
    });
    const run = createRecordingDeps(
      async (kind, onPage) => {
        if (kind === 'following') {
          await onPage(makeUsers(5));
        }
        return true;
      },
      {
        classifier,
        classifyBatchSize: 2,
        shouldAbort: (): boolean => abort,
      },
    );
    const result = await runAccountAudit(run.deps);
    expect(classifyCalls).toHaveLength(1);
    expect(result.finished).toBe(false);
    expect(result.candidates[0].gender).not.toBeNull();
    expect(result.candidates[1].gender).not.toBeNull();
    expect(result.candidates[2].gender).toBeNull();
    expect(result.candidates[3].gender).toBeNull();
    expect(result.candidates[4].gender).toBeNull();
    expect(lastProgress(run.progress).notice).toBe('aborted');
  });

  it('marks the run unfinished when aborted during the final classification batch', async () => {
    let abort = false;
    const classifier = createClassifier(async users => {
      abort = true;
      return answerAsWoman(users);
    });
    const run = createRecordingDeps(
      async (kind, onPage) => {
        if (kind === 'following') {
          await onPage(makeUsers(2));
        }
        return true;
      },
      {
        classifier,
        classifyBatchSize: 5,
        shouldAbort: (): boolean => abort,
      },
    );
    const result = await runAccountAudit(run.deps);
    expect(result.finished).toBe(false);
    expect(result.candidates.every(candidate => candidate.gender !== null)).toBe(true);
    expect(lastProgress(run.progress).notice).toBe('aborted');
  });

  it('aborts cleanly when the classifier signals an abort', async () => {
    let abort = false;
    const classifier = createClassifier(async users => {
      abort = true;
      return answerAsWoman(users);
    });
    const run = createRecordingDeps(
      async (kind, onPage) => {
        if (kind === 'following') {
          await onPage([{ pk: 1, username: 'alice' }]);
        }
        return true;
      },
      {
        classifier,
        classifyBatchSize: 1,
        shouldAbort: (): boolean => abort,
      },
    );
    const result = await runAccountAudit(run.deps);
    expect(result.finished).toBe(false);
    expect(lastProgress(run.progress).notice).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// Safety and determinism
// ---------------------------------------------------------------------------

describe('runAccountAudit safety guarantees', () => {
  it('never performs a network request through the global fetch', async () => {
    const harness = createHarness({
      following: [makeUsers(3)],
      followers: [[{ pk: 90, username: 'zoe' }]],
    });
    await runAccountAudit(harness.deps);
    expect(networkGuard).not.toHaveBeenCalled();
  });

  it('leaves the global network guard armed for accidental calls', async () => {
    await expect(fetch('https://www.instagram.com/api/v1/friendships/1/following/')).rejects.toThrow(
      NetworkDisabledError,
    );
    expect(networkGuard).toHaveBeenCalledTimes(1);
  });

  it('produces deterministic results for identical inputs', async () => {
    const options: HarnessOptions = {
      following: [[{ pk: 1, username: 'alice' }, { pk: 2, username: 'bob' }]],
      followers: [[{ pk: 2, username: 'bob' }, { username: 'Carol' }]],
      now: (): number => 42,
      classifyBatchSize: 2,
    };
    const first = await runAccountAudit(createHarness(options).deps);
    const second = await runAccountAudit(createHarness(options).deps);
    expect(first).toEqual(second);
  });

  it('returns partial candidates after an abort rather than throwing', async () => {
    let abort = false;
    const fetchList: FetchListFn = async (kind, onPage) => {
      await onPage([{ pk: 1, username: 'alice' }]);
      abort = true;
      return kind === 'following' ? false : true;
    };
    const run = createRecordingDeps(fetchList, { shouldAbort: (): boolean => abort });
    const result = await runAccountAudit(run.deps);
    expect(result.finished).toBe(false);
    expect(result.candidates).toHaveLength(1);
    // Classification may have completed before the abort landed; either is
    // acceptable as long as the review is marked partial and never live-ready.
    const guess = result.candidates[0].gender;
    expect(guess === null || guess.gender === 'female').toBe(true);
    expect(result.candidates[0].relationship).toBe('following');
  });
});
