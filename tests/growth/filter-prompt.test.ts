import { describe, expect, it } from 'vitest';
import { validateFilterPrompt } from '../../src/utils/filter-prompt';

describe('daily shortlist filter prompt', () => {
  it('allows interests, content style and quality criteria', () => {
    for (const prompt of ['ceramics, printmaking, process work', 'small studios posting original work', 'people who post about film photography']) {
      expect(validateFilterPrompt(prompt).ok).toBe(true);
    }
  });

  it('caps prompt length', () => {
    expect(validateFilterPrompt('a'.repeat(501)).ok).toBe(false);
  });
});
