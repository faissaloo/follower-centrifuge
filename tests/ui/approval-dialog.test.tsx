import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveApprovalDialog } from '../../src/components/LiveApprovalDialog';
import { createDemoCandidates } from '../../src/preview/demo-data';
import { liveConfirmationPhrase } from '../../src/utils/approval';

afterEach(cleanup);

const TARGETS = createDemoCandidates()
  .slice(0, 3)
  .map(candidate => candidate.user);

interface RenderOptions {
  readonly open?: boolean;
  readonly targets?: typeof TARGETS;
}

function renderDialog(options: RenderOptions = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const view = render(
    <LiveApprovalDialog
      open={options.open === undefined ? true : options.open}
      lang='en'
      targets={options.targets === undefined ? TARGETS : options.targets}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { ...view, onCancel, onConfirm };
}

function typePhrase(value: string): void {
  fireEvent.input(screen.getByLabelText('Confirmation phrase'), { target: { value } });
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Unfollow / remove for real' });
}

function understandCheckbox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('checkbox');
}

describe('LiveApprovalDialog', () => {
  it('renders nothing while closed', () => {
    const { container } = renderDialog({ open: false });
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the exact target count, usernames and the irreversible warning', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/really unfollows and\/or removes 3 accounts/)).toBeTruthy();
    expect(screen.getByText('@alina.frames')).toBeTruthy();
    expect(screen.getByText('@brassandbone')).toBeTruthy();
    expect(screen.getByText('@citrus.archive')).toBeTruthy();
    expect(screen.getByText(/cant undo here/)).toBeTruthy();
    expect(screen.getByText(liveConfirmationPhrase(3))).toBeTruthy();
  });

  it('never confirms without the typed phrase, even after the checkbox', () => {
    const { onConfirm } = renderDialog();
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(understandCheckbox());
    expect(understandCheckbox().checked).toBe(true);
    expect(confirmButton().disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('never confirms with only the exact phrase, without the checkbox', () => {
    const { onConfirm } = renderDialog();
    typePhrase(liveConfirmationPhrase(3));
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ['lowercase phrase', 'unfollow 3'],
    ['wrong count', 'UNFOLLOW 2'],
    ['extra whitespace', ' UNFOLLOW 3'],
    ['trailing whitespace', 'UNFOLLOW 3 '],
    ['missing number', 'UNFOLLOW'],
  ])('stays disabled for a %s even with the checkbox ticked', (_label: string, value: string) => {
    const { onConfirm } = renderDialog();
    fireEvent.click(understandCheckbox());
    typePhrase(value);
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows a mismatch hint for a non-matching phrase', () => {
    renderDialog();
    typePhrase('UNFOLLOW 99');
    expect(screen.getByText(/has to match exactly/)).toBeTruthy();
  });

  it('enables confirm only when checkbox and exact phrase are both provided, then calls onConfirm with the phrase', () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(understandCheckbox());
    typePhrase(liveConfirmationPhrase(3));
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('UNFOLLOW 3');
  });

  it('cancels without ever confirming', () => {
    const { onCancel, onConfirm } = renderDialog();
    fireEvent.click(understandCheckbox());
    typePhrase(liveConfirmationPhrase(3));
    fireEvent.click(screen.getByRole('button', { name: /Cancel — dont remove/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels on Escape without confirming', () => {
    const { onCancel, onConfirm } = renderDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('re-arms the gates when reopened', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const view = render(<LiveApprovalDialog open lang='en' targets={TARGETS} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(understandCheckbox());
    typePhrase(liveConfirmationPhrase(3));
    expect(confirmButton().disabled).toBe(false);
    view.rerender(<LiveApprovalDialog open={false} lang='en' targets={TARGETS} onCancel={onCancel} onConfirm={onConfirm} />);
    view.rerender(<LiveApprovalDialog open lang='en' targets={TARGETS} onCancel={onCancel} onConfirm={onConfirm} />);
    expect(understandCheckbox().checked).toBe(false);
    expect(confirmButton().disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cannot be confirmed with zero targets', () => {
    renderDialog({ targets: [] });
    fireEvent.click(understandCheckbox());
    typePhrase(liveConfirmationPhrase(0));
    expect(confirmButton().disabled).toBe(true);
  });

  it('re-arms when the target set changes to a different same-size set', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const first = TARGETS.slice(0, 2);
    const second = TARGETS.slice(1, 3);
    const view = render(<LiveApprovalDialog open lang='en' targets={first} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(understandCheckbox());
    typePhrase(liveConfirmationPhrase(2));
    expect(confirmButton().disabled).toBe(false);

    // Same count, different accounts behind the open dialog: gates must reset.
    view.rerender(<LiveApprovalDialog open lang='en' targets={second} onCancel={onCancel} onConfirm={onConfirm} />);
    expect(understandCheckbox().checked).toBe(false);
    const phraseAfterRerender = screen.getByLabelText('Confirmation phrase');
    if (!(phraseAfterRerender instanceof HTMLInputElement)) {
      throw new Error('expected the confirmation phrase input');
    }
    expect(phraseAfterRerender.value).toBe('');
    expect(confirmButton().disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus inside the dialog', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    // Focus starts inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tab cycles through the dialog's controls and never leaves it.
    for (let index = 0; index < 8; index += 1) {
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    // Shift+Tab from the first control wraps to the last control.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape still cancels in the trapped dialog.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('renders the dialog in Spanish when asked', () => {
    render(<LiveApprovalDialog open lang='es' targets={TARGETS} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/confirmación final/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dejar de seguir \/ quitar de seguidores de verdad/ })).toBeTruthy();
  });
});
