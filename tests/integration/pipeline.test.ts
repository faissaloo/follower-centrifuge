/**
 * End-to-end pipeline integration tests.
 *
 * Drives the real modules the app uses, in the same order the App does:
 *   paginated list fetch -> women audit runner -> review selection ->
 *   plan building -> dry-run/live executor.
 *
 * Every external dependency is a deterministic fake: no Instagram, no DeepSeek,
 * no timers, no network. The global fetch guard in tests/setup.ts makes any
 * accidental real request fail the suite.
 */
import { describe, expect, it, vi } from 'vitest';
import { GenderBatchEntry, GenderClassifier, GenderInput } from '../../src/model/gender';
import { AuditCandidate } from '../../src/model/audit';
import { createFriendshipsListFetcher } from '../../src/utils/friendships-list';
import { runAccountAudit } from '../../src/utils/account-audit';
import { buildUnfollowPlan } from '../../src/utils/action-plan';
import { executeUnfollowPlan, UnfollowExecutorDeps } from '../../src/utils/unfollow-executor';
import { liveConfirmationPhrase } from '../../src/utils/approval';
import { UnfollowResult } from '../../src/utils/utils';
import { createRawUser } from '../helpers/fixtures';
import { expectNoNetworkCalls } from './network-assertions';

const FEMALE_NAMES = new Set(['alice', 'cara', 'erin']);
const MALE_NAMES = new Set(['bob', 'dave']);

function classifyName(fullName: string): { gender: 'female' | 'male' | 'ambiguous'; confidence: number } {
  const first = fullName.trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (FEMALE_NAMES.has(first)) {
    return { gender: 'female', confidence: 0.95 };
  }
  if (MALE_NAMES.has(first)) {
    return { gender: 'male', confidence: 0.9 };
  }
  return { gender: 'ambiguous', confidence: 0.3 };
}

function createFakeClassifier(): GenderClassifier {
  return {
    version: 'fake-classifier:v1',
    source: 'deepseek',
    model: 'fake-model',
    async classifyBatch(users: readonly GenderInput[]): Promise<readonly GenderBatchEntry[]> {
      return users.map(user => {
        const classification = classifyName(user.fullName);
        return { id: user.id, gender: classification.gender, confidence: classification.confidence, reason: 'fake' };
      });
    },
  };
}

/** One fake Instagram "server": two pages for each list. */
function createFakeInstagramPages() {
  const followingPageOne = [
    createRawUser({ pk: 1, pk_id: '1', username: 'alice.w', full_name: 'Alice Wonder' }),
    createRawUser({ pk: 2, pk_id: '2', username: 'bob.builder', full_name: 'Bob Builder' }),
  ];
  const followingPageTwo = [
    createRawUser({ pk: 3, pk_id: '3', username: 'cara.d', full_name: 'Cara Day' }),
    createRawUser({ pk: 4, pk_id: '4', username: 'dave.k', full_name: 'Dave Knight' }),
  ];
  const followersPageOne = [
    createRawUser({ pk: 3, pk_id: '3', username: 'cara.d', full_name: 'Cara Day' }),
    createRawUser({ pk: 5, pk_id: '5', username: 'erin.f', full_name: 'Erin Fox' }),
  ];
  const followersPageTwo = [createRawUser({ pk: 1, pk_id: '1', username: 'alice.w', full_name: 'Alice Wonder' })];

  const fetchPage = vi.fn(async (kind: 'following' | 'followers', maxId?: string) => {
    if (kind === 'following') {
      return maxId === undefined
        ? { users: followingPageOne, next_max_id: 'f2', has_more: true }
        : { users: followingPageTwo };
    }
    return maxId === undefined
      ? { users: followersPageOne, next_max_id: 'r2', has_more: true }
      : { users: followersPageTwo };
  });

  const fetchList = createFriendshipsListFetcher({
    fetchPage,
    sleep: vi.fn(async () => undefined),
    random: () => 0,
    shouldAbort: () => false,
    pageSafetyLimit: 10,
  });

  return { fetchList, fetchPage };
}

async function runPipeline(): Promise<readonly AuditCandidate[]> {
  const { fetchList } = createFakeInstagramPages();
  const result = await runAccountAudit({
    fetchList,
    classifier: createFakeClassifier(),
    classifyBatchSize: 2,
    onProgress: () => undefined,
    onCandidatesBatch: () => undefined,
    shouldAbort: () => false,
    now: () => 1735689600000,
  });
  expect(result.finished).toBe(true);
  expect(result.followingComplete).toBe(true);
  expect(result.followersComplete).toBe(true);
  return result.candidates;
}

function candidateByUsername(candidates: readonly AuditCandidate[], username: string): AuditCandidate {
  const found = candidates.find(candidate => candidate.user.username === username);
  if (found === undefined) {
    throw new Error(`missing candidate ${username}`);
  }
  return found;
}

function createExecutorHarness(outcomes: Partial<Record<string, UnfollowResult>> = {}) {
  const unfollow = vi.fn(async (user: { username: string }): Promise<UnfollowResult> => {
    const outcome = outcomes[user.username];
    return outcome ?? { outcome: 'unfollowed', detail: 'confirmed' };
  });
  const progress: number[] = [];
  const deps: UnfollowExecutorDeps = {
    unfollow: unfollow as unknown as UnfollowExecutorDeps['unfollow'],
    getCsrfToken: () => 'csrf-token',
    sleep: vi.fn(async () => undefined),
    timings: { timeBetweenUnfollows: 1, timeToWaitAfterFiveUnfollows: 2 },
    onProgress: p => progress.push(p.percentage),
    shouldAbort: () => false,
    random: () => 0,
  };
  return { deps, unfollow, progress };
}

describe('women audit end-to-end pipeline', () => {
  it('scans both lists, merges mutuals and classifies every candidate', async () => {
    const candidates = await runPipeline();
    expect(candidates).toHaveLength(5);
    expect(candidateByUsername(candidates, 'alice.w').relationship).toBe('mutual');
    expect(candidateByUsername(candidates, 'cara.d').relationship).toBe('mutual');
    expect(candidateByUsername(candidates, 'bob.builder').relationship).toBe('following');
    expect(candidateByUsername(candidates, 'dave.k').relationship).toBe('following');
    expect(candidateByUsername(candidates, 'erin.f').relationship).toBe('follower');
  });

  it('classifies likely women while keeping follower-only accounts ineligible', async () => {
    const candidates = await runPipeline();
    expect(candidateByUsername(candidates, 'alice.w').gender?.gender).toBe('female');
    expect(candidateByUsername(candidates, 'bob.builder').gender?.gender).toBe('male');
    expect(candidateByUsername(candidates, 'erin.f').gender?.gender).toBe('female');
    expect(candidateByUsername(candidates, 'erin.f').user.followed_by_viewer).toBe(false);
  });

  it('builds a dry-run plan containing only eligible likely women', async () => {
    const candidates = await runPipeline();
    const selected = [
      candidateByUsername(candidates, 'alice.w').user,
      candidateByUsername(candidates, 'bob.builder').user,
      candidateByUsername(candidates, 'cara.d').user,
      candidateByUsername(candidates, 'erin.f').user,
    ];
    const result = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set([candidateByUsername(candidates, 'cara.d').user.id]),
      mode: 'dry-run',
      now: () => 1735689600000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.mode).toBe('dry-run');
    expect(result.plan.targets.map(target => target.user.username)).toEqual(['alice.w']);
    expect(result.plan.skipped.map(skip => [skip.user.username, skip.reason])).toEqual([
      ['bob.builder', 'not-target-gender'],
      ['cara.d', 'whitelisted'],
      ['erin.f', 'not-followed-by-you'],
    ]);
  });

  it('builds a dry-run plan over likely males when the target is male', async () => {
    const candidates = await runPipeline();
    const selected = [
      candidateByUsername(candidates, 'alice.w').user,
      candidateByUsername(candidates, 'bob.builder').user,
      candidateByUsername(candidates, 'cara.d').user,
      candidateByUsername(candidates, 'dave.k').user,
    ];
    const result = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set(),
      mode: 'dry-run',
      targetCategory: 'male',
      now: () => 1735689600000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.targets.map(target => target.user.username)).toEqual(['bob.builder', 'dave.k']);
    expect(result.plan.skipped.map(skip => [skip.user.username, skip.reason])).toEqual([
      ['alice.w', 'not-target-gender'],
      ['cara.d', 'not-target-gender'],
    ]);
  });

  it('the same selection yields disjoint targets for the two audit targets', async () => {
    const candidates = await runPipeline();
    const selected = candidates.map(candidate => candidate.user);
    const womenPlan = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set(),
      mode: 'dry-run',
      targetCategory: 'female',
    });
    const menPlan = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set(),
      mode: 'dry-run',
      targetCategory: 'male',
    });
    expect(womenPlan.ok && menPlan.ok).toBe(true);
    if (!womenPlan.ok || !menPlan.ok) {
      return;
    }
    expect(womenPlan.plan.targets.map(target => target.user.username)).toEqual(['alice.w', 'cara.d']);
    expect(menPlan.plan.targets.map(target => target.user.username)).toEqual(['bob.builder', 'dave.k']);
  });

  it('a live plan for the male target needs the exact phrase for the male count', async () => {
    const candidates = await runPipeline();
    const selection = {
      selected: ['alice.w', 'bob.builder', 'dave.k'].map(username => candidateByUsername(candidates, username).user),
      candidates,
      whitelistedIds: new Set<string>(),
      mode: 'live' as const,
      targetCategory: 'male' as const,
    };
    expect(buildUnfollowPlan({ ...selection, typedConfirmation: 'UNFOLLOW 3' }).ok).toBe(false);
    const planResult = buildUnfollowPlan({ ...selection, typedConfirmation: 'UNFOLLOW 2' });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) {
      return;
    }
    expect(planResult.plan.targets.map(target => target.user.username)).toEqual(['bob.builder', 'dave.k']);
  });

  it('a dry run executes zero unfollow requests and changes nothing', async () => {
    const candidates = await runPipeline();
    const planResult = buildUnfollowPlan({
      selected: [candidateByUsername(candidates, 'alice.w').user, candidateByUsername(candidates, 'cara.d').user],
      candidates,
      whitelistedIds: new Set(),
      mode: 'dry-run',
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) {
      return;
    }
    const { deps, unfollow } = createExecutorHarness();
    const result = await executeUnfollowPlan(planResult.plan, deps);
    expect(unfollow).not.toHaveBeenCalled();
    expect(result.mode).toBe('dry-run');
    expect(result.stopReason).toBe('complete');
    expect(result.changedAnything).toBe(false);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every(entry => entry.status === 'simulated')).toBe(true);
    expectNoNetworkCalls();
  });

  it('live plan creation fails without the exact typed phrase', async () => {
    const candidates = await runPipeline();
    const selected = [candidateByUsername(candidates, 'alice.w').user, candidateByUsername(candidates, 'cara.d').user];
    const missing = buildUnfollowPlan({ selected, candidates, whitelistedIds: new Set(), mode: 'live' });
    expect(missing.ok).toBe(false);
    const wrongCount = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set(),
      mode: 'live',
      typedConfirmation: liveConfirmationPhrase(1),
    });
    expect(wrongCount.ok).toBe(false);
    const wrongCase = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set(),
      mode: 'live',
      typedConfirmation: liveConfirmationPhrase(2).toLowerCase(),
    });
    expect(wrongCase.ok).toBe(false);
  });

  it('live plan + exact approval unfollows only eligible accounts', async () => {
    const candidates = await runPipeline();
    const selected = [
      candidateByUsername(candidates, 'alice.w').user,
      candidateByUsername(candidates, 'bob.builder').user,
      candidateByUsername(candidates, 'cara.d').user,
    ];
    const planResult = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set([candidateByUsername(candidates, 'cara.d').user.id]),
      mode: 'live',
      typedConfirmation: liveConfirmationPhrase(1),
      now: () => 1735689600000,
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) {
      return;
    }
    const { deps, unfollow } = createExecutorHarness();
    const result = await executeUnfollowPlan(planResult.plan, deps);
    expect(unfollow).toHaveBeenCalledTimes(1);
    expect(unfollow.mock.calls[0][0].username).toBe('alice.w');
    expect(result.mode).toBe('live');
    expect(result.changedAnything).toBe(true);
    expect(result.entries.map(entry => [entry.user.username, entry.status])).toEqual([['alice.w', 'unfollowed']]);
  });

  it('a live plan with a forged approval is rejected before any request', async () => {
    const candidates = await runPipeline();
    const planResult = buildUnfollowPlan({
      selected: [candidateByUsername(candidates, 'alice.w').user],
      candidates,
      whitelistedIds: new Set(),
      mode: 'live',
      typedConfirmation: liveConfirmationPhrase(1),
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok || planResult.plan.mode !== 'live') {
      return;
    }
    const forged = {
      ...planResult.plan,
      approval: { ...planResult.plan.approval, typedConfirmation: 'yes please' },
    };
    const { deps, unfollow } = createExecutorHarness();
    const result = await executeUnfollowPlan(forged, deps);
    expect(result.stopReason).toBe('invalid-approval');
    expect(result.changedAnything).toBe(false);
    expect(unfollow).not.toHaveBeenCalled();
  });

  it('stops a live run on an Instagram action block', async () => {
    const candidates = await runPipeline();
    const selected = ['alice.w', 'cara.d', 'dave.k'].map(username => candidateByUsername(candidates, username).user);
    const planResult = buildUnfollowPlan({
      selected,
      candidates,
      whitelistedIds: new Set(),
      mode: 'live',
      typedConfirmation: liveConfirmationPhrase(2),
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) {
      return;
    }
    const { deps, unfollow } = createExecutorHarness({
      'alice.w': { outcome: 'unfollowed', detail: 'confirmed' },
      'cara.d': { outcome: 'blocked', detail: 'feedback_required' },
    });
    const result = await executeUnfollowPlan(planResult.plan, deps);
    expect(unfollow).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('action-blocked');
    expect(result.changedAnything).toBe(true);
    expect(result.entries.map(entry => entry.status)).toEqual(['unfollowed', 'blocked']);
  });

  it('never calls the real network across the whole happy path', async () => {
    await runPipeline();
    expectNoNetworkCalls();
  });
});
