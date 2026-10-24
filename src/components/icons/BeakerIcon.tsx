import React, { FC } from 'react';

/** Round-bottom flask used by the dry-run ("simulation") banner. */
export const BeakerIcon: FC = () => (
  <svg
    width='18'
    height='18'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='1.7'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    focusable='false'
  >
    <path d='M9 3h6' />
    <path d='M10 3v6.1L4.95 18A2 2 0 0 0 6.65 21h10.7A2 2 0 0 0 19.05 18L14 9.1V3' />
    <path d='M7.6 14.4h8.8' />
  </svg>
);
