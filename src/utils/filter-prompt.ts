import { DEFAULT_FILTER_PROMPT, MAX_FILTER_PROMPT_LENGTH } from '../model/growth';

/**
 * The shortlist filter prompt is for interests, content style and account
 * quality only. It must not be used to select people by protected or sensitive
 * traits (religion, ethnicity, gender, sexuality, health, nationality, etc.).
 * This is a lightweight guard; the scoring prompt also tells the model to
 * ignore any such instruction.
 */
export interface FilterPromptValidation {
  readonly ok: boolean;
  readonly prompt: string;
  readonly error?: string;
}

const SENSITIVE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /\b(muslim|islam|islamic|christian|jewish|jew|hindu|sikh|buddhist|catholic|religio\w*)\b/i, label: 'religion' },
  { pattern: /\b(race|racial|ethnic\w*|black|white|asian|arab|latina?|latino|desi|african)\b/i, label: 'race or ethnicity' },
  { pattern: /\b(gay|lesbian|queer|bisexual|trans\w*|lgbt\w*|sexuality|sexual orientation)\b/i, label: 'sexuality or gender identity' },
  { pattern: /\b(women?|woman|female|females|girls?|men?|male|males|boys?)\b/i, label: 'gender' },
  { pattern: /\b(disab\w*|autis\w*|deaf|blind|mental health|depress\w*|anxiety)\b/i, label: 'health or disability' },
  { pattern: /\b(immigrant\w*|refugee\w*|nationality|citizens?|passport)\b/i, label: 'nationality or immigration status' },
  { pattern: /\b(age|teen\w*|elderly|young people|over \d{2}|under \d{2})\b/i, label: 'age' },
];

export function validateFilterPrompt(raw: string): FilterPromptValidation {
  const prompt = raw.replace(/\s+/g, ' ').trim();
  if (prompt.length > MAX_FILTER_PROMPT_LENGTH) {
    return { ok: false, prompt, error: `keep the filter under ${MAX_FILTER_PROMPT_LENGTH} characters.` };
  }
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(prompt)) {
      return {
        ok: false,
        prompt,
        error: `i cant filter by ${label}. this is read-only account discovery — use interests, content style or quality signals instead.`,
      };
    }
  }
  return { ok: true, prompt };
}

/** Prompt actually used for scoring: never empty, always the safe default. */
export function effectiveFilterPrompt(raw: string): string {
  const validation = validateFilterPrompt(raw);
  return validation.ok && validation.prompt !== '' ? validation.prompt : DEFAULT_FILTER_PROMPT;
}
