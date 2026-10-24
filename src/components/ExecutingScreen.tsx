import React, { useEffect, useState } from 'react';
import { ExecutionEntry, ExecutionEntryStatus, ExecutionStopReason, UnfollowPlan } from '../model/action-plan';
import { Language, t } from '../utils/i18n';
import { ModeBanner } from './AuditPrimitives';
import { Toolbar } from './Toolbar';
import { WizardSteps } from './WizardSteps';

export interface ExecutingScreenProps {
  readonly lang: Language;
  readonly plan: UnfollowPlan;
  /** 0..100 */
  readonly percentage: number;
  readonly entries: readonly ExecutionEntry[];
  /** Estimated pacing time left in a live run (excluding network latency). */
  readonly estimatedRemainingMs?: number;
  /** Epoch milliseconds when the current deliberate cooldown ends. */
  readonly cooldownEndsAt?: number;
  /** Present once the executor stops (complete, aborted, blocked, invalid…). */
  readonly stopReason?: ExecutionStopReason;
  readonly searchTerm: string;
  readonly showSucceeded: boolean;
  readonly showFailed: boolean;
  readonly onSearchChange: (term: string) => void;
  readonly onShowSucceededChange: (show: boolean) => void;
  readonly onShowFailedChange: (show: boolean) => void;
  /** Dry-run only: hand back to review and open the typed live approval. */
  readonly onRequestLive?: () => void;
  /** Why the dry run cannot be promoted to a live run right now. */
  readonly requestLiveDisabledReason?: string;
  readonly onStop: () => void;
  readonly onBack: () => void;
  readonly onLanguageChange: (lang: Language) => void;
  readonly onOpenSettings: () => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function clampPercent(percentage: number): number {
  if (!isFinite(percentage)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

function entryStatusLabelKey(
  status: ExecutionEntryStatus,
): 'entryUnfollowed' | 'entryRemovedFollower' | 'entryFailed' | 'entryBlocked' | 'entrySimulated' {
  switch (status) {
    case 'unfollowed':
      return 'entryUnfollowed';
    case 'removed-follower':
      return 'entryRemovedFollower';
    case 'failed':
      return 'entryFailed';
    case 'blocked':
      return 'entryBlocked';
    case 'simulated':
    default:
      return 'entrySimulated';
  }
}

function stopReasonLabelKey(
  stopReason: ExecutionStopReason,
):
  | 'stopReasonComplete'
  | 'stopReasonAborted'
  | 'stopReasonActionBlocked'
  | 'stopReasonInvalidApproval'
  | 'stopReasonMissingSession'
  | 'stopReasonProtectedTarget' {
  switch (stopReason) {
    case 'complete':
      return 'stopReasonComplete';
    case 'aborted':
      return 'stopReasonAborted';
    case 'action-blocked':
      return 'stopReasonActionBlocked';
    case 'invalid-approval':
      return 'stopReasonInvalidApproval';
    case 'protected-target':
      return 'stopReasonProtectedTarget';
    case 'missing-session':
    default:
      return 'stopReasonMissingSession';
  }
}

function succeededStatus(status: ExecutionEntryStatus): boolean {
  return status === 'unfollowed' || status === 'removed-follower' || status === 'simulated';
}

/**
 * Execution screen shared by dry runs and live runs.
 *
 * The two modes are deliberately impossible to confuse: the mode banner text,
 * colour, icon and ARIA role differ, the toolbar carries a mode badge, and the
 * dry-run log labels every entry as simulated.
 */
export const ExecutingScreen = ({
  lang,
  plan,
  percentage,
  entries,
  estimatedRemainingMs,
  cooldownEndsAt,
  stopReason,
  searchTerm,
  showSucceeded,
  showFailed,
  onSearchChange,
  onShowSucceededChange,
  onShowFailedChange,
  onRequestLive,
  requestLiveDisabledReason,
  onStop,
  onBack,
  onLanguageChange,
  onOpenSettings,
}: ExecutingScreenProps) => {
  const total = plan.targets.length;
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (cooldownEndsAt === undefined) {
      return undefined;
    }
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [cooldownEndsAt]);
  const cooldownRemainingMs = cooldownEndsAt === undefined ? 0 : Math.max(0, cooldownEndsAt - clockNow);
  const completed = entries.length;
  const running = stopReason === undefined && completed < total;
  const percent = clampPercent(percentage);
  const unfollowedCount = entries.filter(entry => entry.status === 'unfollowed' || entry.status === 'removed-follower').length;
  const needle = searchTerm.toLowerCase();

  const filteredEntries = entries.filter(entry => {
    const inGroup = succeededStatus(entry.status) ? showSucceeded : showFailed;
    if (!inGroup) {
      return false;
    }
    if (needle === '') {
      return true;
    }
    return (
      entry.user.username.toLowerCase().indexOf(needle) !== -1 ||
      entry.user.full_name.toLowerCase().indexOf(needle) !== -1
    );
  });

  const isLive = plan.mode === 'live';

  return (
    <section className='wa-screen wa-executing' data-executing-mode={plan.mode}>
      <Toolbar
        lang={lang}
        onLanguageChange={onLanguageChange}
        onOpenSettings={onOpenSettings}
        onBack={onBack}
        backDisabled={running}
        mode={plan.mode}
        searchValue={searchTerm}
        onSearchChange={onSearchChange}
        searchPlaceholder={t(lang, 'execSearchPlaceholder')}
      />

      <div className='wa-executing__wizard'>
        <WizardSteps lang={lang} current={plan.mode === 'dry-run' && stopReason === 'complete' ? 3 : 2} />
      </div>

      <ModeBanner lang={lang} mode={plan.mode} unfollowedCount={unfollowedCount} />

      {plan.mode === 'dry-run' && stopReason === 'complete' && plan.targets.length > 0 && onRequestLive !== undefined && (
        <section className='wa-panel wa-nuke-ready' aria-labelledby='wa-nuke-ready-title'>
          <h2 id='wa-nuke-ready-title' className='wa-panel__title'>
            {t(lang, 'dryRunReadyTitle')}
          </h2>
          <p className='wa-panel__meta'>{t(lang, 'dryRunReadyBody', plan.targets.length)}</p>
          <button
            type='button'
            className='wa-btn wa-btn--danger wa-nuke-ready__action'
            onClick={onRequestLive}
            disabled={requestLiveDisabledReason !== undefined}
            title={requestLiveDisabledReason}
          >
            {t(lang, 'dryRunReadyAction')}
          </button>
          <p className='wa-panel__meta'>{requestLiveDisabledReason !== undefined ? requestLiveDisabledReason : t(lang, 'dryRunReadyHint')}</p>
        </section>
      )}

      <div className='wa-executing__body'>
        <section className='wa-panel wa-panel--progress' aria-labelledby='wa-exec-progress-title'>
          <h2 id='wa-exec-progress-title' className='wa-panel__title'>
            {running ? t(lang, 'execRunning') : t(lang, 'execFinished')}
          </h2>
          <div
            className={`wa-progress wa-progress--large wa-progress--${isLive ? 'live' : 'dry'}`}
            role='progressbar'
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t(lang, 'execProgressLabel', completed, total)}
          >
            <span className='wa-progress__fill' style={{ width: `${percent}%` }} />
          </div>
          <p className='wa-executing__progress'>{t(lang, 'progressPercent', percent)}</p>
          <p className='wa-executing__progress-caption'>{t(lang, 'execProgressLabel', completed, total)}</p>
          <p className='wa-executing__plan-meta'>
            {t(lang, 'execTargetsCount', total)}
            {plan.skipped.length > 0 && ` · ${t(lang, 'execPlannedSkipNote', plan.skipped.length)}`}
          </p>
          <p className='wa-executing__plan-meta'>
            {plan.mode === 'live'
              ? t(lang, 'execLiveApprovalNote', plan.approval.expectedCount)
              : t(lang, 'execDryApprovalNote')}
          </p>

          {running && isLive && cooldownRemainingMs > 0 && (
            <p className='wa-executing__cooldown' role='status'>
              {t(lang, 'execCooldown', formatDuration(cooldownRemainingMs))}
            </p>
          )}
          {running && isLive && estimatedRemainingMs !== undefined && estimatedRemainingMs > 0 && (
            <p className='wa-executing__eta'>{t(lang, 'execEta', formatDuration(estimatedRemainingMs))}</p>
          )}
          {running && isLive && (estimatedRemainingMs === undefined || estimatedRemainingMs <= 0) && (
            <p className='wa-executing__eta'>{t(lang, 'execEtaCalculating')}</p>
          )}

          {stopReason !== undefined && (
            <p className='wa-executing__stopped' role='status'>
              {t(lang, 'execStopped')} — {t(lang, stopReasonLabelKey(stopReason))}
            </p>
          )}

          <div className='wa-executing__controls'>
            {running && (
              <>
                <button type='button' className='wa-btn wa-btn--ghost wa-btn--danger-text' onClick={onStop}>
                  {t(lang, 'execStop')}
                </button>
                <span className='wa-panel__meta'>{t(lang, 'execStopHint')}</span>
              </>
            )}
            {!running && (
              <button type='button' className='wa-btn wa-btn--primary' onClick={onBack}>
                {t(lang, 'execBackToReview')}
              </button>
            )}
          </div>
          {running && isLive && <p className='wa-banner wa-banner--warning'>{t(lang, 'execRunningNote')}</p>}
        </section>

        <section className='wa-panel wa-panel--log' aria-labelledby='wa-exec-log-title'>
          <h2 id='wa-exec-log-title' className='wa-panel__title'>
            {t(lang, 'execLogTitle')}
          </h2>
          <div className='wa-filters'>
            <label className='wa-checkbox'>
              <input
                type='checkbox'
                checked={showSucceeded}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => onShowSucceededChange(event.currentTarget.checked)}
              />
              <span>{t(lang, 'execFilterSucceeded')}</span>
            </label>
            <label className='wa-checkbox'>
              <input
                type='checkbox'
                checked={showFailed}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => onShowFailedChange(event.currentTarget.checked)}
              />
              <span>{t(lang, 'execFilterFailed')}</span>
            </label>
          </div>

          {filteredEntries.length === 0 ? (
            <p className='wa-empty' role='status'>
              {t(lang, 'execNoEntries')}
            </p>
          ) : (
            <ol className='wa-log'>
              {filteredEntries.map(entry => (
                <li key={entry.user.id} className={`wa-log-entry wa-log-entry--${entry.status}`}>
                  <span className='wa-log-entry__status'>{t(lang, entryStatusLabelKey(entry.status))}</span>
                  <a
                    className='wa-log-entry__username'
                    href={`https://www.instagram.com/${entry.user.username}/`}
                    target='_blank'
                    rel='noreferrer'
                  >
                    @{entry.user.username}
                  </a>
                  <span className='wa-log-entry__name'>{entry.user.full_name}</span>
                  {entry.detail !== undefined && entry.detail !== '' && (
                    <span className='wa-log-entry__detail'>{entry.detail}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
};
