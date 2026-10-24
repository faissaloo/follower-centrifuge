#!/usr/bin/env node
/**
 * Install the local relay's certificate authority into the browsers so the
 * secure WSS relay (`wss://localhost:8788`) is trusted without any manual
 * "accept the risk" dialog.
 *
 * Preferred path: add the generated CA certificate to the NSS databases used by
 * Firefox (and Chrome's ~/.pki/nssdb) as a trusted CA (`certutil -A -t "C,,"`).
 * This is the same mechanism mkcert uses; it survives proxy restarts and only
 * requires a browser restart to load the updated trust store.
 *
 * Fallback (no certutil available): write a Firefox `cert_override.txt`
 * exception for the leaf certificate instead.
 *
 * A timestamped backup is made before touching cert_override.txt. NSS trust
 * changes are per-profile and can be removed with certutil `-D -n <nickname>`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureLocalCertificate } from '../server/proxy-tls.mjs';

const CERT_DIR = '.proxy-cert';
const CA_CERT_FILE = 'ca-cert.pem';
const LEAF_CERT_FILE = 'localhost-cert.pem';
const SHA256_OID = 'OID.2.16.840.1.101.3.4.2.1';
const HEADER = '# PSM Certificate Override Settings file\n# This is a generated file!  Do not edit.\n';
export const CA_NICKNAME = 'Follower Centrifuge Local Relay CA';

/** SHA-256 fingerprint of a PEM certificate, uppercase colon-hex (Firefox style). */
export function certificateFingerprintSha256(certPem) {
  const certificate = new crypto.X509Certificate(certPem);
  return certificate.fingerprint256.toUpperCase();
}

/** The exact cert_override.txt line for the local relay (fallback mode). */
export function overrideLine(wssPort, fingerprint) {
  return `localhost:${wssPort}\t${SHA256_OID}\t${fingerprint}\n`;
}

/** Locate a usable certutil binary (system PATH, project .tools, or CERTUTIL env). */
export function findCertutil(rootDir = process.cwd()) {
  const candidates = [];
  if (typeof process.env.CERTUTIL === 'string' && process.env.CERTUTIL.trim() !== '') {
    candidates.push(process.env.CERTUTIL.trim());
  }
  candidates.push(path.join(rootDir, '.tools', 'extracted', 'usr', 'bin', 'certutil'));
  candidates.push('certutil');
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-H'], { stdio: 'ignore' });
      return candidate;
    } catch (error) {
      // `certutil -H` exits non-zero on some builds; ENOENT means truly absent.
      const code = error !== null && typeof error === 'object' ? error.code : undefined;
      if (code !== 'ENOENT') {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Find certutil, optionally downloading the tiny Ubuntu package into the
 * gitignored `.tools/` directory (no root needed). Best effort only; when this
 * fails we fall back to a Firefox cert_override.txt exception.
 */
export function ensureCertutil(rootDir = process.cwd(), options = {}) {
  const existing = findCertutil(rootDir);
  if (existing !== null) {
    return existing;
  }
  if (options.allowDownload === false || process.platform !== 'linux') {
    return null;
  }
  try {
    const toolsDir = path.join(rootDir, '.tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    execFileSync('apt-get', ['download', 'libnss3-tools'], { cwd: toolsDir, stdio: 'ignore', timeout: 30000 });
    const deb = fs.readdirSync(toolsDir).find(name => name.startsWith('libnss3-tools') && name.endsWith('.deb'));
    if (deb === undefined) {
      return null;
    }
    execFileSync('dpkg-deb', ['-x', path.join(toolsDir, deb), path.join(toolsDir, 'extracted')], {
      stdio: 'ignore',
      timeout: 30000,
    });
    return findCertutil(rootDir);
  } catch {
    return null;
  }
}

/** Locate Firefox profiles that contain (or can contain) cert_override.txt. */
export function findFirefoxProfiles(home = os.homedir()) {
  const base = path.join(home, '.mozilla', 'firefox');
  const profiles = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return profiles;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(base, entry.name);
    if (fs.existsSync(path.join(dir, 'prefs.js')) || fs.existsSync(path.join(dir, 'cert9.db'))) {
      profiles.push(dir);
    }
  }
  return profiles;
}

/** Locate Chrome/Chromium shared NSS database, when present. */
export function findChromeNssDb(home = os.homedir()) {
  const db = path.join(home, '.pki', 'nssdb');
  return fs.existsSync(path.join(db, 'cert9.db')) ? db : null;
}

/** Add (or refresh) the relay exception in one Firefox profile directory. */
export function installOverrideInProfile(profileDir, line, wssPort = 8788) {
  const file = path.join(profileDir, 'cert_override.txt');
  let existing = '';
  let backupPath = null;
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf8');
    backupPath = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backupPath);
  }
  const relayKey = new RegExp(`^localhost:${wssPort}:?\\t`);
  const withoutRelay = existing
    .split('\n')
    .filter(entry => !relayKey.test(entry))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  let content = withoutRelay;
  if (!content.startsWith('# PSM Certificate Override Settings file')) {
    content = HEADER + content;
  }
  if (!content.endsWith('\n')) {
    content += '\n';
  }
  content += line;
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { changed: content !== existing, backupPath };
}

/** Remove any relay exception line from a Firefox profile (CA install supersedes it). */
export function removeOverrideFromProfile(profileDir, wssPort = 8788) {
  const file = path.join(profileDir, 'cert_override.txt');
  if (!fs.existsSync(file)) {
    return { changed: false };
  }
  const existing = fs.readFileSync(file, 'utf8');
  const relayKey = new RegExp(`^localhost:${wssPort}:?\\t`, 'm');
  if (!relayKey.test(existing)) {
    return { changed: false };
  }
  const content = existing
    .split('\n')
    .filter(entry => !relayKey.test(entry))
    .join('\n');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return { changed: true };
}

function installCaIntoNssDb(certutil, dbDir, caCertPath) {
  try {
    execFileSync(certutil, ['-D', '-n', CA_NICKNAME, '-d', `sql:${dbDir}`], { stdio: 'ignore' });
  } catch {
    // No previous entry.
  }
  execFileSync(
    certutil,
    ['-A', '-n', CA_NICKNAME, '-t', 'C,,', '-i', caCertPath, '-d', `sql:${dbDir}`],
    { stdio: 'pipe' },
  );
  const listed = execFileSync(certutil, ['-L', '-d', `sql:${dbDir}`], { encoding: 'utf8' });
  if (!listed.includes(CA_NICKNAME)) {
    throw new Error('certutil did not list the installed CA');
  }
}

/**
 * Install the relay certificate authority into every browser trust store found.
 * Returns a structured report for the CLI/proxy startup log.
 */
export function installRelayTrust(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const home = options.home ?? os.homedir();
  const wssPort = options.wssPort ?? 8788;
  const certDir = path.join(rootDir, CERT_DIR);
  let caPath = path.join(certDir, CA_CERT_FILE);
  let leafPath = path.join(certDir, LEAF_CERT_FILE);
  if (!fs.existsSync(caPath) || !fs.existsSync(leafPath)) {
    const generated = ensureLocalCertificate({ rootDir, certDir });
    if (generated === null) {
      return { ok: false, reason: 'could not generate the local CA; is openssl installed?' };
    }
    caPath = path.join(certDir, CA_CERT_FILE);
    leafPath = path.join(certDir, LEAF_CERT_FILE);
  }
  const caPem = fs.readFileSync(caPath, 'utf8');
  const leafFingerprint = certificateFingerprintSha256(fs.readFileSync(leafPath, 'utf8'));
  const certutil =
    options.certutilPath !== undefined
      ? options.certutilPath
      : ensureCertutil(rootDir, { allowDownload: options.allowDownloadCertutil !== false });
  const profiles = findFirefoxProfiles(home);
  const chromeDb = findChromeNssDb(home);
  const results = [];

  if (certutil !== null) {
    for (const profileDir of profiles) {
      const dbDir = path.join(profileDir, 'cert9.db');
      if (!fs.existsSync(dbDir)) {
        results.push({ profileDir, mode: 'skipped', error: 'no NSS database yet (start Firefox once)' });
        continue;
      }
      try {
        installCaIntoNssDb(certutil, profileDir, caPath);
        removeOverrideFromProfile(profileDir, wssPort);
        results.push({ profileDir, mode: 'ca', changed: true });
      } catch (error) {
        results.push({ profileDir, mode: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (chromeDb !== null) {
      try {
        installCaIntoNssDb(certutil, chromeDb, caPath);
        results.push({ profileDir: chromeDb, mode: 'ca', changed: true });
      } catch (error) {
        results.push({ profileDir: chromeDb, mode: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      ok: true,
      mode: 'ca',
      caFingerprint: certificateFingerprintSha256(caPem),
      leafFingerprint,
      certutil,
      profiles: results,
      restartRequired: results.some(entry => entry.mode === 'ca'),
    };
  }

  // Fallback: Firefox per-host certificate exception.
  const line = overrideLine(wssPort, leafFingerprint);
  for (const profileDir of profiles) {
    try {
      results.push({ profileDir, mode: 'override', ...installOverrideInProfile(profileDir, line, wssPort) });
    } catch (error) {
      results.push({ profileDir, mode: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ok: true,
    mode: 'override',
    leafFingerprint,
    profiles: results,
    restartRequired: profiles.length > 0,
    reason: 'certutil not found; Firefox certificate exception written instead',
  };
}

// Backwards-compatible name used by earlier code/tests.
export function installFirefoxRelayTrust(options = {}) {
  return installRelayTrust(options);
}

function describeTrust(results) {
  for (const entry of results.profiles ?? []) {
    if (entry.error !== undefined) {
      console.error(`✗ ${entry.profileDir}: ${entry.error}`);
    } else if (entry.mode === 'ca') {
      console.log(`✓ ${entry.profileDir} (trusted local CA)`);
    } else if (entry.mode === 'override') {
      console.log(`✓ ${entry.profileDir}${entry.changed ? '' : ' (already up to date)'} (certificate exception)`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = installRelayTrust();
  if (!result.ok) {
    console.error(`Could not install the local relay certificate: ${result.reason}`);
    process.exitCode = 1;
  } else if ((result.profiles ?? []).length === 0) {
    console.warn('No browser trust stores found.');
  } else {
    if (result.mode === 'ca') {
      console.log(`Installed trusted local CA "${CA_NICKNAME}" (${result.caFingerprint}).`);
    } else {
      console.log(`certutil unavailable (${result.reason}); installed Firefox certificate exception instead.`);
    }
    describeTrust(result);
    console.log('Restart Firefox once so it reloads the trust store — no certificate dialog is needed.');
  }
}
