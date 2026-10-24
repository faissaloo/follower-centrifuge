import React, { FC } from 'react';
import { Logo } from './Logo';

/**
 * Product wordmark for the Follower Centrifuge (uranium-enrichment edition).
 *
 * The display name is provided by i18n (`appName`) so the copy stays in one
 * place. On screen it is split into a refined two-line wordmark — the product
 * name on the first line, the edition tracked out and uppercase beneath it —
 * while a screen-reader-only span (and the container aria-label) keep the
 * complete, exact product name in the accessibility tree.
 */
export const BRAND_NAME = 'Follower Centrifuge';
export const BRAND_EDITION = '6000 Pro Max Ultra Plus Titanium Reloaded Flash Xtreme HD Turbo Enriched';
export const BRAND_FULL_NAME = `${BRAND_NAME} ${BRAND_EDITION}`;

export interface BrandWordmarkProps {
  /** Full product name, usually `t(lang, 'appName')`. */
  readonly name: string;
  /** Larger treatment used by the launch header. */
  readonly large?: boolean;
  /** Stretch the wordmark across the available toolbar width. */
  readonly toolbar?: boolean;
}

/**
 * Splits a product name into wordmark + edition without hard-coding copy that
 * belongs to i18n. The edition starts at the "6000" model marker; a name
 * without that marker falls back to a first-space split.
 */
function splitProductName(name: string): { readonly wordmark: string; readonly edition: string } {
  const trimmed = name.trim();
  const modelMarker = trimmed.indexOf(' 6000 ');
  if (modelMarker > 0) {
    return { wordmark: trimmed.slice(0, modelMarker), edition: trimmed.slice(modelMarker + 1) };
  }
  const split = trimmed.indexOf(' ');
  if (split <= 0) {
    return { wordmark: trimmed, edition: '' };
  }
  return { wordmark: trimmed.slice(0, split), edition: trimmed.slice(split + 1) };
}

export const BrandWordmark: FC<BrandWordmarkProps> = ({ name, large = false, toolbar = false }) => {
  const { wordmark, edition } = splitProductName(name);
  const classes = ['wa-brand', large ? 'wa-brand--launch' : '', toolbar ? 'wa-brand--toolbar' : '']
    .filter(className => className !== '')
    .join(' ');
  return (
    <div className={classes} aria-label={name}>
      <span className='wa-brand__mark' aria-hidden='true'>
        <Logo />
      </span>
      <span className='wa-brand__text' aria-hidden='true'>
        <strong>{wordmark}</strong>
        {edition !== '' && <small>{edition}</small>}
      </span>
      <span className='wa-sr-only'>{name}</span>
    </div>
  );
};
