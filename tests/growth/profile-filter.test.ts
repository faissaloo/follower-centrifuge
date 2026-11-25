import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEEPSEEK_CONFIG, DeepSeekConfig } from '../../src/model/deepseek-config';
import { ShortlistCandidate } from '../../src/model/growth';
import { filterShortlistCandidates } from '../../src/utils/profile-filter';

interface BiasedCandidate extends ShortlistCandidate {
  readonly scoreBias: number;
}

function candidate(index: number, scoreBias: number, sourceCount: number): BiasedCandidate {
  return {
    id: String(index),
    username: `candidate_${index}`,
    fullName: `Candidate ${index}`,
    biography: 'posts process work',
    profilePicUrl: '',
    isPrivate: false,
    isVerified: false,
    followerCount: 500,
    followingCount: 200,
    score: 0,
    sourceUsername: 'seed',
    sourceCount,
    scoreBias,
  };
}

function config(): DeepSeekConfig {
  return {
    ...DEFAULT_DEEPSEEK_CONFIG,
    provider: 'typesafe',
    typesafeApiKey: 'apikey_test',
    typesafeModel: 'jev-latest',
    typesafeBaseUrl: 'https://api.typesafe.ai',
    requestTimeoutMs: 5000,
    maxRetries: 0,
  };
}

describe('profile filter scoring', () => {
  it('ranks strong matches, keeps 20, and exposes far-out network distance', async () => {
    const profiles: BiasedCandidate[] = Array.from({ length: 25 }, (_, index) => candidate(index, 0.2 + index * 0.03, index === 0 ? 1 : 3));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/v1/systemone');
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(body.questions)) {
        const index = Number(key.split('_')[1]) - 1;
        const score = profiles[index].scoreBias;
        answers[key] = {
          type: 'choice',
          choice: 'match',
          confidence: score,
          probabilities: { match: score, maybe: 0.05, no: 1 - score },
        };
      }
      return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const result = await filterShortlistCandidates(profiles, 'ceramics and process work', config(), { fetchImpl });
    expect(result).toHaveLength(20);
    expect(result[0].score).toBeGreaterThan(0.7);
    expect(result.every(entry => entry.score > 0)).toBe(true);
    const farOut = result.find(entry => entry.username === 'candidate_0');
    expect(farOut?.networkDistance).toBe(1);
  });

  it('passes neutral profile-photo cues into the Jev state', async () => {
    const withPhoto = { ...candidate(1, 0.8, 1), profilePicUrl: 'https://cdn.example/avatar.jpg' };
    let observedPhotoCues: unknown;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: { candidates: Array<Record<string, unknown>> }; questions: Record<string, unknown> };
      observedPhotoCues = body.state.candidates[0].photo_cues;
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(body.questions)) {
        answers[key] = { type: 'choice', choice: 'match', confidence: 0.8, probabilities: { match: 0.8, maybe: 0.1, no: 0.1 } };
      }
      return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await filterShortlistCandidates([withPhoto], 'ceramics process work', config(), {
      fetchImpl,
      describePhotos: async () => new Map([['1', 'photo shows a ceramics studio shelf']]),
    });
    expect(observedPhotoCues).toBe('photo shows a ceramics studio shelf');
  });

  it('gives private profiles a modest ranking boost', async () => {
    const publicCandidate = { ...candidate(1, 0.6, 1), isPrivate: false };
    const privateCandidate = { ...candidate(2, 0.6, 1), isPrivate: true };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(body.questions)) {
        answers[key] = { type: 'choice', choice: 'match', confidence: 0.6, probabilities: { match: 0.6, maybe: 0.1, no: 0.3 } };
      }
      return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await filterShortlistCandidates([publicCandidate, privateCandidate], 'ceramics', config(), { fetchImpl });
    expect(result[0].username).toBe('candidate_2');
  });

  it('requires Jev and does not silently fall back to DeepSeek', async () => {
    await expect(
      filterShortlistCandidates([candidate(1, 0.8, 1)], 'ceramics', { ...config(), typesafeApiKey: '' }, {}),
    ).rejects.toThrow(/TypeSafe Jev/);
  });
});
