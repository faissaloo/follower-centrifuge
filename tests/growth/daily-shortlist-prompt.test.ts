import { describe, expect, it } from 'vitest';
import {
  SHORTLIST_JEV_CRITERIA,
  shortlistJevInstructions,
  shortlistJevStateHeader,
} from '../../src/prompts/daily-shortlist';

describe('visible Daily 20 Jev prompt', () => {
  it('keeps the filter and photo-cue rules explicit in source', () => {
    expect(SHORTLIST_JEV_CRITERIA.match).toBeTruthy();
    expect(shortlistJevInstructions(3)).toContain('photo_cues');
    expect(shortlistJevInstructions(3)).toContain('candidate 3');
    expect(shortlistJevStateHeader('ceramics')).toEqual({
      filter_prompt: 'ceramics',
    });
  });
});
