/**
 * TLS support for the local classifier relay.
 *
 * Instagram's CSP sends `upgrade-insecure-requests`, which (in Firefox) upgrades
 * the allowed `ws://localhost:*` connection to `wss://localhost:*`. To be
 * Firefox-compatible the relay therefore also serves WSS on a separate port
 * using a certificate issued by a locally generated CA. The installer script
 * adds that CA to the browser trust stores so the certificate is trusted without
 * any manual "accept the risk" step (one browser restart is still required for
 * NSS-based browsers to load the updated trust store).
 *
 * Everything lives in a gitignored `.proxy-cert/` directory and is only used for
 * this loopback relay.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WSS_PORT } from './proxy-constants.mjs';

export { DEFAULT_WSS_PORT };

const CERT_DIR_NAME = '.proxy-cert';
const CA_CERT_FILE = 'ca-cert.pem';
const CA_KEY_FILE = 'ca-key.pem';
const CERT_FILE = 'localhost-cert.pem';
const KEY_FILE = 'localhost-key.pem';
const CA_COMMON_NAME = 'Follower Centrifuge Local Relay CA';

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readFileIfPresent(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** True when both the CA and the leaf certificate/key are present. */
export function hasLocalCertificateChain(options = {}) {
  const certDir =
    typeof options.certDir === 'string'
      ? options.certDir
      : path.join(typeof options.rootDir === 'string' ? options.rootDir : process.cwd(), CERT_DIR_NAME);
  return [CA_CERT_FILE, CA_KEY_FILE, CERT_FILE, KEY_FILE].every(name => fs.existsSync(path.join(certDir, name)));
}

/**
 * Ensure the local CA + signed localhost certificate exist, generating them on
 * first use (or when the files are incomplete). Returns
 * `{ key, cert, caCert, certDir }` or null when openssl is unavailable.
 */
export function ensureLocalCertificate(options = {}) {
  const rootDir = typeof options.rootDir === 'string' ? options.rootDir : process.cwd();
  const certDir = typeof options.certDir === 'string' ? options.certDir : path.join(rootDir, CERT_DIR_NAME);
  const caCertPath = path.join(certDir, CA_CERT_FILE);
  const caKeyPath = path.join(certDir, CA_KEY_FILE);
  const certPath = path.join(certDir, CERT_FILE);
  const keyPath = path.join(certDir, KEY_FILE);
  try {
    const key = readFileIfPresent(keyPath);
    const cert = readFileIfPresent(certPath);
    const caCert = readFileIfPresent(caCertPath);
    if (key !== null && cert !== null && caCert !== null && fs.existsSync(caKeyPath)) {
      return { key, cert, caCert, certDir };
    }
  } catch {
    // Fall through to regeneration.
  }
  if (!opensslAvailable()) {
    return null;
  }
  try {
    fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
    const extPath = path.join(certDir, 'localhost.ext');
    const csrPath = path.join(certDir, 'localhost.csr');
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', caKeyPath, '-out', caCertPath,
        '-days', '825', '-subj', `/CN=${CA_COMMON_NAME}`,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      ],
      { stdio: 'ignore' },
    );
    execFileSync('openssl', ['genrsa', '-out', keyPath, '2048'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.writeFileSync(
      extPath,
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
        '',
      ].join('\n'),
    );
    execFileSync(
      'openssl',
      [
        'x509', '-req', '-in', csrPath,
        '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
        '-out', certPath, '-days', '397', '-extfile', extPath,
      ],
      { stdio: 'ignore' },
    );
    for (const file of [caKeyPath, keyPath]) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Best effort on non-POSIX filesystems.
      }
    }
    for (const file of [csrPath, extPath, path.join(certDir, 'ca-cert.srl')]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
    return {
      key: fs.readFileSync(keyPath, 'utf8'),
      cert: fs.readFileSync(certPath, 'utf8'),
      caCert: fs.readFileSync(caCertPath, 'utf8'),
      certDir,
    };
  } catch {
    return null;
  }
}

/** Small HTTPS landing page explaining the one-time certificate acceptance. */
export function relayLandingPage(wssPort) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Follower Centrifuge relay</title></head>
<body style="background:#131410;color:#ece8d8;font:16px/1.5 system-ui,Segoe UI,Arial;padding:2rem;max-width:44rem;margin:auto">
<h1 style="font:600 1.6rem Georgia,serif">Follower Centrifuge — local relay</h1>
<p><strong>The relay is running and its local CA is trusted.</strong> You can close this tab and return to Instagram.</p>
<p style="color:#a4a28c">If this page ever shows a certificate warning, run <code>npm run trust:relay</code> and restart Firefox once. Relay endpoint: wss://localhost:${wssPort}/ws · loopback only · no data leaves this machine except the classifier request you configured.</p>
</body></html>`;
}
