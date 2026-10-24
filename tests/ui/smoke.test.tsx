import React from 'react';
import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

const Probe = ({ label }: { readonly label: string }) => (
  <div>
    <span>{label}</span>
  </div>
);

describe('test tooling', () => {
  it('renders preact components through the react compat alias', () => {
    render(<Probe label='hello-demo' />);
    expect(screen.getByText('hello-demo')).toBeTruthy();
  });

  it('trips the network guard on accidental fetch calls', async () => {
    await expect(fetch('https://www.instagram.com/api/v1/friendships/1/following/')).rejects.toThrow(
      /Automated tests must not perform real network requests/,
    );
  });

  it('blocks non-fetch browser transports as well', () => {
    expect(() => new XMLHttpRequest()).toThrow(/Automated tests must not perform real network requests/);
    expect(() => new WebSocket('wss://example.com')).toThrow(/Automated tests must not perform real network requests/);
    expect(() => new EventSource('https://example.com/events')).toThrow(
      /Automated tests must not perform real network requests/,
    );
    expect(() => navigator.sendBeacon('https://example.com', 'x')).toThrow(
      /Automated tests must not perform real network requests/,
    );
  });
});
