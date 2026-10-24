import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_TARGET_CATEGORY_STORAGE_KEY,
  DEFAULT_TARGET_CATEGORY,
  LEGACY_TARGET_GENDER_STORAGE_KEY,
  loadTargetCategory,
  normalizeTargetCategory,
  saveTargetCategory,
} from '../../src/utils/audit-preferences';

beforeEach(() => {
  localStorage.clear();
});

describe('audit target category preference', () => {
  it('defaults to women when nothing is stored', () => {
    expect(DEFAULT_TARGET_CATEGORY).toBe('female');
    expect(loadTargetCategory()).toBe('female');
  });

  it('accepts all five categories and upgrades legacy gender values', () => {
    for (const category of ['female', 'male', 'machine', 'organization', 'ambiguous'] as const) {
      expect(normalizeTargetCategory(category)).toBe(category);
    }
    expect(normalizeTargetCategory('woman')).toBe('female');
    expect(normalizeTargetCategory('man')).toBe('male');
    expect(normalizeTargetCategory('unknown')).toBe('ambiguous');
    expect(normalizeTargetCategory('nonsense')).toBe('female');
    expect(normalizeTargetCategory(null)).toBe('female');
  });

  it('round-trips a saved category', () => {
    saveTargetCategory('machine');
    expect(localStorage.getItem(AUDIT_TARGET_CATEGORY_STORAGE_KEY)).toBe('machine');
    expect(loadTargetCategory()).toBe('machine');
  });

  it('migrates the legacy target-gender key', () => {
    localStorage.setItem(LEGACY_TARGET_GENDER_STORAGE_KEY, 'man');
    expect(loadTargetCategory()).toBe('male');
  });

  it('prefers the new key over the legacy one', () => {
    localStorage.setItem(LEGACY_TARGET_GENDER_STORAGE_KEY, 'woman');
    localStorage.setItem(AUDIT_TARGET_CATEGORY_STORAGE_KEY, 'organization');
    expect(loadTargetCategory()).toBe('organization');
  });

  it('degrades to the default when storage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadTargetCategory()).toBe('female');
    expect(() => saveTargetCategory('male')).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
