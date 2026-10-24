import React, { useEffect, useRef } from 'react';
import { ActionMode } from '../model/action-plan';
import { Language, t } from '../utils/i18n';
import { BrandWordmark } from './icons/BrandWordmark';
import { SettingIcon } from './icons/SettingIcon';
import { BackIcon } from './icons/BackIcon';

/** Checkbox whose third (indeterminate) state can be driven from props. */
interface TriStateCheckboxProps {
  readonly label: string;
  readonly title?: string;
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}

const TriStateCheckbox = ({ label, title, checked, indeterminate, disabled = false, onChange }: TriStateCheckboxProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current !== null) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);
  return (
    <label className='wa-toggle'>
      <input
        ref={inputRef}
        type='checkbox'
        checked={checked}
        disabled={disabled}
        aria-label={label}
        title={title}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
};

export interface ToolbarProps {
  readonly lang: Language;
  readonly onLanguageChange: (lang: Language) => void;
  readonly onOpenSettings: () => void;
  readonly onBack: () => void;
  readonly backDisabled?: boolean;
  /** Current plan mode, when one exists. Hidden when null/undefined. */
  readonly mode?: ActionMode | null;
  /** True when the review screen is showing the built-in demo dataset. */
  readonly demo?: boolean;
  readonly searchValue?: string;
  readonly onSearchChange?: (value: string) => void;
  readonly searchPlaceholder?: string;
  readonly searchDisabled?: boolean;
  readonly showSelection?: boolean;
  readonly selectionDisabled?: boolean;
  readonly selectPageChecked?: boolean;
  readonly selectPageIndeterminate?: boolean;
  readonly onToggleSelectPage?: (checked: boolean) => void;
  readonly selectAllChecked?: boolean;
  readonly selectAllIndeterminate?: boolean;
  readonly onToggleSelectAll?: (checked: boolean) => void;
  readonly onCopy?: () => void;
  readonly onExportJson?: () => void;
  readonly onExportCsv?: () => void;
  readonly exportsDisabled?: boolean;
}

/**
 * Global app toolbar: brand, search, selection shortcuts, exports, language
 * switch, settings and the dry-run/live mode badge.
 *
 * Entirely controlled: all values come from props and every interaction is a
 * callback, so the same component can drive the review and execution screens.
 */
export const Toolbar = ({
  lang,
  onLanguageChange,
  onOpenSettings,
  onBack,
  backDisabled = false,
  mode = null,
  demo = false,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchDisabled = false,
  showSelection = false,
  selectionDisabled = false,
  selectPageChecked = false,
  selectPageIndeterminate = false,
  onToggleSelectPage,
  selectAllChecked = false,
  selectAllIndeterminate = false,
  onToggleSelectAll,
  onCopy,
  onExportJson,
  onExportCsv,
  exportsDisabled = false,
}: ToolbarProps) => (
  <header className='wa-toolbar'>
    <div className='wa-toolbar__bar'>
      <button
        type='button'
        className='wa-btn wa-btn--ghost wa-toolbar__back'
        aria-label={t(lang, 'back')}
        title={t(lang, 'back')}
        disabled={backDisabled}
        onClick={onBack}
      >
        <BackIcon />
        <span>{t(lang, 'back')}</span>
      </button>

      <BrandWordmark name={t(lang, 'appName')} toolbar />

      {onSearchChange !== undefined && (
        <input
          type='search'
          className='wa-search'
          value={searchValue}
          placeholder={searchPlaceholder === undefined ? t(lang, 'searchPlaceholder') : searchPlaceholder}
          aria-label={searchPlaceholder === undefined ? t(lang, 'searchPlaceholder') : searchPlaceholder}
          disabled={searchDisabled}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => onSearchChange(event.currentTarget.value)}
        />
      )}

      <div className='wa-toolbar__controls'>
        {mode !== null && (
          <span
            className={`wa-mode-badge wa-mode-badge--${mode === 'live' ? 'live' : 'dry'}`}
            aria-label={t(lang, 'modeBadgeAria', mode === 'live' ? t(lang, 'execLiveBadge') : t(lang, 'execSimulationBadge'))}
            data-testid='mode-badge'
          >
            {mode === 'live' ? t(lang, 'modeLiveBadge') : t(lang, 'modeDryBadge')}
          </span>
        )}
        {demo && (
          <span className='wa-badge wa-badge--demo' data-testid='demo-badge'>
            {t(lang, 'demoBadge')}
          </span>
        )}
      </div>

      <div className='wa-toolbar__exports'>
        {onCopy !== undefined && (
          <button type='button' className='wa-btn wa-btn--ghost' disabled={exportsDisabled} onClick={onCopy}>
            {t(lang, 'copyList')}
          </button>
        )}
        {onExportJson !== undefined && (
          <button type='button' className='wa-btn wa-btn--ghost' disabled={exportsDisabled} onClick={onExportJson}>
            {t(lang, 'exportJson')}
          </button>
        )}
        {onExportCsv !== undefined && (
          <button type='button' className='wa-btn wa-btn--ghost' disabled={exportsDisabled} onClick={onExportCsv}>
            {t(lang, 'exportCsv')}
          </button>
        )}
      </div>

      <div className='wa-toolbar__utility'>
        <button
          type='button'
          className='wa-btn wa-btn--ghost wa-toolbar__lang'
          title={lang === 'en' ? t(lang, 'switchToSpanish') : t(lang, 'switchToEnglish')}
          aria-label={lang === 'en' ? t(lang, 'switchToSpanish') : t(lang, 'switchToEnglish')}
          onClick={() => onLanguageChange(lang === 'en' ? 'es' : 'en')}
        >
          {lang.toUpperCase()}
        </button>
        <button
          type='button'
          className='wa-btn wa-btn--icon wa-toolbar__settings'
          title={t(lang, 'openSettings')}
          aria-label={t(lang, 'openSettings')}
          onClick={onOpenSettings}
        >
          <SettingIcon />
        </button>
      </div>
    </div>

    {showSelection && (
      <div className='wa-toolbar__selection'>
        <TriStateCheckbox
          label={t(lang, 'selectPage')}
          checked={selectPageChecked}
          indeterminate={selectPageIndeterminate}
          disabled={selectionDisabled}
          onChange={(checked: boolean) => {
            if (onToggleSelectPage !== undefined) {
              onToggleSelectPage(checked);
            }
          }}
        />
        <TriStateCheckbox
          label={t(lang, 'selectAll')}
          checked={selectAllChecked}
          indeterminate={selectAllIndeterminate}
          disabled={selectionDisabled}
          onChange={(checked: boolean) => {
            if (onToggleSelectAll !== undefined) {
              onToggleSelectAll(checked);
            }
          }}
        />
      </div>
    )}
  </header>
);
