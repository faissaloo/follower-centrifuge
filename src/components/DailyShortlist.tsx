import React, { useEffect, useState } from 'react';
import { DailyShortlistState, matchStrength, MAX_FILTER_PROMPT_LENGTH, MatchStrength, SHORTLIST_REFRESH_MS } from '../model/growth';
import { Language, t } from '../utils/i18n';

export interface DailyShortlistProps {
  readonly lang: Language;
  readonly prompt: string;
  readonly state: DailyShortlistState | null;
  readonly busy: boolean;
  readonly progress?: string;
  readonly error?: string;
  readonly promptError?: string;
  readonly disabledReason?: string;
  readonly onSavePrompt: (prompt: string) => void;
  readonly onRefresh: () => void;
}

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

/** Read-only Daily 20 shortlist. No follow action exists in this component. */
export const DailyShortlist = ({
  lang,
  prompt,
  state,
  busy,
  progress,
  error,
  promptError,
  disabledReason,
  onSavePrompt,
  onRefresh,
}: DailyShortlistProps) => {
  const [draft, setDraft] = useState(prompt);
  useEffect(() => {
    setDraft(prompt);
  }, [prompt]);
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

      {state !== null && state.entries.length > 0 ? (
        <ol className='wa-daily__list'>
          {state.entries.map(entry => (
            <li key={entry.username} className='wa-daily__item'>
              <a
                className='wa-daily__user'
                href={`https://www.instagram.com/${encodeURIComponent(entry.username)}/`}
                target='_blank'
                rel='noreferrer'
              >
                @{entry.username}
              </a>
              <span className='wa-daily__name'>{entry.fullName}</span>
              <span className={`wa-daily__strength wa-daily__strength--${matchStrength(entry.score)}`}>
                {t(lang, STRENGTH_LABEL_KEYS[matchStrength(entry.score)])}
              </span>
              <span className='wa-daily__score'>{t(lang, 'dailyScore', Math.round(entry.score * 100))}</span>
              {entry.sourceUsername !== undefined && (
                <span className='wa-daily__source'>{t(lang, 'dailySource', entry.sourceUsername)}</span>
              )}
              {entry.isPrivate && <span className='wa-daily__badge'>{t(lang, 'privateBadge')}</span>}
              {entry.isVerified && <span className='wa-daily__badge'>{t(lang, 'verifiedBadge')}</span>}
              {(entry.sourceCount ?? 1) === 1 ? (
                <span className='wa-daily__distance wa-daily__distance--far'>{t(lang, 'dailyFar')}</span>
              ) : (
                <span className='wa-daily__distance'>{t(lang, 'dailySourceCount', entry.sourceCount ?? 1)}</span>
              )}
              {entry.biography !== '' && <span className='wa-daily__bio'>{entry.biography}</span>}
            </li>
          ))}
        </ol>
      ) : (
        <p className='wa-daily__empty'>{t(lang, 'dailyEmpty')}</p>
      )}
    </section>
  );
};
