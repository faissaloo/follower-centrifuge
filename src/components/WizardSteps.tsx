import React from 'react';
import { Language, t } from '../utils/i18n';

/**
 * Three-step wizard indicator: pick a category -> dry run -> nuke.
 * Purely presentational; each step is announced as current/complete via text.
 */
export interface WizardStepsProps {
  readonly lang: Language;
  /** 1 = pick, 2 = dry run, 3 = nuke. */
  readonly current: 1 | 2 | 3;
}

export const WizardSteps = ({ lang, current }: WizardStepsProps) => {
  const steps: ReadonlyArray<{ readonly number: 1 | 2 | 3; readonly key: 'wizardStepPick' | 'wizardStepDryRun' | 'wizardStepNuke' }> = [
    { number: 1, key: 'wizardStepPick' },
    { number: 2, key: 'wizardStepDryRun' },
    { number: 3, key: 'wizardStepNuke' },
  ];
  return (
    <div className='wa-steps' aria-label={t(lang, 'wizardStepAria', current, t(lang, steps[current - 1].key))}>
      {steps.map(step => {
        const state = step.number < current ? 'done' : step.number === current ? 'current' : 'todo';
        return (
          <span
            key={step.number}
            className={`wa-steps__item wa-steps__item--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className='wa-steps__number'>{step.number}</span>
            <span className='wa-steps__label'>{t(lang, step.key)}</span>
          </span>
        );
      })}
    </div>
  );
};
