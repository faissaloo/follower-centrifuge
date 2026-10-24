import { expect } from 'vitest';
import { networkGuard } from '../setup';

/**
 * Asserts that the shared network guard (tests/setup.ts) was never invoked.
 * The guard is a global fetch stub that throws on any call, so this proves the
 * code under test cannot have reached Instagram or any other real endpoint.
 */
export function expectNoNetworkCalls(): void {
  const calls = networkGuard.mock.calls.length;
  expect(
    calls,
    `expected zero real network requests, but fetch was called ${calls} time(s): ` +
      networkGuard.mock.calls.map(call => String(call[0])).join(', '),
  ).toBe(0);
}
