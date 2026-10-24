#!/usr/bin/env node
/**
 * Build the OPTIONAL local, gitignored script with provider API keys compiled
 * in, so the pasted browser script works with zero setup (no proxy).
 *
 * The default/public build (used for GitHub Pages) NEVER embeds keys — users of
 * the published page bring their own credentials in the app settings.
 *
 * Usage:
 *   npm run build:local-key                  # reads .deepseek-key / .typesafe-key
 *   TYPESAFE_API_KEY=... DEEPSEEK_API_KEY=... npm run build:local-key
 *
 * Output: dist/critical-relations-local.js (gitignored).
 * NEVER commit, publish or share the output.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');

function readKey(envName, fileName) {
  const envValue = typeof process.env[envName] === 'string' ? process.env[envName].trim() : '';
  if (envValue !== '') {
    return envValue;
  }
  const filePath = path.join(root, fileName);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  return '';
}

function fingerprint(key) {
  return `${key.slice(0, 8)}…${key.slice(-4)} (${key.length} chars, sha256 ${crypto
    .createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 12)})`;
}

const typeSafeKey = readKey('TYPESAFE_API_KEY', '.typesafe-key');
const deepSeekKey = readKey('DEEPSEEK_API_KEY', '.deepseek-key');

if (typeSafeKey === '' && deepSeekKey === '') {
  console.error('No keys found. Put a TypeSafe key in .typesafe-key and/or a DeepSeek key in .deepseek-key (both gitignored), or set TYPESAFE_API_KEY / DEEPSEEK_API_KEY.');
  process.exit(1);
}
if (typeSafeKey !== '' && !/^apikey_[A-Za-z0-9_-]{10,}$/.test(typeSafeKey)) {
  console.error('The TypeSafe key does not look valid (expected apikey_...). Aborting.');
  process.exit(1);
}
if (deepSeekKey !== '' && !/^sk-[A-Za-z0-9_-]{10,}$/.test(deepSeekKey)) {
  console.error('The DeepSeek key does not look valid (expected sk-...). Aborting.');
  process.exit(1);
}

console.log(
  `Building local keyed script — TypeSafe: ${typeSafeKey === '' ? 'not embedded' : fingerprint(typeSafeKey)}, ` +
    `DeepSeek fallback: ${deepSeekKey === '' ? 'not embedded' : fingerprint(deepSeekKey)}`,
);
try {
  execFileSync('npx', ['webpack', '--mode', 'production'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      IU_ALLOW_EMBEDDED_KEY: '1',
      TYPESAFE_API_KEY: typeSafeKey,
      DEEPSEEK_API_KEY: deepSeekKey,
    },
  });
} catch (error) {
  console.error('webpack build failed.');
  process.exit(error.status === undefined ? 1 : error.status);
}

const bundlePath = path.join(root, 'dist', 'dist.js');
const outputPath = path.join(root, 'dist', 'critical-relations-local.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');
if (typeSafeKey !== '' && !bundle.includes(typeSafeKey)) {
  console.error('Build did not embed the TypeSafe key (DefinePlugin missing?). Aborting.');
  process.exit(1);
}
if (deepSeekKey !== '' && !bundle.includes(deepSeekKey)) {
  console.error('Build did not embed the DeepSeek fallback key (DefinePlugin missing?). Aborting.');
  process.exit(1);
}
const banner =
  '/* Follower Centrifuge 6000 Pro Max Ultra Plus Titanium Reloaded Flash Xtreme HD Turbo Enriched — LOCAL BUILD WITH EMBEDDED PROVIDER KEYS.\n' +
  '   Do not commit, publish or share this file. Regenerate with: npm run build:local-key */\n';
fs.writeFileSync(outputPath, banner + bundle);
console.log(`Wrote ${path.relative(root, outputPath)} (${fs.statSync(outputPath).size} bytes)`);
console.log('Paste it into the instagram.com DevTools console. TypeSafe Jev is primary; DeepSeek is the fallback.');
