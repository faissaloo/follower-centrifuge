import React, { FC } from 'react';

/** "Not followed" avatar glyph; muted line art (inherits text colour). */
export const UserUncheckIcon: FC = () => (
  <svg
    width='24'
    height='24'
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='1.7'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    focusable='false'
  >
    <path d='M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' />
    <circle cx='8.5' cy='7' r='4' />
    <line x1='18' y1='8' x2='23' y2='13' />
    <line x1='23' y1='8' x2='18' y2='13' />
  </svg>
);
