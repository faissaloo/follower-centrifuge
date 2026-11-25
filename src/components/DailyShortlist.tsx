import React, { useEffect, useState } from 'react';
import {
  DailyShortlistState,
  matchStrength,
  MAX_FILTER_PROMPT_LENGTH,
  MAX_MANUAL_SEEDS,
  MatchStrength,
  SHORTLIST_REFRESH_MS,
  ShortlistCandidate,
} from '../model/growth';
import { Language, t } from '../utils/i18n';
import { BrandWordmark } from './icons/BrandWordmark';
import { parseSeedAccounts } from '../utils/daily-shortlist';

export interface ShortlistFollowResult {
  readonly ok: boolean;
  readonly state?: 'requested' | 'following';
  readonly message?: string;
}

export interface DailyShortlistProps {
  readonly lang: Language;
  readonly prompt: string;
  readonly state: DailyShortlistState | null;
  readonly busy: boolean;
  readonly progress?: string;
  readonly error?: string;
  readonly promptError?: string;
  readonly disabledReason?: string;
  readonly seeds?: readonly string[];
  readonly seedWarning?: string;
  readonly onSavePrompt: (prompt: string) => void;
  readonly onSaveSeeds?: (seeds: readonly string[]) => void;
  readonly onRefresh: () => void;
  /** Explicit, per-row follow action; never automatic. */
  readonly onFollow?: (candidate: ShortlistCandidate) => Promise<ShortlistFollowResult>;
}

const EMPTY_SEEDS: readonly string[] = [];

const STRENGTH_LABEL_KEYS: Record<MatchStrength, 'dailyMatchStrong' | 'dailyMatchGood' | 'dailyMatchMaybe' | 'dailyMatchWeak'> = {
  strong: 'dailyMatchStrong',
  good: 'dailyMatchGood',
  maybe: 'dailyMatchMaybe',
  weak: 'dailyMatchWeak',
};

function formatRelative(from: number, now: number): string {
  const delta = Math.max(0, from - now);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) {
    return '<1m';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function avatarFallback(username: string): string {
  return username.trim().charAt(0).toUpperCase() || '?';
}

/** Read-only shortlist with a single explicit manual follow action per row. */
export const DailyShortlist = ({
  lang,
  prompt,
  state,
  busy,
  progress,
  error,
  promptError,
  seeds = EMPTY_SEEDS,
  seedWarning,
  disabledReason,
  onSavePrompt,
  onSaveSeeds,
  onRefresh,
  onFollow,
}: DailyShortlistProps) => {
  const [draft, setDraft] = useState(prompt);
  useEffect(() => {
    setDraft(prompt);
  }, [prompt]);
  const [tags, setTags] = useState<string[]>([...seeds]);
  const [seedDraft, setSeedDraft] = useState('');
  const [seedError, setSeedError] = useState<string | undefined>(undefined);
  useEffect(() => {
    setTags([...seeds]);
  }, [seeds]);

  const commitSeeds = (raw: string): void => {
    if (raw.trim() === '') {
      return;
    }
    const parsed = parseSeedAccounts(`${tags.join(' ')}, ${raw}`);
    if (parsed.length === tags.length) {
      setSeedError(t(lang, 'dailySeedInvalid'));
      return;
    }
    const next = parsed.slice(0, MAX_MANUAL_SEEDS);
    setSeedError(parsed.length >= MAX_MANUAL_SEEDS ? t(lang, 'dailySeedLimit', MAX_MANUAL_SEEDS) : undefined);
    setSeedDraft('');
    setTags(next);
    onSaveSeeds?.(next);
  };
  const removeSeed = (seed: string): void => {
    const next = tags.filter(tag => tag !== seed);
    setTags(next);
    setSeedError(undefined);
    onSaveSeeds?.(next);
  };
  const [followPending, setFollowPending] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const dueAt = state === null ? now : state.dueAt;
  const refreshDisabled = busy || disabledReason !== undefined;
  const nextRefresh = state === null ? null : formatRelative(Math.max(dueAt, now), now);
  const lastRefresh = state === null ? null : formatRelative(now, state.refreshedAt);
  const healthy = state !== null && now - state.refreshedAt < SHORTLIST_REFRESH_MS;
  const viaFollowing = state?.entries.filter(entry => entry.discoveredVia?.some(via => via.endsWith('following'))).length ?? 0;
  const viaFollowers = state?.entries.filter(entry => entry.discoveredVia?.some(via => via.endsWith('followers'))).length ?? 0;

  const handleFollow = async (candidate: ShortlistCandidate): Promise<void> => {
    if (onFollow === undefined || followPending !== null || candidate.followState !== undefined) {
      return;
    }
    setFollowPending(candidate.username);
    setFollowError(undefined);
    try {
      const result = await onFollow(candidate);
      if (!result.ok) {
        setFollowError(result.message ?? 'couldnt follow. try again.');
      }
    } catch (followFailure) {
      setFollowError(followFailure instanceof Error ? followFailure.message : 'couldnt follow. try again.');
    } finally {
      setFollowPending(null);
    }
  };

  return (
    <section className='wa-panel wa-daily' aria-labelledby='wa-daily-title'>
      <header className='wa-daily__header'>
        <div>
          <h2 id='wa-daily-title' className='wa-panel__title'>
            {t(lang, 'dailyTitle')}
          </h2>
          <p className='wa-daily__intro'>{t(lang, 'dailyIntro')}</p>
        </div>
        <span className={`wa-daily__pill${healthy ? '' : ' wa-daily__pill--due'}`}>{t(lang, 'dailyReadOnly')}</span>
      </header>

      <div className='wa-daily__filter'>
        <label className='wa-field'>
          <span className='wa-field__label'>{t(lang, 'dailyFilterLabel')}</span>
          <textarea
            className='wa-input wa-daily__prompt'
            rows={2}
            maxLength={MAX_FILTER_PROMPT_LENGTH}
            value={draft}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value)}
            placeholder={t(lang, 'dailyFilterPlaceholder')}
          />
        </label>
        {promptError !== undefined && <p className='wa-field__error'>{promptError}</p>}
        {onSaveSeeds !== undefined && (
          <div className='wa-field'>
            <label className='wa-field__label' htmlFor='wa-seed-tags'>
              {t(lang, 'dailySeedsLabel')}
            </label>
            <div className='wa-daily__tags'>
              {tags.map(seed => (
                <span key={seed} className='wa-daily__tag'>
                  @{seed}
                  <button
                    type='button'
                    className='wa-daily__tag-remove'
                    aria-label={t(lang, 'dailySeedRemove', seed)}
                    onClick={() => removeSeed(seed)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                id='wa-seed-tags'
                className='wa-daily__tag-input'
                value={seedDraft}
                placeholder={t(lang, 'dailySeedsPlaceholder')}
                autoComplete='off'
                aria-label={t(lang, 'dailySeedsLabel')}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSeedDraft(event.currentTarget.value)}
                onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
                    event.preventDefault();
                    commitSeeds(seedDraft);
                  }
                }}
                onPaste={(event: React.ClipboardEvent<HTMLInputElement>) => {
                  const pasted = event.clipboardData?.getData('text') ?? '';
                  if (/[\s,;]/.test(pasted)) {
                    event.preventDefault();
                    commitSeeds(`${seedDraft} ${pasted}`);
                  }
                }}
                onBlur={() => commitSeeds(seedDraft)}
              />
            </div>
            <p className='wa-field__hint'>{t(lang, 'dailySeedsHint')}</p>
            {seedError !== undefined && <p className='wa-field__error'>{seedError}</p>}
          </div>
        )}
        <div className='wa-daily__actions'>
          <button type='button' className='wa-btn wa-btn--small' onClick={() => onSavePrompt(draft)}>
            {t(lang, 'dailySaveFilter')}
          </button>
          <button
            type='button'
            className='wa-btn wa-btn--primary wa-btn--small'
            onClick={onRefresh}
            disabled={refreshDisabled}
            title={disabledReason}
          >
            {busy ? t(lang, 'dailyRefreshing') : t(lang, 'dailyRefresh')}
          </button>
          <span className='wa-daily__status'>
            {disabledReason !== undefined
              ? disabledReason
              : error !== undefined && error !== ''
                ? error
                : busy && progress !== undefined && progress !== ''
                  ? progress
                  : state === null
                    ? t(lang, 'dailyNever')
                    : nextRefresh === null
                      ? ''
                      : now >= state.dueAt
                        ? t(lang, 'dailyDue')
                        : `${t(lang, 'dailyLastRefresh', lastRefresh ?? '')} · ${t(lang, 'dailyNextRefresh', nextRefresh)}`}
          </span>
        </div>
      </div>

      {followError !== undefined && (
        <p className='wa-banner wa-banner--warning' role='alert'>{followError}</p>
      )}
      {seedWarning !== undefined && (
        <p className='wa-banner wa-banner--warning' role='alert'>{seedWarning}</p>
      )}

      {state !== null && state.entries.length > 0 ? (
        <ol className='wa-daily__list'>
          {state.entries.map(entry => {
            const strength = matchStrength(entry.score);
            return (
              <li key={entry.username} className='wa-daily__item'>
                <div className='wa-daily__avatar' aria-hidden='true'>
                  {entry.profilePicUrl !== '' ? (
                    <img src={entry.profilePicUrl} alt='' loading='lazy' referrerPolicy='no-referrer' />
                  ) : (
                    <span>{avatarFallback(entry.username)}</span>
                  )}
                </div>

                <div className='wa-daily__identity'>
                  <a
                    className='wa-daily__user'
                    href={`https://www.instagram.com/${encodeURIComponent(entry.username)}/`}
                    target='_blank'
                    rel='noreferrer'
                  >
                    @{entry.username}
                  </a>
                  <span className='wa-daily__name'>{entry.fullName}</span>
                  <span className='wa-daily__badges'>
                    {entry.isPrivate && <span className='wa-daily__badge'>{t(lang, 'privateBadge')}</span>}
                    {entry.isVerified && <span className='wa-daily__badge'>{t(lang, 'verifiedBadge')}</span>}
                  </span>
                  {entry.biography !== '' && <span className='wa-daily__bio'>{entry.biography}</span>}
                </div>

                <div className='wa-daily__match'>
                  <span className={`wa-daily__strength wa-daily__strength--${strength}`}>
                    {t(lang, STRENGTH_LABEL_KEYS[strength])}
                  </span>
                  <span className='wa-daily__score'>{t(lang, 'dailyScore', Math.round(entry.score * 100))}</span>
                  {entry.discoveredVia !== undefined && entry.discoveredVia.length > 0 ? (
                    <>
                      <span className='wa-daily__source'>{t(lang, 'dailyVia', entry.discoveredVia[0])}</span>
                      {entry.discoveredVia.length > 1 && (
                        <span className='wa-daily__distance'>{t(lang, 'dailyViaMore', entry.discoveredVia.length - 1)}</span>
                      )}
                    </>
                  ) : (
                    entry.sourceUsername !== undefined && (
                      <span className='wa-daily__source'>{t(lang, 'dailySource', entry.sourceUsername)}</span>
                    )
                  )}
                  {(entry.sourceCount ?? 1) === 1 ? (
                    <span className='wa-daily__distance wa-daily__distance--far'>{t(lang, 'dailyFar')}</span>
                  ) : (
                    <span className='wa-daily__distance'>{t(lang, 'dailySourceCount', entry.sourceCount ?? 1)}</span>
                  )}
                </div>

                <div className='wa-daily__action'>
                  {entry.followState !== undefined ? (
                    <span className='wa-daily__follow-state'>
                      {entry.followState === 'requested' ? t(lang, 'dailyRequested') : t(lang, 'dailyFollowing')}
                    </span>
                  ) : (
                    <button
                      type='button'
                      className='wa-btn wa-btn--small wa-btn--primary'
                      disabled={onFollow === undefined || followPending !== null}
                      onClick={() => {
                        void handleFollow(entry);
                      }}
                    >
                      {followPending === entry.username
                        ? t(lang, 'dailyFollowing')
                        : entry.isPrivate
                          ? t(lang, 'dailyRequestFollow')
                          : t(lang, 'dailyFollow')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className='wa-daily__empty'>{t(lang, 'dailyEmpty')}</p>
      )}

      {state !== null && state.entries.length > 0 && (
        <p className='wa-daily__sources'>
          {t(lang, 'dailySourceBreakdown', viaFollowing, viaFollowers)}
        </p>
      )}
    </section>
  );
};

export interface DailyShortlistPageProps extends DailyShortlistProps {
  readonly onBack: () => void;
}

/** Full-page wrapper so the shortlist is a destination, not launch-screen clutter. */
export const DailyShortlistPage = ({ onBack, ...props }: DailyShortlistPageProps) => (
  <section className='wa-screen wa-growth-page'>
    <header className='wa-growth-page__header'>
      <button type='button' className='wa-btn wa-btn--small wa-btn--ghost' onClick={onBack}>
        {t(props.lang, 'dailyBack')}
      </button>
      <BrandWordmark name={t(props.lang, 'appName')} toolbar />
      <span className='wa-growth-page__tag'>{t(props.lang, 'dailyTitle')}</span>
    </header>
    <DailyShortlist {...props} />
  </section>
);
