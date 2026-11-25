import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailyShortlist } from '../../src/components/DailyShortlist';
import { DailyShortlistState } from '../../src/model/growth';
import { t } from '../../src/utils/i18n';

afterEach(cleanup);

const state: DailyShortlistState = {
  version: 1,
  refreshedAt: Date.now() - 60_000,
  dueAt: Date.now() + 24 * 60 * 60 * 1000,
  filterPrompt: 'ceramics',
  entries: [
    {
      id: '1',
      username: 'clay.studio',
      fullName: 'Clay Studio',
      biography: 'handbuilt stoneware',
      profilePicUrl: '',
      isPrivate: false,
      isVerified: false,
      followerCount: 1000,
      followingCount: 200,
      score: 0.82,
      sourceUsername: 'seed_one',
      sourceCount: 1,
      networkDistance: 1,
    },
  ],
  seen: {},
};

describe('DailyShortlist', () => {
  it('shows read-only 20 recommendations with match strength and far-out signal', () => {
    render(
      <DailyShortlist
        lang='en'
        prompt='ceramics'
        state={state}
        busy={false}
        onSavePrompt={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(t('en', 'dailyTitle'))).toBeTruthy();
    expect(screen.getByText('strong match')).toBeTruthy();
    expect(screen.getByText(t('en', 'dailyFar'))).toBeTruthy();
    expect(screen.getByText('@clay.studio')).toBeTruthy();
    expect(screen.getByText(t('en', 'dailyReadOnly'))).toBeTruthy();
  });

  it('shows an avatar, follow button and follow state from the explicit action', async () => {
    const onFollow = vi.fn(async () => ({ ok: true, state: 'following' as const }));
    const withPicture = {
      ...state,
      entries: [{ ...state.entries[0], profilePicUrl: 'https://cdn.example/avatar.jpg', isPrivate: true }],
    };
    const { container } = render(
      <DailyShortlist
        lang='en'
        prompt='ceramics'
        state={withPicture}
        busy={false}
        onSavePrompt={vi.fn()}
        onRefresh={vi.fn()}
        onFollow={onFollow}
      />,
    );
    const avatar = container.querySelector('.wa-daily__avatar img');
    expect(avatar?.getAttribute('src')).toBe('https://cdn.example/avatar.jpg');
    const button = screen.getByRole('button', { name: t('en', 'dailyRequestFollow') });
    fireEvent.click(button);
    expect(onFollow).toHaveBeenCalledTimes(1);
  });

  it('keeps save available while a refresh is running', () => {
    const onSavePrompt = vi.fn();
    render(
      <DailyShortlist lang='en' prompt='ceramics' state={state} busy onSavePrompt={onSavePrompt} onRefresh={vi.fn()} />,
    );
    const input = screen.getByLabelText(t('en', 'dailyFilterLabel'));
    fireEvent.input(input, { target: { value: 'process videos' } });
    const save = screen.getByRole('button', { name: t('en', 'dailySaveFilter') });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    expect(onSavePrompt).toHaveBeenCalledWith('process videos');
  });

  it('saves the filter prompt and reloads suggestions manually', () => {
    const onSavePrompt = vi.fn();
    const onRefresh = vi.fn();
    render(
      <DailyShortlist lang='en' prompt='ceramics' state={state} busy={false} onSavePrompt={onSavePrompt} onRefresh={onRefresh} />,
    );
    const input = screen.getByLabelText(t('en', 'dailyFilterLabel'));
    fireEvent.input(input, { target: { value: 'process videos and small studios' } });
    fireEvent.click(screen.getByRole('button', { name: t('en', 'dailySaveFilter') }));
    expect(onSavePrompt).toHaveBeenCalledWith('process videos and small studios');
    fireEvent.click(screen.getByRole('button', { name: t('en', 'dailyRefresh') }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
