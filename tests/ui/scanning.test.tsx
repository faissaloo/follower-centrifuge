import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScanningScreen, ScanningScreenProps } from '../../src/components/ScanningScreen';

afterEach(cleanup);

function scanningProps(overrides: Partial<ScanningScreenProps> = {}): ScanningScreenProps {
  return {
    lang: 'en',
    phase: 'fetching-following',
    percentage: 10,
    followingFetched: 50,
    followersFetched: 0,
    classified: 0,
    toClassify: 0,
    ...overrides,
  };
}

describe('ScanningScreen', () => {
  it.each([
    ['fetching-following', 'loading follows'],
    ['fetching-followers', 'loading followers'],
    ['classifying', 'guessing names'],
    ['complete', 'done'],
    ['failed', 'stopped'],
  ] as const)('labels the %s phase', (phase, label) => {
    render(<ScanningScreen {...scanningProps({ phase, percentage: 100 })} />);
    expect(screen.getByText(`phase: ${label}`)).toBeTruthy();
  });

  it('shows that names are guessed while lists are still loading', () => {
    render(<ScanningScreen {...scanningProps({ phase: 'fetching-followers', classified: 12, toClassify: 3 })} />);
    expect(screen.getByText('guessing names while the lists load ⚡')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('shows the percentage through an accessible progress bar', () => {
    render(<ScanningScreen {...scanningProps({ percentage: 42 })} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('42');
    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('100');
    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('clamps out-of-range percentages', () => {
    render(<ScanningScreen {...scanningProps({ percentage: 250 })} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows all four live counters', () => {
    render(
      <ScanningScreen
        {...scanningProps({ classified: 12, toClassify: 38, followingFetched: 120, followersFetched: 80, percentage: 55 })}
      />,
    );
    expect(screen.getByText('follows loaded')).toBeTruthy();
    expect(screen.getByText('followers loaded')).toBeTruthy();
    expect(screen.getByText('names guessed')).toBeTruthy();
    expect(screen.getByText('left to guess')).toBeTruthy();
    for (const value of ['120', '80', '12', '38']) {
      expect(screen.getByText(value)).toBeTruthy();
    }
  });

  it('renders a runner notice when one is provided', () => {
    render(<ScanningScreen {...scanningProps({ notice: 'retrying after 30s' })} />);
    expect(screen.getByText(/retrying after 30s/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('heads up');
  });

  it('shows the stopped banner when the phase failed', () => {
    render(<ScanningScreen {...scanningProps({ phase: 'failed', percentage: 64 })} />);
    expect(screen.getByText(/scan stopped early/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel scan' })).toBeNull();
  });

  it('cancels a running scan', () => {
    const onCancel = vi.fn();
    render(<ScanningScreen {...scanningProps({ phase: 'classifying', onCancel })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables the cancel button when requested', () => {
    render(<ScanningScreen {...scanningProps({ onCancel: vi.fn(), cancelDisabled: true })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel scan' }).disabled).toBe(true);
  });

  it('renders in Spanish', () => {
    render(<ScanningScreen {...scanningProps({ lang: 'es', phase: 'classifying', percentage: 70 })} />);
    expect(screen.getByText('Escaneando tus listas de Instagram')).toBeTruthy();
    expect(screen.getByText(/Estimando nombres con DeepSeek/)).toBeTruthy();
  });
});
