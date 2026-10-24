import React, { useState } from 'react';
import { GenderCategory } from '../model/gender';
import { Language, t } from '../utils/i18n';
import { BrandWordmark } from './icons/BrandWordmark';
import { ShieldIcon } from './icons/ShieldIcon';
import { WarningIcon } from './icons/WarningIcon';
import { WizardSteps } from './WizardSteps';

/**
 * Wizard step 1: choose which classifier category to nuke.
 *
 * The rest of the app (scan -> dry run -> typed live approval) is downstream of
 * this single choice. Advanced configuration (classifier keys, pacing,
 * whitelist) lives behind the quiet “Advanced” link and is expected to be used
 * rarely; the wizard itself stays focused on the category + one clear action.
 */
export interface NukeWizardProps {
  readonly lang: Language;
  readonly onNuke: (category: GenderCategory) => void;
  /** Quiet access to the advanced settings dialog. */
  readonly onOpenAdvanced: () => void;
  /** Primary classifier label + detail shown in the small status rail. */
  readonly classifierLabel: string;
  readonly classifierDetail?: string;
  readonly classifierReady: boolean;
  readonly onLoadDemo?: () => void;
  readonly cachedScanCount?: number;
  readonly onLoadCached?: () => void;
  readonly busy?: boolean;
  readonly scanDisabled?: boolean;
  readonly scanDisabledReason?: string;
  /** Launch preflight state for the local relay (Instagram only). */
  readonly relayStatus?: 'checking' | 'ok' | 'error';
  readonly relayMessage?: string;
  readonly onRetryRelay?: () => void;
  /** True when this build has no baked-in classifier keys and none are entered yet. */
  readonly keySetupNeeded?: boolean;
  /** Save user-provided API keys for this tab (sessionStorage only). */
  readonly onSaveClassifierKeys?: (typesafeKey: string, deepseekKey: string) => void;
}

interface CategoryCard {
  readonly category: GenderCategory;
  readonly labelKey:
    | 'categoryFemale'
    | 'categoryMale'
    | 'categoryMachine'
    | 'categoryOrganization'
    | 'categoryAmbiguous';
  readonly hintKey: 'nukeFemaleHint' | 'nukeMaleHint' | 'nukeMachineHint' | 'nukeOrganizationHint' | 'nukeAmbiguousHint';
}

const CATEGORY_CARDS: readonly CategoryCard[] = [
  { category: 'female', labelKey: 'categoryFemale', hintKey: 'nukeFemaleHint' },
  { category: 'male', labelKey: 'categoryMale', hintKey: 'nukeMaleHint' },
  { category: 'machine', labelKey: 'categoryMachine', hintKey: 'nukeMachineHint' },
  { category: 'organization', labelKey: 'categoryOrganization', hintKey: 'nukeOrganizationHint' },
  { category: 'ambiguous', labelKey: 'categoryAmbiguous', hintKey: 'nukeAmbiguousHint' },
];

export const NukeWizard = ({
  lang,
  onNuke,
  onOpenAdvanced,
  classifierLabel,
  classifierDetail,
  classifierReady,
  onLoadDemo,
  cachedScanCount,
  onLoadCached,
  busy = false,
  scanDisabled = false,
  scanDisabledReason,
  relayStatus,
  relayMessage,
  onRetryRelay,
  keySetupNeeded = false,
  onSaveClassifierKeys,
}: NukeWizardProps) => {
  const relayBlocked = relayStatus === 'checking' || relayStatus === 'error';
  const keySetupBlocked = keySetupNeeded && onSaveClassifierKeys !== undefined;
  const disabled = busy || scanDisabled || relayBlocked || keySetupBlocked;
  const [typesafeKey, setTypesafeKey] = useState('');
  const [deepseekKey, setDeepseekKey] = useState('');
  return (
    <section className='wa-wizard'>
      <header className='wa-wizard__header'>
        <BrandWordmark name={t(lang, 'appName')} large />
        <WizardSteps lang={lang} current={1} />
      </header>

      <div className='wa-wizard__body'>
        <main className='wa-wizard__main'>
          <h1 className='wa-wizard__title'>{t(lang, 'nukeHeading')}</h1>
          <p className='wa-wizard__lead'>{t(lang, 'nukeIntro')}</p>

          {keySetupBlocked && (
            <section className='wa-panel wa-key-setup' aria-labelledby='wa-key-setup-title'>
              <h2 id='wa-key-setup-title' className='wa-panel__title'>
                {t(lang, 'keySetupTitle')}
              </h2>
              <p className='wa-panel__meta'>{t(lang, 'keySetupBody')}</p>
              <div className='wa-key-setup__fields'>
                <label className='wa-field'>
                  <span className='wa-field__label'>{t(lang, 'keySetupTypeSafe')}</span>
                  <input
                    type='password'
                    className='wa-input'
                    autoComplete='off'
                    value={typesafeKey}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTypesafeKey(event.currentTarget.value)}
                  />
                </label>
                <label className='wa-field'>
                  <span className='wa-field__label'>{t(lang, 'keySetupDeepSeek')}</span>
                  <input
                    type='password'
                    className='wa-input'
                    autoComplete='off'
                    value={deepseekKey}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDeepseekKey(event.currentTarget.value)}
                  />
                </label>
              </div>
              <div className='wa-key-setup__actions'>
                <button
                  type='button'
                  className='wa-btn wa-btn--primary wa-btn--small'
                  disabled={typesafeKey.trim() === '' && deepseekKey.trim() === ''}
                  onClick={() => onSaveClassifierKeys(typesafeKey.trim(), deepseekKey.trim())}
                >
                  {t(lang, 'keySetupSave')}
                </button>
                <span className='wa-panel__meta'>{t(lang, 'keySetupHint')}</span>
              </div>
            </section>
          )}

          <div className='wa-nuke-grid' role='group' aria-label={t(lang, 'nukeHeading')}>
            {CATEGORY_CARDS.map(card => (
              <button
                key={card.category}
                type='button'
                className='wa-nuke-card'
                aria-label={t(lang, card.labelKey)}
                disabled={disabled}
                onClick={() => onNuke(card.category)}
              >
                <span className={`wa-nuke-card__dot wa-nuke-card__dot--${card.category}`} aria-hidden='true' />
                <span className='wa-nuke-card__label'>{t(lang, card.labelKey)}</span>
                <span className='wa-nuke-card__hint'>{t(lang, card.hintKey)}</span>
              </button>
            ))}
          </div>

          {relayStatus === 'checking' && (
            <p className='wa-banner wa-banner--info' role='status'>
              <span>{t(lang, 'relayChecking')}</span>
            </p>
          )}
          {relayStatus === 'error' && (
            <div className='wa-banner wa-banner--warning' role='alert'>
              <WarningIcon />
              <div className='wa-relay-check'>
                <strong>{t(lang, 'relayUnavailableTitle')}</strong>
                <span>{t(lang, 'relayUnavailableBody')}</span>
                {relayMessage !== undefined && relayMessage !== '' && (
                  <code className='wa-relay-check__detail'>{relayMessage}</code>
                )}
                {onRetryRelay !== undefined && (
                  <button type='button' className='wa-btn wa-btn--small wa-btn--outline' onClick={onRetryRelay}>
                    {t(lang, 'relayRetry')}
                  </button>
                )}
              </div>
            </div>
          )}
          {scanDisabled && scanDisabledReason !== undefined && (
            <p className='wa-banner wa-banner--warning' role='alert'>
              <WarningIcon />
              <span>{scanDisabledReason}</span>
            </p>
          )}

          <p className='wa-wizard__promise'>{t(lang, 'dryRunPromise')}</p>

          <div className='wa-wizard__quiet'>
            {onLoadDemo !== undefined && (
              <button type='button' className='wa-btn wa-btn--ghost wa-btn--small' onClick={onLoadDemo} disabled={busy}>
                {t(lang, 'loadDemoPreview')}
              </button>
            )}
            {onLoadCached !== undefined && cachedScanCount !== undefined && cachedScanCount > 0 && (
              <button type='button' className='wa-btn wa-btn--ghost wa-btn--small' onClick={onLoadCached} disabled={busy}>
                {t(lang, 'cachedScanAvailable', cachedScanCount)}
              </button>
            )}
          </div>
        </main>

        <aside className='wa-wizard__aside'>
          <section className='wa-panel wa-classifier' aria-labelledby='wa-classifier-title'>
            <h2 id='wa-classifier-title' className='wa-panel__title'>
              {t(lang, 'providerLabel')}
            </h2>
            <div className='wa-classifier__status'>
              <span className='wa-dot' aria-hidden='true' />
              <strong className='wa-provider'>{classifierLabel}</strong>
            </div>
            {!classifierReady && (
              <p className='wa-classifier__detail wa-classifier__detail--warning'>{t(lang, 'wizardNotConfigured')}</p>
            )}
            {classifierDetail !== undefined && classifierDetail !== '' && (
              <p className='wa-classifier__detail'>{classifierDetail}</p>
            )}
            {relayStatus === 'ok' && (
              <p className='wa-classifier__detail wa-classifier__relay-ok'>{t(lang, 'relayConnected')}</p>
            )}
            <p className='wa-classifier__detail wa-classifier__relay-hint'>{t(lang, 'wizardRelayHint')}</p>
            <div className='wa-classifier__actions'>
              <button type='button' className='wa-btn wa-btn--quiet-link' onClick={onOpenAdvanced}>
                {t(lang, 'advancedLabel')}
              </button>
              <span className='wa-classifier__advanced-hint'>{t(lang, 'advancedHint')}</span>
            </div>
          </section>

          <section className='wa-note' aria-labelledby='wa-privacy-title'>
            <h2 id='wa-privacy-title' className='wa-note__label'>
              <ShieldIcon />
              {t(lang, 'signalPrivacyTitle')}
            </h2>
            <p>{t(lang, 'privacyNote')}</p>
          </section>
        </aside>
      </div>
    </section>
  );
};
