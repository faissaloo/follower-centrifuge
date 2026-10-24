import { describe, expect, it } from 'vitest';
import { isLiveApprovalValid, liveConfirmationPhrase } from '../../src/utils/approval';
import { LiveApproval } from '../../src/model/action-plan';

function approval(overrides: Partial<LiveApproval> = {}): LiveApproval {
  return {
    typedConfirmation: liveConfirmationPhrase(3),
    expectedCount: 3,
    approvedAt: 1735689600000,
    ...overrides,
  };
}

describe('liveConfirmationPhrase', () => {
  it('embeds the exact target count', () => {
    expect(liveConfirmationPhrase(0)).toBe('UNFOLLOW 0');
    expect(liveConfirmationPhrase(1)).toBe('UNFOLLOW 1');
    expect(liveConfirmationPhrase(137)).toBe('UNFOLLOW 137');
  });
});

describe('isLiveApprovalValid', () => {
  it('accepts the exact phrase for the exact count', () => {
    expect(isLiveApprovalValid(approval(), 3)).toBe(true);
  });

  it('rejects an approval whose expected count does not match the plan', () => {
    expect(isLiveApprovalValid(approval({ expectedCount: 4 }), 3)).toBe(false);
  });

  it('rejects a phrase with the wrong count', () => {
    expect(isLiveApprovalValid(approval({ typedConfirmation: 'UNFOLLOW 4' }), 3)).toBe(false);
  });

  it('is case sensitive', () => {
    expect(isLiveApprovalValid(approval({ typedConfirmation: 'unfollow 3' }), 3)).toBe(false);
    expect(isLiveApprovalValid(approval({ typedConfirmation: 'Unfollow 3' }), 3)).toBe(false);
  });

  it('is whitespace sensitive', () => {
    expect(isLiveApprovalValid(approval({ typedConfirmation: ' UNFOLLOW 3' }), 3)).toBe(false);
    expect(isLiveApprovalValid(approval({ typedConfirmation: 'UNFOLLOW 3 ' }), 3)).toBe(false);
    expect(isLiveApprovalValid(approval({ typedConfirmation: 'UNFOLLOW  3' }), 3)).toBe(false);
  });

  it('rejects empty/absent confirmations', () => {
    expect(isLiveApprovalValid(approval({ typedConfirmation: '' }), 3)).toBe(false);
  });

  it('never validates a zero-target live plan', () => {
    expect(isLiveApprovalValid(approval({ typedConfirmation: liveConfirmationPhrase(0), expectedCount: 0 }), 0)).toBe(
      false,
    );
  });

  it('never validates a negative target count', () => {
    expect(isLiveApprovalValid(approval({ typedConfirmation: liveConfirmationPhrase(-1), expectedCount: -1 }), -1)).toBe(
      false,
    );
  });
});
