/**
 * WebSocket relay for the bundled local proxy.
 *
 * Instagram's page Content-Security-Policy blocks cross-origin `fetch`/XHR to
 * api.typesafe.ai and api.deepseek.com from the pasted console script, but it
 * explicitly allows `ws://localhost:*`. This relay turns those allowed local
 * WebSockets into outbound HTTPS requests, so the classifier keeps working on
 * instagram.com without a browser extension.
 *
 * Security posture:
 * - loopback-only (the proxy binds 127.0.0.1);
 * - only browser origins belonging to Instagram or localhost may connect;
 * - only the two classifier hosts may be proxied;
 * - request bodies/headers are forwarded verbatim (the caller's API key never
 *   leaves the browser except toward the classifier API via this process).
 */
import crypto from 'node:crypto';

export const RELAY_PATH = '/ws';
export const RELAY_ALLOWED_HOSTS = Object.freeze(['api.typesafe.ai', 'api.deepseek.com']);
/** Public Instagram image hosts the browser may ask the relay to fetch. */
export const RELAY_IMAGE_HOSTS = Object.freeze(['instagram.com', 'i.instagram.com', 'cdninstagram.com', 'fbcdn.net']);
export const RELAY_MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** True for public Instagram/Facebook CDN image hosts (profile photos). */
export function isAllowedRelayImage(rawUrl, allowedHosts = RELAY_IMAGE_HOSTS) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  return allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** True when a target URL is an HTTPS classifier endpoint we are willing to relay. */
export function isAllowedRelayTarget(rawUrl, allowedHosts = RELAY_ALLOWED_HOSTS) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && allowedHosts.includes(parsed.hostname);
}

/** True when a browser Origin may use the relay (Instagram pages or loopback dev pages). */
export function isAllowedRelayOrigin(origin) {
  if (typeof origin !== 'string' || origin.trim() === '') {
    // Non-browser callers (tests, curl) have no Origin header.
    return true;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  return (
    host === 'instagram.com' ||
    host.endsWith('.instagram.com') ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

/** RFC 6455 accept key from the client's Sec-WebSocket-Key header. */
export function webSocketAcceptKey(clientKey) {
  return crypto
    .createHash('sha1')
    .update(`${clientKey}${WS_GUID}`)
    .digest('base64');
}

/** Encode one unmasked (server-to-client) text/binary frame. */
export function encodeServerFrame(payload, opcode = 0x1) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, body]);
}

/** Encode a client-style masked frame (used by tests). */
export function encodeClientFrame(payload, opcode = 0x1, mask = Buffer.from([0x12, 0x34, 0x56, 0x78])) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * Incremental parser for masked client frames. Returns a sink you push socket
 * chunks into; it accumulates one complete message (fragmentation supported)
 * and invokes `onMessage(text, opcode)`.
 */
export function createClientFrameParser({ maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES, onMessage, onProtocolError } = {}) {
  let buffer = Buffer.alloc(0);
  let messageOpcode = 0;
  const fragments = [];
  let messageLength = 0;

  function fail(reason) {
    if (typeof onProtocolError === 'function') {
      onProtocolError(reason);
    }
  }

  function push(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) {
        return;
      }
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) {
          return;
        }
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) {
          return;
        }
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxPayloadBytes)) {
          fail('payload too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > maxPayloadBytes) {
        fail('payload too large');
        return;
      }
      const maskLength = masked ? 4 : 0;
      const total = offset + maskLength + length;
      if (buffer.length < total) {
        return;
      }
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      let payload = buffer.subarray(offset + maskLength, total);
      if (mask !== null) {
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      buffer = buffer.subarray(total);
      if (opcode === 0x8) {
        onMessage?.('', 0x8);
        return;
      }
      if (opcode === 0x9 || opcode === 0xa) {
        onMessage?.(payload.toString('utf8'), opcode);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          messageOpcode = opcode;
          fragments.push(payload);
          messageLength = payload.length;
          continue;
        }
        onMessage?.(payload.toString('utf8'), opcode);
        continue;
      }
      if (opcode === 0x0) {
        fragments.push(payload);
        messageLength += payload.length;
        if (messageLength > maxPayloadBytes) {
          fail('payload too large');
          return;
        }
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments.length = 0;
          messageLength = 0;
          onMessage?.(whole.toString('utf8'), messageOpcode);
        }
      }
    }
  }

  return { push };
}

function writeHttpError(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // Socket may already be gone.
  }
  socket.destroy();
}

function sanitizeRequestHeaders(rawHeaders) {
  const headers = {};
  if (typeof rawHeaders !== 'object' || rawHeaders === null) {
    return headers;
  }
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof value !== 'string') {
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'origin' || lower === 'content-length' || lower.startsWith('sec-')) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

/**
 * Attach the relay to an existing HTTP server. Returns a disposer that removes
 * the upgrade listener.
 */
export function attachRelay(server, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const logger = options.logger !== undefined ? options.logger : console;
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 60000;
  const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts : RELAY_ALLOWED_HOSTS;
  const maxPayloadBytes =
    typeof options.maxPayloadBytes === 'number' && options.maxPayloadBytes > 0 ? options.maxPayloadBytes : DEFAULT_MAX_PAYLOAD_BYTES;
  const connections = new Set();

  function onUpgrade(req, socket) {
    const url = typeof req.url === 'string' ? req.url : '';
    const path = url.split('?')[0];
    if (path !== RELAY_PATH) {
      writeHttpError(socket, 404, 'Not Found');
      return;
    }
    if (!isAllowedRelayOrigin(req.headers.origin)) {
      writeHttpError(socket, 403, 'Forbidden');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      writeHttpError(socket, 400, 'Bad Request');
      return;
    }
    const accept = webSocketAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => connections.delete(socket));

    function send(payload, opcode = 0x1) {
      if (!socket.destroyed) {
        socket.write(encodeServerFrame(payload, opcode));
      }
    }

    async function handleMessage(text) {
      let envelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        send(JSON.stringify({ kind: 'error', id: null, code: 'bad_request', message: 'Relay expects JSON.' }));
        return;
      }
      const id = envelope !== null && typeof envelope === 'object' ? envelope.id : null;
      if (envelope !== null && typeof envelope === 'object' && envelope.kind === 'fetch-image') {
        if (typeof envelope.url !== 'string' || !isAllowedRelayImage(envelope.url)) {
          send(JSON.stringify({ kind: 'error', id, code: 'forbidden', message: 'Relay only fetches public Instagram/Facebook CDN images.' }));
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(envelope.url, { method: 'GET', headers: { Accept: 'image/*' }, signal: controller.signal });
          const contentType = response.headers.get('content-type') ?? '';
          if (!response.ok) throw new Error(`image responded HTTP ${response.status}`);
          if (!/^image\//i.test(contentType)) throw new Error(`URL is not an image (${contentType || 'unknown type'})`);
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 6 * 1024 * 1024) throw new Error('image is larger than 6 MiB');
          send(JSON.stringify({ kind: 'image-response', id, mimeType: contentType.split(';')[0].trim().toLowerCase(), base64: buffer.toString('base64') }));
        } catch (error) {
          const isAbort = error instanceof Error && error.name === 'AbortError';
          send(JSON.stringify({ kind: 'error', id, code: isAbort ? 'timeout' : 'network', message: isAbort ? 'Image fetch timed out.' : 'Could not fetch the profile image.' }));
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      if (
        envelope === null ||
        typeof envelope !== 'object' ||
        envelope.kind !== 'http' ||
        typeof envelope.url !== 'string' ||
        !isAllowedRelayTarget(envelope.url, allowedHosts)
      ) {
        send(
          JSON.stringify({
            kind: 'error',
            id,
            code: 'forbidden',
            message: 'Relay only forwards HTTPS requests to api.typesafe.ai or api.deepseek.com.',
          }),
        );
        return;
      }
      const method = typeof envelope.method === 'string' ? envelope.method.toUpperCase() : 'POST';
      if (method !== 'POST' && method !== 'GET') {
        send(JSON.stringify({ kind: 'error', id, code: 'bad_request', message: 'Unsupported relay method.' }));
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(envelope.url, {
          method,
          headers: sanitizeRequestHeaders(envelope.headers),
          body: method === 'GET' ? undefined : typeof envelope.body === 'string' ? envelope.body : undefined,
          signal: controller.signal,
        });
        const body = await response.text();
        const headers = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        send(JSON.stringify({ kind: 'http-response', id, status: response.status, headers, body }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'relay request failed';
        const isAbort = error instanceof Error && error.name === 'AbortError';
        send(
          JSON.stringify({
            kind: 'error',
            id,
            code: isAbort ? 'timeout' : 'network',
            message: isAbort ? `Relay request timed out after ${timeoutMs} ms.` : `Relay request failed: ${message}`,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    }

    const parser = createClientFrameParser({
      maxPayloadBytes,
      onMessage: (text, opcode) => {
        if (opcode === 0x8) {
          try {
            socket.end(encodeServerFrame(Buffer.alloc(0), 0x8));
          } catch {
            socket.destroy();
          }
          return;
        }
        if (opcode === 0x9) {
          send(text, 0xa);
          return;
        }
        if (opcode === 0x1) {
          void handleMessage(text);
        }
      },
      onProtocolError: reason => {
        if (logger !== null && typeof logger === 'object' && typeof logger.error === 'function') {
          logger.error(`Relay protocol error: ${reason}`);
        }
        socket.destroy();
      },
    });

    socket.on('data', chunk => {
      try {
        parser.push(chunk);
      } catch (error) {
        if (logger !== null && typeof logger === 'object' && typeof logger.error === 'function') {
          logger.error(`Relay parse error: ${error instanceof Error ? error.message : 'unknown'}`);
        }
        socket.destroy();
      }
    });
  }

  server.on('upgrade', onUpgrade);
  return () => {
    server.removeListener('upgrade', onUpgrade);
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();
  };
}
