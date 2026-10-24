/* eslint-disable react/no-deprecated -- `react-dom` is aliased to preact/compat below, so `render` is Preact's. */
import React from 'react';
import { render } from 'react-dom';
import './styles.scss';

import { App } from './App';
import { INSTAGRAM_HOSTNAME } from './constants/constants';

/**
 * Bootstrap for the console-pasted browser script (and the localhost preview).
 *
 * - On instagram.com the app is rendered into the tab of the logged-in account
 *   and uses that tab's own session cookies.
 * - On localhost/127.0.0.1 the app runs in fully offline demo mode: synthetic
 *   accounts only, no Instagram and no DeepSeek requests. `?preview=review`
 *   opens the demo review immediately (legacy `?preview=women` also works).
 * - Any other host is refused.
 */
const LOCAL_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const isLocalPreview = LOCAL_PREVIEW_HOSTS.has(location.hostname);

if (location.hostname !== INSTAGRAM_HOSTNAME && !isLocalPreview) {
  alert('Can be used only on Instagram routes');
} else {
  document.title = 'Follower Centrifuge 6000 Pro Max Ultra Plus Titanium Reloaded Flash Xtreme HD Turbo Enriched';
  document.body.innerHTML = '';
  // `?preview=review` is the documented token; `women` is a legacy alias.
  const previewToken = new URLSearchParams(location.search).get('preview');
  const autoLoadDemo = isLocalPreview && (previewToken === 'review' || previewToken === 'women');
  // `react-dom` is aliased to `preact/compat` (see webpack/vitest config), so
  // this is Preact's render, not React 18's deprecated ReactDOM.render.
  render(<App demoMode={isLocalPreview} autoLoadDemo={autoLoadDemo} />, document.body);
}
