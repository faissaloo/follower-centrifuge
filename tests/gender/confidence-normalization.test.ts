import { describe, expect, it } from 'vitest';
import { normalizeConfidence, normalizeGender } from '../../src/model/gender';

describe('normalizeConfidence (fail-closed coercion)', () => {
  it('accepts finite numbers in range', () => {
    expect(normalizeConfidence(0)).toBe(0);
    expect(normalizeConfidence(0.6)).toBe(0.6);
    expect(normalizeConfidence(0.999)).toBeCloseTo(0.999, 5);
    expect(normalizeConfidence(1)).toBe(1);
  });

  it('clamps numeric out-of-range values', () => {
    expect(normalizeConfidence(-2)).toBe(0);
    expect(normalizeConfidence(42)).toBe(1);
    expect(normalizeConfidence(NaN)).toBe(0);
    expect(normalizeConfidence(Infinity)).toBe(0);
  });

  it('accepts plain decimal strings only', () => {
    expect(normalizeConfidence('0.9')).toBe(0.9);
    expect(normalizeConfidence(' 0.8 ')).toBe(0.8);
    expect(normalizeConfidence('.5')).toBe(0.5);
    expect(normalizeConfidence('1')).toBe(1);
    expect(normalizeConfidence('1.00')).toBe(1);
  });

  it('rejects booleans, arrays, objects and localized/odd strings', () => {
    expect(normalizeConfidence(true)).toBe(0);
    expect(normalizeConfidence(false)).toBe(0);
    expect(normalizeConfidence([0.9])).toBe(0);
    expect(normalizeConfidence({ value: 0.9 })).toBe(0);
    expect(normalizeConfidence('true')).toBe(0);
    expect(normalizeConfidence('NaN')).toBe(0);
    expect(normalizeConfidence('0,9')).toBe(0);
    expect(normalizeConfidence('90%')).toBe(0);
    expect(normalizeConfidence('2')).toBe(0);
    expect(normalizeConfidence('-0.5')).toBe(0);
    expect(normalizeConfidence(null)).toBe(0);
    expect(normalizeConfidence(undefined)).toBe(0);
  });

  it('passes the five current categories through unchanged', () => {
    expect(normalizeGender('female')).toBe('female');
    expect(normalizeGender('male')).toBe('male');
    expect(normalizeGender('machine')).toBe('machine');
    expect(normalizeGender('organization')).toBe('organization');
    expect(normalizeGender('ambiguous')).toBe('ambiguous');
  });

  it('maps legacy woman/man/unknown categories onto the current ones', () => {
    expect(normalizeGender('woman')).toBe('female');
    expect(normalizeGender('man')).toBe('male');
    expect(normalizeGender('unknown')).toBe('ambiguous');
  });

  it('fails closed to ambiguous for unknown values', () => {
    expect(normalizeGender('WOMAN')).toBe('ambiguous');
    expect(normalizeGender('Female')).toBe('ambiguous');
    expect(normalizeGender('nonbinary')).toBe('ambiguous');
    expect(normalizeGender('bot')).toBe('ambiguous');
    expect(normalizeGender(true)).toBe('ambiguous');
    expect(normalizeGender(null)).toBe('ambiguous');
    expect(normalizeGender(undefined)).toBe('ambiguous');
    expect(normalizeGender(42)).toBe('ambiguous');
  });
});
