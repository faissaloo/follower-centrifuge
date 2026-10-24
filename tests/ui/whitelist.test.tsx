import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhitelistManager } from '../../src/components/WhitelistManager';
import { createDemoDataset } from '../../src/preview/demo-data';

afterEach(cleanup);

const DEMO = createDemoDataset();

function renderManager(overrides: { readonly lang?: 'en' | 'es'; readonly users?: boolean } = {}) {
  const onWhitelistUpdate = vi.fn();
  const view = render(
    <WhitelistManager
      lang={overrides.lang === undefined ? 'en' : overrides.lang}
      whitelistedUsers={overrides.users === false ? [] : DEMO.whitelistedResults}
      onWhitelistUpdate={onWhitelistUpdate}
    />,
  );
  return { ...view, onWhitelistUpdate };
}

describe('WhitelistManager', () => {
  it('shows an empty state and disables destructive actions with no protected accounts', () => {
    renderManager({ users: false });
    expect(screen.getByText('0 accounts')).toBeTruthy();
    expect(screen.getByText(/No protected accounts yet/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Export protected list/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Clear protected list/ }).disabled).toBe(true);
  });

  it('lists the protected accounts and enables export', () => {
    renderManager();
    expect(screen.getByText('2 accounts')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Export protected list/ }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /Clear protected list/ })).toBeTruthy();
  });

  it('adds bulk-pasted usernames through the callback', () => {
    const { onWhitelistUpdate } = renderManager({ users: false });
    fireEvent.click(screen.getByRole('button', { name: /Paste usernames/ }));
    const textarea = screen.getByLabelText(/Paste usernames here/);
    fireEvent.input(textarea, { target: { value: 'new.person, @Another_One\nthird' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to protected list/ }));
    expect(onWhitelistUpdate).toHaveBeenCalledTimes(1);
    const users = onWhitelistUpdate.mock.calls[0][0];
    expect(users.map((user: { username: string }) => user.username)).toEqual(['new.person', 'another_one', 'third']);
    expect(screen.getByText(/Added 3 new accounts to the protected list/)).toBeTruthy();
  });

  it('rejects a paste with no valid usernames', () => {
    const { onWhitelistUpdate } = renderManager({ users: false });
    fireEvent.click(screen.getByRole('button', { name: /Paste usernames/ }));
    fireEvent.input(screen.getByLabelText(/Paste usernames here/), { target: { value: '!! ??' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to protected list/ }));
    expect(onWhitelistUpdate).not.toHaveBeenCalled();
    expect(screen.getByText('No valid usernames found.')).toBeTruthy();
  });

  it('clears the protected list after confirmation', () => {
    const { onWhitelistUpdate } = renderManager();
    fireEvent.click(screen.getByRole('button', { name: /Clear protected list/ }));
    expect(onWhitelistUpdate).toHaveBeenCalledWith([]);
    expect(screen.getByText('Protected list cleared.')).toBeTruthy();
  });

  it('does not clear when the confirmation is declined', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const { onWhitelistUpdate } = renderManager();
    fireEvent.click(screen.getByRole('button', { name: /Clear protected list/ }));
    expect(onWhitelistUpdate).not.toHaveBeenCalled();
  });

  it('renders in Spanish', () => {
    renderManager({ lang: 'es' });
    expect(screen.getByText('Lista protegida')).toBeTruthy();
    expect(screen.getByText('2 cuentas')).toBeTruthy();
  });

  it('never performs network requests', () => {
    renderManager();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
