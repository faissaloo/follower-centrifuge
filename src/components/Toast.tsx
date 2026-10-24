import React from 'react';

export interface ToastProps {
  readonly show?: boolean;
  readonly style?: 'success' | 'error' | 'warning' | 'info';
  readonly message: string;
  readonly onClose?: () => void;
  /** Localized accessible label for the close button. */
  readonly closeLabel?: string;
}

/** Small auto-positioned notification used for App-level feedback. */
export const Toast = ({ show = false, style = 'info', message, onClose, closeLabel }: ToastProps) => (
  <div className={`wa-toast wa-toast--${style}${show ? ' wa-toast--visible' : ''}`} role='alert'>
    <span className='wa-toast__bar' aria-hidden='true' />
    <p className='wa-toast__message'>{message}</p>
    <button
      type='button'
      className='wa-toast__close'
      onClick={onClose}
      aria-label={closeLabel === undefined ? '×' : closeLabel}
    >
      &times;
    </button>
  </div>
);
