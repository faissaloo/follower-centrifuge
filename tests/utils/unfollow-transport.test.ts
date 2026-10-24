/**
 * Tests for the REAL destructive transport in src/utils/utils.ts.
 *
 * This is the only code in the app that actually writes to Instagram. It is
 * tested with a fake global fetch (never real network) so the GraphQL request
 * shape, session-token handling, action-block detection and unfollow
 * verification logic are covered instead of only mocked away.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCookie, isStillFollowing, removeFollower, unfollowUser } from '../../src/utils/utils';
import { INSTAGRAM_UNFOLLOW_DOC_ID, INSTAGRAM_UNFOLLOW_FRIENDLY_NAME } from '../../src/constants/constants';

interface FakeResponseInit {
  readonly status?: number;
  readonly body?: string;
  readonly json?: unknown;
}

function fakeResponse(init: FakeResponseInit = {}) {
  const status = init.status === undefined ? 200 : init.status;
  const body = init.body === undefined ? JSON.stringify(init.json ?? {}) : init.body;
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: 'https://www.instagram.com/api/graphql',
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

const fetchMock = vi.fn();

beforeAll(() => {
  // The app reads these per-session tokens from Instagram's module registry when
  // available; provide a deterministic fake registry.
  (window as unknown as { require: (name: string) => unknown }).require = (name: string) => {
    if (name === 'DTSGInitialData') {
      return { token: 'fb-dtsg-token' };
    }
    if (name === 'LSD') {
      return { token: 'lsd-token' };
    }
    if (name === 'SiteData') {
      return { client_revision: 12345, rollout_hash: 'rollout-123' };
    }
    return undefined;
  };
  // jsdom's document.cookie setter only accepts one cookie per assignment.
  document.cookie = 'csrftoken=csrf-token';
  document.cookie = 'ds_user_id=viewer-1';
});

afterAll(() => {
  delete (window as unknown as { require?: unknown }).require;
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function graphqlRequestOptions(): {
  readonly body: URLSearchParams;
  readonly headers: Record<string, string>;
} {
  expect(fetchMock).toHaveBeenCalled();
  const call = fetchMock.mock.calls[0];
  expect(String(call[0])).toBe('https://www.instagram.com/api/graphql');
  const options = call[1] as { body: string; headers: Record<string, string>; method: string; signal?: AbortSignal };
  expect(options.method).toBe('POST');
  // Requests are abortable/bounded by a timeout instead of hanging forever.
  expect(options.signal).toBeDefined();
  return { body: new URLSearchParams(options.body), headers: options.headers };
}

const TARGET = { id: '42', username: 'alina.frames' };
const FOLLOWING_SEARCH_EMPTY = fakeResponse({ json: { users: [] } });

describe('unfollowUser (real transport, fake fetch)', () => {
  it('sends the expected GraphQL request and confirms a successful unfollow', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ json: { data: { user: { friendship_status: { following: false } } } } }))
      .mockResolvedValueOnce(FOLLOWING_SEARCH_EMPTY);

    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('unfollowed');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const { body, headers } = graphqlRequestOptions();
    expect(body.get('doc_id')).toBe(INSTAGRAM_UNFOLLOW_DOC_ID);
    expect(body.get('fb_api_req_friendly_name')).toBe(INSTAGRAM_UNFOLLOW_FRIENDLY_NAME);
    expect(body.get('fb_dtsg')).toBe('fb-dtsg-token');
    expect(body.get('lsd')).toBe('lsd-token');
    expect(body.get('jazoest')).toMatch(/^2\d+$/);
    expect(body.get('__rev')).toBe('12345');
    const variables = JSON.parse(body.get('variables') ?? '{}');
    expect(variables.target_user_id).toBe('42');
    expect(headers['x-csrftoken']).toBe('csrf-token');
    expect(headers['x-fb-lsd']).toBe('lsd-token');
  });

  it('reports an action block from feedback_required without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ json: { errors: [{ message: 'feedback_required' }] } }),
    );
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('blocked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an action block from HTTP 429', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 429, body: '' }));
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('blocked');
  });

  it('reports an action block when Instagram flags the request as spam', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ json: { spam: true, data: {} } }));
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('blocked');
  });

  it('fails (not blocked) on a server error', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 500, body: 'oops' }));
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('500');
  });

  it('fails when Instagram still reports the follow relationship', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ json: { data: { user: { friendship_status: { following: true } } } } }),
    );
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('friendship_status');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails when the follow-up following-list search still finds the account', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ json: { data: { user: { friendship_status: {} } } } }))
      .mockResolvedValueOnce(fakeResponse({ json: { users: [{ pk: 42, username: 'alina.frames' }] } }));
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('still in your following list');
  });

  it('cannot confirm when the response is not JSON (e.g. an HTML error page with HTTP 200)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ body: '<html>not json</html>' }));
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('not JSON');
  });

  it('trusts a positive friendship_status=false even if verification is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse({ json: { data: { user: { friendship_status: { following: false } } } } }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('unfollowed');
  });
});

describe('isStillFollowing', () => {
  it('returns true when the account appears in the following search', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ json: { users: [{ pk: 42, username: 'alina.frames' }] } }));
    await expect(isStillFollowing(TARGET)).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/friendships/viewer-1/following/');
    expect(String(fetchMock.mock.calls[0][0])).toContain('query=alina.frames');
  });

  it('returns false when the account is gone from the following search', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ json: { users: [{ pk: 7, username: 'someone.else' }] } }));
    await expect(isStillFollowing(TARGET)).resolves.toBe(false);
  });

  it('returns null when the lookup fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(isStillFollowing(TARGET)).resolves.toBeNull();
  });
});

describe('getCookie', () => {
  it('reads existing cookies and returns null for missing ones', () => {
    expect(getCookie('csrftoken')).toBe('csrf-token');
    expect(getCookie('ds_user_id')).toBe('viewer-1');
    expect(getCookie('not_there')).toBeNull();
  });
});

describe('missing session tokens', () => {
  it('fails closed when fb_dtsg/lsd cannot be found', async () => {
    vi.resetModules();
    const fresh = await import('../../src/utils/utils');
    // No module registry, no token-bearing page, and an empty fallback page.
    delete (window as unknown as { require?: unknown }).require;
    document.documentElement.innerHTML = '<html><body></body></html>';
    fetchMock.mockResolvedValueOnce(fakeResponse({ body: '<html></html>' }));

    const result = await fresh.unfollowUser(TARGET, 'csrf-token');
    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('fb_dtsg');

    (window as unknown as { require: (name: string) => unknown }).require = () => undefined;
  });
});

describe('remove follower transport', () => {
  it('POSTs the web remove_follower endpoint with fb_dtsg/jazoest and the right headers', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { status: 'ok' } }));
    const result = await removeFollower({ id: '66278202087', username: 'softlybyfatima' }, 'csrf-token');
    expect(result.outcome).toBe('removed-follower');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.instagram.com/api/v1/friendships/remove_follower/66278202087/');
    expect(options.method).toBe('POST');
    const body = new URLSearchParams(String(options.body));
    expect(body.get('fb_dtsg')).toBe('fb-dtsg-token');
    const checksum = Array.from('fb-dtsg-token').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    expect(body.get('jazoest')).toBe(`2${checksum}`);
    expect(body.get('user_id')).toBeNull();
    const headers = options.headers as Record<string, string>;
    expect(headers['x-csrftoken']).toBe('csrf-token');
    expect(headers['x-ig-app-id']).toBe('936619743392459');
    expect(headers['x-asbd-id']).toBe('359341');
    expect(headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(headers['x-instagram-ajax']).toBe('rollout-123');
  });

  it('fails closed when Instagram answers without status ok', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ json: { status: 'fail', message: 'nope' } }));
    const result = await removeFollower({ id: '1', username: 'target' }, 'csrf-token');
    expect(result.outcome).toBe('failed');
  });
});

