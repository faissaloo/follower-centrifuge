import React from 'react';
import { AuditCandidate } from '../model/audit';
import { Language, t } from '../utils/i18n';
import { ConfidenceMeter, GuessTone, RelationshipBadge } from './AuditPrimitives';
import { ShieldIcon } from './icons/ShieldIcon';

export interface AuditCandidateRowProps {
  readonly candidate: AuditCandidate;
  readonly lang: Language;
  /** Whether this row is included in the current unfollow selection. */
  readonly selected: boolean;
  /**
   * Only confidently classified accounts of the selected target gender can be
   * unfollowed. Follower-only accounts, whitelisted accounts, off-target and
   * low-confidence guesses are not selectable.
   */
  readonly selectable: boolean;
  /** Localized, visible reason rendered when the row is not selectable. */
  readonly lockedExplanation?: string;
  readonly whitelisted: boolean;
  /** 'via main' / 'via fallback' / 'via demo' when the guess has a source. */
  readonly classifierRoleLabel?: string;
  /** Tooltip with source/model details. */
  readonly classifierTitle?: string;
  readonly onToggleSelected: (selected: boolean) => void;
  readonly onToggleWhitelist: () => void;
}

function percentOf(confidence: number): number {
  if (!isFinite(confidence)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(confidence * 100)));
}

/**
 * The "likely female · 97%" style label for one of the five classifier
 * categories; never asserts a category as a fact.
 */
function guessLabel(lang: Language, candidate: AuditCandidate): { readonly text: string; readonly tone: GuessTone } {
  const guess = candidate.gender;
  if (guess === null) {
    return { text: t(lang, 'unclassified'), tone: 'unknown' };
  }
  const percent = percentOf(guess.confidence);
  switch (guess.gender) {
    case 'female':
      return { text: t(lang, 'likelyFemalePercent', percent), tone: 'female' };
    case 'male':
      return { text: t(lang, 'likelyMalePercent', percent), tone: 'male' };
    case 'machine':
      return { text: t(lang, 'machinePercent', percent), tone: 'machine' };
    case 'organization':
      return { text: t(lang, 'organizationPercent', percent), tone: 'organization' };
    case 'ambiguous':
    default:
      return { text: t(lang, 'ambiguousPercent', percent), tone: 'ambiguous' };
  }
}

/**
 * One account in the review list.
 *
 * Presentational and fully controlled: the checkbox state, whitelist state and
 * all mutations come from the parent through callbacks.
 */
export const AuditCandidateRow = ({
  candidate,
  lang,
  selected,
  selectable,
  lockedExplanation,
  whitelisted,
  classifierRoleLabel,
  classifierTitle,
  onToggleSelected,
  onToggleWhitelist,
}: AuditCandidateRowProps) => {
  const { user } = candidate;
  const guess = guessLabel(lang, candidate);
  const selectionLabel = selectable
    ? t(lang, 'selectAccount', user.username)
    : t(lang, 'selectAccountDisabled', user.username);

  return (
    <li className={`wa-row${selected ? ' wa-row--selected' : ''}${selectable ? '' : ' wa-row--locked'}`}>
      <span className='wa-row__check'>
        <input
          type='checkbox'
          className='wa-row__checkbox'
          aria-label={selectionLabel}
          title={selectable ? undefined : lockedExplanation}
          disabled={!selectable}
          checked={selected}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onToggleSelected(event.currentTarget.checked)}
        />
      </span>

      <img className='wa-row__avatar' src={user.profile_pic_url} alt='' aria-hidden='true' />

      <span className='wa-row__identity'>
        <a className='wa-row__username' href={`https://www.instagram.com/${user.username}/`} target='_blank' rel='noreferrer'>
          @{user.username}
        </a>
        <span className='wa-row__fullname'>{user.full_name}</span>
        <span className='wa-row__badges'>
          <RelationshipBadge lang={lang} relationship={candidate.relationship} />
          {user.is_private && <span className='wa-badge wa-badge--private'>{t(lang, 'privateBadge')}</span>}
          {user.is_verified && <span className='wa-badge wa-badge--verified'>{t(lang, 'verifiedBadge')}</span>}
        </span>
      </span>

      <span className='wa-row__guess'>
        <span className={`wa-row__guess-label wa-row__guess-label--${guess.tone}`}>{guess.text}</span>
        {classifierRoleLabel !== undefined && (
          <span className='wa-row__classifier' title={classifierTitle}>
            {classifierRoleLabel}
          </span>
        )}
        <ConfidenceMeter lang={lang} confidence={candidate.gender === null ? 0 : candidate.gender.confidence} tone={guess.tone} />
        {candidate.gender !== null && candidate.gender.reason !== undefined && (
          <span className='wa-row__reason'>{candidate.gender.reason}</span>
        )}
        {!selectable && lockedExplanation !== undefined && <span className='wa-row__locked'>{lockedExplanation}</span>}
      </span>

      <span className='wa-row__actions'>
        <button
          type='button'
          className={`wa-btn wa-btn--chip${whitelisted ? ' wa-btn--chip-active' : ''}`}
          aria-label={
            whitelisted
              ? t(lang, 'unprotectAccount', user.username)
              : t(lang, 'protectAccount', user.username)
          }
          aria-pressed={whitelisted}
          title={t(lang, 'whitelistToggleTitle')}
          onClick={onToggleWhitelist}
        >
          <ShieldIcon />
          {whitelisted ? t(lang, 'unprotectButton') : t(lang, 'protectButton')}
        </button>
      </span>
    </li>
  );
};
