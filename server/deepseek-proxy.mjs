#!/usr/bin/env node
/**
 * Entry point for the bundled local DeepSeek proxy (`npm run proxy`).
 *
 * Binds to 127.0.0.1 by default and never to a public interface: the proxy is
 * an extension of the user's own browser session and must not be reachable
 * from the network. The DeepSeek API key is read from the environment and
 * stays in this process.
 *
 * Environment:
 *   DEEPSEEK_API_KEY  required unless every caller sends its own Authorization
 *   DEEPSEEK_BASE_URL upstream base URL (default https://api.deepseek.com)
 *   CORS_ORIGINS      comma-separated allowed browser origins
 *   PORT (or DEEPSEEK_PROXY_PORT) listening port, default 8787
 *   HOST              listening host, default 127.0.0.1 (do not expose publicly)
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { createProxyHandler } from './proxy-handler.mjs';
import { attachRelay, RELAY_PATH } from './proxy-relay.mjs';
import { ensureLocalCertificate, relayLandingPage } from './proxy-tls.mjs';

import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_WSS_PORT } from './proxy-constants.mjs';
export { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_WSS_PORT };

function normalizePort(value) {
  const port = typeof value === 'number' ? value : Number(value);
  if (!isFinite(port) || port < 0 || port > 65535) {
    return DEFAULT_PORT;
  }
  return Math.floor(port);
}

function readPortFromEnv(env) {
  const explicit = typeof env.DEEPSEEK_PROXY_PORT === 'string' ? env.DEEPSEEK_PROXY_PORT.trim() : '';
  const standard = typeof env.PORT === 'string' ? env.PORT.trim() : '';
  if (explicit !== '') {
    return normalizePort(explicit);
  }
  if (standard !== '') {
    return normalizePort(standard);
  }
  return DEFAULT_PORT;
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
}

/**
 * Start the proxy on loopback. By default it listens on BOTH 127.0.0.1 and
 * ::1 so `ws://localhost:8787/ws` works no matter whether the browser resolves
 * localhost to IPv4 or IPv6 (Firefox often prefers ::1).
 *
 * Exported for tests; importing this module never starts a server (only running
 * it directly does).
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] Defaults to process.env.
 * @param {string} [options.host] Explicit single host override (defaults to dual loopback).
 * @param {number} [options.port] Defaults to PORT/DEEPSEEK_PROXY_PORT/8787.
 * @param {typeof fetch} [options.fetchImpl] Injected upstream transport.
 * @param {() => number} [options.now] Injected clock.
 * @param {number} [options.timeoutMs] Upstream timeout override.
 * @param {boolean} [options.tls] Also serve the WSS relay for Firefox.
 * @param {number} [options.wssPort] WSS/HTTPS port (default WSS_PORT/8788).
 * @param {string} [options.certDir] Directory for the generated localhost certificate.
 * @param {{ error?: (message: string) => void }} [options.logger] Logger sink.
 * @returns {Promise<{ server: import('node:http').Server, servers: import('node:http').Server[], host: string, port: number, relayUrl: string, close: () => Promise<void> }>}
 */
export function startDeepSeekProxy(options = {}) {
  const env = typeof options.env === 'object' && options.env !== null ? options.env : process.env;
  const explicitHost = typeof options.host === 'string' && options.host.trim() !== '' ? options.host.trim() : null;
  const requestedPort = options.port !== undefined ? normalizePort(options.port) : readPortFromEnv(env);
  const logger = options.logger !== undefined ? options.logger : console;
  const handler = createProxyHandler({
    env,
    fetchImpl: options.fetchImpl,
    now: options.now,
    timeoutMs: options.timeoutMs,
    logger: options.logger,
  });

  function createListeningServer(host) {
    const server = http.createServer(handler);
    const detachRelay = attachRelay(server, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      logger,
      allowedOrigins: options.allowedOrigins,
    });
    return { server, detachRelay, host };
  }

  function listen(server, host, port) {
    return new Promise((resolve, reject) => {
      function onError(error) {
        server.removeListener('listening', onListening);
        reject(error);
      }
      function onListening() {
        server.removeListener('error', onError);
        const address = server.address();
        const boundPort = address !== null && typeof address === 'object' ? address.port : port;
        resolve(boundPort);
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  return (async () => {
    const primary = createListeningServer(explicitHost !== null ? explicitHost : DEFAULT_HOST);
    let boundPort;
    try {
      boundPort = await listen(primary.server, primary.host, requestedPort);
    } catch (error) {
      primary.detachRelay();
      throw error;
    }

    const servers = [primary];
    if (explicitHost === null) {
      // Best-effort dual-stack loopback. Not all systems have IPv6; a failure
      // here must never stop the IPv4 proxy from working.
      const secondary = createListeningServer('::1');
      try {
        await listen(secondary.server, '::1', boundPort);
        servers.push(secondary);
      } catch {
        secondary.detachRelay();
        if (typeof logger.warn === 'function') {
          logger.warn('IPv6 loopback (::1) is unavailable; the relay only listens on 127.0.0.1.');
        }
      }
    }

    // Optional TLS/WSS relay: Instagram's `upgrade-insecure-requests` turns
    // ws://localhost into wss://localhost in Firefox, so Firefox users need this.
    let wssPort = null;
    let detachHttpsRelay = null;
    const tlsEnabled = options.tls === true;
    if (tlsEnabled) {
      const certificate = ensureLocalCertificate({ rootDir: process.cwd(), certDir: options.certDir });
      if (certificate === null) {
        if (typeof logger.warn === 'function') {
          logger.warn('openssl is unavailable: WSS relay disabled. Firefox users will need Chrome or an insecure-ws pref.');
        }
      } else {
        const requestedWssPort = normalizePort(
          options.wssPort !== undefined ? options.wssPort : env.WSS_PORT !== undefined ? env.WSS_PORT : DEFAULT_WSS_PORT,
        );
        const landing = Buffer.from(relayLandingPage(requestedWssPort), 'utf8');
        const tlsHandler = (req, res) => {
          if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(landing);
            return;
          }
          handler(req, res);
        };
        const tlsServer = https.createServer({ key: certificate.key, cert: `${certificate.cert}\n${certificate.caCert}` }, tlsHandler);
        detachHttpsRelay = attachRelay(tlsServer, {
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          logger,
        });
        try {
          wssPort = await listen(tlsServer, DEFAULT_HOST, requestedWssPort);
          const tlsSecondary = https.createServer({ key: certificate.key, cert: `${certificate.cert}\n${certificate.caCert}` }, tlsHandler);
          const tlsDetachSecondary = attachRelay(tlsSecondary, {
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
            logger,
          });
          try {
            await listen(tlsSecondary, '::1', wssPort);
            servers.push({ server: tlsServer, detachRelay: detachHttpsRelay, host: DEFAULT_HOST });
            servers.push({ server: tlsSecondary, detachRelay: tlsDetachSecondary, host: '::1' });
          } catch {
            tlsDetachSecondary();
            servers.push({ server: tlsServer, detachRelay: detachHttpsRelay, host: DEFAULT_HOST });
          }
        } catch {
          detachHttpsRelay();
          detachHttpsRelay = null;
          if (typeof logger.warn === 'function') {
            logger.warn(`Could not start the WSS relay on port ${requestedWssPort}; the plain ws relay still works.`);
          }
        }
      }
    }

    const relayHost = primary.host === '127.0.0.1' || primary.host === '::1' ? 'localhost' : primary.host;
    return {
      server: primary.server,
      servers: servers.map(entry => entry.server),
      host: primary.host,
      port: boundPort,
      relayUrl: `ws://${relayHost}:${boundPort}${RELAY_PATH}`,
      wssRelayUrl: wssPort === null ? null : `wss://localhost:${wssPort}${RELAY_PATH}`,
      httpsUrl: wssPort === null ? null : `https://localhost:${wssPort}/`,
      close: async () => {
        await Promise.all(
          servers.map(async entry => {
            entry.detachRelay();
            await closeServer(entry.server);
          }),
        );
      },
    };
  })();
}

function isExecutedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  startDeepSeekProxy({
    env: process.env,
    tls: true,
    // HOST is documented; default remains loopback (127.0.0.1).
    host: typeof process.env.HOST === 'string' && process.env.HOST.trim() !== '' ? process.env.HOST.trim() : undefined,
  })
    .then(async running => {
      const listenHosts = running.servers
        .map(server => {
          const address = server.address();
          return address !== null && typeof address === 'object' ? address.address : running.host;
        })
        .join(', ');
      console.log(`Local classifier proxy listening on http://${running.host}:${running.port} (${listenHosts})`);
      console.log(`Health check: curl http://${running.host}:${running.port}/health`);
      console.log(`WebSocket relay for instagram.com: ${running.relayUrl}`);
      if (running.wssRelayUrl !== null) {
        console.log(`Secure relay for Firefox: ${running.wssRelayUrl}`);
        console.log(`Firefox one-time step: open ${running.httpsUrl} and accept the local certificate, then rescan.`);
      } else {
        console.warn('Secure relay unavailable (openssl missing). Firefox will need network.websocket.allowInsecureFromHTTPS=true.');
      }
      console.log('Keep this process running while you scan from instagram.com.');
      if (running.wssRelayUrl !== null && process.env.INSTALL_FIREFOX_CERT !== '0') {
        try {
          const { installFirefoxRelayTrust } = await import('../scripts/trust-local-relay.mjs');
          const wssPort = Number(new URL(running.wssRelayUrl).port);
          const trust = installFirefoxRelayTrust({ rootDir: process.cwd(), wssPort });
          if (!trust.ok) {
            console.warn(`Could not install the Firefox certificate exception automatically: ${trust.reason}`);
          } else if (trust.profiles.length === 0) {
            console.log('No Firefox profiles found; Chrome/Edge need no certificate.');
          } else {
            const failures = trust.profiles.filter(profile => profile.error !== undefined);
            if (failures.length > 0) {
              console.warn('Could not update some Firefox profiles (run `npm run trust:relay` outside the sandbox).');
            } else {
              console.log('Firefox certificate exception installed for localhost:' + wssPort + ' (restart Firefox once to load it).');
            }
          }
        } catch (error) {
          console.warn(`Firefox certificate auto-install skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const configuredKey = typeof process.env.DEEPSEEK_API_KEY === 'string' ? process.env.DEEPSEEK_API_KEY.trim() : '';
      if (configuredKey === '') {
        console.warn(
          'Warning: DEEPSEEK_API_KEY is not set. Only requests that carry their own Authorization header will work. ' +
            'Set it before starting the proxy so the key never has to live in the browser.',
        );
      }
      const shutdown = () => {
        running.server.close(() => {
          process.exit(0);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch(error => {
      const detail = error instanceof Error ? error.message : 'unknown error';
      console.error(`Could not start the DeepSeek proxy: ${detail}`);
      process.exitCode = 1;
    });
}
