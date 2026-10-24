import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DryRunPlan,
  ExecutionEntry,
  LivePlan,
  PlannedTarget,
} from '../../src/model/action-plan';
import { ExecutingScreen, ExecutingScreenProps } from '../../src/components/ExecutingScreen';
import { t, TranslationKey } from '../../src/utils/i18n';

function text(key: TranslationKey, ...args: Array<string | number>): string {
  return t('en', key, ...args);
}
import { createDemoCandidates } from '../../src/preview/demo-data';
import { liveConfirmationPhrase } from '../../src/utils/approval';

afterEach(cleanup);

function targetsFromDemo(count: number): readonly PlannedTarget[] {
  const candidates = createDemoCandidates().filter(
    candidate => candidate.relationship !== 'follower' && candidate.gender !== null && candidate.gender.gender === 'female',
  );
  return candidates.slice(0, count).map(candidate => ({ user: candidate.user, relationship: candidate.relationship }));
}

function dryPlan(count = 3): DryRunPlan {
  return { mode: 'dry-run', targets: targetsFromDemo(count), skipped: [], createdAt: 0 };
}

function livePlan(count = 3): LivePlan {
  const targets = targetsFromDemo(count);
  return {
    mode: 'live',
    targets,
    skipped: [],
    createdAt: 0,
    approval: { typedConfirmation: liveConfirmationPhrase(targets.length), expectedCount: targets.length, approvedAt: 0 },
  };
}

function simulatedEntries(plan: DryRunPlan): readonly ExecutionEntry[] {
  return plan.targets.map(target => ({ user: target.user, status: 'simulated' as const }));
}

function executingProps(overrides: Partial<ExecutingScreenProps> = {}): ExecutingScreenProps {
  return {
    lang: 'en',
    plan: dryPlan(),
    percentage: 0,
    entries: [],
    searchTerm: '',
    showSucceeded: true,
    showFailed: true,
    onSearchChange: vi.fn(),
    onShowSucceededChange: vi.fn(),
    onShowFailedChange: vi.fn(),
    onStop: vi.fn(),
    onBack: vi.fn(),
    onLanguageChange: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

function renderExecuting(overrides: Partial<ExecutingScreenProps> = {}) {
  const props = executingProps(overrides);
  return render(<ExecutingScreen {...props} />);
}

describe('ExecutingScreen', () => {
  it('renders the distinct blue simulation banner for a dry run', () => {
    renderExecuting({ plan: dryPlan(), entries: simulatedEntries(dryPlan()), percentage: 100 });
    const banner = screen.getByTestId('mode-banner');
    expect(banner.getAttribute('data-mode')).toBe('dry-run');
    expect(banner.getAttribute('role')).toBe('status');
    expect(screen.getByText('SIMULATION — nothing was changed')).toBeTruthy();
    expect(screen.getByText(/nobody got unfollowed/)).toBeTruthy();
    expect(screen.queryByText('LIVE RUN — accounts were really removed')).toBeNull();
    expect(screen.getByTestId('mode-badge').textContent).toBe('DRY RUN — nothing changed');
  });

  it('shows the pacing cooldown countdown and an estimated time to completion', () => {
    const plan = livePlan();
    renderExecuting({
      plan,
      percentage: 2,
      entries: [{ user: plan.targets[0].user, status: 'unfollowed' }],
      estimatedRemainingMs: 65_000,
      cooldownEndsAt: Date.now() + 5_000,
    });
    expect(screen.getByText(/estimated time remaining: ~1m 5s/)).toBeTruthy();
    expect(screen.getByText(/pacing pause — next removal in/)).toBeTruthy();
  });

  it('renders the distinctive red live-run alert for a live plan', () => {
    const plan = livePlan();
    const entries: readonly ExecutionEntry[] = [
      { user: plan.targets[0].user, status: 'unfollowed' },
      { user: plan.targets[1].user, status: 'failed', detail: '429 rate limited' },
      { user: plan.targets[2].user, status: 'blocked', detail: 'feedback_required' },
    ];
    renderExecuting({ plan, entries, percentage: 100, stopReason: 'action-blocked' });
    const banner = screen.getByTestId('mode-banner');
    expect(banner.getAttribute('data-mode')).toBe('live');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(screen.getByText('LIVE RUN — accounts were really removed')).toBeTruthy();
    expect(screen.getByText(/live run\. 1 accounts were actually unfollowed or removed/)).toBeTruthy();
    expect(screen.queryByText('SIMULATION — nothing was changed')).toBeNull();
    expect(screen.getByTestId('mode-badge').textContent).toBe('LIVE RUN');
  });

  it('shows progress, plan size and approval provenance', () => {
    const plan = livePlan();
    const entries: readonly ExecutionEntry[] = [{ user: plan.targets[0].user, status: 'unfollowed' }];
    renderExecuting({ plan, entries, percentage: 33, stopReason: 'aborted' });
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('33');
    expect(screen.getByText('33%')).toBeTruthy();
    expect(screen.getByText('1 / 3 done')).toBeTruthy();
    expect(screen.getByText(/3 accounts in this plan/)).toBeTruthy();
    expect(screen.getByText(/live approval entered for 3 accounts/i)).toBeTruthy();
  });

  it('offers a stop button while running and disables back navigation', () => {
    const onStop = vi.fn();
    const plan = dryPlan();
    renderExecuting({ plan, entries: [], percentage: 0, onStop });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Back' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Back to review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows the live running warning only for live runs', () => {
    const live = livePlan();
    renderExecuting({ plan: live, entries: [], percentage: 10 });
    expect(screen.getByText(/dont close this tab/)).toBeTruthy();
    cleanup();
    renderExecuting({ plan: dryPlan(), entries: [], percentage: 10 });
    expect(screen.queryByText(/dont close this tab/)).toBeNull();
  });

  it('shows the finished state with a back-to-review action once stopped', () => {
    const plan = dryPlan();
    const onBack = vi.fn();
    renderExecuting({ plan, entries: simulatedEntries(plan), percentage: 100, stopReason: 'complete', onBack });
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByText(/^done$/i)).toBeTruthy();
    expect(screen.getByText(/Completed/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Back' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back to review' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('promotes a completed dry run with a clear nuke-for-real prompt', () => {
    const onRequestLive = vi.fn();
    const plan = dryPlan();
    renderExecuting({ plan, entries: simulatedEntries(plan), percentage: 100, stopReason: 'complete', onRequestLive });
    expect(screen.getByText(text('dryRunReadyTitle'))).toBeTruthy();
    expect(screen.getByText(text('dryRunReadyBody', plan.targets.length))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: text('dryRunReadyAction') }));
    expect(onRequestLive).toHaveBeenCalledTimes(1);
  });

  it('explains why a completed dry run cannot be promoted', () => {
    const onRequestLive = vi.fn();
    const plan = dryPlan();
    renderExecuting({
      plan,
      entries: simulatedEntries(plan),
      percentage: 100,
      stopReason: 'complete',
      onRequestLive,
      requestLiveDisabledReason: 'live is locked here',
    });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: text('dryRunReadyAction') });
    expect(button.disabled).toBe(true);
    expect(screen.getByText('live is locked here')).toBeTruthy();
  });

  it.each([
    ['complete', /Completed/],
    ['aborted', /Stopped by you/],
    ['action-blocked', /Stopped by Instagram \(action block\)/],
    ['invalid-approval', /Stopped: invalid approval/],
    ['missing-session', /Stopped: Instagram session missing/],
  ] as const)('renders the %s stop reason', (stopReason, matcher) => {
    renderExecuting({ stopReason, entries: [], percentage: 0 });
    expect(screen.getByText(matcher)).toBeTruthy();
  });

  it('labels dry-run entries as simulated and live statuses distinctly', () => {
    const plan = dryPlan();
    const entries: readonly ExecutionEntry[] = [
      { user: plan.targets[0].user, status: 'simulated', detail: 'would unfollow' },
      { user: plan.targets[1].user, status: 'unfollowed' },
      { user: plan.targets[2].user, status: 'failed', detail: 'network error' },
    ];
    renderExecuting({ plan, entries, percentage: 100, stopReason: 'complete' });
    expect(screen.getByText('Simulated — would have been removed')).toBeTruthy();
    expect(screen.getByText('Unfollowed')).toBeTruthy();
    expect(within(screen.getByRole('list')).getByText('Failed')).toBeTruthy();
    expect(screen.getByText('network error')).toBeTruthy();
  });

  it('filters the log by succeeded/failed checkboxes', () => {
    const plan = dryPlan();
    const entries: readonly ExecutionEntry[] = [
      { user: plan.targets[0].user, status: 'simulated' },
      { user: plan.targets[1].user, status: 'failed', detail: 'boom' },
    ];
    const onShowSucceededChange = vi.fn();
    const onShowFailedChange = vi.fn();
    renderExecuting({ plan, entries, percentage: 100, stopReason: 'complete', onShowSucceededChange, onShowFailedChange });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Succeeded' }));
    expect(onShowSucceededChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Failed' }));
    expect(onShowFailedChange).toHaveBeenCalledWith(false);
  });

  it('hides log groups according to the controlled filter props', () => {
    const plan = dryPlan();
    const entries: readonly ExecutionEntry[] = [
      { user: plan.targets[0].user, status: 'simulated' },
      { user: plan.targets[1].user, status: 'failed', detail: 'boom' },
    ];
    renderExecuting({ plan, entries, percentage: 100, stopReason: 'complete', showSucceeded: false });
    expect(screen.queryByText('Simulated — would have been removed')).toBeNull();
    expect(within(screen.getByRole('list')).getByText('Failed')).toBeTruthy();
    cleanup();
    renderExecuting({ plan, entries, percentage: 100, stopReason: 'complete', showFailed: false });
    expect(screen.getByText('Simulated — would have been removed')).toBeTruthy();
    expect(screen.queryByText('boom')).toBeNull();
    cleanup();
    renderExecuting({ plan, entries, percentage: 100, stopReason: 'complete', showSucceeded: false, showFailed: false });
    expect(screen.getByText('nothing matches those filters.')).toBeTruthy();
  });

  it('filters log entries by the controlled search term', () => {
    const plan = dryPlan();
    const entries: readonly ExecutionEntry[] = [
      { user: plan.targets[0].user, status: 'simulated' },
      { user: plan.targets[1].user, status: 'simulated' },
    ];
    const firstUsername = plan.targets[0].user.username;
    renderExecuting({ plan, entries, percentage: 100, stopReason: 'complete', searchTerm: firstUsername.slice(0, 5) });
    expect(screen.getByText(`@${plan.targets[0].user.username}`)).toBeTruthy();
    expect(screen.queryByText(`@${plan.targets[1].user.username}`)).toBeNull();
  });

  it('sends search input changes to App', () => {
    const onSearchChange = vi.fn();
    renderExecuting({ onSearchChange });
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'ali' } });
    expect(onSearchChange).toHaveBeenCalledWith('ali');
  });

  it('renders in Spanish with the simulation banner translated', () => {
    const plan = dryPlan();
    renderExecuting({ lang: 'es', plan, entries: simulatedEntries(plan), percentage: 100, stopReason: 'complete' });
    expect(screen.getByText('SIMULACIÓN — no se cambió nada')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Volver a revisar' })).toBeTruthy();
  });

  it('never performs network requests', () => {
    const plan = dryPlan();
    renderExecuting({ plan, entries: simulatedEntries(plan), percentage: 100, stopReason: 'complete' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('ExecutingScreen: whitelist-during-run stop', () => {
  it('explains that the queue stopped because a queued account was protected', () => {
    const plan = livePlan(2);
    render(
      <ExecutingScreen
        {...executingProps({
          plan,
          percentage: 50,
          entries: [{ user: plan.targets[0].user, status: 'unfollowed' }],
          stopReason: 'protected-target',
        })}
      />,
    );
    expect(screen.getByText(/a queued account was protected/i)).toBeTruthy();
  });
});
