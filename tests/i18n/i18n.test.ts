import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_STORAGE_KEY,
  getInitialLanguage,
  saveLanguage,
  t,
  translations,
} from '../../src/utils/i18n';

describe('i18n dictionaries', () => {
  it('has exactly the same keys in English and Spanish', () => {
    const englishKeys = Object.keys(translations.en).sort();
    const spanishKeys = Object.keys(translations.es).sort();
    expect(spanishKeys).toEqual(englishKeys);
  });

  it('never contains an empty string', () => {
    for (const key of Object.keys(translations.en)) {
      expect((translations.en as Record<string, string>)[key].length).toBeGreaterThan(0);
      expect((translations.es as Record<string, string>)[key].length).toBeGreaterThan(0);
    }
  });

  it('contains real translations, not copies of the English text', () => {
    expect(translations.es.cancel).not.toBe(translations.en.cancel);
    expect(translations.es.settingsTitle).not.toBe(translations.en.settingsTitle);
    expect(translations.es.launchTitle).not.toBe(translations.en.launchTitle);
    // Language names intentionally stay in their own language.
    expect(translations.es.languageSpanish).toBe('Español (ES)');
  });

  it('keeps the product name identical (proper noun) in both languages', () => {
    expect(translations.en.appName).toBe('Follower Centrifuge 6000 Pro Max Ultra Plus Titanium Reloaded Flash Xtreme HD Turbo Enriched');
    expect(translations.es.appName).toBe(translations.en.appName);
  });

  it('interpolates a percentage placeholder', () => {
    expect(t('en', 'progressPercent', 42)).toBe('42%');
    expect(t('es', 'progressPercent', 42)).toBe('42%');
  });

  it('interpolates multiple placeholders in order', () => {
    expect(t('en', 'pageLabel', 2, 5)).toBe('Page 2 of 5');
    expect(t('en', 'showingAccounts', 10, 55)).toBe('Showing 10 of 55 accounts');
    expect(t('en', 'whitelistImportMerged', 3, 1)).toBe('Merged: 3 new accounts added (1 duplicates skipped).');
  });

  it('interpolates the dynamic confirmation phrase', () => {
    expect(t('en', 'approvalPhraseInstruction', 'UNFOLLOW 7')).toContain('UNFOLLOW 7');
    expect(t('es', 'approvalPhraseInstruction', 'UNFOLLOW 7')).toContain('UNFOLLOW 7');
  });

  it('falls back to English for an invalid saved language and honours a valid one', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es');
    expect(getInitialLanguage()).toBe('es');
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
    expect(getInitialLanguage()).toBe('en');
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    expect(getInitialLanguage()).toBe('en');
  });

  it('persists the chosen language', () => {
    saveLanguage('es');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es');
    saveLanguage('en');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
  });

  it('keeps the settings and protected-list keys used by the UI', () => {
    const requiredKeys = [
      'settingsTitle',
      'timeBetweenSearchCycles',
      'timeToWaitAfterFiveCycles',
      'timeBetweenUnfollows',
      'timeToWaitAfterFiveUnfollows',
      'usersPerSearchCycle',
      'saveSettings',
      'whitelistTitle',
      'exportWhitelist',
      'importWhitelist',
      'clearWhitelist',
      'clearWhitelistConfirm',
      'mergeWhitelist',
      'replaceWhitelist',
      'pasteWhitelist',
      'addPastedToWhitelist',
      'pastedUsersAdded',
      'noValidUsernamesFound',
      'pastedUsersAlreadyExist',
    ];
    for (const key of requiredKeys) {
      expect(Object.prototype.hasOwnProperty.call(translations.en, key)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(translations.es, key)).toBe(true);
    }
  });
});
