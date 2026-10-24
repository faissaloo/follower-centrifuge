import React from 'react';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Centrifuge } from '../../src/components/Centrifuge';
import {
  BRAND_EDITION,
  BRAND_FULL_NAME,
  BRAND_NAME,
  BrandWordmark,
} from '../../src/components/icons/BrandWordmark';
import { translations } from '../../src/utils/i18n';

afterEach(cleanup);

describe('Centrifuge animation', () => {
  it('renders a decorative enrichment cascade', () => {
    const { container } = render(<Centrifuge size='lg' enriching />);
    const root = container.querySelector<HTMLElement>('.wa-centrifuge');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.classList.contains('wa-centrifuge--lg')).toBe(true);
    expect(root?.classList.contains('wa-centrifuge--enriching')).toBe(true);
    expect(container.querySelectorAll('.wa-centrifuge__ring')).toHaveLength(3);
    expect(container.querySelectorAll('.wa-centrifuge__bar')).toHaveLength(8);
    expect(container.querySelector('.wa-centrifuge__core')).not.toBeNull();
  });

  it('supports compact sizing without the enriching fast-forward', () => {
    const { container } = render(<Centrifuge size='sm' />);
    const root = container.querySelector<HTMLElement>('.wa-centrifuge');
    expect(root?.classList.contains('wa-centrifuge--sm')).toBe(true);
    expect(root?.classList.contains('wa-centrifuge--enriching')).toBe(false);
  });
});

describe('Follower Centrifuge branding', () => {
  it('keeps the head name short and stacks plenty of version suffixes', () => {
    expect(BRAND_NAME).toBe('Follower Centrifuge');
    for (const suffix of ['6000', 'Pro Max', 'Ultra Plus', 'Titanium', 'Reloaded', 'Flash', 'Xtreme', 'HD', 'Turbo', 'Enriched']) {
      expect(BRAND_EDITION).toContain(suffix);
    }
    expect(BRAND_FULL_NAME).toBe(`${BRAND_NAME} ${BRAND_EDITION}`);
  });

  it('uses the same exact product name in both dictionaries', () => {
    expect(translations.en.appName).toBe(BRAND_FULL_NAME);
    expect(translations.es.appName).toBe(translations.en.appName);
    expect(translations.en.appName).not.toContain('Critical Relations');
  });

  it('renders the wordmark with the full name in the accessibility tree', () => {
    const { container } = render(<BrandWordmark name={translations.en.appName} large />);
    const root = container.querySelector<HTMLElement>('.wa-brand');
    expect(root?.getAttribute('aria-label')).toBe(BRAND_FULL_NAME);
    expect(container.textContent).toContain(BRAND_FULL_NAME);
  });
});
