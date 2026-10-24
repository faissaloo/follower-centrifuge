import { describe, expect, it } from 'vitest';
import {
  buildWhitelistProtection,
  isProtectedBy,
  isProtectedByWhitelist,
  normalizeProtectedUsername,
  withoutProtectionFor,
} from '../../src/utils/whitelist-match';
import { createUserNode } from '../helpers/fixtures';

const pastedAlice = createUserNode({
  id: 'pasted_alice_1735689600000_abc12',
  username: 'Alice',
  fullName: 'Alice',
});

describe('whitelist matching', () => {
  it('normalizes usernames (trim, @ prefix, case)', () => {
    expect(normalizeProtectedUsername('  @Alice.W  ')).toBe('alice.w');
    expect(normalizeProtectedUsername('ALICE')).toBe('alice');
    expect(normalizeProtectedUsername('')).toBe('');
  });

  it('protects by real id', () => {
    const alice = createUserNode({ id: 'real-1', username: 'alice' });
    expect(isProtectedByWhitelist(alice, [createUserNode({ id: 'real-1', username: 'someone-else' })])).toBe(true);
  });

  it('protects a real account through a pasted username entry with a synthetic id', () => {
    const realAlice = createUserNode({ id: 'real-123', username: 'alice' });
    expect(isProtectedByWhitelist(realAlice, [pastedAlice])).toBe(true);
  });

  it('matches usernames case-insensitively and ignores a leading @', () => {
    const realAlice = createUserNode({ id: 'real-123', username: 'ALICE' });
    expect(isProtectedByWhitelist(realAlice, [createUserNode({ id: 'x', username: '@alice' })])).toBe(true);
  });

  it('does not protect different accounts with different ids and usernames', () => {
    const bob = createUserNode({ id: 'real-2', username: 'bob' });
    expect(isProtectedByWhitelist(bob, [pastedAlice])).toBe(false);
  });

  it('does not let an empty username entry protect everybody', () => {
    const anyone = createUserNode({ id: 'real-3', username: 'carol' });
    const emptyEntry = createUserNode({ id: 'y', username: '' });
    expect(isProtectedBy(anyone, buildWhitelistProtection([emptyEntry]))).toBe(false);
    expect(isProtectedByWhitelist(anyone, [emptyEntry])).toBe(false);
  });

  it('builds id and username lookup sets', () => {
    const protection = buildWhitelistProtection([
      pastedAlice,
      createUserNode({ id: 'real-9', username: 'zoe' }),
    ]);
    expect(Array.from(protection.ids).sort()).toEqual(['pasted_alice_1735689600000_abc12', 'real-9']);
    expect(Array.from(protection.usernames).sort()).toEqual(['alice', 'zoe']);
  });

  it('removes protection entries by id and by username', () => {
    const realAlice = createUserNode({ id: 'real-123', username: 'alice' });
    const remaining = withoutProtectionFor(realAlice, [
      pastedAlice,
      createUserNode({ id: 'real-123', username: 'alice' }),
      createUserNode({ id: 'z', username: 'zoe' }),
    ]);
    expect(remaining.map(entry => entry.id)).toEqual(['z']);
  });
});
