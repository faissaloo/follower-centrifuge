import React, { FC } from 'react';

/**
 * Brand mark: an engraved instrument seal for the Follower Centrifuge — a deep-stamped
 * radiation trefoil inside a dial ring. Low-contrast and matte: it reads as
 * engraved metal, never as a glowing cartoon symbol.
 */
export const Logo: FC = () => (
  <svg width='40' height='40' viewBox='0 0 40 40' fill='none' aria-hidden='true' focusable='false'>
    <defs>
      <linearGradient id='iu-trefoil-stamp' x1='14' y1='10' x2='26' y2='30' gradientUnits='userSpaceOnUse'>
        <stop offset='0' stopColor='#a8944a' />
        <stop offset='0.6' stopColor='#8a7a3d' />
        <stop offset='1' stopColor='#6e6231' />
      </linearGradient>
    </defs>
    <circle cx='20' cy='20' r='18.6' fill='#202119' />
    <circle cx='20' cy='20' r='18.6' stroke='rgba(236,232,216,0.16)' strokeWidth='1' />
    <circle cx='20' cy='20' r='15.2' stroke='rgba(236,232,216,0.07)' strokeWidth='1' />
    <g stroke='rgba(236,232,216,0.13)' strokeWidth='0.8'>
      <line x1='20.00' y1='4.00' x2='20.00' y2='2.20' />
      <line x1='24.32' y1='3.87' x2='24.61' y2='2.81' />
      <line x1='28.00' y1='6.14' x2='28.90' y2='4.58' />
      <line x1='31.81' y1='8.19' x2='32.59' y2='7.41' />
      <line x1='33.86' y1='12.00' x2='35.42' y2='11.10' />
      <line x1='36.13' y1='15.68' x2='37.19' y2='15.39' />
      <line x1='36.00' y1='20.00' x2='37.80' y2='20.00' />
      <line x1='36.13' y1='24.32' x2='37.19' y2='24.61' />
      <line x1='33.86' y1='28.00' x2='35.42' y2='28.90' />
      <line x1='31.81' y1='31.81' x2='32.59' y2='32.59' />
      <line x1='28.00' y1='33.86' x2='28.90' y2='35.42' />
      <line x1='24.32' y1='36.13' x2='24.61' y2='37.19' />
      <line x1='20.00' y1='36.00' x2='20.00' y2='37.80' />
      <line x1='15.68' y1='36.13' x2='15.39' y2='37.19' />
      <line x1='12.00' y1='33.86' x2='11.10' y2='35.42' />
      <line x1='8.19' y1='31.81' x2='7.41' y2='32.59' />
      <line x1='6.14' y1='28.00' x2='4.58' y2='28.90' />
      <line x1='3.87' y1='24.32' x2='2.81' y2='24.61' />
      <line x1='4.00' y1='20.00' x2='2.20' y2='20.00' />
      <line x1='3.87' y1='15.68' x2='2.81' y2='15.39' />
      <line x1='6.14' y1='12.00' x2='4.58' y2='11.10' />
      <line x1='8.19' y1='8.19' x2='7.41' y2='7.41' />
      <line x1='12.00' y1='6.14' x2='11.10' y2='4.58' />
      <line x1='15.68' y1='3.87' x2='15.39' y2='2.81' />
    </g>
    <g fill='url(#iu-trefoil-stamp)'>
      <path d='M14.9 11.17A10.2 10.2 0 0 1 25.1 11.17L22.3 16.02A4.6 4.6 0 0 0 17.7 16.02Z' />
      <path d='M14.9 11.17A10.2 10.2 0 0 1 25.1 11.17L22.3 16.02A4.6 4.6 0 0 0 17.7 16.02Z' transform='rotate(120 20 20)' />
      <path d='M14.9 11.17A10.2 10.2 0 0 1 25.1 11.17L22.3 16.02A4.6 4.6 0 0 0 17.7 16.02Z' transform='rotate(240 20 20)' />
      <circle cx='20' cy='20' r='4.6' />
    </g>
    <circle cx='20' cy='20' r='4.6' stroke='rgba(236,232,216,0.07)' strokeWidth='0.8' />
  </svg>
);
