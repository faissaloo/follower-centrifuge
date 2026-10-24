/**
 * Shared building blocks for the audit UI.
 *
 * These are deliberately small and presentation-only so the more complex
 * screens can stay readable and every visual contract (relationship badge,
 * confidence bar, dry-run/live banner) is rendered in exactly one place.
 */
import React from 'react';
import { ActionMode } from '../model/action-plan';
import { FollowRelationship } from '../model/audit';
import { GenderCategory } from '../model/gender';
import { Language, t } from '../utils/i18n';
import { BeakerIcon } from './icons/BeakerIcon';
import { WarningIcon } from './icons/WarningIcon';

// ---------------------------------------------------------------------------
// ModeBanner: THE visual distinction between a simulation and a real run.
// ---------------------------------------------------------------------------

export interface ModeBannerProps {
  readonly lang: Language;
  readonly mode: ActionMode;
  /** Number of live unfollows Instagram confirmed (ignored for dry runs). */
  readonly unfollowedCount?: number;
}

/**
 * Banner shown above the execution log.
 *
 * Dry runs get a calm sage "simulation" banner, live runs an assertive
 * terracotta "live run" alert. Colour is never the only signal: the heading
 * text, the icon, the ARIA role and the `data-mode` attribute all differ.
 */
export const ModeBanner = ({ lang, mode, unfollowedCount = 0 }: ModeBannerProps) => {
  const isLive = mode === 'live';
  return (
    <section
      className={`wa-mode-banner wa-mode-banner--${isLive ? 'live' : 'dry'}`}
      role={isLive ? 'alert' : 'status'}
      aria-live={isLive ? 'assertive' : 'polite'}
      data-mode={mode}
      data-testid='mode-banner'
    >
      <span className='wa-mode-banner__icon' aria-hidden='true'>
        {isLive ? <WarningIcon /> : <BeakerIcon />}
      </span>
      <div className='wa-mode-banner__text'>
        <h2>{t(lang, isLive ? 'execLiveTitle' : 'execDryTitle')}</h2>
        <p>{t(lang, isLive ? 'execLiveBody' : 'execDryBody', unfollowedCount)}</p>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// RelationshipBadge
// ---------------------------------------------------------------------------

export interface RelationshipBadgeProps {
  readonly lang: Language;
  readonly relationship: FollowRelationship;
}

/** "You follow" / "Follows you" / "Mutual" pill. */
export const RelationshipBadge = ({ lang, relationship }: RelationshipBadgeProps) => {
  const labelKey =
    relationship === 'mutual' ? 'relMutual' : relationship === 'following' ? 'relFollowing' : 'relFollower';
  return (
    <span className={`wa-badge wa-badge--rel wa-badge--rel-${relationship}`} title={t(lang, 'relationshipLabel')}>
      {t(lang, labelKey)}
    </span>
  );
};

// ---------------------------------------------------------------------------
// ConfidenceMeter
// ---------------------------------------------------------------------------

/**
 * Visual tone of a guess: one per classifier category, plus `unknown` for
 * accounts that were never classified. Colour is never the only signal — the
 * row label always spells the category out.
 */
export type GuessTone = GenderCategory | 'unknown';

export interface ConfidenceMeterProps {
  readonly confidence: number;
  readonly tone: GuessTone;
  readonly lang: Language;
}

function confidencePercent(confidence: number): number {
  if (!isFinite(confidence)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(confidence * 100)));
}

/**
 * Small horizontal confidence bar. The numeric label is rendered by the caller,
 * so the bar itself is decorative and hidden from assistive technology.
 */
export const ConfidenceMeter = ({ confidence, tone, lang }: ConfidenceMeterProps) => {
  const percent = confidencePercent(confidence);
  return (
    <span
      className={`wa-confidence wa-confidence--${tone}`}
      aria-hidden='true'
      title={t(lang, 'guessEstimateNote')}
    >
      <span className='wa-confidence__fill' style={{ width: `${percent}%` }} />
    </span>
  );
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationProps {
  readonly lang: Language;
  readonly page: number;
  readonly maxPage: number;
  readonly onPageChange: (page: number) => void;
  readonly shownCount?: number;
  readonly totalCount?: number;
}

export const Pagination = ({ lang, page, maxPage, onPageChange, shownCount, totalCount }: PaginationProps) => (
  <nav className='wa-pagination' aria-label={t(lang, 'pageLabel', page, maxPage)}>
    <button
      type='button'
      className='wa-btn wa-btn--ghost'
      aria-label={t(lang, 'previousPage')}
      disabled={page <= 1}
      onClick={() => onPageChange(page - 1)}
    >
      ‹
    </button>
    <span className='wa-pagination__label'>{t(lang, 'pageLabel', page, maxPage)}</span>
    <button
      type='button'
      className='wa-btn wa-btn--ghost'
      aria-label={t(lang, 'nextPage')}
      disabled={page >= maxPage}
      onClick={() => onPageChange(page + 1)}
    >
      ›
    </button>
    {shownCount !== undefined && totalCount !== undefined && (
      <span className='wa-pagination__count'>{t(lang, 'showingAccounts', shownCount, totalCount)}</span>
    )}
  </nav>
);
