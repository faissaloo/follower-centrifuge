import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar, ToolbarProps } from '../../src/components/Toolbar';
import { t } from '../../src/utils/i18n';

afterEach(cleanup);

function toolbarProps(overrides: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    lang: 'en',
    onLanguageChange: vi.fn(),
    onOpenSettings: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe('Toolbar', () => {
  it('renders the brand and a working back button', () => {
    const onBack = vi.fn();
    render(<Toolbar {...toolbarProps({ onBack })} />);
    expect(screen.getByText(t('en', 'appName'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('disables back navigation while a process is active', () => {
    render(<Toolbar {...toolbarProps({ backDisabled: true })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Back' }).disabled).toBe(true);
  });

  it('switches from English to Spanish and back', () => {
    const onLanguageChange = vi.fn();
    const view = render(<Toolbar {...toolbarProps({ onLanguageChange })} />);
    const langButton = screen.getByRole('button', { name: 'Cambiar a Español' });
    expect(langButton.textContent).toContain('EN');
    fireEvent.click(langButton);
    expect(onLanguageChange).toHaveBeenCalledWith('es');
    view.rerender(<Toolbar {...toolbarProps({ lang: 'es', onLanguageChange })} />);
    expect(screen.getByRole('button', { name: 'Switch to English' }).textContent).toContain('ES');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to English' }));
    expect(onLanguageChange).toHaveBeenLastCalledWith('en');
  });

  it('opens settings from the icon button', () => {
    const onOpenSettings = vi.fn();
    render(<Toolbar {...toolbarProps({ onOpenSettings })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('renders the controlled search field and forwards changes', () => {
    const onSearchChange = vi.fn();
    const view = render(<Toolbar {...toolbarProps({ searchValue: 'ali', onSearchChange })} />);
    const search = screen.getByRole<HTMLInputElement>('searchbox');
    expect(search.value).toBe('ali');
    fireEvent.input(search, { target: { value: 'alina' } });
    expect(onSearchChange).toHaveBeenCalledWith('alina');
    view.rerender(<Toolbar {...toolbarProps({ searchValue: 'alina', onSearchChange })} />);
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('alina');
  });

  it('hides the search field when no search callback is provided', () => {
    render(<Toolbar {...toolbarProps()} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('shows no mode badge before a plan exists', () => {
    render(<Toolbar {...toolbarProps({ mode: null })} />);
    expect(screen.queryByTestId('mode-badge')).toBeNull();
  });

  it('shows a distinct dry-run badge and a distinct live badge', () => {
    const view = render(<Toolbar {...toolbarProps({ mode: 'dry-run' })} />);
    expect(screen.getByTestId('mode-badge').textContent).toBe('DRY RUN — nothing changed');
    expect(screen.getByTestId('mode-badge').className).toContain('wa-mode-badge--dry');
    view.rerender(<Toolbar {...toolbarProps({ mode: 'live' })} />);
    expect(screen.getByTestId('mode-badge').textContent).toBe('LIVE RUN');
    expect(screen.getByTestId('mode-badge').className).toContain('wa-mode-badge--live');
  });

  it('shows the demo badge only for demo datasets', () => {
    const view = render(<Toolbar {...toolbarProps({ demo: true })} />);
    expect(screen.getByTestId('demo-badge').textContent).toBe('DEMO DATA');
    view.rerender(<Toolbar {...toolbarProps({ demo: false })} />);
    expect(screen.queryByTestId('demo-badge')).toBeNull();
  });

  it('renders export buttons only when callbacks exist and calls them', () => {
    const onCopy = vi.fn();
    const onExportJson = vi.fn();
    const onExportCsv = vi.fn();
    const view = render(<Toolbar {...toolbarProps()} />);
    expect(screen.queryByRole('button', { name: 'Copy list' })).toBeNull();
    view.rerender(<Toolbar {...toolbarProps({ onCopy, onExportJson, onExportCsv })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy list' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onExportJson).toHaveBeenCalledTimes(1);
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  it('disables exports when requested', () => {
    render(<Toolbar {...toolbarProps({ onCopy: vi.fn(), exportsDisabled: true })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy list' }).disabled).toBe(true);
  });

  it('shows selection shortcuts and forwards page/all toggles', () => {
    const onToggleSelectPage = vi.fn();
    const onToggleSelectAll = vi.fn();
    render(
      <Toolbar
        {...toolbarProps({
          showSelection: true,
          selectPageChecked: true,
          onToggleSelectPage,
          onToggleSelectAll,
        })}
      />,
    );
    const selectPage = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select page' });
    expect(selectPage.checked).toBe(true);
    fireEvent.click(selectPage);
    expect(onToggleSelectPage).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(onToggleSelectAll).toHaveBeenCalledWith(true);
  });

  it('hides selection shortcuts outside the review screen', () => {
    render(<Toolbar {...toolbarProps()} />);
    expect(screen.queryByRole('checkbox', { name: 'Select page' })).toBeNull();
  });

  it('disables selection shortcuts when requested', () => {
    render(<Toolbar {...toolbarProps({ showSelection: true, selectionDisabled: true })} />);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select page' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select all' }).disabled).toBe(true);
  });
});
