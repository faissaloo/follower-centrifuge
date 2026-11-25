import { DAILY_SHORTLIST_SIZE, ShortlistCandidate } from '../model/growth';
import { DeepSeekConfig } from '../model/deepseek-config';
import { createPhotoCueDescriber, isDeepSeekConfigured, isTypeSafeConfigured } from './gender-classifier';
import { resolveClassifierFetch } from './classifier-relay';
import { createTypeSafeClient, TypeSafeChoiceAnswer, TypeSafeQuestion } from './typesafe-client';
import { effectiveFilterPrompt, validateFilterPrompt } from './filter-prompt';
import {
  SHORTLIST_JEV_CRITERIA,
  shortlistJevInstructions,
  shortlistJevStateHeader,
} from '../prompts/daily-shortlist';

/**
 * Read-only filter scoring for the Daily 20 shortlist. Jev only.
 */
export interface ProfileFilterDeps {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly hostname?: string;
  readonly signal?: AbortSignal;
  /** Test hook; production defaults to the shared DeepSeek photo-cue pass. */
  readonly describePhotos?: (candidates: readonly ShortlistCandidate[]) => Promise<ReadonlyMap<string, string>>;
}

export class ProfileFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileFilterError';
  }
}

interface ScoredProfile {
  readonly username: string;
  readonly score: number;
}

function profileStateRow(candidate: ShortlistCandidate, index: number): Record<string, unknown> {
  return {
    candidate: index + 1,
    username: candidate.username,
    display_name: candidate.fullName.slice(0, 120),
    biography: candidate.biography.slice(0, 220),
    discovered_via: (candidate.discoveredVia ?? []).slice(0, 8),
    follower_count: candidate.followerCount,
    following_count: candidate.followingCount,
    verified: candidate.isVerified,
    private: candidate.isPrivate,
    source: candidate.sourceUsername ?? '',
    ...(candidate.photoCues !== undefined && candidate.photoCues !== ''
      ? { photo_cues: candidate.photoCues.slice(0, 240) }
      : {}),
  };
}

function scoreFromJev(answer: TypeSafeChoiceAnswer | undefined): number {
  if (answer === undefined) {
    return 0;
  }
  const probabilities = answer.probabilities as Record<string, number | undefined>;
  const match = probabilities.match;
  const maybe = probabilities.maybe;
  if (typeof match === 'number' || typeof maybe === 'number') {
    return Math.max(0, Math.min(1, (match ?? 0) + 0.5 * (maybe ?? 0)));
  }
  if (answer.choice === 'match') {
    return answer.confidence;
  }
  if (answer.choice === 'maybe') {
    return answer.confidence * 0.5;
  }
  return 0;
}

async function scoreWithJev(
  candidates: readonly ShortlistCandidate[],
  prompt: string,
  config: DeepSeekConfig,
  deps: ProfileFilterDeps,
): Promise<readonly ScoredProfile[]> {
  const fetchImpl = resolveClassifierFetch(config, {
    fetchImpl: deps.fetchImpl,
    hostname: deps.hostname,
  });
  const client = createTypeSafeClient(
    {
      baseUrl: config.typesafeBaseUrl,
      apiKey: config.typesafeApiKey,
      model: config.typesafeModel,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    },
    { fetchImpl, sleep: deps.sleep },
  );
  const scored: ScoredProfile[] = [];
  const chunkSize = 20;
  for (let start = 0; start < candidates.length; start += chunkSize) {
    if (deps.signal?.aborted === true) {
      throw new ProfileFilterError('shortlist scoring cancelled');
    }
    const chunk = candidates.slice(start, start + chunkSize);
    const state = {
      ...shortlistJevStateHeader(prompt),
      candidates: chunk.map(profileStateRow),
    };
    const questions: Record<string, TypeSafeQuestion> = {};
    for (let index = 0; index < chunk.length; index += 1) {
      questions[`candidate_${index + 1}`] = {
        type: 'choice',
        instructions: shortlistJevInstructions(index + 1),
        criteria: SHORTLIST_JEV_CRITERIA,
      };
    }
    const response = await client.systemOne(state, questions);
    for (let index = 0; index < chunk.length; index += 1) {
      const answer = response.answers[`candidate_${index + 1}`];
      const score = answer?.type === 'choice' ? scoreFromJev(answer) : 0;
      scored.push({ username: chunk[index].username, score });
    }
  }
  return scored;
}

/**
 * Score candidates against the user's filter and return the best 20.
 * Jev is required for this read-only shortlist.
 */
export async function filterShortlistCandidates(
  candidates: readonly ShortlistCandidate[],
  rawPrompt: string,
  config: DeepSeekConfig,
  deps: ProfileFilterDeps = {},
): Promise<readonly ShortlistCandidate[]> {
  const validation = validateFilterPrompt(rawPrompt);
  if (!validation.ok) {
    throw new ProfileFilterError(validation.error ?? 'filter prompt rejected');
  }
  const prompt = effectiveFilterPrompt(validation.prompt);
  if (candidates.length === 0) {
    throw new ProfileFilterError('no candidates to score');
  }
  if (!isTypeSafeConfigured(config)) {
    throw new ProfileFilterError('configure a TypeSafe Jev key before building the daily shortlist.');
  }

  // Jev cannot read images. When DeepSeek vision is configured, describe the
  // profile photos first and add those neutral cues to the Jev state. The
  // filter DECISION remains Jev-only; photos are evidence, not a fallback.
  let candidatesWithPhotos: readonly ShortlistCandidate[] = candidates;
  const hasPhotos = candidates.some(candidate => candidate.profilePicUrl !== '');
  if (hasPhotos) {
    try {
      const describer =
        deps.describePhotos ??
        (isDeepSeekConfigured(config)
          ? createPhotoCueDescriber(config, {
              fetchImpl: deps.fetchImpl,
              sleep: deps.sleep,
              hostname: deps.hostname,
            })
          : undefined);
      if (describer !== undefined) {
        const cues = await describer(candidates);
        candidatesWithPhotos = candidates.map(candidate => {
          const cue = cues.get(candidate.id);
          return cue === undefined ? candidate : { ...candidate, photoCues: cue };
        });
      }
    } catch {
      // Photo cues are optional; text-only Jev scoring still runs.
    }
  }

  let scores: readonly ScoredProfile[];
  try {
    scores = await scoreWithJev(candidatesWithPhotos, prompt, config, deps);
  } catch (error) {
    throw new ProfileFilterError(
      error instanceof Error ? `could not score profiles: ${error.message}` : 'could not score profiles',
    );
  }
  const byUsername = new Map<string, number>();
  for (const entry of scores) {
    byUsername.set(entry.username.toLowerCase(), entry.score);
  }
  return candidatesWithPhotos
    .map(candidate => {
      const score = byUsername.get(candidate.username.toLowerCase()) ?? 0;
      const sourceCount = candidate.sourceCount ?? 1;
      // Far-out accounts (fewer sampled follows lead to them) get a boost.
      // Private accounts get a modest boost too: a manual follow request is a
      // higher-yield outcome than a public follow. Strong filter matches still
      // dominate the ranking.
      const networkDistance = 1 / sourceCount;
      const privateBoost = candidate.isPrivate ? 0.12 : 0;
      return { ...candidate, score, networkDistance, priority: score * 0.58 + networkDistance * 0.3 + privateBoost };
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.priority - a.priority || b.score - a.score)
    .slice(0, DAILY_SHORTLIST_SIZE)
    .map(({ priority: _priority, ...candidate }) => candidate);
}
