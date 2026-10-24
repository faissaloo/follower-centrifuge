/**
 * Tests for the local relay certificate trust installer.
 *
 * Preferred mode installs a generated CA into browser NSS databases with
 * certutil (same approach as mkcert); when certutil is unavailable it falls
 * back to a Firefox cert_override.txt exception. All writes happen in temporary
 * directories; real browser profiles are never touched by the tests.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  certificateFingerprintSha256,
  findCertutil,
  findFirefoxProfiles,
  installFirefoxRelayTrust,
  installOverrideInProfile,
  overrideLine,
  removeOverrideFromProfile,
} from '../../scripts/trust-local-relay.mjs';

function makeCertificate(dir: string): { key: string; cert: string } {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
  ], { stdio: 'ignore' });
  return { key, cert: fs.readFileSync(cert, 'utf8') };
}

function makeFakeHomeWithProfiles(): { home: string; profiles: string[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-home-'));
  const profiles: string[] = [];
  for (const name of ['abc.default', 'xyz.Work']) {
    const profile = path.join(home, '.mozilla', 'firefox', name);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'prefs.js'), '// prefs\n');
    profiles.push(profile);
  }
  return { home, profiles };
}

describe('cert_override fallback helpers', () => {
  it('builds the current cert_override.txt line format', () => {
    expect(overrideLine(8788, 'AA:BB:CC')).toBe('localhost:8788\tOID.2.16.840.1.101.3.4.2.1\tAA:BB:CC\n');
  });

  it('fingerprints a certificate as uppercase colon-hex SHA-256', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-cert-'));
    try {
      const { cert } = makeCertificate(dir);
      expect(certificateFingerprintSha256(cert)).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the exception, backs up the old file and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-profile-'));
    try {
      const file = path.join(dir, 'cert_override.txt');
      fs.writeFileSync(file, '# PSM Certificate Override Settings file\nlocalhost:7127:\tOID.2.16.840.1.101.3.4.2.1\tAA:BB\tU\tZZZ\n');
      const line = overrideLine(8788, '11:22');
      const first = installOverrideInProfile(dir, line, 8788);
      expect(first.changed).toBe(true);
      expect(first.backupPath).not.toBeNull();
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain(line);
      expect(content).toContain('localhost:7127'); // unrelated exception preserved
      expect(content.indexOf(line)).toBe(content.lastIndexOf(line));

      const second = installOverrideInProfile(dir, line, 8788);
      expect(second.changed).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes only this relay port from an override file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-remove-'));
    try {
      const file = path.join(dir, 'cert_override.txt');
      fs.writeFileSync(
        file,
        '# PSM Certificate Override Settings file\nlocalhost:7127:\tOID.2.16.840.1.101.3.4.2.1\tAA:BB\tU\tZZZ\n' +
          'localhost:8788\tOID.2.16.840.1.101.3.4.2.1\t11:22\n',
      );
      expect(removeOverrideFromProfile(dir, 8788).changed).toBe(true);
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain('localhost:7127');
      expect(content).not.toContain('localhost:8788');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('relay trust installer', () => {
  it('generates the CA + certificate itself when they are missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-empty-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-nocert-'));
    try {
      const result = installFirefoxRelayTrust({ rootDir: root, home, wssPort: 8788, allowDownloadCertutil: false });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(root, '.proxy-cert', 'ca-cert.pem'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.proxy-cert', 'localhost-cert.pem'))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to Firefox exceptions when certutil is unavailable', () => {
    const { home, profiles } = makeFakeHomeWithProfiles();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-fallback-'));
    try {
      expect(findFirefoxProfiles(home)).toHaveLength(2);
      const result = installFirefoxRelayTrust({
        rootDir: root,
        home,
        wssPort: 8788,
        allowDownloadCertutil: false,
        certutilPath: null,
      });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('override');
      for (const profile of profiles) {
        expect(fs.readFileSync(path.join(profile, 'cert_override.txt'), 'utf8')).toContain('localhost:8788');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs the generated CA into a real NSS database when certutil is available', () => {
    const certutil = findCertutil(process.cwd());
    if (certutil === null) {
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-ca-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trust-ca-root-'));
    try {
      const profile = path.join(home, '.mozilla', 'firefox', 'test.default');
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, 'prefs.js'), '// prefs\n');
      execFileSync(certutil, ['-N', '--empty-password', '-d', `sql:${profile}`], { stdio: 'ignore' });
      const result = installFirefoxRelayTrust({ rootDir: root, home, wssPort: 8788, certutilPath: certutil });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe('ca');
      expect(result.profiles?.some(entry => entry.mode === 'ca')).toBe(true);
      const listed = execFileSync(certutil, ['-L', '-d', `sql:${profile}`], { encoding: 'utf8' });
      expect(listed).toContain('Follower Centrifuge Local Relay CA');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
