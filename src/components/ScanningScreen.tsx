import React from 'react';
import { AuditPhase } from '../model/audit';
import { Language, t } from '../utils/i18n';
import { Centrifuge } from './Centrifuge';

export interface ScanningScreenProps {
  readonly lang: Language;
  readonly phase: AuditPhase;
  /** 0..100 */
  readonly percentage: number;
  readonly followingFetched: number;
  readonly followersFetched: number;
  readonly classified: number;
  readonly toClassify: number;
  /** Human readable progress note (e.g. a rate-limit pause). */
  readonly notice?: string;
  readonly onCancel?: () => void;
  readonly cancelDisabled?: boolean;
}

function phaseLabelKey(phase: AuditPhase): 'phaseFetchingFollowing' | 'phaseFetchingFollowers' | 'phaseClassifying' | 'phaseComplete' | 'phaseFailed' {
  switch (phase) {
    case 'fetching-following':
      return 'phaseFetchingFollowing';
    case 'fetching-followers':
      return 'phaseFetchingFollowers';
    case 'classifying':
      return 'phaseClassifying';
    case 'complete':
      return 'phaseComplete';
    case 'failed':
      return 'phaseFailed';
    default:
      return 'phaseFetchingFollowing';
  }
}

function clampPercent(percentage: number): number {
  if (!isFinite(percentage)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

/**
 * Read-only progress screen for the audit runner (fetching both lists, then
 * classifying names). Shows the phase, per-list counters and any runner notice.
 */
export const ScanningScreen = ({
  lang,
  phase,
  percentage,
  followingFetched,
  followersFetched,
  classified,
  toClassify,
  notice,
  onCancel,
  cancelDisabled = false,
}: ScanningScreenProps) => {
  const percent = clampPercent(percentage);
  const active = phase !== 'complete' && phase !== 'failed';
  return (
    <section className='wa-screen wa-scanning'>
      <h1 className='wa-scanning__title'>{t(lang, 'scanningTitle')}</h1>
      <p className='wa-scanning__phase'>{t(lang, 'scanningPhase', t(lang, phaseLabelKey(phase)))}</p>
      {(phase === 'fetching-following' || phase === 'fetching-followers') && classified > 0 && (
        <p className='wa-scanning__parallel-note' role='status'>
          {t(lang, 'scanParallelNote')}
        </p>
      )}

      <div className='wa-scanning__centrifuge'>
        <Centrifuge size='lg' enriching={phase === 'classifying'} />
      </div>

      <div
        className='wa-progress wa-progress--large'
        role='progressbar'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t(lang, 'scanningTitle')}
      >
        <span className='wa-progress__fill' style={{ width: `${percent}%` }} />
      </div>
      <p className='wa-scanning__percent'>{t(lang, 'progressPercent', percent)}</p>

      <dl className='wa-scanning__counts'>
        <div className='wa-metric'>
          <dt>{t(lang, 'scanFollowingFetched')}</dt>
          <dd>{String(followingFetched)}</dd>
        </div>
        <div className='wa-metric'>
          <dt>{t(lang, 'scanFollowersFetched')}</dt>
          <dd>{String(followersFetched)}</dd>
        </div>
        <div className='wa-metric'>
          <dt>{t(lang, 'scanClassified')}</dt>
          <dd>{String(classified)}</dd>
        </div>
        <div className='wa-metric'>
          <dt>{t(lang, 'scanToClassify')}</dt>
          <dd>{String(toClassify)}</dd>
        </div>
      </dl>

      {notice !== undefined && notice !== '' && (
        <div className='wa-notice' role='status'>
          <strong>{t(lang, 'scanNoticeTitle')}:</strong> {notice}
        </div>
      )}
      {phase === 'failed' && (
        <div className='wa-banner wa-banner--warning' role='alert'>
          {t(lang, 'scanStoppedNote')}
        </div>
      )}

      <p className='wa-scanning__note'>{t(lang, 'scanEstimatesNote')}</p>
      <p className='wa-scanning__note'>{t(lang, 'scanWorkingNote')}</p>

      {onCancel !== undefined && active && (
        <button type='button' className='wa-btn wa-btn--ghost' onClick={onCancel} disabled={cancelDisabled}>
          {t(lang, 'scanCancel')}
        </button>
      )}
    </section>
  );
};
