/** Instructions for the Jev question for one candidate. */
export function shortlistJevInstructions(accountNumber: number): string {
  return (
    `Judge whether candidate ${accountNumber} matches the user's filter and looks like a real account posting original content. ` +
    'Use the public username, display name, biography, follower/following counts and discovered_via. discovered_via shows which of the user\'s follows led here; treat it as a weak network signal, not content. ' +
    'If photo_cues are present, treat them as useful evidence about the account\'s presentation/style and use them together with the bio and names — never from the photo alone. ' +
    'Be strict about brands, reposters and obvious bots.'
  );
}

/** Jev choice criteria for the Daily 20 filter. */
export const SHORTLIST_JEV_CRITERIA: Record<string, string> = {
  match: 'clearly matches the filter, looks like a real person/account and posts original content',
  maybe: 'partially matches, or there is not enough public information to be sure',
  no: 'does not match, looks like a brand/reposter/bot, or is obviously off-topic',
};

/** State header repeated for every Jev batch. */
export function shortlistJevStateHeader(filterPrompt: string): { readonly filter_prompt: string } {
  return {
    filter_prompt: filterPrompt.slice(0, 500),
  };
}
