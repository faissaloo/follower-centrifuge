import React from 'react';

/**
 * Centrifuge animation — a gas-centrifuge "enrichment cascade" motif for the
 * Follower Centrifuge. Purely decorative (aria-hidden) and CSS-driven:
 * counter-rotating rotor rings, a pulsing core, and staged cascade bars.
 *
 * Motion is disabled automatically under `prefers-reduced-motion`.
 */
export interface CentrifugeProps {
  readonly size?: 'sm' | 'md' | 'lg';
  /** Faster spin (used while a scan is actively classifying). */
  readonly enriching?: boolean;
  /** Adds a compact caption ring (decorative, not announced). */
  readonly className?: string;
}

const CASCADE_BARS = 8;

export const Centrifuge = ({ size = 'md', enriching = false, className }: CentrifugeProps) => {
  const classes = [
    'wa-centrifuge',
    `wa-centrifuge--${size}`,
    enriching ? 'wa-centrifuge--enriching' : '',
    className === undefined ? '' : className,
  ]
    .filter(part => part !== '')
    .join(' ');

  const bars: React.JSX.Element[] = [];
  for (let index = 0; index < CASCADE_BARS; index += 1) {
    bars.push(<span key={index} className='wa-centrifuge__bar' />);
  }

  return (
    <div className={classes} aria-hidden='true'>
      <span className='wa-centrifuge__ring wa-centrifuge__ring--outer' />
      <span className='wa-centrifuge__ring wa-centrifuge__ring--mid' />
      <span className='wa-centrifuge__ring wa-centrifuge__ring--inner' />
      <span className='wa-centrifuge__core' />
      <span className='wa-centrifuge__cascade'>{bars}</span>
    </div>
  );
};
