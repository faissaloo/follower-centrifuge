/**
 * Guards the GitHub Pages landing page: it must carry the product branding,
 * the public-build key/privacy explanation and the relay requirements, and it
 * must keep the build-injection markers used by scripts/update-index.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

describe('public GitHub Pages landing page', () => {
  it('uses the Follower Centrifuge branding instead of the old fork page', () => {
    expect(html).toContain('Follower Centrifuge');
    expect(html).toContain('ur follows,');
    expect(html).toContain('both lists · dry run first');
    expect(html).not.toContain('Comic Neue');
    expect(html).not.toContain('Or use a Bookmarklet');
  });

  it('explains the keyless public build, API-key wizard and session-only storage', () => {
    expect(html).toContain('this page ships keyless');
    expect(html).toContain('the wizard asks for');
    expect(html).toContain('sessionStorage');
    expect(html).toContain('no api keys baked into this page');
  });

  it('explains the relay requirement and both removal directions', () => {
    expect(html).toContain('npm run proxy');
    expect(html).toContain('CA');
    expect(html).toContain('remove followers');
    expect(html).toContain('typesafe jev');
    expect(html).toContain('deepseek');
    expect(html).toContain('dry run first');
  });

  it('keeps the build-injection markers and copy control working', () => {
    expect(html).toContain('const instagramScript = "');
    expect(html).toContain('//__END_OF_SCRIPT__');
    expect(html).toContain('id="copy-button"');
    expect(html).toContain('navigator.clipboard.writeText(instagramScript)');
  });
});
