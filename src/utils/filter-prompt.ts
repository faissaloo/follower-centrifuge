import { DEFAULT_FILTER_PROMPT, MAX_FILTER_PROMPT_LENGTH } from '../model/growth';

export interface FilterPromptValidation {
  readonly ok: boolean;
  readonly prompt: string;
  readonly error?: string;
}

export function validateFilterPrompt(raw: string): FilterPromptValidation {
  const prompt = raw.replace(/\s+/g, ' ').trim();
  if (prompt.length > MAX_FILTER_PROMPT_LENGTH) {
    return { ok: false, prompt, error: `keep the filter under ${MAX_FILTER_PROMPT_LENGTH} characters.` };
  }

  return { ok: true, prompt };
}

/** Prompt actually used for scoring: never empty, always the safe default. */
export function effectiveFilterPrompt(raw: string): string {
  const validation = validateFilterPrompt(raw);
  return validation.ok && validation.prompt !== '' ? validation.prompt : DEFAULT_FILTER_PROMPT;
}
