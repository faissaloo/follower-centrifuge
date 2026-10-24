import { describe, expect, it, vi } from 'vitest';
import { copyListToClipboard, serializeUsersCsv, serializeUsersJson } from '../../src/utils/utils';
import { createCandidate, createUserNode } from '../helpers/fixtures';

const ALICE = createUserNode({ id: '1', username: 'alice', fullName: 'Alice "Wonder"', isPrivate: true, isVerified: true });
const BOB = createUserNode({ id: '2', username: 'bob', fullName: 'Bob' });

describe('exports never leak classification data', () => {
  it('JSON export contains only public account fields', () => {
    // Build a candidate with a gender guess; exporting the UserNode must not
    // include the guess, confidence, reason or source.
    const candidate = createCandidate({ id: '1', username: 'alice', gender: 'woman', confidence: 0.97 });
    const payload = serializeUsersJson([candidate.user]);
    expect(payload).not.toMatch(/gender|confidence|reason|deepseek/i);
    expect(JSON.parse(payload)).toEqual([
      expect.objectContaining({ id: '1', username: 'alice' }),
    ]);
  });

  it('CSV export has exactly the public headers', () => {
    const csv = serializeUsersCsv([ALICE, BOB]);
    const header = csv.split('\n')[0];
    expect(header).toBe('id,username,full_name,is_verified,is_private,profile_pic_url');
    expect(csv).not.toMatch(/gender|confidence|reason/i);
    expect(csv.split('\n')).toHaveLength(3);
  });

  it('CSV escapes quotes in display names', () => {
    expect(serializeUsersCsv([ALICE])).toContain('"Alice ""Wonder"""');
  });

  it('JSON export handles an empty list', () => {
    expect(serializeUsersJson([])).toBe('[]');
    expect(serializeUsersCsv([])).toBe('id,username,full_name,is_verified,is_private,profile_pic_url');
  });
});

describe('copyListToClipboard', () => {
  it('copies a sorted, newline-separated username list and alerts', async () => {
    // The global test setup installs a clipboard stub on navigator.
    const writeText = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    await copyListToClipboard([BOB, ALICE], 'copied!');
    expect(writeText).toHaveBeenCalledWith('alice\nbob\n');
    expect(alert).toHaveBeenCalledWith('copied!');
  });
});
