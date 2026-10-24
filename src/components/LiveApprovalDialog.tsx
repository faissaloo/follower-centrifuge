import React, { useEffect, useRef, useState } from 'react';
import { UserNode } from '../model/user';
import { liveConfirmationPhrase } from '../utils/approval';
import { Language, t } from '../utils/i18n';
import { WarningIcon } from './icons/WarningIcon';

export interface LiveApprovalDialogProps {
  /** The dialog renders nothing while closed. */
  readonly open: boolean;
  readonly lang: Language;
  /** The exact accounts a live run would unfollow, in plan order. */
  readonly targets: readonly UserNode[];
  readonly onCancel: () => void;
  /** Called with the typed phrase only after every gate passes. */
  readonly onConfirm: (typedConfirmation: string) => void;
}

/**
 * Last line of defence before real unfollows.
 *
 * Three independent requirements must all hold before the confirm button is
 * enabled: the irreversible warning is displayed, the "I understand" checkbox
 * is ticked, and the typed phrase exactly equals `liveConfirmationPhrase(count)`.
 * The dialog never confirms by itself — no timers, no defaults.
 */
export const LiveApprovalDialog = ({ open, lang, targets, onCancel, onConfirm }: LiveApprovalDialogProps) => {
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Re-arm the gates whenever the exact set of accounts changes (not just the
  // count): a same-size swap of targets must never inherit an approval typed
  // for different accounts.
  const targetSignature = targets
    .map(target => target.id)
    .slice()
    .sort()
    .join('|');
  useEffect(() => {
    if (open) {
      setUnderstood(false);
      setTyped('');
    }
  }, [open, targetSignature]);

  // Minimal focus trap: keep keyboard focus inside the destructive dialog and
  // restore it on close, so background controls cannot be operated while the
  // approval is displayed.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const container = dialogRef.current;
    // The ref can be null if the dialog closed before this effect ran. The DOM
    // typings disagree about nullability here, so the guard is intentional.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (container === null) {
      return undefined;
    }
    const previousFocus = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const selector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusable = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(selector));
    const initialFocusable = focusable();
    if (initialFocusable.length > 0) {
      initialFocusable[0].focus();
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') {
        return;
      }
      const items = focusable();
      if (items.length === 0) {
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && container.contains(active);
      if (event.shiftKey && (active === firstItem || !inside)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !inside)) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, [open, targetSignature]);

  if (!open) {
    return null;
  }

  const count = targets.length;
  const phrase = liveConfirmationPhrase(count);
  const phraseMatches = typed === phrase;
  const canConfirm = understood && phraseMatches && count > 0;

  return (
    <div className='wa-dialog-backdrop'>
      <div
        ref={dialogRef}
        className='wa-dialog wa-dialog--danger'
        role='dialog'
        aria-modal='true'
        aria-labelledby='wa-approval-title'
        aria-describedby='wa-approval-warning'
        onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape') {
            onCancel();
          }
        }}
      >
        <header className='wa-dialog__header'>
          <span className='wa-dialog__icon' aria-hidden='true'>
            <WarningIcon />
          </span>
          <h2 id='wa-approval-title'>{t(lang, 'approvalTitle')}</h2>
        </header>

        <p className='wa-dialog__intro'>{t(lang, 'approvalIntro', count)}</p>
        <p className='wa-dialog__warning' id='wa-approval-warning' role='alert'>
          {t(lang, 'approvalIrreversible')}
        </p>

        <section className='wa-approval__targets'>
          <h3>{t(lang, 'approvalTargetsLabel', count)}</h3>
          <ul className='wa-approval__list' aria-label={t(lang, 'approvalTargetsLabel', count)}>
            {targets.map(target => (
              <li key={target.id}>
                <span className='wa-approval__username'>@{target.username}</span>
                <span className='wa-approval__fullname'>{target.full_name}</span>
              </li>
            ))}
          </ul>
        </section>

        <label className='wa-checkbox wa-approval__understand'>
          <input
            type='checkbox'
            checked={understood}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setUnderstood(event.currentTarget.checked)}
          />
          <span>{t(lang, 'approvalUnderstand')}</span>
        </label>

        <div className='wa-approval__phrase'>
          <label className='wa-approval__phrase-label' htmlFor='wa-approval-phrase-input'>
            {t(lang, 'approvalPhraseInstruction', phrase)}
          </label>
          <code className='wa-approval__phrase-value'>{phrase}</code>
          <input
            id='wa-approval-phrase-input'
            type='text'
            className='wa-input wa-approval__phrase-input'
            autoComplete='off'
            aria-label={t(lang, 'approvalPhraseInputLabel')}
            aria-invalid={typed !== '' && !phraseMatches}
            value={typed}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTyped(event.currentTarget.value)}
          />
          {typed !== '' && !phraseMatches && <p className='wa-approval__mismatch'>{t(lang, 'approvalPhraseMismatch')}</p>}
        </div>

        <p className='wa-dialog__note'>{t(lang, 'approvalLockedNote')}</p>

        <footer className='wa-dialog__actions'>
          <button type='button' className='wa-btn wa-btn--ghost' onClick={onCancel}>
            {t(lang, 'approvalCancel')}
          </button>
          <button
            type='button'
            className='wa-btn wa-btn--danger'
            disabled={!canConfirm}
            onClick={() => {
              if (canConfirm) {
                onConfirm(typed);
              }
            }}
          >
            {t(lang, 'approvalConfirm')}
          </button>
        </footer>
      </div>
    </div>
  );
};
