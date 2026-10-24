import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewScreen } from '../../src/components/ReviewScreen';
import { getCandidatesForDisplay, getEligibleTargets, summarizeAudit } from '../../src/utils/audit-display';
import { relationshipIncludesFollowing } from '../../src/model/audit';
import { t } from '../../src/utils/i18n';
import { demoDataset, filterForTarget, repeatedWomenFollowing, reviewProps } from './test-utils';

afterEach(cleanup);

function renderReview(overrides: Parameters<typeof reviewProps>[0] = {}) {
  const props = reviewProps(overrides);
  return render(<ReviewScreen {...props} />);
}

describe('ReviewScreen', () => {
  it('renders the audit summary, tabs and paginated rows', () => {
    renderReview();
    expect(screen.getByText('Review the audit')).toBeTruthy();
    expect(screen.getByText('Audit summary')).toBeTruthy();
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByTestId('selected-count').textContent).toBe('Selected: 0');
    expect(screen.getByTestId('eligible-count').textContent).toBe('Eligible selection: 0');
  });

  it('shows tab counts computed by the shared audit-display helpers', () => {
    const dataset = demoDataset();
    renderReview();
    const expected = getCandidatesForDisplay(
      dataset.candidates,
      dataset.whitelistedResults,
      'target-following',
      '',
    );
    const tab = screen.getByRole('tab', { name: new RegExp(t('en', 'tabTargetFollowing', 'Female')) });
    expect(within(tab).getByText(String(expected.length))).toBeTruthy();
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });

  it('marks the current tab and asks App to change tabs on click', () => {
    const onTabChange = vi.fn();
    renderReview({ onTabChange });
    const uncertainTab = screen.getByRole('tab', { name: /Other \/ uncertain/i });
    expect(uncertainTab.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(uncertainTab);
    expect(onTabChange).toHaveBeenCalledWith('uncertain');
  });

  it('emits filter changes for the minimum confidence field', () => {
    const onFilterChange = vi.fn();
    renderReview({ onFilterChange });
    const input = screen.getByLabelText('Minimum confidence');
    fireEvent.input(input, { target: { value: '35' } });
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    const nextFilter = onFilterChange.mock.calls[0][0];
    expect(nextFilter.minimumConfidence).toBe(0.35);
    expect(nextFilter.showPrivate).toBe(true);
    expect(nextFilter.showVerified).toBe(true);
  });

  it('emits filter changes for the private and verified toggles', () => {
    const onFilterChange = vi.fn();
    renderReview({ onFilterChange });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Private accounts' }));
    expect(onFilterChange.mock.calls[0][0].showPrivate).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Verified accounts' }));
    expect(onFilterChange.mock.calls[1][0].showVerified).toBe(false);
  });

  it('forwards search input changes to App', () => {
    const onSearchChange = vi.fn();
    renderReview({ onSearchChange });
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'ali' } });
    expect(onSearchChange).toHaveBeenCalledWith('ali');
  });

  it('filters rendered rows by the search term', () => {
    renderReview({ searchTerm: 'alina' });
    expect(screen.getByText('@alina.frames')).toBeTruthy();
    expect(screen.queryByText('@citrus.archive')).toBeNull();
  });

  it('does not show whitelisted accounts in the women tabs', () => {
    renderReview();
    expect(screen.queryByText('@inkline.daily')).toBeNull();
    expect(screen.queryByText('@velvet.orbit')).toBeNull();
  });

  it('lists protected accounts in the protected tab and can unprotect them', () => {
    const onToggleWhitelist = vi.fn();
    renderReview({ currentTab: 'whitelisted', onToggleWhitelist });
    expect(screen.getByText('@inkline.daily')).toBeTruthy();
    expect(screen.getByText('@velvet.orbit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove @inkline.daily from the protected list' }));
    expect(onToggleWhitelist).toHaveBeenCalledTimes(1);
    expect(onToggleWhitelist.mock.calls[0][0].username).toBe('inkline.daily');
  });

  it('renders follower-only accounts in the followers tab but keeps them unselectable', () => {
    const onSelectionChange = vi.fn();
    renderReview({ currentTab: 'target-followers', onSelectionChange });
    expect(screen.getByText('@keystone.labs')).toBeTruthy();
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: '@keystone.labs cannot be removed here' });
    expect(checkbox.disabled).toBe(true);
    // The selectable variant simply does not exist for follower-only accounts.
    expect(screen.queryByRole('checkbox', { name: 'Select @keystone.labs for a possible removal' })).toBeNull();
    expect(screen.getAllByText(/Follows you only/).length).toBeGreaterThan(0);
  });

  it('selects an eligible mutual account from the followers tab', () => {
    const onSelectionChange = vi.fn();
    renderReview({ currentTab: 'target-followers', onSelectionChange });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select @brassandbone for a possible removal' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['demo-2']);
  });

  it('select page only selects accounts that are eligible for unfollow', () => {
    const dataset = demoDataset();
    const onSelectionChange = vi.fn();
    renderReview({ currentTab: 'target-followers', onSelectionChange });
    const eligibleIds = getEligibleTargets(dataset.candidates, dataset.whitelistedResults, 0.6).map(
      candidate => candidate.user.id,
    );
    const visible = getCandidatesForDisplay(dataset.candidates, dataset.whitelistedResults, 'target-followers', '');
    const expectedIds = visible
      .filter(candidate => relationshipIncludesFollowing(candidate.relationship))
      .filter(candidate => eligibleIds.indexOf(candidate.user.id) !== -1)
      .map(candidate => candidate.user.id);
    expect(expectedIds.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page' }));
    expect(onSelectionChange).toHaveBeenCalledWith(expectedIds);
  });

  it('select all selects every eligible visible account and can clear it', () => {
    const dataset = demoDataset();
    const onSelectionChange = vi.fn();
    const allEligible = getEligibleTargets(dataset.candidates, dataset.whitelistedResults, 0.6).map(c => c.user.id);
    renderReview({ onSelectionChange });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(onSelectionChange).toHaveBeenCalledWith(allEligible);
    cleanup();
    renderReview({ selectedIds: allEligible, onSelectionChange });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it('starts a dry run from the primary action', () => {
    const dataset = demoDataset();
    const eligible = getEligibleTargets(dataset.candidates, dataset.whitelistedResults, 0.6);
    const onDryRun = vi.fn();
    renderReview({ selectedIds: [eligible[0].user.id], onDryRun });
    fireEvent.click(screen.getByRole('button', { name: /Dry run — nothing will be changed/ }));
    expect(onDryRun).toHaveBeenCalledTimes(1);
  });

  it('locks live unfollow until the whole scan completes', () => {
    const dataset = demoDataset();
    const eligible = getEligibleTargets(dataset.candidates, dataset.whitelistedResults, 0.6);
    renderReview({
      scanComplete: false,
      followingComplete: false,
      selectedIds: [eligible[0].user.id],
    });
    const liveButton = screen.getByRole<HTMLButtonElement>('button', { name: /Unfollow \/ remove for real…/ });
    expect(liveButton.disabled).toBe(true);
    expect(screen.getByText(/Live removal is locked until the whole scan finishes/)).toBeTruthy();
    expect(screen.getByText('Scan incomplete')).toBeTruthy();
  });

  it('locks live unfollow when nothing eligible is selected', () => {
    // Demo data is live-locked for a different reason; exercise the real
    // "no eligible selection" gate with a non-demo review.
    renderReview({ demo: false });
    const liveButton = screen.getByRole<HTMLButtonElement>('button', { name: /Unfollow \/ remove for real…/ });
    expect(liveButton.disabled).toBe(true);
    expect(screen.getByText(t('en', 'liveRunLockedNoTargets'))).toBeTruthy();
  });

  it('locks live unfollow when name classification has not run', () => {
    const dataset = demoDataset();
    const unclassified = dataset.candidates.map(candidate => ({ ...candidate, gender: null }));
    renderReview({ candidates: unclassified, whitelistedResults: [], scanComplete: true });
    expect(screen.getByText(/No name classification results are available/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Unfollow \/ remove for real…/ }).disabled).toBe(true);
  });

  it('opens the live approval dialog with the exact eligible selection and forwards the typed phrase', () => {
    const onLiveRun = vi.fn();
    renderReview({ selectedIds: ['demo-1', 'demo-3'], onLiveRun });
    fireEvent.click(screen.getByRole('button', { name: /Unfollow \/ remove for real…/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/really unfollows or removes from your followers 2 accounts/)).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.input(within(dialog).getByLabelText('Confirmation phrase'), { target: { value: 'UNFOLLOW 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unfollow / remove for real' }));
    expect(onLiveRun).toHaveBeenCalledWith('UNFOLLOW 2', expect.arrayContaining(['demo-1', 'demo-3']));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('labels each guess with the main provider or the fallback that produced it', () => {
    const dataset = demoDataset();
    const first = dataset.candidates[0];
    const fallbackCandidate = {
      ...first,
      gender: first.gender === null ? null : { ...first.gender, source: 'deepseek' as const, model: 'deepseek-flash' },
    };
    renderReview({
      candidates: [fallbackCandidate],
      classifierAttribution: {
        primary: 'typesafe',
        fallback: 'deepseek',
        visionModel: 'deepseek-flash',
        photoEnabled: true,
      },
    });
    expect(screen.getByText(t('en', 'classifierViaFallback'))).toBeTruthy();
    const badge = screen.getByText(t('en', 'classifierViaFallback'));
    expect(badge.getAttribute('title')).toContain('deepseek');
  });

  it('shows an actionable banner when the classifier transport is blocked', () => {
    const onOpenSettings = vi.fn();
    renderReview({
      classifierError: 'Could not reach the local relay at ws://localhost:8787/ws. Start it with `npm run proxy`',
      onOpenSettings,
    });
    expect(screen.getByText(t('en', 'classifierUnavailableTitle'))).toBeTruthy();
    expect(screen.getByText(/Could not reach the local relay/)).toBeTruthy();
    expect(screen.getByText(t('en', 'relayHint'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('en', 'advancedLabel') }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('reports classification failures to the user', () => {
    renderReview({ classificationFailures: 4 });
    expect(screen.getByText(/could not answer for 4 accounts/)).toBeTruthy();
  });

  it('paginates long lists through the shared helpers', () => {
    const candidates = repeatedWomenFollowing(55);
    renderReview({ candidates, whitelistedResults: [], totalFetched: candidates.length });
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
  });

  it('shows an empty state when no rows match', () => {
    renderReview({ candidates: [], whitelistedResults: [] });
    expect(screen.getByText('No accounts match these filters.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Dry run — nothing will be changed/ }).disabled).toBe(
      true,
    );
  });

  it('shows the demo notice and demo badge only for the demo dataset', () => {
    renderReview();
    expect(screen.getByText(/Demo dataset — synthetic accounts/)).toBeTruthy();
    expect(screen.getByTestId('demo-badge')).toBeTruthy();
    cleanup();
    renderReview({ demo: false });
    expect(screen.queryByText(/Demo dataset — synthetic accounts/)).toBeNull();
    expect(screen.queryByTestId('demo-badge')).toBeNull();
  });

  it('switches language through the toolbar without hardcoded English', () => {
    const onLanguageChange = vi.fn();
    renderReview({ lang: 'es', onLanguageChange });
    expect(screen.getByRole('tab', { name: new RegExp(t('es', 'tabTargetFollowing', 'Mujeres')) })).toBeTruthy();
    expect(screen.getByText('Resumen de la auditoría')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    expect(onLanguageChange).toHaveBeenCalledWith('en');
  });

  it('lists machine, organization and ambiguous accounts under Other / uncertain and never makes them selectable', () => {
    renderReview({ currentTab: 'uncertain', demo: false });
    for (const username of ['nightly.bot', 'glint.supply', 'terra.works', 'field.notes.corp', 'nightform']) {
      expect(screen.getByText(`@${username}`)).toBeTruthy();
      const checkbox = screen.getByLabelText<HTMLInputElement>(`@${username} cannot be removed here`);
      expect(checkbox.disabled).toBe(true);
    }
    // Nothing in this tab can ever be selected for a plan.
    expect(screen.getByTestId('eligible-count').textContent).toBe(t('en', 'eligibleSelection', 0));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Dry run — nothing will be changed/ }).disabled).toBe(true);
  });

  it('shows the wizard-selected nuke category instead of a target selector', () => {
    renderReview();
    expect(screen.getByText(t('en', 'reviewNuking', 'Female'))).toBeTruthy();
    expect(screen.queryByLabelText('Looking for')).toBeNull();
    expect(screen.getByRole('tab', { name: new RegExp(t('en', 'tabTargetFollowing', 'Female')) })).toBeTruthy();
  });

  it('renders men target tabs, rows and summary when the target is men', () => {
    const dataset = demoDataset();
    const manFilter = filterForTarget('male');
    const summary = summarizeAudit(dataset.candidates, dataset.whitelistedResults, manFilter);
    renderReview({ filter: manFilter });

    // Tab labels and counts are target-aware.
    const followingTab = screen.getByRole('tab', { name: new RegExp(t('en', 'tabTargetFollowing', 'Male')) });
    expect(within(followingTab).getByText(String(summary.targetFollowing))).toBeTruthy();
    expect(screen.getByRole('tab', { name: new RegExp(t('en', 'tabTargetFollowers', 'Male')) })).toBeTruthy();

    // Likely men the viewer follows are listed; likely women are not.
    expect(screen.getByText('@dawnledger')).toBeTruthy();
    expect(screen.getByText('@elias.market')).toBeTruthy();
    expect(screen.getByText('@juniper.signal')).toBeTruthy();
    expect(screen.getByText('@lowlight.club')).toBeTruthy();
    expect(screen.getByText('@xenon.drift')).toBeTruthy();
    expect(screen.queryByText('@alina.frames')).toBeNull();

    // Summary labels and counts follow the target.
    const summaryTerm = screen.getByText(t('en', 'summaryTargetFollowing', 'Male'));
    expect(summaryTerm.parentElement?.querySelector('dd')?.textContent).toBe(String(summary.targetFollowing));
    expect(summary.targetFollowing).toBe(5);
    expect(summary.targetFollowers).toBe(0);
    // Everything that is not a confident man now lives in the other bucket.
    expect(summary.uncertain).toBe(dataset.candidates.length - 5);
    expect(summary.eligibleForUnfollow).toBe(5);
    expect(screen.getByText(t('en', 'summaryTargetFollowers', 'Male'))).toBeTruthy();
    // The old women wording is gone from the summary.
    expect(screen.queryByText(t('en', 'summaryTargetFollowing', 'Female'))).toBeNull();
  });

  it('renders the target-aware labels and summary in Spanish', () => {
    const manFilter = filterForTarget('male');
    renderReview({ lang: 'es', filter: manFilter });
    expect(screen.getByRole('tab', { name: new RegExp(t('es', 'tabTargetFollowing', 'Hombres')) })).toBeTruthy();
    expect(screen.getByText(t('es', 'summaryTargetFollowing', 'Hombres'))).toBeTruthy();
    expect(screen.getByText(t('es', 'reviewNuking', 'Hombres'))).toBeTruthy();
    expect(screen.queryByLabelText('Buscando')).toBeNull();
  });

  it('only lets likely men become eligible when the target is men', () => {
    const dataset = demoDataset();
    const manFilter = filterForTarget('male');
    const menEligible = getEligibleTargets(dataset.candidates, dataset.whitelistedResults, 0.6, 'male');
    expect(menEligible.map(candidate => candidate.user.username).sort()).toEqual([
      'dawnledger',
      'elias.market',
      'juniper.signal',
      'lowlight.club',
      'xenon.drift',
    ]);
    const onSelectionChange = vi.fn();
    renderReview({ filter: manFilter, demo: false, onSelectionChange });
    // The live action is locked until at least one eligible man is selected.
    const liveButton = screen.getByRole<HTMLButtonElement>('button', { name: /Unfollow \/ remove for real…/ });
    expect(liveButton.disabled).toBe(true);
    expect(screen.getByText(t('en', 'liveRunLockedNoTargets'))).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select @dawnledger for a possible removal' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['demo-4']);
  });

  it('keeps likely women unselectable under the men target', () => {
    const manFilter = filterForTarget('male');
    renderReview({ filter: manFilter });
    // A woman row is not in the men target tab at all, so there is no checkbox
    // offering to unfollow her under this target.
    expect(screen.queryByRole('checkbox', { name: 'Select @alina.frames for a possible removal' })).toBeNull();
    expect(screen.queryByLabelText('Select @citrus.archive for a possible removal')).toBeNull();
  });

  it('never performs network requests while rendering or interacting', () => {
    renderReview();
    fireEvent.click(screen.getByRole('tab', { name: /Other \/ uncertain/i }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
