/**
 * Loopback tests for the proxy's WebSocket relay.
 *
 * Instagram's CSP allows ws://localhost:* but blocks direct fetch to the
 * classifier APIs, so the relay is the production transport on instagram.com.
 * These tests use a real local server + WebSocket client; the upstream is an
 * injected fake fetch, so no external network is touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startDeepSeekProxy } from '../../server/deepseek-proxy.mjs';

interface StartedProxy {
  readonly server: import('node:http').Server;
  readonly relayUrl: string;
  readonly wssRelayUrl?: string | null;
  readonly httpsUrl?: string | null;
  readonly close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      await cleanup();
    }
  }
});

async function startProxy(fetchImpl: typeof fetch): Promise<StartedProxy> {
  const started = (await startDeepSeekProxy({
    env: {},
    port: 0,
    fetchImpl,
    logger: { error: () => undefined },
  })) as unknown as StartedProxy;
  cleanups.push(started.close);
  return started;
}

function openRelay(
  relayUrl: string,
  origin = 'https://www.instagram.com',
): Promise<{ readonly socket: WebSocket; readonly next: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl, { origin });
    const queue: Array<Record<string, unknown>> = [];
    const pending: Array<(value: Record<string, unknown>) => void> = [];
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      const waiter = pending.shift();
      if (waiter !== undefined) {
        waiter(message);
      } else {
        queue.push(message);
      }
    });
    socket.once('open', () => {
      resolve({
        socket,
        next: () =>
          new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
            const queued = queue.shift();
            if (queued !== undefined) {
              resolveMessage(queued);
              return;
            }
            const timer = setTimeout(() => rejectMessage(new Error('relay response timed out')), 3000);
            pending.push(value => {
              clearTimeout(timer);
              resolveMessage(value);
            });
          }),
      });
    });
    socket.once('error', reject);
  });
}

describe('proxy WebSocket relay', () => {
  it('forwards an allowed classifier request and returns the upstream response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"model":"jev-relay","answers":{"account_1":{"type":"choice","choice":"female","confidence":0.9}}}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'retry-after': '3' },
      }),
    );
    const proxy = await startProxy(fetchImpl as unknown as typeof fetch);
    const relay = await openRelay(proxy.relayUrl);
    relay.socket.send(
      JSON.stringify({
        kind: 'http',
        id: 'req-1',
        url: 'https://api.typesafe.ai/v1/systemone',
        method: 'POST',
        headers: { 'Authorization': 'Bearer apikey_test', 'Content-Type': 'application/json' },
        body: '{"model":"jev-latest"}',
      }),
    );
    const message = await relay.next();
    relay.socket.close();
    expect(message.kind).toBe('http-response');
    expect(message.id).toBe('req-1');
    expect(message.status).toBe(200);
    expect(String(message.body)).toContain('jev-relay');
    expect((message.headers as Record<string, string>)['retry-after']).toBe('3');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer apikey_test');
    expect(init.body).toBe('{"model":"jev-latest"}');
  });

  it('refuses non-classifier targets and keeps the connection usable', async () => {
    const proxy = await startProxy(vi.fn() as unknown as typeof fetch);
    const relay = await openRelay(proxy.relayUrl);
    relay.socket.send(
      JSON.stringify({ kind: 'http', id: 'req-2', url: 'https://evil.test/collect', method: 'POST', headers: {}, body: '{}' }),
    );
    const message = await relay.next();
    relay.socket.close();
    expect(message.kind).toBe('error');
    expect(String(message.message)).toMatch(/only forwards/i);
  });

  it('listens on IPv6 loopback too, so ws://localhost works in Firefox', async () => {
    const proxy = await startProxy(vi.fn() as unknown as typeof fetch);
    const port = Number(new URL(proxy.relayUrl.replace('ws:', 'http:')).port);
    const opened = await new Promise<boolean>(resolve => {
      const socket = new WebSocket(`ws://[::1]:${port}/ws`, { origin: 'https://www.instagram.com' });
      const timer = setTimeout(() => {
 socket.terminate(); resolve(false);
}, 3000);
      socket.once('open', () => {
 clearTimeout(timer); socket.close(); resolve(true);
});
      socket.once('error', () => {
 clearTimeout(timer); resolve(false);
});
    });
    expect(opened).toBe(true);
  });

  it('serves a secure wss relay for browsers that upgrade ws:// (Firefox)', async () => {
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-relay-cert-'));
    const proxy = (await (async () => {
      const started = await startDeepSeekProxy({
        env: {},
        port: 0,
        tls: true,
        wssPort: 0,
        certDir,
        fetchImpl: vi.fn(async () =>
          new Response('{"model":"jev-relay"}', { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
        logger: { error: () => undefined },
      });
      return started as unknown as StartedProxy;
    })());
    cleanups.push(async () => {
      await proxy.close();
      fs.rmSync(certDir, { recursive: true, force: true });
    });
    expect(proxy.wssRelayUrl).toMatch(/^wss:\/\/localhost:\d+\/ws$/);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(String(proxy.wssRelayUrl), { origin: 'https://www.instagram.com', rejectUnauthorized: false });
      const timer = setTimeout(() => {
 socket.terminate(); reject(new Error('wss relay timed out'));
}, 4000);
      socket.once('open', () => {
        socket.send(JSON.stringify({ kind: 'http', id: 'wss-1', url: 'https://api.typesafe.ai/v1/systemone', method: 'POST', headers: {}, body: '{}' }));
      });
      socket.on('message', raw => {
        clearTimeout(timer);
        socket.close();
        resolve(raw.toString());
      });
      socket.once('error', error => {
 clearTimeout(timer); reject(error);
});
    });
    expect(JSON.parse(response)).toMatchObject({ kind: 'http-response', status: 200 });

    // The landing page exists so the browser can accept the local certificate.
    const landing = await new Promise<string>((resolve, reject) => {
      https
        .get(String(proxy.httpsUrl), { rejectUnauthorized: false }, res => {
          let body = '';
          res.on('data', chunk => {
 body += String(chunk);
});
          res.on('end', () => resolve(body));
        })
        .on('error', reject);
    });
    expect(landing).toContain('local relay');
  });

  it('rejects browser origins that are not Instagram or localhost', async () => {
    const proxy = await startProxy(vi.fn() as unknown as typeof fetch);
    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(proxy.relayUrl, { origin: 'https://evil.test' });
        socket.once('unexpected-response', (_request, response) => {
          resolve(response.statusCode);
          socket.terminate();
        });
        socket.once('open', () => resolve('opened'));
        socket.once('error', reject);
      }),
    ).resolves.toBe(403);
  });
});
