import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/preact';

/**
 * Shared test setup.
 *
 * Hard safety rule: automated tests must NEVER reach the real network. Every
 * real API (Instagram, DeepSeek) is replaced by an injected fake in tests, and
 * the global `fetch` below fails loudly so an accidental real call is
 * impossible to miss. Tests that need to exercise a fetch-based transport
 * stub `fetch` themselves (see `vi.stubGlobal('fetch', ...)`).
 */

export class NetworkDisabledError extends Error {
  constructor(input: unknown) {
    super(
      `Automated tests must not perform real network requests (attempted: ${String(input)}). ` +
        'Inject a fake transport instead.',
    );
    this.name = 'NetworkDisabledError';
  }
}

export const networkGuard = vi.fn(async (input: unknown) => {
  throw new NetworkDisabledError(input);
});

/** Browser egress APIs other than fetch: constructing/using them fails loudly. */
function createForbiddenTransport(name: string): new (...args: unknown[]) => never {
  return class ForbiddenTransport {
    constructor() {
      throw new NetworkDisabledError(`${name} (non-fetch browser transport)`);
    }
  } as unknown as new (...args: unknown[]) => never;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', networkGuard);
  // Tests are structurally offline: no fetch, XHR, WebSocket, EventSource or
  // sendBeacon may reach the network, even if a test forgets to inject a fake.
  vi.stubGlobal('XMLHttpRequest', createForbiddenTransport('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', createForbiddenTransport('WebSocket'));
  vi.stubGlobal('EventSource', createForbiddenTransport('EventSource'));
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('prompt', vi.fn(() => null));
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: vi.fn(() => {
        throw new NetworkDisabledError('navigator.sendBeacon');
      }),
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  }
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  }
});

afterEach(() => {
  // Unmount any component rendered by @testing-library/preact so state never
  // leaks between tests (globals are disabled, so its own auto-cleanup is not
  // registered).
  cleanup();
  vi.unstubAllGlobals();
});
